'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHash, createHmac } = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  DshApiClient,
  DshApiError,
  mintSessionCookie,
  parseCredentialsSecret,
  sessionCookieName,
} = require('../src/core/dsh-api-client');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

test('DshApiClient.call 发送 Gateway wire 信封并返回业务值', async (t) => {
  let received;
  let seenUrl;
  const server = await startServer(async (request, response) => {
    seenUrl = request.url;
    received = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: received.rpcId,
      result: { ok: true, value: { items: [{ id: 'session-1' }] } },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({ baseUrl: server.baseUrl });
  const result = await client.call('session/list', { _request: {} }, { rpcId: 'caller-rpc' });

  assert.strictEqual(received.type, 'client-request');
  assert.strictEqual(received.method, 'session/list');
  assert.deepStrictEqual(received.payload, { args: { _request: {} } });
  assert.strictEqual(received.rpcId, 'caller-rpc');
  assert.strictEqual(seenUrl, '/api/session/list');
  assert.deepStrictEqual(result.value, { items: [{ id: 'session-1' }] });
});

test('DshApiClient.call 用凭据文件铸造的 Cookie 通过 0.1.2 认证栅栏', async (t) => {
  let seenCookie;
  let seenAuthExchange = false;
  const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const server = await startServer(async (request, response) => {
    if (request.url.startsWith('/?token=')) {
      seenAuthExchange = true;
      response.statusCode = 303;
      response.end();
      return;
    }
    seenCookie = request.headers.cookie;
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [] } },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({
    baseUrl: server.baseUrl,
    dshHome: '/fake-home',
    readCredentialsFile: () => [
      'version: 1',
      'records:',
      '  other/record:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      secret: NOTTHES3CRETNOTTHES3CRETNOTTHES3CRET',
      `  client-connection/browser-session:`,
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${secret}`,
      '',
    ].join('\n'),
  });
  await client.call('session/list', { _request: {} });

  // 认证离线完成：没有发生 token 交换，Cookie 名与铸造公式一致且可被同公式验证。
  assert.strictEqual(seenAuthExchange, false);
  const authority = new URL(server.baseUrl).host;
  const expectedName = sessionCookieName(authority);
  assert.match(seenCookie, new RegExp(`^${expectedName}=v1\\.`));

  const [, body, signature] = seenCookie.split('=')[1].split('.');
  const expectedSignature = createHmac('sha256', Buffer.from(secret, 'base64')).update(body).digest().toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
  assert.strictEqual(signature, expectedSignature);
  const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  assert.strictEqual(payload.authority, authority);
  assert.strictEqual(payload.version, 1);
});

test('DshApiClient.call 在 401 后用 launch token 交换 Cookie 并重试一次', async (t) => {
  const seen = [];
  const server = await startServer(async (request, response) => {
    seen.push({ url: request.url, cookie: request.headers.cookie || '' });

    if (request.url.startsWith('/?token=')) {
      response.statusCode = 303;
      response.setHeader('set-cookie', 'dsh-auth-abc=v1.body.sig; HttpOnly; Path=/');
      response.end();
      return;
    }

    if (request.headers.cookie !== 'dsh-auth-abc=v1.body.sig') {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }

    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [] } },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({ baseUrl: server.baseUrl, token: 'launch-token' });
  await client.call('session/list', { _request: {} });

  // call() 先预认证（token 交换），首个 unary 即携带 Cookie，无需 401 重试。
  assert.strictEqual(seen.length, 2);
  assert.match(seen[0].url, /^\//);
  assert.ok(seen[0].url.includes('token=launch-token'));
  assert.strictEqual(seen[1].url, '/api/session/list');
  assert.strictEqual(seen[1].cookie, 'dsh-auth-abc=v1.body.sig');
});

test('DshApiClient.converts a DSH business failure into DshApiError', async (t) => {
  const server = await startServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: false,
        error: { code: 'gateway/arguments-invalid', message: 'missing "request"', details: {} },
      },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({ baseUrl: server.baseUrl });
  await assert.rejects(
    client.call('session/prompt', { request: {} }),
    (error) => error instanceof DshApiError && error.code === 'gateway/arguments-invalid'
  );
});

test('DshApiClient 账号密码登录路由不存在（404）时落到凭据铸造', async (t) => {
  const server = await startServer(async (request, response) => {
    const body = await readJson(request);
    if (request.url === '/api/auth/login') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    // 核心 0.1.2+ 栅栏：只认铸造格式的 Cookie（dsh-auth- 前缀）。
    if (!request.headers.cookie || !request.headers.cookie.startsWith('dsh-auth-')) {
      response.statusCode = 401;
      response.end('unauthorized');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: { ok: true, value: { items: [] } },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({
    baseUrl: server.baseUrl,
    dshHome: '/fake-home',
    username: 'bridge',
    password: 'stale-value',
    readCredentialsFile: () => `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${'A'.repeat(43)}\n`,
    log: (m) => logs.push(m),
  });
  // 登录路由 404 后自动落回凭据铸造，请求成功。
  await client.call('session/list', { _request: {} });
  assert.ok(client.cookie.startsWith('dsh-auth-'));
});

test('DshApiClient.openStream 复用一条 mux 连接、路由 item/error 并在 close 时发送 cancel', async (t) => {
  let opened;
  const sent = [];
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      opened = this;
      opened.url = url;
      opened.options = options;
      this.readyState = 1;
      queueMicrotask(() => this.emit('open'));
    }
    send(text) {
      sent.push(JSON.parse(text));
    }
    close() {
      this.emit('close');
    }
  }

  const client = new DshApiClient({
    baseUrl: 'http://127.0.0.1:3081',
    dshHome: '/fake-home',
    readCredentialsFile: () => `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${'A'.repeat(43)}\n`,
    webSocketFactory: (url, options) => new FakeSocket(url, options),
  });

  const items = [];
  const errors = [];
  const first = await client.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 'session-a' } } }, {
    onItem: (value) => items.push(value),
    onError: (error) => errors.push(error),
  });
  const second = await client.openStream('session/follow', { request: { address: { kind: 'session', sessionId: 'session-b' } } }, {
    onItem: () => {},
    onError: (error) => errors.push(error),
  });

  // 同一条连接，两条 open 帧。
  assert.match(opened.url, /^ws:\/\/127\.0\.0\.1:3081\/api\/remote\.mux$/);
  assert.strictEqual(opened.options.headers.cookie.startsWith('dsh-auth-'), true);
  assert.strictEqual(sent.length, 2);
  assert.strictEqual(sent[0].type, 'open');
  assert.strictEqual(sent[0].endpoint, 'session/follow');
  assert.deepStrictEqual(sent[0].payload, { args: { request: { address: { kind: 'session', sessionId: 'session-a' } } } });
  assert.notStrictEqual(sent[1].streamId, sent[0].streamId);

  const socket = opened;
  socket.emit('message', Buffer.from(JSON.stringify({
    type: 'item',
    streamId: first.streamId,
    value: { type: 'event', event: { type: 'turn/start', data: { turn: 1 } } },
  })));
  assert.deepStrictEqual(items, [{ type: 'event', event: { type: 'turn/start', data: { turn: 1 } } }]);

  opened.emit('message', Buffer.from(JSON.stringify({
    type: 'error',
    streamId: second.streamId,
    error: { code: 'gateway/input-invalid', message: 'bad follow' },
  })));
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, 'gateway/input-invalid');

  first.close();
  assert.deepStrictEqual(sent.at(-1), { type: 'cancel', streamId: first.streamId });
  opened.emit('message', Buffer.from(JSON.stringify({
    type: 'item',
    streamId: first.streamId,
    value: { type: 'event', event: { type: 'turn/end' } },
  })));
  assert.strictEqual(items.length, 1);

  client.closeStreams();
  assert.strictEqual(client.socket, null);
});

test('DshApiClient 底层连接断开时通知所有存活流', async (t) => {
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send() {}
    close() {
      this.emit('close');
    }
  }
  const client = new DshApiClient({
    baseUrl: 'http://127.0.0.1:3081',
    dshHome: '/fake-home',
    readCredentialsFile: () => `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${'A'.repeat(43)}\n`,
    webSocketFactory: () => new FakeSocket(),
  });

  const errors = [];
  await client.openStream('session/follow', { request: {} }, { onError: (error) => errors.push(error) });
  client.socket.emit('close');

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].code, 'disconnected');
});

test('parseCredentialsSecret 只提取目标记录的 secret', () => {
  const text = [
    'version: 1',
    'records:',
    '  other/record:',
    '    payload:',
    '      secret: WRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONG',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: R1GHTR1GHTR1GHTR1GHTR1GHTR1GHTR1GHTR1GHT',
  ].join('\n');
  assert.strictEqual(parseCredentialsSecret(text), 'R1GHTR1GHTR1GHTR1GHTR1GHTR1GHTR1GHTR1GHT');
  assert.strictEqual(parseCredentialsSecret('version: 1\nrecords: {}\n'), undefined);
});

test('mintSessionCookie 产出与 dsh browser-auth 相同的 Cookie 结构', () => {
  const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { cookie, expiresAt } = mintSessionCookie('127.0.0.1:3081', secret, 1000, 2000);
  const [name, value] = cookie.split('=');
  assert.strictEqual(name, sessionCookieName('127.0.0.1:3081'));
  assert.strictEqual(expiresAt, 3000);
  const [version, body, signature] = value.split('.');
  assert.strictEqual(version, 'v1');
  const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  assert.deepStrictEqual(payload, { version: 1, authority: '127.0.0.1:3081', issuedAt: 1000, expiresAt: 3000 });
  const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(body).digest();
  assert.ok(expected.byteLength > 0);
  assert.strictEqual(Buffer.from(signature, 'base64').equals(expected), true);
});
