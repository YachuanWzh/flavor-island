'use strict';

// macOS: pin the notch-fusion window so it does NOT slide along with a Space
// (Mission Control desktop) switch when the user three-finger-swipes. CodeIsland
// achieves this with:
//
//   panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary,
//                               .stationary, .ignoresCycle]
//
// The `.stationary` flag is the one that keeps the window glued in place during
// the space-change animation. Electron's `setVisibleOnAllWorkspaces()` only sets
// `CanJoinAllSpaces` and exposes no way to reach `.stationary` (known Electron
// limitation — see electron/electron#8734), so we poke the live NSWindow through
// the Objective-C runtime using koffi: a prebuilt Node-API FFI library that ships
// per-platform binaries and needs NO native build step (Node-API is ABI-stable,
// so the same binary loads inside Electron unchanged).
//
// This is entirely best-effort and darwin-only. Any failure — koffi not
// installed, a symbol/signature mismatch, the window not found — is swallowed and
// logged, so the island keeps working; it just keeps the cosmetic slide behavior.

const NOTCH_WINDOW_TITLE = 'Flavor Island';

// NSWindowCollectionBehavior (AppKit) bit values.
const CAN_JOIN_ALL_SPACES = 1 << 0; // 1
const IGNORES_CYCLE = 1 << 2; // 4
const STATIONARY = 1 << 3; // 8
const FULLSCREEN_AUXILIARY = 1 << 8; // 256
const DESIRED_BEHAVIOR =
  CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY | STATIONARY | IGNORES_CYCLE;

let ffi = null;
// Only macOS has /usr/lib/libobjc.dylib; skip the whole load elsewhere so a
// Windows/Linux dev run doesn't log a spurious "load failed".
if (process.platform === 'darwin') {
  try {
    const lib = require('koffi').load('/usr/lib/libobjc.dylib');
    const objc_getClass = lib.func('void *objc_getClass(const char *name)');
    const sel_registerName = lib.func('void *sel_registerName(const char *sel)');
    // objc_msgSend is variadic; declare one concrete prototype per call shape we
    // need (koffi keys overloads by the full prototype, so the same symbol can be
    // declared several times with different signatures).
    const send = {
      id: lib.func('void *objc_msgSend(void *receiver, void *op)'),
      cstr: lib.func('const char *objc_msgSend(void *receiver, void *op)'),
      setBehavior: lib.func(
        'void objc_msgSend(void *receiver, void *op, uint64_t behavior)'
      ),
    };
    const sel = (name) => sel_registerName(name);
    ffi = { objc_getClass, sel_registerName, sel, send };
  } catch (err) {
    // koffi missing or dylib not loadable: disable the pin, island still works.
    console.log('[notch-stationary] native FFI unavailable:', err.message);
  }
}

// Find the island's NSWindow by matching its title, then set the collection
// behavior. Enumerating via NSEnumerator (nextObject until NULL) avoids needing
// scalar-returning objc_msgSend wrappers for -count.
function applyNotchStationary() {
  if (process.platform !== 'darwin' || !ffi) return false;
  try {
    const { send, sel } = ffi;
    const nsAppClass = ffi.objc_getClass('NSApplication');
    if (!nsAppClass) return false;
    const app = send.id(nsAppClass, sel('sharedApplication'));
    if (!app) return false;
    const windows = send.id(app, sel('windows'));
    if (!windows) return false;
    const enumerator = send.id(windows, sel('objectEnumerator'));
    if (!enumerator) return false;

    const titleSel = sel('title');
    const utf8Sel = sel('UTF8String');
    const setBehaviorSel = sel('setCollectionBehavior:');
    let win = send.id(enumerator, sel('nextObject'));
    while (win) {
      const titleStr = send.id(win, titleSel);
      let title = '';
      if (titleStr) {
        const cstr = send.cstr(titleStr, utf8Sel);
        if (typeof cstr === 'string') title = cstr;
      }
      if (title === NOTCH_WINDOW_TITLE) {
        send.setBehavior(win, setBehaviorSel, BigInt(DESIRED_BEHAVIOR));
        console.log('[notch-stationary] applied .stationary to notch window');
        return true;
      }
      win = send.id(enumerator, sel('nextObject'));
    }
    console.log('[notch-stationary] notch window not found (title mismatch?)');
    return false;
  } catch (err) {
    console.log('[notch-stationary] failed:', err.message);
    return false;
  }
}

module.exports = { applyNotchStationary, NOTCH_WINDOW_TITLE, DESIRED_BEHAVIOR };
