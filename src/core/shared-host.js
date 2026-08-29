'use strict';

const path = require('node:path');
const { DshApiClient } = require('./dsh-api-client');
const { SessionBindings } = require('./session-bindings');
const { DshControl } = require('./dsh-control');

/** 按配置构造共享 DSH Host 控制服务；未启用时返回 null。 */
function createSharedHost(config, log = () => {}, dependencies = {}) {
  if (!config.dshApiUrl) return null;
  const ApiClient = dependencies.DshApiClient || DshApiClient;
  const Bindings = dependencies.SessionBindings || SessionBindings;
  const Control = dependencies.DshControl || DshControl;
  const api = new ApiClient({
    baseUrl: config.dshApiUrl,
    username: config.dshApiUsername,
    password: config.dshApiPassword,
  });
  const bindings = new Bindings({
    filePath: path.join(config.dshHome, 'lark-bridge', 'session-bindings.json'),
    controlAllowFrom: config.controlAllowFrom,
  });
  return new Control({
    api,
    bindings,
    promptTimeoutMs: config.dshTimeoutMs,
    log,
  });
}

module.exports = { createSharedHost };
