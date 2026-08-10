// flavor-code → Flavor Island plugin
//
// Installed by the Flavor Island app into flavor-code's global plugin
// directory (~/.flavor-code/plugins/flavor-island), so every flavor-code
// session — on Windows and macOS, in any project — relays hook events to the
// island without needing `flavor init` per project.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const bridgePath = join(__dirname, "bridge.mjs");
const BLOCKING_TIMEOUT_MS = 86_400_000;
const FIRE_TIMEOUT_MS = 10_000;
// When flavor-code runs as its Electron desktop app, execPath is the Electron
// binary — ELECTRON_RUN_AS_NODE turns it back into plain Node for the bridge.
const bridgeEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };

function relay(event, signal) {
  if (event.type !== "PermissionRequest") {
    const child = spawn(process.execPath, [bridgePath], {
      stdio: ["pipe", "ignore", "ignore"],
      env: bridgeEnvironment,
      windowsHide: true,
      detached: true,
    });
    child.stdin.end(JSON.stringify(event));
    child.unref();
    return { decision: "allow" };
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: bridgeEnvironment,
      windowsHide: true,
    });
    let stdout = "";
    const onAbort = () => {
      child.kill();
      resolve({ decision: "deny", reason: "Cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (code !== 0 || !stdout) {
        resolve({ decision: "ask", reason: "Flavor Island unavailable" });
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ decision: "ask", reason: "Flavor Island response invalid" }); }
    });
    child.on("error", () => {
      signal.removeEventListener("abort", onAbort);
      resolve({ decision: "ask", reason: "Flavor Island unavailable" });
    });
    child.stdin.end(JSON.stringify(event));
  });
}

export function activate(context) {
  const names = [
    "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop",
    "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse",
    "PostToolUseFailure", "PermissionRequest", "PreCompact", "Notification",
    // Model-call and planning lifecycle — the island shows the model name and a
    // distinct "Planning…" state from these, plus PostCompact to recover from
    // the 'Compacting context…' state PreCompact sets.
    "BeforeModelCall", "AfterModelCall", "BeforePlan", "AfterPlan", "PostCompact",
  ];
  const disposers = [];
  for (const eventName of names) {
    const blocking = eventName === "PermissionRequest";
    const disposer = context.registerHook(eventName, (event, signal) => relay(event, signal), {
      timeoutMs: blocking ? BLOCKING_TIMEOUT_MS : FIRE_TIMEOUT_MS,
      failurePolicy: blocking ? "ask" : "allow",
    });
    disposers.push(disposer);
  }
  return async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch { /* ignore */ }
    }
  };
}
