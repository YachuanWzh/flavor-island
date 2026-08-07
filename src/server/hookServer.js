'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { parseHookEvent } = require('../core/hookEvent');
const { normalize } = require('../core/eventNormalizer');
const { pipePath } = require('../core/pipePath');
const { permissionResponse } = require('../core/permissionResponse');

const MAX_PAYLOAD = 1024 * 1024; // 1MB, matches macOS HookServer.

// Route a parsed event to the right handler.
//
//   'permission'      -> onPermission(event)      -> Promise<'allow'|'allowAll'|'deny'>
//   'askUserQuestion' -> onAskUserQuestion(event) -> Promise<object>  (full hook response)
//   'question'        -> onQuestion(event)        -> Promise<object|null> (raw response or null to skip)
//   'event'           -> onEvent(event)           -> void (fire-and-forget UI update)
function routeKind(event) {
  const name = normalize(event.eventName);
  if (name === 'PermissionRequest') {
    // AskUserQuestion is information input (select/type), not a yes/no approval.
    return event.toolName === 'AskUserQuestion' ? 'askUserQuestion' : 'permission';
  }
  if (name === 'Notification' && typeof event.rawJSON.question === 'string') return 'question';
  return 'event';
}

// Named-pipe server that receives hook events from the flavor-code codeisland
// bridge, routes them, and for blocking events (permission/question) holds the
// connection open until the handler resolves a decision, then writes the JSON
// response back to the bridge.
function createHookServer({ pipe = pipePath(), onEvent, onPermission, onQuestion, onAskUserQuestion } = {}) {
  // Windows named pipes do not support TCP-style half-close, so we frame the
  // request with a trailing newline instead of relying on the peer's FIN: the
  // bridge writes `JSON\n` and waits, we read up to the newline, then reply and
  // fully close. JSON.stringify never emits a literal newline, so `\n` is a
  // safe delimiter.
  const server = net.createServer();

  server.on('connection', (socket) => {
    let buf = '';
    let handled = false;

    socket.on('error', () => { /* ignore: broken pipe on a flaky bridge must not crash */ });

    socket.on('data', (chunk) => {
      if (handled) return;
      buf += chunk.toString('utf8');
      if (buf.length > MAX_PAYLOAD) {
        handled = true;
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return; // wait for the full line
      handled = true;
      processMessage(socket, buf.slice(0, nl));
    });
  });

  async function processMessage(socket, line) {
    const event = parseHookEvent(Buffer.from(line, 'utf8'));
    if (!event) {
      safeEnd(socket, JSON.stringify({ error: 'parse_failed' }));
      return;
    }
    try {
      switch (routeKind(event)) {
        case 'permission': {
          const decision = await onPermission(event);
          safeEnd(socket, permissionResponse(decision, event));
          break;
        }
        case 'askUserQuestion': {
          const response = await onAskUserQuestion(event);
          safeEnd(socket, response ? JSON.stringify(response) : permissionResponse('deny'));
          break;
        }
        case 'question': {
          const answer = await onQuestion(event);
          safeEnd(socket, answer ? JSON.stringify(answer) : '{}');
          break;
        }
        default:
          onEvent(event);
          safeEnd(socket, '{}');
      }
    } catch (err) {
      safeEnd(socket, '{}');
    }
  }

  function safeEnd(socket, payload) {
    try { socket.end(payload); } catch { /* socket already gone */ }
  }

  return {
    pipe,
    start() {
      let retriedStaleSocket = false;
      const startOnce = () => new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('error', onError);
          // Unix sockets leave a stale file behind after a crash; unlink it
          // and retry once. (Windows named pipes never hit this path.)
          if (!retriedStaleSocket && err && err.code === 'EADDRINUSE'
            && typeof pipe === 'string' && !pipe.startsWith('\\\\')) {
            retriedStaleSocket = true;
            try { fs.unlinkSync(pipe); } catch { /* nothing to unlink */ }
            startOnce().then(resolve, reject);
            return;
          }
          reject(err);
        };
        server.once('error', onError);
        server.listen(pipe, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      return startOnce();
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createHookServer, routeKind };
