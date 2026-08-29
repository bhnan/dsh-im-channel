'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { DshApiClient, DshApiError } = require('../src/core/dsh-api-client');

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

test('DshApiClient.call sends the DSH RPC envelope and preserves its rpcId', async (t) => {
  let received;
  const server = await startServer(async (request, response) => {
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
  const result = await client.call('session.list', { limit: 20 }, { rpcId: 'caller-rpc' });

  assert.strictEqual(received.type, 'client-request');
  assert.strictEqual(received.method, 'session.list');
  assert.deepStrictEqual(received.payload, { limit: 20 });
  assert.strictEqual(received.rpcId, 'caller-rpc');
  assert.strictEqual(result.rpcId, received.rpcId);
  assert.deepStrictEqual(result.value, { items: [{ id: 'session-1' }] });
});

test('DshApiClient logs in after 401, stores only the session cookie, and retries once', async (t) => {
  const seen = [];
  const server = await startServer(async (request, response) => {
    const body = await readJson(request);
    seen.push({ url: request.url, cookie: request.headers.cookie, body });

    if (request.url === '/api/auth/login') {
      assert.deepStrictEqual(body, { username: 'bridge', password: 'private-value' });
      response.statusCode = 200;
      response.setHeader('set-cookie', 'dsh_session=session-token; HttpOnly; Path=/; SameSite=Strict');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.headers.cookie !== 'dsh_session=session-token') {
      response.statusCode = 401;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'Authentication required' }));
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
    username: 'bridge',
    password: 'private-value',
  });
  await client.call('session.list', {});

  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[0].url, '/api/session.list');
  assert.strictEqual(seen[1].url, '/api/auth/login');
  assert.strictEqual(seen[2].cookie, 'dsh_session=session-token');
});

test('DshApiClient converts a DSH business failure into DshApiError', async (t) => {
  const server = await startServer(async (request, response) => {
    const body = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      type: 'server-response',
      rpcId: body.rpcId,
      result: {
        ok: false,
        error: { code: 'session-not-found', message: 'missing', details: { sessionId: 'gone' } },
      },
    }));
  });
  t.after(server.close);

  const client = new DshApiClient({ baseUrl: server.baseUrl });
  await assert.rejects(
    client.call('session.history', { sessionId: 'gone' }),
    (error) => error instanceof DshApiError && error.code === 'session-not-found' && error.message === 'missing'
  );
});

test('DshApiClient.respond sends a client-response envelope', async (t) => {
  let received;
  const server = await startServer(async (request, response) => {
    received = await readJson(request);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ accepted: true }));
  });
  t.after(server.close);

  const client = new DshApiClient({ baseUrl: server.baseUrl });
  const receipt = await client.respond('approval-rpc', {
    sessionId: 'session-1',
    approvalId: 'approval-1',
    outcome: 'allowed-once',
  });

  assert.strictEqual(received.type, 'client-response');
  assert.strictEqual(received.rpcId, 'approval-rpc');
  assert.deepStrictEqual(received.result, {
    ok: true,
    value: { sessionId: 'session-1', approvalId: 'approval-1', outcome: 'allowed-once' },
  });
  assert.deepStrictEqual(receipt, { accepted: true });
});

test('DshApiClient.connectMux authenticates the WebSocket and parses server requests', async (t) => {
  const server = await startServer(async (request, response) => {
    assert.strictEqual(request.url, '/api/auth/login');
    await readJson(request);
    response.setHeader('set-cookie', 'dsh_session=mux-token; HttpOnly; Path=/');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  t.after(server.close);

  let opened;
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      opened = { url, options };
      queueMicrotask(() => this.emit('open'));
    }
    close() {
      this.emit('close', 1000, Buffer.from('closed'));
    }
  }

  const frames = [];
  const client = new DshApiClient({
    baseUrl: server.baseUrl,
    username: 'bridge',
    password: 'private-value',
    webSocketFactory: (url, options) => new FakeSocket(url, options),
  });
  const connection = await client.connectMux({ onFrame: (frame) => frames.push(frame) });
  connection.socket.emit('message', Buffer.from(JSON.stringify({
    type: 'server-request',
    rpcId: 'event-1',
    method: 'session/event',
    payload: { sessionId: 'session-1', event: { type: 'assistant/chunk' } },
  })));

  assert.match(opened.url, /^ws:\/\/127\.0\.0\.1:\d+\/api\/events\.mux$/);
  assert.strictEqual(opened.options.headers.Cookie, 'dsh_session=mux-token');
  assert.deepStrictEqual(frames, [{
    rpcId: 'event-1',
    method: 'session/event',
    payload: { sessionId: 'session-1', event: { type: 'assistant/chunk' } },
  }]);
  connection.close();
});
