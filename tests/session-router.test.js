'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { runSession } = require('../src/core/session-router');

const config = { dshHome: '/unused' };
const message = { chatType: 'p2p', senderId: 'ou_owner', chatId: 'oc_dm' };

test('session router resolves the binding and streams through the shared DSH host', async () => {
  const seen = { deltas: [] };
  const control = {
    resolveSession: async (msg, accountId, fallback) => {
      seen.resolve = { msg, accountId, fallback };
      return 'session-b';
    },
    prompt: async (sessionId, prompt, handlers) => {
      seen.prompt = { sessionId, prompt };
      handlers.onDelta('共享');
      handlers.onDelta('回复');
      return { text: '共享回复', command: false };
    },
  };
  const legacyRun = async () => { throw new Error('legacy runner should not execute'); };

  const result = await runSession(
    config,
    message,
    '测试消息',
    () => {},
    'default',
    (text) => seen.deltas.push(text),
    { control, legacyRun }
  );

  assert.strictEqual(seen.resolve.fallback, 'feishu-ou-owner');
  assert.deepStrictEqual(seen.prompt, { sessionId: 'session-b', prompt: '测试消息' });
  assert.deepStrictEqual(seen.deltas, ['共享', '回复']);
  assert.deepStrictEqual(result, {
    reply: '共享回复',
    sessionId: 'session-b',
    tools: [],
    thinking: '',
  });
});

test('session router preserves the existing subprocess runner when shared-host mode is disabled', async () => {
  let received;
  const legacyResult = { reply: '旧回复', sessionId: 'legacy-session', tools: [], thinking: '' };
  const legacyRun = async (...args) => {
    received = args;
    return legacyResult;
  };
  const log = () => {};
  const onDelta = () => {};

  const result = await runSession(config, message, '测试消息', log, 'default', onDelta, { legacyRun });

  assert.strictEqual(result, legacyResult);
  assert.deepStrictEqual(received, [config, message, '测试消息', log, 'default', onDelta]);
});
