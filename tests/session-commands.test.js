'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { handleSlashCommand, COMMANDS } = require('../src/commands/slash');

function createControl() {
  const state = { current: 'session-a', switched: [], created: 0 };
  return {
    state,
    isAuthorized: (senderId) => senderId === 'ou_owner',
    resolveSession: async () => state.current,
    listSessions: async () => [
      { sessionId: 'session-a', running: false, cwd: '/workspace/a', updatedAt: 20 },
      { sessionId: 'session-b', running: true, cwd: '/workspace/b', updatedAt: 10 },
    ],
    switchSession: async (_msg, _accountId, sessionId) => {
      state.current = sessionId;
      state.switched.push(sessionId);
      return sessionId;
    },
    createSession: async () => {
      state.created += 1;
      return 'session-new';
    },
    bindSession: async (_msg, _accountId, sessionId) => {
      state.current = sessionId;
      state.switched.push(sessionId);
      return sessionId;
    },
  };
}

const config = { dshHome: '/unused' };
const owner = { chatType: 'p2p', senderId: 'ou_owner', chatId: 'oc_dm' };
const services = (control) => ({ control, accountId: 'default' });

test('session commands are included in slash help metadata', () => {
  assert.ok(COMMANDS.sessions);
  assert.ok(COMMANDS.session);
});

test('/sessions lists shared DSH sessions and marks the current binding', async () => {
  const control = createControl();
  const result = await handleSlashCommand(config, owner, '/sessions', 'fallback', () => {}, services(control));

  assert.strictEqual(result.handled, true);
  assert.match(result.reply, /（无标题） · `a`.*当前/s);
  assert.match(result.reply, /`b`.*运行中/s);
  assert.match(result.reply, /\/workspace\/a/);
  assert.match(result.reply, /\/session <session-id 或短 id>/);
});

test('/sessions shows the projected title when available', async () => {
  const control = createControl();
  control.listSessions = async () => [
    { sessionId: 'session-t', running: false, updatedAt: 20, projections: { values: { title: '修复登录 bug' } } },
  ];
  const result = await handleSlashCommand(config, owner, '/sessions', 'fallback', () => {}, services(control));
  assert.match(result.reply, /\*\*修复登录 bug\*\*/);
});

test('/sessions reports an empty DSH host without inventing sessions', async () => {
  const control = createControl();
  control.listSessions = async () => [];

  const result = await handleSlashCommand(config, owner, '/sessions', 'fallback', () => {}, services(control));
  assert.match(result.reply, /暂无可用 Session/);
});

test('/session shows the current shared binding', async () => {
  const control = createControl();
  const result = await handleSlashCommand(config, owner, '/session', 'fallback', () => {}, services(control));

  assert.match(result.reply, /当前 Session/);
  assert.match(result.reply, /session-a/);
});

test('/session <id> verifies and switches through DshControl', async () => {
  const control = createControl();
  const result = await handleSlashCommand(config, owner, '/session session-b', 'fallback', () => {}, services(control));

  assert.match(result.reply, /已切换/);
  assert.match(result.reply, /session-b/);
  assert.deepStrictEqual(control.state.switched, ['session-b']);
});

test('/new creates and binds a real DSH session in shared-host mode', async () => {
  const control = createControl();
  const result = await handleSlashCommand(config, owner, '/new', 'fallback', () => {}, services(control));

  assert.match(result.reply, /已创建并切换/);
  assert.match(result.reply, /session-new/);
  assert.strictEqual(control.state.created, 1);
  assert.deepStrictEqual(control.state.switched, ['session-new']);
});

test('session controls fail closed for an unauthorized sender without leaking ids', async () => {
  const control = createControl();
  const result = await handleSlashCommand(
    config,
    { ...owner, senderId: 'ou_other' },
    '/sessions',
    'fallback',
    () => {},
    services(control)
  );

  assert.match(result.reply, /无权执行/);
  assert.doesNotMatch(result.reply, /session-a|session-b/);
});

test('session controls explain when shared-host mode is disabled', async () => {
  const result = await handleSlashCommand(config, owner, '/sessions', 'fallback');

  assert.match(result.reply, /共享 Session 模式未启用/);
});
