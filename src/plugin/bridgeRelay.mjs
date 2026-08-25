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
const TIMEOUT_REASON = "Flavor Island timed out";
// Slightly below flavor-code's default PermissionRequest hook timeout (24h) so
// the relay settles first with ask and the host's timeout abort is a no-op.
const DEFAULT_BLOCKING_TIMEOUT_MS = 86_400_000 - 5_000;

export function createBridgeRelay(deps) {
  const { spawn, execPath, bridgePath } = deps;
  const blockingTimeoutMs = deps.blockingTimeoutMs ?? DEFAULT_BLOCKING_TIMEOUT_MS;
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
    const onDaemonGone = (reason) => {
      // Daemon died (crash, spawn failure, or disposal): fail every blocked
      // request with ask, then forget the child so the next relay re-spawns.
      // Guarded so 'error' + 'close' firing together only settles once.
      if (child !== c) return;
      child = null;
      for (const [id, entry] of pending) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.resolve({ decision: "ask", reason });
      }
    };
    // Without this listener, a failed spawn (EMFILE, permission denial, …)
    // surfaces as an uncaught 'error' on the child and crashes flavor-code.
    c.on("error", () => onDaemonGone(UNAVAILABLE_REASON));
    c.on("close", () => onDaemonGone(UNAVAILABLE_REASON));
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
          if (entry.timer) clearTimeout(entry.timer);
          resolve({ decision: "deny", reason: ABORT_REASON });
        };
        const entry = {
          timer: null,
          resolve: (value) => {
            signal?.removeEventListener("abort", onAbort);
            if (entry.timer) clearTimeout(entry.timer);
            resolve(value);
          },
        };
        if (c === null) {
          resolve({ decision: "ask", reason: UNAVAILABLE_REASON });
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        // Own timeout: the host's hook timeout would abort the signal and
        // settle as deny; the spec wants a hung island to fall back to ask so
        // the user still gets a terminal prompt. Settle ask first instead.
        entry.timer = setTimeout(() => {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          resolve({ decision: "ask", reason: TIMEOUT_REASON });
        }, blockingTimeoutMs);
        pending.set(id, entry);
        try {
          c.stdin.write(encodeRequest(id, event, true));
        } catch {
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          clearTimeout(entry.timer);
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
