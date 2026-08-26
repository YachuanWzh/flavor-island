// flavor-code → Flavor Island plugin
//
// Installed by the Flavor Island app into flavor-code's global plugin
// directory (~/.flavor-code/plugins/flavor-island), so every flavor-code
// session — on Windows and macOS, in any project — relays hook events to the
// island without needing `flavor init` per project.
//
// A single persistent bridge daemon (bridgeDaemon.mjs) is spawned at first
// use and reused for every hook event; bridgeRelay.mjs owns its lifecycle,
// frames requests on stdin, and resolves blocking PermissionRequest decisions
// from daemon responses. When flavor-code runs as its Electron desktop app,
// execPath is the Electron binary — ELECTRON_RUN_AS_NODE (set by the relay)
// turns it back into plain Node for the daemon.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridgeRelay } from "./bridgeRelay.mjs";
import { transformEvent } from "./eventTransform.mjs";

const bridgePath = fileURLToPath(new URL("./bridgeDaemon.mjs", import.meta.url));
const BLOCKING_TIMEOUT_MS = 86_400_000;
const FIRE_TIMEOUT_MS = 10_000;

export function activate(context) {
  const names = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop",
    "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionRequest", "PreCompact", "Notification",
    // Model-call and planning lifecycle — the island shows the model name and a
    // distinct "Planning…" state from these, plus PostCompact to recover from
    // the 'Compacting context…' state PreCompact sets.
    "BeforeModelCall", "AfterModelCall", "BeforePlan", "AfterPlan", "PostCompact", "LoopEnd",
  ];
  const relay = createBridgeRelay({
    spawn,
    execPath: process.execPath,
    bridgePath,
    transform: transformEvent,
  });
  const disposers = [];
  for (const eventName of names) {
    const blocking = eventName === "PermissionRequest" || eventName === "Notification";
    const disposer = context.registerHook(eventName, (event, signal) => relay.relay(event, signal), {
      timeoutMs: blocking ? BLOCKING_TIMEOUT_MS : FIRE_TIMEOUT_MS,
      failurePolicy: blocking ? "ask" : "allow",
    });
    disposers.push(disposer);
  }
  return async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch { /* ignore */ }
    }
    await relay.dispose();
  };
}
