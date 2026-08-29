'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionBindings, deriveScopeKey } = require('../src/core/session-bindings');

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bindings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state', 'session-bindings.json');
}

test('deriveScopeKey separates P2P, group mainline, thread, and account scopes', () => {
  assert.strictEqual(deriveScopeKey({ chatType: 'p2p', chatId: 'oc_dm', senderId: 'ou_a' }), 'default:p2p:ou_a');
  assert.strictEqual(deriveScopeKey({ chatType: 'group', chatId: 'oc_g', senderId: 'ou_a' }), 'default:group:oc_g:ou_a');
  assert.strictEqual(deriveScopeKey({ chatType: 'group', chatId: 'oc_g', senderId: 'ou_a', threadId: 'omt_t' }), 'default:thread:oc_g:omt_t');
  assert.strictEqual(deriveScopeKey({ chatType: 'p2p', chatId: 'oc_dm', senderId: 'ou_a' }, 'work'), 'work:p2p:ou_a');
});

test('SessionBindings.resolve persists the fallback and bind survives restart', async (t) => {
  const filePath = tempFile(t);
  const first = new SessionBindings({ filePath });

  assert.strictEqual(await first.resolve('default:p2p:ou_a', 'feishu-ou-a'), 'feishu-ou-a');
  await first.bind('default:p2p:ou_a', 'shared-session');

  const second = new SessionBindings({ filePath });
  assert.strictEqual(await second.resolve('default:p2p:ou_a', 'unused'), 'shared-session');
  assert.deepStrictEqual(await second.entries(), [{ scopeKey: 'default:p2p:ou_a', sessionId: 'shared-session' }]);
});

test('SessionBindings.unbind restores the caller-provided fallback', async (t) => {
  const bindings = new SessionBindings({ filePath: tempFile(t) });
  await bindings.bind('default:p2p:ou_a', 'shared-session');
  assert.strictEqual(await bindings.unbind('default:p2p:ou_a'), true);
  assert.strictEqual(await bindings.resolve('default:p2p:ou_a', 'fresh-session'), 'fresh-session');
});

test('SessionBindings allows privileged controls only for configured senders', () => {
  const bindings = new SessionBindings({
    filePath: '/unused/session-bindings.json',
    controlAllowFrom: ['ou_owner', 'ou_admin'],
  });

  assert.strictEqual(bindings.isAuthorized('ou_owner'), true);
  assert.strictEqual(bindings.isAuthorized('ou_other'), false);
  assert.strictEqual(new SessionBindings({ filePath: '/unused/empty.json' }).isAuthorized('ou_owner'), false);
});

test('SessionBindings rejects a corrupt state file instead of silently losing bindings', async (t) => {
  const filePath = tempFile(t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const bindings = new SessionBindings({ filePath });

  await assert.rejects(bindings.entries(), /会话绑定文件无效/);
});
