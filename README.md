<p align="center">
  <img src="src/assets/flavor.png" width="128" alt="Flavor Island logo" />
</p>

<h1 align="center">Flavor Island</h1>

<p align="center">
  A cross-platform (Windows / macOS) desktop <strong>floating island</strong> that shows the
  real-time working status of the <strong>flavor-code</strong> coding agent.
  <br />
  Inspired by <a href="https://github.com/wxtsky/CodeIsland">CodeIsland</a> &amp;
  <a href="https://github.com/wxtsky/CodeIslandWin">CodeIslandWin</a>, with native support for flavor-code.
</p>

<p align="center">
  <a href="README.zh-CN.md"><strong>中文</strong></a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.0-6f42c1" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-brightgreen" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d4" />
  <img alt="electron" src="https://img.shields.io/badge/Electron-42.7.0-47848f" />
</p>

---

## ✨ Features

Flavor Island lives at the top of your screen as an always-on-top pill that mirrors your flavor-code session:

- 🟢 **Real-time status** — thinking (blinking dots) / running a tool (tool-category color) / awaiting approval (amber pulse) / awaiting an answer
- 🔐 **Permission approval** — Allow / Allow all / Deny tool permission requests right from the island
- ❓ **Question answering** — renders AskUserQuestion cards (single-choice / multi-choice / text / custom input); custom input is submitted as a checkbox + single-line text combo
- 💬 **Session overview** — multiple sessions sorted, with the active session pinned on top
- 🖱️ **Drag to move** — drag it anywhere; double-click to reset to top-center
- 🪟 **Click-through** — the transparent area around the island doesn't block the desktop
- 🔊 **Sound alerts** — optional 8-bit style notification sounds

## 🎯 Native to flavor-code

Flavor Island ships with a bundled flavor-code plugin (`src/plugin/`) and auto-installs it into flavor-code's global plugin directory when the app starts:

```
~/.flavor-code/plugins/flavor-island/
  ├── flavor-plugin.json   plugin manifest (declares 12 hooks)
  ├── activate.mjs         hook registration: event forwarding + approval blocking relay
  └── bridge.mjs           cross-platform transport: Win named pipe / macOS Unix socket
```

The plugin:

1. Captures the full lifecycle through flavor-code's hook system — `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `PermissionRequest` / `Stop` and more.
2. Forwards events via `bridge.mjs` to the endpoint the island listens on:
   - **Windows**: named pipe `\\.\pipe\codeisland-<user>` (overridable with `CODEISLAND_PIPE`)
   - **macOS**: Unix socket `/tmp/codeisland-<uid>.sock` (overridable with `CODEISLAND_SOCKET_PATH`, following CodeIsland's original convention)
3. Blocks on `PermissionRequest` and waits for the island's decision (allow / allow-all / deny); falls back to `ask` when the island is unreachable, returning approval to the terminal without blocking flavor-code.
4. `AskUserQuestion` is relayed the same way through `PermissionRequest`: the island pops up a selection panel (pick an option / custom input, then confirm to submit) and the answer is written back through the decision's `updatedInput`; if the island doesn't respond, flavor-code automatically falls back to asking in the terminal — either end covers the other.

The global plugin directory applies to every project — **no `flavor init` or per-project configuration needed**. If a project also has the built-in `codeisland` plugin installed via `flavor init`, the island automatically deduplicates repeated permission requests, so both plugins can safely coexist.

## 🔌 How it works

```
flavor-code (CLI)
  → flavor-island plugin (~/.flavor-code/plugins, auto-installed when the island starts)
    → bridge.mjs
      → Windows: \\.\pipe\codeisland-<user>
      → macOS:   /tmp/codeisland-<uid>.sock
        → Flavor Island (Electron)
          → real-time island UI updates (status color / animation / session list)
          → approval / answer decisions written back to the socket → bridge converts to hook decision
            (AskUserQuestion answers are passed back to the tool via updatedInput)
```

### Platform differences

| | Windows | macOS |
|---|---|---|
| Transport | Named pipe | Unix socket |
| Stale cleanup | Not needed (pipe is released with the process) | Auto-cleans stale sockets left by crashes on startup |
| GPU workaround | Enabled (disable-gpu etc.) | Not enabled |
| Dock icon | — | Hidden (tray-only) |

## 🚀 Getting Started

```bash
npm install
npm start          # start in dev mode (auto-installs the flavor-code plugin on first launch)
npm test           # run unit tests
npm run dist       # build the Windows installer (NSIS)
npm run dist:mac   # build the macOS package (dmg + zip, must run on macOS)
```

After the first run, the island stays in the system tray (the tray menu shows plugin install status).

### Verify the pipeline

```bash
node scripts/e2e-bridge.mjs   # events → island → decision write-back through the real bridge
node scripts/smoke.mjs        # launch Electron and check the endpoint is listening
```

## 📁 Project Structure

```
src/
  core/       pure logic layer (no Electron dependency, unit-testable): endpoint paths, event parsing, session reducer, question parsing, view models, window layout
  server/     socket server: event routing + blocking decision write-back + stale socket cleanup
  main/       Electron main process: window, state machine, tray, IPC, plugin auto-install
  plugin/     bundled flavor-code plugin (distributed with the app, installed to ~/.flavor-code/plugins on startup)
  renderer/   island UI: HTML / CSS / JS
  assets/     icons and sounds
test/         node:test unit tests
scripts/      diagnostic & end-to-end verification scripts
```

## 🙏 Credits

- [CodeIsland](https://github.com/wxtsky/CodeIsland) — macOS notch Dynamic Island, MIT
- [CodeIslandWin](https://github.com/wxtsky/CodeIslandWin) — Windows port, MIT
- [flavor-code](https://github.com/wxtsky/flavor-code) — coding agent that provides the plugin system and hook bus

## 📄 License

[MIT](LICENSE)
