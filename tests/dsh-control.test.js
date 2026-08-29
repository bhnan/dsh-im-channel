'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { DshControl } = require('../src/core/dsh-control');

class FakeApi {
  constructor() {
    this.calls = [];
    this.responses = [];
    this.frames = null;
  }

  async connectMux(handlers) {
    this.frames = handlers;
    return { close() {} };
  }

  async call(method, payload, options = {}) {
    this.calls.push({ method, payload, options });
    if (method === 'session.list') return { rpcId: options.rpcId || 'list', value: { items: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] } };
    if (method === 'session.create') return { rpcId: options.rpcId || 'create', value: { sessionId: 'session-new' } };
    if (method === 'session.models') return { rpcId: options.rpcId || 'models', value: { current: { provider: 'deepseek', model: 'chat' }, groups: [], failures: [], routable: true } };
    if (method === 'session.selectModel') return { rpcId: options.rpcId || 'select', value: { selected: { provider: payload.provider, model: payload.model, reasoningEffort: payload.reasoningEffort } } };
    if (method === 'session.prompt') return { rpcId: options.rpcId, value: { accepted: true } };
    throw new Error(`unexpected method ${method}`);
  }

  async respond(rpcId, value) {
    this.responses.push({ rpcId, value });
    return { accepted: true };
  }

  emit(payload, rpcId = 'server-event') {
    this.frames.onFrame({ rpcId, method: payload.type, payload });
  }
}

function fakeBindings() {
  const values = new Map();
  return {
    isAuthorized: (senderId) => senderId === 'ou_owner',
    resolve: async (scopeKey, fallback) => values.get(scopeKey) || fallback,
    bind: async (scopeKey, sessionId) => { values.set(scopeKey, sessionId); return sessionId; },
  };
}

test('DshControl resolves and switches the shared session only for an authorized sender', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings() });
  const message = { chatType: 'p2p', senderId: 'ou_owner', chatId: 'oc_dm' };

  assert.strictEqual(await control.resolveSession(message, 'default', 'feishu-ou-owner'), 'feishu-ou-owner');
  assert.strictEqual(await control.switchSession(message, 'default', 'session-b'), 'session-b');
  assert.strictEqual(await control.resolveSession(message, 'default', 'unused'), 'session-b');

  await assert.rejects(
    control.switchSession({ ...message, senderId: 'ou_other' }, 'default', 'session-a'),
    /无权执行/
  );
});

test('DshControl exposes authorization and can bind a newly created session directly', async () => {
  const api = new FakeApi();
  const bindings = fakeBindings();
  const control = new DshControl({ api, bindings });
  const message = { chatType: 'p2p', senderId: 'ou_owner', chatId: 'oc_dm' };

  assert.strictEqual(control.isAuthorized('ou_owner'), true);
  assert.strictEqual(control.isAuthorized('ou_other'), false);
  assert.strictEqual(await control.bindSession(message, 'default', 'session-new'), 'session-new');
  assert.strictEqual(await control.resolveSession(message, 'default', 'fallback'), 'session-new');
});

test('DshControl maps session and model controls to official DSH RPC methods', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings() });

  assert.strictEqual((await control.listSessions()).length, 2);
  assert.strictEqual(await control.createSession({ cwd: '/workspace' }), 'session-new');
  assert.strictEqual((await control.models('session-a')).current.model, 'chat');
  assert.deepStrictEqual(
    await control.selectModel('session-a', { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }),
    { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }
  );
  assert.deepStrictEqual(api.calls.map((call) => call.method), [
    'session.list', 'session.create', 'session.models', 'session.selectModel',
  ]);
});

test('DshControl correlates prompt events, streams text, and completes at turn/end', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'prompt-rpc', promptTimeoutMs: 1000 });
  await control.start();
  const chunks = [];

  const prompt = control.prompt('session-a', '你好', { onDelta: (text) => chunks.push(text) });
  await new Promise((resolve) => setImmediate(resolve));
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'turn/start', data: { turn: 3 } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'someone-else' } } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'prompt-rpc' } } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'assistant/chunk', data: { turn: 3, step: 1, chunk: { type: 'text-delta', text: '你' } } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'assistant/chunk', data: { turn: 3, step: 1, chunk: { type: 'text-delta', text: '好' } } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } } });

  assert.deepStrictEqual(await prompt, { text: '你好', command: false });
  assert.deepStrictEqual(chunks, ['你', '好']);
  assert.strictEqual(api.calls.at(-1).options.rpcId, 'prompt-rpc');
});

test('DshControl forwards approvals for the active session and can answer them', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'prompt-rpc', promptTimeoutMs: 1000 });
  await control.start();
  const approvals = [];
  const prompt = control.prompt('session-a', '运行命令', { onApproval: (request) => approvals.push(request) });
  await new Promise((resolve) => setImmediate(resolve));

  api.emit({
    type: 'approval/requested',
    sessionId: 'session-a',
    approvalId: 'approval-1',
    toolName: 'bash',
    reason: 'needs permission',
  }, 'approval-rpc');
  assert.strictEqual(approvals[0].rpcId, 'approval-rpc');
  await control.answerApproval(approvals[0], 'allowed-once');

  assert.deepStrictEqual(api.responses, [{
    rpcId: 'approval-rpc',
    value: { sessionId: 'session-a', approvalId: 'approval-1', outcome: 'allowed-once' },
  }]);

  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'turn/start', data: { turn: 1 } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'user/message', data: { source: { rpcId: 'prompt-rpc' } } } });
  api.emit({ type: 'session/event', sessionId: 'session-a', event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } });
  await prompt;
});

test('DshControl returns official slash-command text without waiting for a turn', async () => {
  const api = new FakeApi();
  api.call = async (method, payload, options) => {
    api.calls.push({ method, payload, options });
    return { rpcId: options.rpcId, value: { accepted: true, command: { kind: 'success', text: 'Permission mode: workspace-write' } } };
  };
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'command-rpc' });

  assert.deepStrictEqual(await control.prompt('session-a', '/permission workspace-write'), {
    text: 'Permission mode: workspace-write',
    command: true,
  });
});
