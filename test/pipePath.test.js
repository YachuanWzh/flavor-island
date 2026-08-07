'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pipePath } = require('../src/core/pipePath');

test('pipePath returns per-user named pipe on win32', () => {
  assert.equal(pipePath({ USERNAME: 'alice' }, 'win32'), '\\\\.\\pipe\\codeisland-alice');
});

test('pipePath falls back to USER then default', () => {
  assert.equal(pipePath({ USER: 'bob' }, 'win32'), '\\\\.\\pipe\\codeisland-bob');
  assert.equal(pipePath({}, 'win32'), '\\\\.\\pipe\\codeisland-default');
});

test('pipePath honors CODEISLAND_PIPE override on win32', () => {
  assert.equal(
    pipePath({ CODEISLAND_PIPE: '\\\\.\\pipe\\custom' }, 'win32'),
    '\\\\.\\pipe\\custom'
  );
  assert.equal(
    pipePath({ CODEISLAND_PIPE: '   ', USERNAME: 'alice' }, 'win32'),
    '\\\\.\\pipe\\codeisland-alice'
  );
});

test('pipePath returns per-uid unix socket on darwin', () => {
  assert.equal(pipePath({}, 'darwin', 501), '/tmp/codeisland-501.sock');
});

test('pipePath honors CODEISLAND_SOCKET_PATH override on darwin', () => {
  assert.equal(
    pipePath({ CODEISLAND_SOCKET_PATH: '/tmp/custom.sock' }, 'darwin', 501),
    '/tmp/custom.sock'
  );
  assert.equal(
    pipePath({ CODEISLAND_SOCKET_PATH: '  ' }, 'darwin', 0),
    '/tmp/codeisland-0.sock'
  );
});

test('pipePath defaults follow the host platform', () => {
  const value = pipePath({ USERNAME: 'alice', USER: 'alice' });
  if (process.platform === 'win32') {
    assert.equal(value, '\\\\.\\pipe\\codeisland-alice');
  } else {
    assert.match(value, /^\/tmp\/codeisland-\d+\.sock$/);
  }
});
