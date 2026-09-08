'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { DshControl } = require('../src/core/dsh-control');

/** 模拟 0.1.2 Gateway wire 客户端：unary call + 可注入帧的 follow 流。 */
class FakeApi {
  constructor() {
    this.calls = [];
    this.streams = [];
    this.ensureAuthCount = 0;
    this.promptRequestId = null;
  }

  async ensureAuth() {
    this.ensureAuthCount += 1;
  }

  async openStream(endpoint, args, handlers) {
    this.streams.push({ endpoint, args, handlers });
    return {
      streamId: `stream-${this.streams.length}`,
      close: () => {},
    };
  }

  closeStreams() {
    this.closedStreams = true;
  }

  async call(method, args, options = {}) {
    this.calls.push({ method, args, options });
    if (method === 'session/list') return { rpcId: options.rpcId || 'list', value: { items: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }] } };
    if (method === 'session/create') return { rpcId: options.rpcId || 'create', value: { sessionId: 'session-new' } };
    if (method === 'session/models') throw Object.assign(new Error('not found'), { code: '404' });
    if (method === 'session/selectModel') {
      const request = args.request;
      return { rpcId: options.rpcId || 'select', value: { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } } };
    }
    if (method === 'session/prompt') {
      this.promptRequestId = args.request.requestId;
      return { rpcId: options.rpcId, value: { accepted: true } };
    }
    if (method === 'commands/execute') return { rpcId: options.rpcId || 'cmd', value: { result: { kind: 'success', text: '已压缩' } } };
    throw new Error(`unexpected method ${method}`);
  }

  /** 把 journal 帧喂进指定会话的 follow 流。 */
  emitItem(value) {
    this.streams.at(-1).handlers.onItem(value);
  }

  emitError(error) {
    this.streams.at(-1).handlers.onError(error);
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

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function journalEvent(type, data) {
  return { type: 'event', event: { type, data } };
}

test('DshControl resolves and switches the shared session only for an authorized sender', async () => {
  const control = new DshControl({ api: new FakeApi(), bindings: fakeBindings() });
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
  const control = new DshControl({ api: new FakeApi(), bindings: fakeBindings() });
  const message = { chatType: 'p2p', senderId: 'ou_owner', chatId: 'oc_dm' };

  assert.strictEqual(control.isAuthorized('ou_owner'), true);
  assert.strictEqual(control.isAuthorized('ou_other'), false);
  assert.strictEqual(await control.bindSession(message, 'default', 'session-new'), 'session-new');
  assert.strictEqual(await control.resolveSession(message, 'default', 'fallback'), 'session-new');
});

test('DshControl maps session controls onto the 0.1.2 Gateway wire methods and arg shapes', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings() });

  assert.strictEqual((await control.listSessions()).length, 2);
  assert.strictEqual(await control.createSession({ cwd: '/workspace' }), 'session-new');
  const models = await control.models('session-a');
  assert.strictEqual(models.groups.length, 0);
  assert.deepStrictEqual(
    await control.selectModel('session-a', { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }),
    { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' }
  );
  assert.deepStrictEqual(api.calls.map((call) => call.method), [
    'session/list', 'session/create', 'session/models', 'session/selectModel',
  ]);
  assert.deepStrictEqual(api.calls[0].args, { _request: {} });
  assert.deepStrictEqual(api.calls[1].args, { request: { cwd: '/workspace' } });
  assert.deepStrictEqual(api.calls[3].args.request, {
    sessionId: 'session-a', provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high',
  });
});

test('DshControl.prompt 走 session/follow + requestId 归因并流式收集文本', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 1000 });
  await control.start();
  assert.strictEqual(api.ensureAuthCount, 1);
  const chunks = [];

  const prompt = control.prompt('session-a', '你好', { onDelta: (text) => chunks.push(text) });
  await flush();

  // 打开的是 0.1.2 的 session/follow 流，请求带 address/maxMessages。
  assert.strictEqual(api.streams.length, 1);
  assert.strictEqual(api.streams[0].endpoint, 'session/follow');
  assert.deepStrictEqual(api.streams[0].args.request.address, { kind: 'session', sessionId: 'session-a' });

  // 快照里别人的消息不应归因到本 prompt。
  api.emitItem({
    type: 'snapshot',
    records: [{ type: 'event', event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'someone-else' } } } }],
  });
  api.emitItem(journalEvent('turn/start', { turn: 3 }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem(journalEvent('assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', text: '你' } }));
  api.emitItem(journalEvent('assistant/chunk', { turn: 3, step: 1, chunk: { type: 'text-delta', text: '好' } }));
  api.emitItem(journalEvent('turn/end', { turn: 3, reason: { kind: 'completed' } }));

  assert.deepStrictEqual(await prompt, { text: '你好', command: false });
  assert.deepStrictEqual(chunks, ['你', '好']);

  const promptCall = api.calls.find((call) => call.method === 'session/prompt');
  assert.strictEqual(promptCall.method, 'session/prompt');
  assert.deepStrictEqual(promptCall.args.request, {
    requestId: 'request-1',
    sessionId: 'session-a',
    mode: 'queue',
    content: [{ type: 'text', text: '你好' }],
  });
});

