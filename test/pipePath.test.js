'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pipePath } = require('../src/core/pipePath');

test('pipePath returns per-user named pipe on win32', () => {
  assert.equal(pipePath({ USERNAME: 'alice' }, 'win32'), '\\\\.\\pipe\\flavor-island-alice');
});

test('pipePath falls back to USER then default', () => {
  assert.equal(pipePath({ USER: 'bob' }, 'win32'), '\\\\.\\pipe\\flavor-island-bob');
  assert.equal(pipePath({}, 'win32'), '\\\\.\\pipe\\flavor-island-default');
});

test('pipePath honors only the Flavor Island override on win32', () => {
  assert.equal(
    pipePath({ FLAVOR_ISLAND_PIPE: '\\\\.\\pipe\\custom' }, 'win32'),
    '\\\\.\\pipe\\custom'
  );
  assert.equal(
    pipePath({ FLAVOR_ISLAND_PIPE: '   ', CODEISLAND_PIPE: '\\\\.\\pipe\\other', USERNAME: 'alice' }, 'win32'),
    '\\\\.\\pipe\\flavor-island-alice'
  );
});

test('pipePath returns per-uid unix socket on darwin', () => {
  assert.equal(pipePath({}, 'darwin', 501), '/tmp/flavor-island-501.sock');
});

test('pipePath honors only the Flavor Island override on darwin', () => {
  assert.equal(
    pipePath({ FLAVOR_ISLAND_SOCKET_PATH: '/tmp/custom.sock' }, 'darwin', 501),
    '/tmp/custom.sock'
  );
  assert.equal(
    pipePath({ FLAVOR_ISLAND_SOCKET_PATH: '  ', CODEISLAND_SOCKET_PATH: '/tmp/other.sock' }, 'darwin', 0),
    '/tmp/flavor-island-0.sock'
  );
});

test('pipePath defaults follow the host platform', () => {
  const value = pipePath({ USERNAME: 'alice', USER: 'alice' });
  if (process.platform === 'win32') {
    assert.equal(value, '\\\\.\\pipe\\flavor-island-alice');
  } else {
    assert.match(value, /^\/tmp\/flavor-island-\d+\.sock$/);
  }
});
