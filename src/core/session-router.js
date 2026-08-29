'use strict';

const legacySession = require('../session');

/** 在共享 DSH Host 与旧子进程 Session runner 之间路由一条普通消息。 */
async function runSession(config, message, prompt, log = () => {}, accountId, onDelta, options = {}) {
  const legacyRun = options.legacyRun || legacySession.runSession;
  if (!options.control) {
    return legacyRun(config, message, prompt, log, accountId, onDelta);
  }

  const fallbackSessionId = legacySession.deriveSessionId(message, accountId);
  const sessionId = await options.control.resolveSession(message, accountId, fallbackSessionId);
  const result = await options.control.prompt(sessionId, prompt, { onDelta });
  return {
    reply: result.text,
    sessionId,
    tools: [],
    thinking: '',
  };
}

module.exports = { runSession };