test('DshControl.prompt 只消费归因 turn 的事件并忽略其它 turn', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 1000 });
  await control.start();
  const chunks = [];

  const prompt = control.prompt('session-a', '你好', { onDelta: (text) => chunks.push(text) });
  await flush();

  api.emitItem(journalEvent('turn/start', { turn: 1 }));
  api.emitItem(journalEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: '别的turn' } }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem(journalEvent('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish' } }));
  api.emitItem(journalEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }));

  assert.deepStrictEqual(await prompt, { text: '', command: false });
  assert.deepStrictEqual(chunks, []);
});

test('DshControl.prompt 在 turn 失败且无输出时以错误收尾', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 1000 });
  await control.start();

  const prompt = control.prompt('session-a', '你好', {});
  await flush();
  api.emitItem(journalEvent('turn/start', { turn: 1 }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem(journalEvent('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'no API key' } } }));

  await assert.rejects(prompt, /no API key/);
});

test('DshControl.prompt 在 follow 流断开时拒绝未完成的调用', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 5000 });
  await control.start();

  const prompt = control.prompt('session-a', '你好', {});
  await flush();
  api.emitError(Object.assign(new Error('boom'), { code: 'disconnected' }));

  await assert.rejects(prompt, /boom/);
});

test('DshControl.stop 拒绝未完成调用并关闭底层流', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), promptTimeoutMs: 5000 });
  await control.start();

  const prompt = control.prompt('session-a', '你好', {});
  await flush();
  control.stop();

  await assert.rejects(prompt, /已停止/);
  assert.strictEqual(api.closedStreams, true);
});

test('DshControl.answerApproval 在 0.1.2 wire 上明确不支持', async () => {
  const control = new DshControl({ api: new FakeApi(), bindings: fakeBindings() });
  await assert.rejects(control.answerApproval({}), /不透传交互审批/);
});

test('DshControl.executeCommand 走 commands/execute 并返回结果文本', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings() });
  const result = await control.executeCommand('session-a', '/compact');
  assert.deepStrictEqual(result, { kind: 'success', text: '已压缩' });
  assert.deepStrictEqual(api.calls.at(-1).args, { agentId: 'session-a', line: '/compact', images: [] });
});

test('DshControl.executeCommand 在 0.1.3 参数名下自适应重试', async () => {
  const api = new FakeApi();
  // 0.1.3 起拒绝 images，要求 submittedAttachments。
  api.call = async function (method, args, options = {}) {
    this.calls.push({ method, args, options });
    if (method === 'commands/execute') {
      if (args.images !== undefined) {
        throw Object.assign(new Error('typert gateway: commands/execute: missing "submittedAttachments"; unexpected "images"'), { code: 'gateway/arguments-invalid' });
      }
      return { rpcId: options.rpcId || 'cmd', value: { result: { kind: 'success', text: '已压缩' } } };
    }
    return FakeApi.prototype.call.call(this, method, args, options);
  };
  const control = new DshControl({ api, bindings: fakeBindings() });
  const result = await control.executeCommand('session-a', '/compact');
  assert.deepStrictEqual(result, { kind: 'success', text: '已压缩' });
  assert.strictEqual(api.calls.length, 2);
  assert.deepStrictEqual(api.calls[0].args, { agentId: 'session-a', line: '/compact', images: [] });
  assert.deepStrictEqual(api.calls[1].args, { agentId: 'session-a', line: '/compact', submittedAttachments: [] });
});

