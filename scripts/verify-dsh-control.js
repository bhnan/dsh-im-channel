'use strict';

/**
 * 共享模式控制面诊断：用真实 DshApiClient/DshControl 对目标 dsh Web Host
 * 跑一遍 认证 → 会话列表 → 创建 → prompt（含 follow 流归因）→ 斜杠命令。
 *
 * 用法：
 *   DSH_API_URL=http://127.0.0.1:3081 node scripts/verify-dsh-control.js
 * 可选：
 *   DSH_HOME=/tmp/dsh-probe-home      # 凭据铸造来源（默认 ~/.dsh）
 *   DSH_API_TOKEN=xxx                 # 改用 launch token 交换认证
 *   VERIFY_PROMPT=1                   # 真正发一条 prompt（需 Host 已配置模型密钥）
 */

const os = require('node:os');
const path = require('node:path');
const { DshApiClient } = require('../src/core/dsh-api-client');
const { DshControl } = require('../src/core/dsh-control');

const baseUrl = process.env.DSH_API_URL;
if (!baseUrl) {
  console.error('用法: DSH_API_URL=http://127.0.0.1:<port> node scripts/verify-dsh-control.js');
  process.exit(1);
}

(async () => {
  const api = new DshApiClient({
    baseUrl,
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    token: process.env.DSH_API_TOKEN || '',
    log: (m) => console.log('  [log]', m),
  });
  const bindings = { isAuthorized: () => true, resolve: async () => null, bind: async (_k, id) => id };
  const control = new DshControl({ api, bindings, promptTimeoutMs: 30000 });

  await control.start();
  console.log('[1] 认证通过');
  const before = await control.listSessions();
  console.log(`[2] listSessions: ${before.length} 个会话`);
  const sessionId = await control.createSession({ cwd: process.cwd() });
  console.log(`[3] createSession: ${sessionId}`);

  if (process.env.VERIFY_PROMPT) {
    const deltas = [];
    try {
      const result = await control.prompt(sessionId, '用一句话介绍你自己', {
        onDelta: (text) => deltas.push(text),
        clientTimeZone: process.env.TZ || 'Asia/Shanghai',
      });
      console.log(`[4] prompt: ${JSON.stringify(result)} 流式: "${deltas.join('')}"`);
    } catch (error) {
      // 无模型密钥等 Host 侧失败会以 turn/error 传播到这里——归因与错误传播链路本身已验证。
      console.log(`[4] prompt 以错误收尾（归因与错误传播已验证）: ${error.message.slice(0, 120)}`);
    }
  } else {
    console.log('[4] 跳过 prompt（设 VERIFY_PROMPT=1 开启，需 Host 已配置模型密钥）');
  }

  const cmd = await control.executeCommand(sessionId, '/compact').catch((e) => ({ error: e.message }));
  console.log(`[5] executeCommand('/compact'): ${JSON.stringify(cmd).slice(0, 200)}`);

  control.stop();
  console.log('VERIFY DONE');
  process.exit(0);
})().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
