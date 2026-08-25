// Persistent flavor-code → Flavor Island relay. Reads newline-framed requests
// on stdin ({id, event, wait}), transforms each hook event, forwards it to the
// island over the platform named pipe, and for wait=true requests writes the
// island's hook decision back as a framed response on stdout.
//
// Replaces the one-shot bridge.mjs so flavor-code stops paying a Node process
// spawn (~100-300ms) per hook event; the island pipe connection is still made
// per request because src/server/hookServer.js serves one message per
// connection.
import net from "node:net";
import { transformEvent } from "./eventTransform.mjs";

const PIPE_TIMEOUT_MS = 4000;

function endpoint() {
  if (process.platform === "win32") {
    if (process.env.CODEISLAND_PIPE && process.env.CODEISLAND_PIPE.trim()) {
      return process.env.CODEISLAND_PIPE.trim();
    }
    const user = (process.env.USERNAME || process.env.USER || "default").trim() || "default";
    const sep = String.fromCharCode(92);
    return sep + sep + "." + sep + "pipe" + sep + "codeisland-" + user;
  }
  if (process.env.CODEISLAND_SOCKET_PATH && process.env.CODEISLAND_SOCKET_PATH.trim()) {
    return process.env.CODEISLAND_SOCKET_PATH.trim();
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return "/tmp/codeisland-" + uid + ".sock";
}

function toHookDecision(pipeResponse, event) {
  try {
    const parsed = JSON.parse(pipeResponse);
    const dec = parsed?.hookSpecificOutput?.decision;
    if (dec?.behavior === "allow") {
      if (Array.isArray(dec.updatedPermissions) && dec.updatedPermissions.length > 0) {
        return { decision: "allow", additionalContext: "codeisland:allow-all" };
      }
      // AskUserQuestion answers travel back inside updatedInput. flavor-code's
      // hook bus re-validates updatedInput against the PermissionRequest payload
      // shape, so wrap the answered tool input back into { tool, input, agent }.
      if (dec.updatedInput && event?.type === "PermissionRequest" && event?.payload?.tool === "AskUserQuestion") {
        return {
          decision: "allow",
          updatedInput: {
            tool: "AskUserQuestion",
            input: dec.updatedInput,
            agent: event.payload.agent === "subagent" ? "subagent" : "main",
          },
        };
      }
      return { decision: "allow" };
    }
  } catch { /* ignore */ }
  return { decision: "deny" };
}

function writeResponse(id, payload) {
  process.stdout.write(JSON.stringify({ id, ...payload }) + "\n");
}

// Forward one request. wait=false: write the event, flush, close the socket
// (fire-and-forget — the island server still processes the event; its reply
// is ignored). wait=true: hold the socket until the island closes the
// connection, map the reply to a hook decision, and write the framed response.
function handleRequest(request) {
  const { id, event, wait } = request;
  const blocking = wait === true;
  const transformed = transformEvent(event);
  return new Promise((resolve) => {
    const socket = net.connect(endpoint());
    let response = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve();
    };
    if (!blocking) {
      const t = setTimeout(finish, PIPE_TIMEOUT_MS);
      if (t.unref) t.unref();
    }
    socket.on("connect", () => {
      socket.write(JSON.stringify(transformed) + "\n", () => {
        // Data flushed to the kernel. Fire-and-forget requests are done — drop
        // the connection without waiting for the island's '{}' reply. Blocking
        // requests keep the socket open and wait for the decision.
        if (!blocking) finish();
      });
    });
    socket.on("data", (d) => { response += d.toString("utf8"); });
    socket.on("close", () => {
      if (settled) return;
      if (blocking && response) {
        writeResponse(id, { ok: true, decision: toHookDecision(response, event) });
      } else if (blocking) {
        writeResponse(id, { ok: false, reason: "island closed without a response" });
      }
      finish();
    });
    socket.on("error", (err) => {
      // A failed connect fires both 'error' and 'close'; settle once so only
      // one response frame reaches the relay client.
      if (settled) return;
      if (blocking) writeResponse(id, { ok: false, reason: String(err?.message ?? err) });
      finish();
    });
  });
}

// Line-buffered stdin: requests are single \n-terminated JSON lines. Requests
// are handled concurrently — fire-and-forget frames complete quickly and a
// blocking PermissionRequest never queues behind a slow non-blocking one.
const active = new Set();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.id !== "number") continue;
    const run = handleRequest(request);
    active.add(run);
    run.finally(() => active.delete(run)).catch(() => { /* already settled */ });
  }
});
process.stdin.on("end", () => {
  // Drain in-flight requests, then exit.
  Promise.allSettled([...active]).then(() => process.exit(0));
});
process.stdin.on("error", () => process.exit(0));
