# DSH Feishu Control Plane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add secure Feishu slash commands for shared DSH sessions, per-session model selection, native DSH commands, and interactive approval decisions.

**Architecture:** The bridge talks to the running DSH Web Host through its official `/api` RPC and mux event stream, authenticating through the configured login endpoint when required. A small durable binding store maps each Feishu conversation scope to one DSH Session; ordinary prompts, model changes, command execution, and approvals all use that Session. Bridge-only commands remain local, while DSH-owned commands are submitted through `session.prompt` so the DSH command registry remains authoritative.

**Tech Stack:** Node.js CommonJS, WHATWG `fetch`, DSH HTTP RPC/SSE protocol, `@larksuite/channel`, Node test runner.

---

### Task 1: Authenticated DSH API client

**Files:**
- Create: `src/core/dsh-api-client.js`
- Test: `tests/dsh-api-client.test.js`

1. Write failing tests for unauthenticated RPC, login-cookie acquisition, one-time 401 re-authentication, business errors, SSE frame parsing, and approval responses.
2. Run `node --test tests/dsh-api-client.test.js` and confirm failures are caused by the missing client.
3. Implement `DshApiClient` with `call()`, `openMux()`, `respond()`, cookie redaction, abort support, and exact DSH wire envelopes.
4. Re-run the focused test until it passes.

### Task 2: Durable and authorized Feishu-to-DSH bindings

**Files:**
- Create: `src/core/session-bindings.js`
- Test: `tests/session-bindings.test.js`

1. Write failing tests for deterministic default bindings, durable explicit switches, atomic state replacement, malformed-state failure, and sender-scoped access checks.
2. Run the focused test and observe the expected failure.
3. Implement a JSON-backed binding store under the configured bridge state directory. Never enumerate or switch shared sessions unless the sender is in `controlAllowFrom`.
4. Re-run the focused test.

### Task 3: Shared DSH control service

**Files:**
- Create: `src/core/dsh-control.js`
- Test: `tests/dsh-control.test.js`

1. Write failing tests for session list/create/switch, model catalog rendering, exact per-session model selection, DSH command dispatch, prompt event correlation, streamed text deltas, and approval lifecycle routing.
2. Run the focused test and observe the expected failure.
3. Implement one long-lived mux reader, per-session event subscribers, prompt `rpcId` correlation, pending approval records, and reconnect backoff.
4. Re-run the focused test.

### Task 4: Slash command registry and help surface

**Files:**
- Modify: `src/commands/slash.js`
- Test: `tests/features.test.js`

1. Add failing tests for `/help`, `/sessions`, `/session <id>`, `/model`, `/permission`, `/compact`, denied privileged commands, unknown commands, and aliases.
2. Run the focused test and observe the expected failure.
3. Replace the hard-coded switch with command descriptors whose metadata drives parsing and help. Keep `/doctor`, `/features`, `/tools`, and `/channels` local; delegate DSH-owned commands and shared-state operations to the control service.
4. Re-run the focused test.

### Task 5: Feishu prompt streaming and approval cards

**Files:**
- Modify: `src/index.js`
- Modify: `src/channel/feishu.js`
- Create: `src/outbound/approval.js`
- Test: `tests/integration.test.js`

1. Add failing tests showing that shared-host mode routes normal prompts through `DshControl`, sends an approval card with allow-once/reject actions, accepts only the intended sender, and ignores duplicate or expired actions.
2. Run the focused test and observe the expected failure.
3. Integrate the control service without changing the existing standalone fallback. Route DSH `text-delta` events into the existing streaming queue and resolve approval actions through `/api/respond`.
4. Re-run the focused test.

### Task 6: Configuration, installation, and documentation

**Files:**
- Modify: `src/config.js`
- Modify: `config.example.json`
- Modify: `scripts/setup.js`
- Modify: `scripts/install.js`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Test: `tests/plugin.test.js`

1. Add failing tests for `DSH_API_URL`, optional auth credentials, `CONTROL_ALLOW_FROM`, safe defaults, and launchd propagation without logging secrets.
2. Run the focused test and observe the expected failure.
3. Add configuration and setup guidance. Shared-host control remains disabled unless `dshApiUrl` is configured; privileged commands remain denied unless `controlAllowFrom` contains the sender.
4. Re-run the focused test.

### Task 7: Verification

1. Run `npm test`.
2. Run `npm run doctor` against the installed local bridge.
3. Start a disposable local DSH API fixture and verify `/sessions`, `/model`, `/permission`, and one approval round trip.
4. Inspect `git diff --check` and the final diff, preserving all pre-existing local changes.
