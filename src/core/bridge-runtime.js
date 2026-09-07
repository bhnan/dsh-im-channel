'use strict';

const { createSharedHost } = require('./shared-host');

/** 启动共享 DSH Host 控制服务；失败时安全回退到旧 Session runner。 */
async function startSharedHost(config, log = () => {}, create = createSharedHost) {
  const control = create(config, log);
  if (!control) return null;
  try {
    await control.start();
    log('[shared-host] 共享 Session 模式已连接');
    return control;
  } catch (error) {
    control.stop?.();
    log('[shared-host] 共享 Session 模式启动失败，已回退旧 Session runner');
    return null;
  }
}

/** Resolve a Session run and surface DSH failures to the channel instead of swallowing them. */
async function settleSessionRun(runPromise, fallbackSessionId, log = () => {}) {
  try {
    return await runPromise;
  } catch (error) {
    log(`[stream] DSH 处理失败: ${error.message}`);
    return {
      reply: `❌ DSH 处理失败: ${error.message}`,
      sessionId: fallbackSessionId,
      tools: [],
      thinking: '',
    };
  }
}

module.exports = { startSharedHost, settleSessionRun };
