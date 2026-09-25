'use strict';

// Pin the native NSWindow through the NSView pointer Electron exposes. Looking
// up NSApp.windows by title raced the page title and could silently leave the
// island attached to a Space during a three-finger swipe.
const CAN_JOIN_ALL_SPACES = 1 << 0;
const STATIONARY = 1 << 4;
const IGNORES_CYCLE = 1 << 6;
const FULLSCREEN_AUXILIARY = 1 << 8;
const DESIRED_BEHAVIOR =
  CAN_JOIN_ALL_SPACES | FULLSCREEN_AUXILIARY | STATIONARY | IGNORES_CYCLE;

let ffi = null;
let loggedSuccess = false;
if (process.platform === 'darwin') {
  try {
    const koffi = require('koffi');
    const lib = koffi.load('/usr/lib/libobjc.dylib');
    const selRegisterName = lib.func('void *sel_registerName(const char *name)');
    ffi = {
      koffi,
      sel: (name) => selRegisterName(name),
      send: {
        id: lib.func('void *objc_msgSend(void *receiver, void *op)'),
        behavior: lib.func('uint64_t objc_msgSend(void *receiver, void *op)'),
        setBehavior: lib.func('void objc_msgSend(void *receiver, void *op, uint64_t behavior)'),
      },
    };
  } catch (err) {
    console.log('[notch-stationary] native FFI unavailable:', err.message);
  }
}

function applyNotchStationary(browserWindow) {
  if (process.platform !== 'darwin' || !ffi || !browserWindow || browserWindow.isDestroyed()) return false;
  try {
    // The Buffer holds an NSView* value, not an NSView object. Decode the value
    // before sending Objective-C messages, then ask the view for its NSWindow.
    const handle = browserWindow.getNativeWindowHandle();
    if (!Buffer.isBuffer(handle) || handle.length < 8) {
      console.log('[notch-stationary] native NSView handle unavailable');
      return false;
    }
    const view = ffi.koffi.decode(handle, 'void *');
    if (!view || ffi.koffi.address(view) === 0n) {
      console.log('[notch-stationary] native NSView pointer is null');
      return false;
    }
    const nsWindow = ffi.send.id(view, ffi.sel('window'));
    if (!nsWindow) {
      console.log('[notch-stationary] NSView has no NSWindow yet');
      return false;
    }

    const getBehavior = ffi.sel('collectionBehavior');
    const current = BigInt(ffi.send.behavior(nsWindow, getBehavior));
    // Assign the same four flags as CodeIsland. In particular, do not retain
    // managed/transient (bits 2/3): those conflict with stationary (bit 4).
    const desired = BigInt(DESIRED_BEHAVIOR);
    if (current !== desired) {
      ffi.send.setBehavior(nsWindow, ffi.sel('setCollectionBehavior:'), desired);
    }
    const actual = BigInt(ffi.send.behavior(nsWindow, getBehavior));
    const applied = actual === desired;
    if (!applied) console.log('[notch-stationary] collection behavior did not stick:', actual.toString(16));
    else if (!loggedSuccess) {
      console.log('[notch-stationary] pinned NSWindow, collectionBehavior=0x' + actual.toString(16));
      loggedSuccess = true;
    }
    return applied;
  } catch (err) {
    console.log('[notch-stationary] failed:', err.message);
    return false;
  }
}

module.exports = { applyNotchStationary, DESIRED_BEHAVIOR };
