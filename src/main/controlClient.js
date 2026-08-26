'use strict';

const net = require('node:net');

const MAX_RESPONSE = 64 * 1024;

function sendControlCommand({ endpoint, token, command, message }, timeoutMs = 4000) {
  if (typeof endpoint !== 'string' || !endpoint || typeof token !== 'string' || !token) {
    return Promise.reject(new Error('This session does not expose desktop controls'));
  }
  if (!['abort', 'steer', 'follow_up', 'focus'].includes(command)) {
    return Promise.reject(new Error('Unsupported session command'));
  }
  if ((command === 'steer' || command === 'follow_up') && (typeof message !== 'string' || !message.trim())) {
    return Promise.reject(new Error('Message is required'));
  }

  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let response = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Session control timed out')), timeoutMs);
    if (timer.unref) timer.unref();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already closed */ }
      if (error) reject(error); else resolve(value);
    }

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token, command, ...(message ? { message: message.slice(0, 100000) } : {}) })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > MAX_RESPONSE) finish(new Error('Session control response is too large'));
    });
    socket.on('end', () => {
      try {
        const parsed = JSON.parse(response || '{}');
        if (parsed.ok === true) finish(null, parsed);
        else finish(new Error(typeof parsed.error === 'string' ? parsed.error : 'Session control failed'));
      } catch {
        finish(new Error('Invalid session control response'));
      }
    });
    socket.on('error', (error) => finish(error));
  });
}

module.exports = { sendControlCommand };
