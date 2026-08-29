'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { startSharedHost, settleSessionRun } = require('../src/core/bridge-runtime');

test('startSharedHost starts and returns the configured control service', async () => {
  let started = 0;
  const control = { start: async () => { started += 1; } };

  const result = await startSharedHost({ dshApiUrl: 'http://127.0.0.1:3080' }, () => {}, () => control);

  assert.strictEqual(result, control);
  assert.strictEqual(started, 1);
});

test('startSharedHost keeps legacy mode when shared-host mode is disabled', async () => {
  const result = await startSharedHost({ dshApiUrl: '' }, () => {}, () => null);
  assert.strictEqual(result, null);
});

test('startSharedHost fails back to legacy mode and redacts startup errors', async () => {
  let stopped = 0;
  const logs = [];
  const control = {
    start: async () => { throw new Error('login failed with private-value'); },
    stop: () => { stopped += 1; },
  };

  const result = await startSharedHost(
    { dshApiUrl: 'http://127.0.0.1:3080', dshApiPassword: 'private-value' },
    (line) => logs.push(line),
    () => control
  );

  assert.strictEqual(result, null);
  assert.strictEqual(stopped, 1);
  assert.match(logs.join('\n'), /共享 Session 模式启动失败/);
  assert.doesNotMatch(logs.join('\n'), /private-value/);
});

test('settleSessionRun preserves the fallback session id when a run times out', async () => {
  assert.strictEqual(typeof settleSessionRun, 'function');
  const logs = [];

  const result = await settleSessionRun(
    Promise.reject(new Error('DSH response timed out')),
    'feishu-ou_owner',
    (line) => logs.push(line)
  );

  assert.deepStrictEqual(result, {
    reply: '',
    sessionId: 'feishu-ou_owner',
    tools: [],
    thinking: '',
  });
  assert.match(logs.join('\n'), /DSH response timed out/);
});
