'use strict';

// Client half of the persistent bridge: owns the daemon child process, frames
// hook events on stdin, and resolves blocking PermissionRequest promises from
// framed daemon responses on stdout. Exposes `pendingCount()` for tests.
//
// Crash recovery: if the daemon dies (close), every blocked request settles as
// ask and the child handle is forgotten so the next relay() re-spawns it.

import { encodeRequest, decodeResponse, nextId } from "./bridgeProtocol.mjs";

const ABORT_REASON = "Cancelled";
const UNAVAILABLE_REASON = "Flavor Island unavailable";

export function createBridgeRelay(deps) {
  const { spawn, execPath, bridgePath } = deps;
  let child = null;
  let stdoutBuffer = "";
  const pending = new Map();

  function ensureChild() {
    if (child) return child;
    let c;
    try {
      c = spawn(execPath, [bridgePath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      });
    } catch {
      return null;
    }
    c.stdin.on("error", () => { /* EPIPE after daemon death is expected */ });
    c.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let nl;
      while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        const decoded = decodeResponse(line);
        if (!decoded) continue;
        const entry = pending.get(decoded.id);
        if (!entry) continue;
        pending.delete(decoded.id);
        if (decoded.ok) entry.resolve(decoded.decision);
        else entry.resolve({ decision: "ask", reason: decoded.reason });
      }
    });
    c.on("close", () => {
      // Daemon died (crash or disposal): fail every blocked request with ask,
      // then forget the child so the next relay re-spawns.
      child = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.resolve({ decision: "ask", reason: UNAVAILABLE_REASON });
      }
    });
    child = c;
    return c;
  }

  function relay(event, signal) {
    const blocking = event && event.type === "PermissionRequest";
    const id = nextId();
    const c = ensureChild();
    if (blocking) {
      return new Promise((resolve) => {
        const onAbort = () => {
          pending.delete(id);
          resolve({ decision: "deny", reason: ABORT_REASON });
        };
        const entry = {
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
        };
        if (c === null) {
          resolve({ decision: "ask", reason: UNAVAILABLE_REASON });
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, entry);
        try {
          c.stdin.write(encodeRequest(id, event, true));
        } catch {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          resolve({ decision: "ask", reason: UNAVAILABLE_REASON });
        }
      });
    }
    if (c !== null) {
      try {
        c.stdin.write(encodeRequest(id, event, false));
      } catch { /* daemon just died — non-blocking event lost, nothing to settle */ }
    }
    return Promise.resolve({ decision: "allow" });
  }

  function dispose() {
    const c = child;
    child = null;
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.resolve({ decision: "ask", reason: UNAVAILABLE_REASON });
    }
    return Promise.resolve().then(() => {
      if (c) {
        try { c.kill(); } catch { /* ignore */ }
      }
    });
  }

  return {
    relay,
    dispose,
    pendingCount: () => pending.size,
  };
}
