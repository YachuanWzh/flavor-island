// flavor-code → Flavor Island bridge
//
// One-shot relay: reads one hook event from stdin, forwards it to the Flavor
// Island app, and (for blocking PermissionRequest events) prints the island's
// decision to stdout. Transport is platform-aware:
//
//   win32   -> \\.\pipe\codeisland-<USERNAME>     (override: CODEISLAND_PIPE)
//   darwin  -> /tmp/codeisland-<uid>.sock         (override: CODEISLAND_SOCKET_PATH)
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

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded) { resolve(Buffer.alloc(0)); return; }
    const chunks = [];
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", () => resolve(Buffer.concat(chunks)));
  });
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

async function main() {
  const input = await readStdin();
  if (!input.length) process.exit(0);
  let event;
  try { event = JSON.parse(input.toString("utf8")); } catch { process.exit(0); }
  if (!event || typeof event !== "object" || Array.isArray(event)) process.exit(0);

  const blocking = event.type === "PermissionRequest";
  const transformed = transformEvent(event);

  return new Promise((resolve) => {
    const socket = net.connect(endpoint());
    let response = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (blocking && response) {
        process.stdout.write(JSON.stringify(toHookDecision(response, event)), () => process.exit(code));
      } else {
        process.exit(code);
      }
    };
    if (!blocking) {
      const t = setTimeout(() => finish(0), PIPE_TIMEOUT_MS);
      if (t.unref) t.unref();
    }
    socket.on("connect", () => socket.write(JSON.stringify(transformed) + "\n"));
    socket.on("data", (d) => { response += d.toString("utf8"); });
    socket.on("close", () => finish(0));
    socket.on("error", () => finish(0));
  });
}

main();
