'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createSharedHost } = require('../src/core/shared-host');

test('createSharedHost returns null when shared-host mode is disabled', () => {
  assert.strictEqual(createSharedHost({ dshApiUrl: '' }), null);
});

test('createSharedHost constructs API, bindings, and control without exposing credentials', () => {
  const seen = {};
  class FakeApi {
    constructor(options) { seen.api = options; }
  }
  class FakeBindings {
    constructor(options) { seen.bindings = options; }
  }
  class FakeControl {
    constructor(options) { seen.control = options; }
  }
  const log = () => {};
  const config = {
    dshApiUrl: 'http://127.0.0.1:3080',
    dshApiUsername: 'bridge-user',
    dshApiPassword: 'private-value',
    dshHome: '/tmp/dsh-home',
    controlAllowFrom: ['ou_owner'],
    dshTimeoutMs: 1234,
  };

  const control = createSharedHost(config, log, {
    DshApiClient: FakeApi,
    SessionBindings: FakeBindings,
    DshControl: FakeControl,
  });

  assert.ok(control instanceof FakeControl);
  assert.deepStrictEqual(seen.api, {
    baseUrl: 'http://127.0.0.1:3080',
    dshHome: '/tmp/dsh-home',
    token: '',
    username: 'bridge-user',
    password: 'private-value',
    log,
  });
  assert.deepStrictEqual(seen.bindings, {
    filePath: path.join('/tmp/dsh-home', 'lark-bridge', 'session-bindings.json'),
    controlAllowFrom: ['ou_owner'],
  });
  assert.strictEqual(seen.control.api instanceof FakeApi, true);
  assert.strictEqual(seen.control.bindings instanceof FakeBindings, true);
  assert.strictEqual(seen.control.promptTimeoutMs, 1234);
  assert.strictEqual(seen.control.log, log);
});
