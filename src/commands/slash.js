'use strict';

/**
 * 飞书斜杠命令处理 (对齐 OpenClaw / DSH 能力)
 *
 * 在消息进入 DSH 前拦截 `/xxx` 命令, 直接处理并回复, 不消耗 agent 调用。
 *
 * 命令:
 *   /help            命令帮助
 *   /new             开启新对话 (清空当前会话上下文)
 *   /compact         压缩当前会话 (减少上下文)
 *   /model [name]    查看/切换模型
 *   /status          查看当前状态 (会话/模型/账号/工具)
 *   /tools           列出可用飞书工具
 *   /features        查看功能配置清单
 *   /doctor          运行诊断
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

/** 异步运行子进程 (不阻塞事件循环), 返回 {code, out} */
function runAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, opts.timeout || 30000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
  });
}

const COMMANDS = {
  help: { desc: '显示帮助', usage: '/help' },
  new: { desc: '开启新对话 (清空当前会话上下文)', usage: '/new' },
  clear: { desc: '同 /new, 清空会话', usage: '/clear' },
  sessions: { desc: '列出 DSH 网页端共享 Session', usage: '/sessions' },
  session: { desc: '查看/切换当前共享 Session', usage: '/session [session-id]' },
  compact: { desc: '压缩当前会话 (减少上下文)', usage: '/compact' },
  model: { desc: '查看/切换模型 (如 /model deepseek-v4-flash)', usage: '/model [name]' },
  status: { desc: '查看当前状态', usage: '/status' },
  state: { desc: '同 /status', usage: '/state' },
  tools: { desc: '列出可用飞书工具', usage: '/tools' },
  features: { desc: '查看功能配置清单', usage: '/features' },
  doctor: { desc: '运行诊断', usage: '/doctor' },
  channels: { desc: '渠道接入向导 (如 /channels add telegram)', usage: '/channels [add <渠道>]' },
};

/** 是否是斜杠命令 */
function isSlashCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  return trimmed.startsWith('/') && /^\/[a-z][a-z0-9_]*/.test(trimmed);
}

/** 解析命令和参数 */
function parseCommand(text) {
  const trimmed = text.trim();
  const [rawCmd, ...args] = trimmed.split(/\s+/);
  const cmd = rawCmd.slice(1).toLowerCase();
  return { cmd, args };
}

/** 删除会话 (实现 /new) */
function deleteSession(config, sessionId) {
  // session 持久化位置: ~/.dsh/sessions/<profile>/<sessionId>/
  const sessionsRoot = path.join(config.dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) return false;
  // 递归查找匹配 sessionId 的目录
  const entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  let deleted = false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(sessionsRoot, e.name);
    const target = path.join(dir, sessionId);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      deleted = true;
    }
  }
  return deleted;
}

/** 获取当前模型 (读 settings.yaml) */
function getCurrentModel(config) {
  try {
    const settingsPath = path.join(config.dshHome, 'settings.yaml');
    if (fs.existsSync(settingsPath)) {
      const src = fs.readFileSync(settingsPath, 'utf8');
      const m = src.match(/agent-default-model:[\s\S]*?model:\s*(\S+)/);
      return m ? m[1] : 'unknown';
    }
  } catch (e) {}
  return 'unknown';
}

