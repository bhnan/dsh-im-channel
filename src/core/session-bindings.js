'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STATE_VERSION = 1;

function cleanPart(value, fallback) {
  return String(value || fallback).replace(/[:\s/\\]+/g, '-');
}

/** 将飞书消息定位为稳定的账号内会话范围。 */
function deriveScopeKey(message, accountId = 'default') {
  const account = cleanPart(accountId, 'default');
  const sender = cleanPart(message.senderId, 'anonymous');
  const chat = cleanPart(message.chatId, 'unknown');
  const thread = message.threadId || message.rootId;
  if (thread) return `${account}:thread:${chat}:${cleanPart(thread, 'unknown')}`;
  if (message.chatType === 'group') return `${account}:group:${chat}:${sender}`;
  return `${account}:p2p:${sender}`;
}

/** 持久保存飞书范围到 DSH Session 的绑定。 */
class SessionBindings {
  constructor(options) {
    if (!options || !options.filePath) throw new Error('SessionBindings 需要 filePath');
    this.filePath = options.filePath;
    this.controlAllowFrom = new Set(options.controlAllowFrom || []);
    this.state = null;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  /** 当前发送者是否可以读取或修改 DSH 控制面。 */
  isAuthorized(senderId) {
    return this.controlAllowFrom.has(senderId);
  }

  /** 返回当前绑定；若不存在则持久化并返回 fallbackSessionId。 */
  async resolve(scopeKey, fallbackSessionId) {
    this._requireId(scopeKey, 'scopeKey');
    this._requireId(fallbackSessionId, 'fallbackSessionId');
    return this._mutate(async (state) => {
      if (state.bindings[scopeKey]) return { value: state.bindings[scopeKey], changed: false };
      state.bindings[scopeKey] = fallbackSessionId;
      return { value: fallbackSessionId, changed: true };
    });
  }

  /** 将飞书范围切换到指定 DSH Session。 */
  async bind(scopeKey, sessionId) {
    this._requireId(scopeKey, 'scopeKey');
    this._requireId(sessionId, 'sessionId');
    return this._mutate(async (state) => {
      const changed = state.bindings[scopeKey] !== sessionId;
      state.bindings[scopeKey] = sessionId;
      return { value: sessionId, changed };
    });
  }

  /** 删除显式绑定；下一次 resolve 会采用新的 fallback。 */
  async unbind(scopeKey) {
    this._requireId(scopeKey, 'scopeKey');
    return this._mutate(async (state) => {
      if (!state.bindings[scopeKey]) return { value: false, changed: false };
      delete state.bindings[scopeKey];
      return { value: true, changed: true };
    });
  }

  /** 列出全部绑定，主要用于诊断与管理命令。 */
  async entries() {
    const state = await this._load();
    return Object.entries(state.bindings)
      .map(([scopeKey, sessionId]) => ({ scopeKey, sessionId }))
      .sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
  }

  async _mutate(operation) {
    const run = this.writeQueue.then(async () => {
      const state = await this._load();
      const result = await operation(state);
      if (result.changed) await this._write(state);
      return result.value;
    });
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async _load() {
    if (this.state) return this.state;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      let raw;
      try {
        raw = await fs.readFile(this.filePath, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.state = { version: STATE_VERSION, bindings: {} };
          return this.state;
        }
        throw error;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed.version !== STATE_VERSION || !parsed.bindings || Array.isArray(parsed.bindings) || typeof parsed.bindings !== 'object') {
          throw new Error('unsupported state');
        }
        for (const [scopeKey, sessionId] of Object.entries(parsed.bindings)) {
          this._requireId(scopeKey, 'scopeKey');
          this._requireId(sessionId, 'sessionId');
        }
        this.state = parsed;
        return parsed;
      } catch (error) {
        throw new Error(`会话绑定文件无效 ${this.filePath}: ${error.message}`);
      }
    })();
    return this.loadPromise;
  }

  async _write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, this.filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  _requireId(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  }
}

module.exports = { SessionBindings, deriveScopeKey, STATE_VERSION };
