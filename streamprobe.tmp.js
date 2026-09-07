'use strict';
const WebSocket = require('ws');
const crypto = require('node:crypto');
const { DshApiClient } = require('./src/core/dsh-api-client');

(async () => {
  const api = new DshApiClient({ baseUrl: 'http://127.0.0.1:3083', dshHome: '/Users/bhn/.dsh-013' });
  await api.ensureAuth();
  const created = await api.call('session/create', { request: {} });
  const sessionId = created.value.sessionId;

  const ws = await api._ensureSocket();
  const onFrame = (raw) => {
    let f; try { f = JSON.parse(raw.toString()); } catch { return; }
    if (f.type === 'item' && f.streamId === 's1') {
      const v = f.value || {};
      console.log('[item]', v.type, JSON.stringify(v).slice(0, 220));
    }
  };
  ws.on('message', onFrame);
  api._send(ws, { type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1, assistantStream: true } } } });
  await new Promise((r) => setTimeout(r, 1200));
  const requestId = crypto.randomUUID();
  await api.call('session/prompt', { request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: '数到三' }] } }).catch((e) => console.log('[prompt-err]', e.message));
  await new Promise((r) => setTimeout(r, 12000));
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