test('DshControl follows 在 Host 拒绝 assistantStream 时自适应降级重开', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 5000 });
  await control.start();

  // 模拟 0.1.2：带 assistantStream 的开流请求立刻被 Host 报参数错误。
  const originalOpen = api.openStream.bind(api);
  api.openStream = async function (endpoint, args, handlers) {
    const handle = await originalOpen(endpoint, args, handlers);
    if (args.request.assistantStream) {
      queueMicrotask(() => handlers.onError(Object.assign(
        new Error('typert gateway: session/follow: unexpected "assistantStream"'),
        { code: 'gateway/input-invalid' }
      )));
    }
    return handle;
  };

  const prompt = control.prompt('session-a', '你好', {});
  await flush();
  await flush();

  // 首开带 assistantStream 被拒 → 已记忆并以普通参数重开。
  assert.strictEqual(api.streams[0].args.request.assistantStream, true);
  assert.strictEqual(api.streams.length, 2);
  assert.strictEqual(api.streams[1].args.request.assistantStream, undefined);

  // prompt 在重开的普通流上照常完成归因与收尾。
  api.emitItem(journalEvent('turn/start', { turn: 1 }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem(journalEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  assert.deepStrictEqual(await prompt, { text: '', command: false });
});

test('DshControl consumes 0.1.3 assistant-stream presentation frames as typing deltas', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 5000 });
  await control.start();
  const chunks = [];

  const prompt = control.prompt('session-a', '数到三', { onDelta: (text) => chunks.push(text) });
  await flush();

  api.emitItem(journalEvent('turn/start', { turn: 1 }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'session-a:1', turn: 1, step: 1 } });
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'reasoning-delta', text: '思考' } } });
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'text-delta', text: '一' } } });
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'text-delta', text: '二' } } });
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'session-a:1', chunk: { type: 'text-delta', text: '三' } } });
  api.emitItem(journalEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }));

  assert.deepStrictEqual(await prompt, { text: '一二三', command: false });
  assert.deepStrictEqual(chunks, ['一', '二', '三']);
});

test('DshControl 思考/工具阶段上报执行状态，思考正文不进入回复', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), rpcIdFactory: () => 'request-1', promptTimeoutMs: 5000 });
  await control.start();
  const statuses = [];
  const chunks = [];

  const prompt = control.prompt('session-a', '查一下', {
    onDelta: (text) => chunks.push(text),
    onStatus: (status) => statuses.push(status),
  });
  await flush();

  api.emitItem(journalEvent('turn/start', { turn: 1 }));
  api.emitItem(journalEvent('user/message', { source: { kind: 'user', rpcId: 'request-1' } }));
  api.emitItem({ type: 'assistant-stream', frame: { type: 'start', turn: 1, step: 1 } });
  // 连续 reasoning 增量: 状态被节流, 且思考文本不进回复
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '思考A' } } });
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '思考B' } } });
  api.emitItem(journalEvent('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash' }));
  await new Promise((r) => setTimeout(r, 3100)); // 越过节流窗口
  api.emitItem({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '思考C' } } });
  api.emitItem(journalEvent('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'fs' }));
  api.emitItem(journalEvent('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'text-delta', text: '答案是' } }));
  api.emitItem(journalEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }));

  assert.deepStrictEqual(await prompt, { text: '答案是', command: false });
  assert.deepStrictEqual(chunks, ['答案是']);
  const thinkingCount = statuses.filter((s) => s.kind === 'thinking').length;
  assert.strictEqual(thinkingCount, 3); // start 帧 + 首个增量 + 节流窗口后一次
  assert.deepStrictEqual(
    statuses.filter((s) => s.kind === 'tool').map((s) => s.name),
    ['bash', 'fs']
  );
});

test('DshControl.executeCommand 非参数名错误直接上抛', async () => {
  const api = new FakeApi();
  api.call = async function (method, args = {}, options = {}) {
    this.calls.push({ method, args, options });
    if (method === 'commands/execute') throw Object.assign(new Error('session gone'), { code: 'session-not-found' });
    return FakeApi.prototype.call.call(this, method, args, options);
  };
  const control = new DshControl({ api, bindings: fakeBindings() });
  await assert.rejects(control.executeCommand('session-a', '/compact'), /session gone/);
  assert.strictEqual(api.calls.length, 1);
});

test('DshControl.lastOutput 从 follow 快照提取最后一条助手输出', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), promptTimeoutMs: 5000 });
  await control.start();

  const pending = control.lastOutput('session-a');
  await flush();
  // 快照: 倒序找到最后一条 assistant/message 的文本
  api.emitItem({
    type: 'snapshot',
    records: [
      { type: 'event', event: { type: 'user/message', data: { source: { kind: 'user' } } } },
      { type: 'event', event: { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '之前的回答' }] } } } },
      { type: 'event', event: { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '最新的回答' }] } } } },
    ],
  });

  assert.strictEqual(await pending, '最新的回答');
  // 快照拿到即断开临时流
  assert.strictEqual(api.closedStreams, undefined);
});

test('DshControl.lastOutput 无助手消息时返回空串', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), promptTimeoutMs: 5000 });
  await control.start();

  const pending = control.lastOutput('session-empty');
  await flush();
  api.emitItem({ type: 'snapshot', records: [{ type: 'event', event: { type: 'user/message', data: { source: { kind: 'user' } } } }] });

  assert.strictEqual(await pending, '');
});

test('DshControl.lastOutput 流错误时拒绝', async () => {
  const api = new FakeApi();
  const control = new DshControl({ api, bindings: fakeBindings(), promptTimeoutMs: 5000 });
  await control.start();

  const pending = control.lastOutput('session-x');
  await flush();
  api.emitError(Object.assign(new Error('boom'), { code: 'gateway/input-invalid' }));

  await assert.rejects(pending, /boom/);
});