/** 切换模型 (写 settings.yaml, 带备份) */
function setModel(config, model) {
  const settingsPath = path.join(config.dshHome, 'settings.yaml');
  if (!fs.existsSync(settingsPath)) return { ok: false, error: 'settings.yaml 不存在' };
  try {
    const src = fs.readFileSync(settingsPath, 'utf8');
    // 备份
    fs.writeFileSync(settingsPath + '.bak', src);
    const replaced = src.replace(
      /(agent-default-model:[\s\S]*?model:\s*)\S+/,
      `$1${model}`
    );
    if (replaced === src) return { ok: false, error: '未找到 agent-default-model 配置' };
    fs.writeFileSync(settingsPath, replaced);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 获取 MCP 工具列表 */
function listTools() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mcp-server.js'), 'utf8');
    const names = [...src.matchAll(/server\.tool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    return names;
  } catch (e) {
    return [];
  }
}

/**
 * 处理斜杠命令
 * @param {object} config 配置
 * @param {object} msg 消息
 * @param {string} text 消息文本
 * @param {string} sessionId 当前会话 ID
 * @returns {Promise<{handled: boolean, reply?: string}>}
 */
async function handleSlashCommand(config, msg, text, sessionId, log = () => {}, services = {}) {
  if (!isSlashCommand(text)) return { handled: false };
  const { cmd, args } = parseCommand(text);
  if (!COMMANDS[cmd]) {
    return {
      handled: true,
      reply: `未知命令 \`/${cmd}\`。输入 \`/help\` 查看可用命令。`,
    };
  }

  log(`[slash] 命令 /${cmd} (${args.join(' ')}) session=${sessionId}`);

  switch (cmd) {
    case 'help': {
      const lines = ['**可用命令**', ''];
      for (const [name, info] of Object.entries(COMMANDS)) {
        if (name === 'clear' || name === 'state') continue; // 别名
        lines.push(`- \`${info.usage}\` — ${info.desc}`);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    case 'new':
    case 'clear': {
      if (services.control) {
        if (!services.control.isAuthorized(msg.senderId)) {
          return { handled: true, reply: '❌ 无权执行共享 Session 控制命令。' };
        }
        try {
          const created = await services.control.createSession({});
          await services.control.bindSession(msg, services.accountId, created);
          return { handled: true, reply: `✅ 已创建并切换到新 Session: \`${created}\`` };
        } catch (error) {
          return { handled: true, reply: `❌ Session 操作失败: ${error.message}` };
        }
      }
      const deleted = deleteSession(config, sessionId);
      return {
        handled: true,
        reply: deleted
          ? '✅ 已开启新对话，历史上下文已清空。'
          : '✅ 已开启新对话。（未找到旧会话文件，首次对话）',
      };
    }

    case 'sessions': {
      if (!services.control) {
        return { handled: true, reply: '❌ 共享 Session 模式未启用，请先配置 DSH_API_URL。' };
      }
      if (!services.control.isAuthorized(msg.senderId)) {
        return { handled: true, reply: '❌ 无权执行共享 Session 控制命令。' };
      }
      try {
        const current = await services.control.resolveSession(msg, services.accountId, sessionId);
        const items = await services.control.listSessions();
        if (!items.length) return { handled: true, reply: '当前 DSH Host 暂无可用 Session。' };
        const lines = [`**DSH Sessions (${items.length})**`, ''];
        for (const item of items.slice(0, 20)) {
          const tags = [];
          if (item.sessionId === current) tags.push('当前');
          if (item.running) tags.push('运行中');
          const cwd = item.cwd ? ` · \`${item.cwd}\`` : '';
          lines.push(`- \`${item.sessionId}\`${tags.length ? ` · **${tags.join('、')}**` : ''}${cwd}`);
        }
        if (items.length > 20) lines.push(`- …其余 ${items.length - 20} 个未显示`);
        lines.push('', '切换: `/session <session-id>`');
        return { handled: true, reply: lines.join('\n') };
      } catch (error) {
        return { handled: true, reply: `❌ Session 操作失败: ${error.message}` };
      }
    }

    case 'session': {
      if (!services.control) {
        return { handled: true, reply: '❌ 共享 Session 模式未启用，请先配置 DSH_API_URL。' };
      }
      if (!services.control.isAuthorized(msg.senderId)) {
        return { handled: true, reply: '❌ 无权执行共享 Session 控制命令。' };
      }
      try {
        if (!args.length) {
          const current = await services.control.resolveSession(msg, services.accountId, sessionId);
          return { handled: true, reply: `当前 Session: \`${current}\`\n\n切换: \`/session <session-id>\`` };
        }
        const selected = await services.control.switchSession(msg, services.accountId, args[0]);
        return { handled: true, reply: `✅ 已切换到 Session: \`${selected}\`` };
      } catch (error) {
        return { handled: true, reply: `❌ Session 操作失败: ${error.message}` };
      }
    }

    case 'compact': {
      // DSH compaction 由 dsh-compaction-basic 自动触发; 这里手动压缩 = 提示 + 可选清历史
      const deleted = deleteSession(config, sessionId);
      return {
        handled: true,
        reply: deleted
          ? '✅ 已压缩会话（清空历史上下文，重新开始更快的对话）。\n注：DSH 的 compaction 也会自动触发，无需手动。'
          : '✅ 会话已是最新状态（无历史可压缩）。',
      };
    }

    case 'model': {
      // 越权防护: 切换模型是全局写操作 (settings.yaml), 仅允许私聊 (P2P) 执行, 群聊禁止
      if (msg.chatType === 'group') {
        return { handled: true, reply: '❌ /model 仅可在私聊中执行（切换的是全局默认模型）。' };
      }
      const current = getCurrentModel(config);
      if (!args.length) {
        return { handled: true, reply: `当前模型: \`${current}\`\n\n切换: \`/model <模型名>\`` };
      }
      const target = args[0];
      const r = setModel(config, target);
      return {
        handled: true,
        reply: r.ok
          ? `✅ 已切换模型: \`${current}\` → \`${target}\``
          : `❌ 切换失败: ${r.error}`,
      };
    }

    case 'status':
    case 'state': {
      const model = getCurrentModel(config);
      const tools = listTools();
      const uptime = Math.floor((Date.now() - (global.__bridgeStartTs || Date.now())) / 1000);
      const lines = [
        '**当前状态**',
        '',
        `- 模型: \`${model}\``,
        `- 会话: \`${sessionId}\``,
        `- 飞书工具: ${tools.length} 个 (\`/tools\` 查看)`,
        `- 运行时长: ${uptime}s`,
      ];
      return { handled: true, reply: lines.join('\n') };
    }

    case 'tools': {
      const tools = listTools();
      if (!tools.length) return { handled: true, reply: '无可用工具' };
      const grouped = {};
      for (const t of tools) {
        const cat = t.split('_')[0] || 'other';
        grouped[cat] = grouped[cat] || [];
        grouped[cat].push(t);
      }
      const lines = [`**可用飞书工具 (${tools.length} 个)**`, ''];
      for (const [cat, names] of Object.entries(grouped)) {
        lines.push(`- **${cat}**: \`${names.join('` \`')}\``);
      }
      return { handled: true, reply: lines.join('\n') };
    }

    case 'features': {
      const r = await runAsync(process.execPath, [path.join(__dirname, 'features.js')], {
        timeout: 20000,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' },
      });
      const out = (r.out || '').trim();
      return { handled: true, reply: '**功能配置清单**\n\n```\n' + out + '\n```' };
    }

    case 'doctor': {
      const r = await runAsync(process.execPath, [path.join(__dirname, 'doctor.js')], {
        timeout: 30000,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' },
      });
      const out = (r.out || '').trim();
      const tail = out.split('\n').slice(-15).join('\n');
      return { handled: true, reply: '**诊断结果**\n\n```\n' + tail + '\n```' };
    }

    case 'channels': {
      const { handleChannelsCommand } = require('./channels');
      return handleChannelsCommand(args);
    }

    default:
      return { handled: true, reply: `命令 \`/${cmd}\` 未实现` };
  }
}

module.exports = { isSlashCommand, parseCommand, handleSlashCommand, COMMANDS };
