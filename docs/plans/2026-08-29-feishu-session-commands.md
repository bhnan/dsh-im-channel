# Feishu Session Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Feishu list, inspect, create, switch, and continue the same DSH Sessions shown in the browser.

**Architecture:** Session-only slash commands receive an injected `DshControl`; a shared-host factory builds the authenticated API client and durable binding store when `dshApiUrl` is configured. Normal messages use a small router that resolves the current binding and calls the same DSH Host, while disabled shared-host mode preserves the existing subprocess runner.

**Tech Stack:** Node.js CommonJS, DSH HTTP RPC/WebSocket API, `ws`, Node test runner, `@larksuite/channel`.

---

### Task 1: Session slash commands

**Files:**
- Modify: `src/commands/slash.js`
- Create: `tests/session-commands.test.js`

**Step 1: Write the failing tests**

Add tests that inject a control service into `handleSlashCommand` and assert:

```js
const result = await handleSlashCommand(config, owner, '/sessions', fallbackId, log, {
  control,
  accountId: 'default',
});
assert.match(result.reply, /session-a/);
assert.match(result.reply, /当前/);
```

Cover `/session`, `/session session-b`, `/new`, an empty list, unavailable shared-host mode, and denied senders.

**Step 2: Run the focused test and verify RED**

Run: `node --test tests/session-commands.test.js`

Expected: FAIL because `/sessions` and `/session` are unknown and `/new` still deletes files.

**Step 3: Implement the minimal command behavior**

Add `sessions` and `session` descriptors. Extend `handleSlashCommand` with an optional services argument. In shared-host mode:

```js
const current = await control.resolveSession(msg, accountId, sessionId);
const items = await control.listSessions();
await control.switchSession(msg, accountId, args[0]);
const created = await control.createSession({});
await control.bindSession(msg, accountId, created);
```

Catch service errors and return a redacted `❌ Session 操作失败` reply. Keep legacy `/new` only when no control service is configured.

**Step 4: Run the focused test and verify GREEN**

Run: `node --test tests/session-commands.test.js`

Expected: PASS.

### Task 2: Shared-host configuration and factory

**Files:**
- Modify: `src/config.js`
- Create: `src/core/shared-host.js`
- Modify: `config.example.json`
- Modify: `tests/plugin.test.js`

**Step 1: Write failing configuration and factory tests**

Assert that `DSH_API_URL`, `DSH_API_USERNAME`, `DSH_API_PASSWORD`, and comma-separated `CONTROL_ALLOW_FROM` load without logging their values; assert that an empty URL returns no control service.

**Step 2: Run the focused tests and verify RED**

Run: `node --test tests/plugin.test.js`

Expected: FAIL because the shared-host fields and factory do not exist.

**Step 3: Implement configuration and construction**

Add fail-closed defaults and build:

```js
const api = new DshApiClient({
  baseUrl: config.dshApiUrl,
  username: config.dshApiUsername,
  password: config.dshApiPassword,
});
const bindings = new SessionBindings({
  filePath: path.join(config.dshHome, 'lark-bridge', 'session-bindings.json'),
  controlAllowFrom: config.controlAllowFrom,
});
return new DshControl({ api, bindings, log });
```

Document only placeholder credentials in `config.example.json`.

**Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/plugin.test.js tests/dsh-api-client.test.js tests/session-bindings.test.js tests/dsh-control.test.js`

Expected: PASS.

### Task 3: Shared Session prompt router

**Files:**
- Create: `src/core/session-router.js`
- Create: `tests/session-router.test.js`
- Modify: `src/core/dsh-control.js`

**Step 1: Write failing router tests**

Verify that a configured control resolves the binding and streams through `control.prompt`, while an absent control calls the existing subprocess runner.

```js
const result = await runSession({ control, legacyRun }, config, msg, prompt, 'default', onDelta);
assert.strictEqual(result.sessionId, 'session-b');
assert.strictEqual(result.reply, '共享回复');
```

Also test `DshControl.bindSession()` as the direct binding operation used after `/new`.

**Step 2: Run focused tests and verify RED**

Run: `node --test tests/session-router.test.js tests/dsh-control.test.js`

Expected: FAIL because the router and direct bind method do not exist.

**Step 3: Implement the router and bind operation**

The shared path returns the existing result fields (`reply`, `sessionId`, `tools`, `thinking`) so the Feishu renderer remains unchanged. The legacy path delegates without changing arguments.

**Step 4: Run focused tests and verify GREEN**

Run: `node --test tests/session-router.test.js tests/dsh-control.test.js`

Expected: PASS.

### Task 4: Bridge wiring and verification

**Files:**
- Modify: `src/index.js`
- Modify: `README.md`
- Test: `tests/session-commands.test.js`
- Test: `tests/session-router.test.js`

**Step 1: Wire the service once at startup**

Create and start one control service before account channels connect. Pass it to slash handling and the prompt router. Register shutdown cleanup. If shared-host startup fails, log a redacted diagnostic and keep the bridge alive in legacy mode.

**Step 2: Update user documentation**

Document the four Session commands, the control allowlist, browser sharing, and the non-destructive `/new` behavior in shared-host mode.

**Step 3: Run verification**

Run: `npm test`

Expected: all tests PASS.

Run: `git diff --check`

Expected: no output.

Run browser-side `session.list` and open the bound Feishu Session, then send `/sessions` to the installed bridge after deployment.
