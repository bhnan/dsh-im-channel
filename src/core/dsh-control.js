'use strict';

const { randomUUID } = require('node:crypto');
const { deriveScopeKey } = require('./session-bindings');

/** 通过 DSH Web Host (dsh >= 0.1.2 Gateway wire) 控制共享 Session。 */
class DshControl {
  constructor(options) {
    if (!options || !options.api) throw new Error('DshControl 需要 api');
    if (!options.bindings) throw new Error('DshControl 需要 bindings');
    this.api = options.api;
    this.bindings = options.bindings;
    this.rpcIdFactory = options.rpcIdFactory || randomUUID;
    this.promptTimeoutMs = options.promptTimeoutMs || 300000;
    this.reconnectDelayMs = options.reconnectDelayMs || 1500;
    this.log = options.log || (() => {});
    this.stopped = true;
    this.pendingPrompts = new Map();
    this.currentTurns = new Map();
    this.follows = new Map();
    this.noAssistantStream = new Set();
  }

  /** 预热认证并标记服务可用。 */
  async start() {
    this.stopped = false;
    await this.api.ensureAuth();
  }

  /** 停止事件流并拒绝未完成的调用。 */
  stop() {
    this.stopped = true;
    for (const pending of this.pendingPrompts.values()) pending.reject(new Error('DSH 控制服务已停止'));
    this.pendingPrompts.clear();
    this.currentTurns.clear();
    this.follows.clear();
    this.api.closeStreams?.();
  }

  /** 列出 DSH Host 中的 Session。 */
  async listSessions() {
    const result = await this.api.call('session/list', { _request: {} });
    return result.value.items;
  }

  /** 创建一个正式 DSH Session。 */
  async createSession(options = {}) {
    const result = await this.api.call('session/create', { request: options });
    return result.value.sessionId;
  }

  /** 解析当前飞书范围绑定的 DSH Session。 */
  async resolveSession(message, accountId, fallbackSessionId) {
    return this.bindings.resolve(deriveScopeKey(message, accountId), fallbackSessionId);
  }

  /** 当前发送者是否可以使用共享 Session 控制命令。 */
  isAuthorized(senderId) {
    return this.bindings.isAuthorized(senderId);
  }

  /** 直接绑定一个已由当前控制服务创建或验证的 Session。 */
  async bindSession(message, accountId, sessionId) {
    this._assertAuthorized(message.senderId);
    return this.bindings.bind(deriveScopeKey(message, accountId), sessionId);
  }

  /** 将当前飞书范围切换到一个已存在的 DSH Session（支持唯一前缀/子串短 id）。 */
  async switchSession(message, accountId, sessionId) {
    this._assertAuthorized(message.senderId);
    const sessions = await this.listSessions();
    const exact = sessions.find((item) => item.sessionId === sessionId);
    let target = exact && exact.sessionId;
    if (!target) {
      const matches = sessions.filter((item) => item.sessionId.includes(sessionId));
      if (matches.length === 1) target = matches[0].sessionId;
      if (matches.length > 1) throw new Error(`匹配到多个 Session，请用更长的 id: ${matches.map((m) => m.sessionId.replace(/^session-/, '').slice(0, 8)).join('、')}`);
    }
    if (!target) throw new Error(`DSH Session 不存在: ${sessionId}`);
    return this.bindings.bind(deriveScopeKey(message, accountId), target);
  }

  /**
   * 读取一个 Session 可选择的模型目录。0.1.2 Gateway wire 没有目录端点，
   * 仅返回当前路由（无目录时 groups 为空，调用方按无目录降级）。
   */
  async models(sessionId) {
    const result = await this.api.call('session/models', { request: { sessionId } }).catch(() => null);
    if (!result) return { current: null, routable: false, groups: [], failures: [] };
    return result.value;
  }

  /** 修改一个 Session 的模型。 */
  async selectModel(sessionId, selection) {
    const result = await this.api.call('session/selectModel', { request: { sessionId, ...selection } });
    return result.value.selected;
  }

  /**
   * 在共享 Session 上执行一条 DSH 斜杠命令（如 /compact），返回结果文本。
   * 参数名跨版本有差异（0.1.2 为 images，0.1.3 起为 submittedAttachments），
   * 依据网关的参数校验错误自适应重试。
   */
  async executeCommand(sessionId, line) {
    let result;
    try {
      result = await this.api.call('commands/execute', { agentId: sessionId, line, images: [] });
    } catch (error) {
      if (error.code !== 'gateway/arguments-invalid' || !/submittedAttachments/.test(error.message)) throw error;
      result = await this.api.call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] });
    }
    // 部分命令（如 /help）成功时没有回执值。
    return result.value?.result ?? { kind: 'success', text: '' };
  }

  /**
   * 向共享 Session 发送文本，并收集该 turn 的流式输出。
   * 归因链路：客户端铸造 requestId → session/prompt 持久化到 user 消息 source →
   * follow 流的 user/message 事件按 source.rpcId 认领，后续同 turn 事件才被消费。
   */
  async prompt(sessionId, text, handlers = {}) {
    if (this.stopped) throw new Error('DSH 控制服务已停止');
    if (this.pendingPrompts.has(sessionId)) throw new Error(`DSH Session 正在处理另一条消息: ${sessionId}`);
    const requestId = this.rpcIdFactory();
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // turn 事件可能先于 prompt RPC 返回到达（fast-fail 路由），
    // 预挂 no-op 防止 rejection 在调用方 await 之前被判 unhandled。
    completion.catch(() => {});
    const pending = {
      requestId,
      sessionId,
      turn: null,
      text: '',
      reasoningChars: 0,
      lastThinkingAt: 0,
      onDelta: handlers.onDelta,
      onStatus: handlers.onStatus,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      this._settlePrompt(pending, new Error(`DSH 响应超时: ${sessionId}`));
    }, this.promptTimeoutMs);
    this.pendingPrompts.set(sessionId, pending);

    try {
      await this._ensureFollow(sessionId);
      await this.api.call('session/prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          ...(handlers.clientTimeZone ? { clientTimeZone: handlers.clientTimeZone } : {}),
        },
      }, { rpcId: requestId });
    } catch (error) {
      this._settlePrompt(pending, error);
      return completion;
    }
    return completion;
  }

  /**
   * 回答 DSH 的一次原生工具审批。0.1.2 Gateway wire 不透传交互审批
   * （权限由 profile 预设裁决），保留入口以便上层统一处理。
   */
  async answerApproval() {
    throw new Error('dsh 0.1.2 Web Host 不透传交互审批；请调整 profile 的权限预设（permission preset）');
  }

  /** 确保 Session 的 follow 流已打开（快照 + 增量事件）。 */
  async _ensureFollow(sessionId) {
    if (this.follows.has(sessionId)) return;
    // 0.1.3 起流式呈现帧（text-delta）需显式订阅；旧 Host 不认识该字段，
    // 被拒后由 _handleFollowError 记忆并降级重开普通流。
    const useAssistantStream = !this.noAssistantStream.has(sessionId);
    const follow = await this.api.openStream('session/follow', {
      request: {
        address: { kind: 'session', sessionId },
        maxMessages: 1,
        ...(useAssistantStream ? { assistantStream: true } : {}),
      },
    }, {
      onItem: (value) => this._handleJournalItem(sessionId, value),
      onError: (error) => this._handleFollowError(sessionId, error),
    });
    this.follows.set(sessionId, follow);
  }

  /**
   * 读取一个 Session 的最后一条助手输出（切换预览用）；无输出解析为空串。
   * 通过临时 follow 流的快照向前扫描，拿到即断开，不占用常驻连接。
   */
  async lastOutput(sessionId) {
    return new Promise((resolve, reject) => {
      let handle;
      let done = false;
      const finish = (text, error) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        try { handle?.close(); } catch (e) {}
        if (error) reject(error);
        else resolve(text);
      };
      const guard = setTimeout(() => finish('', new Error('读取会话输出超时')), 8000);
      this.api.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 60 },
      }, {
        onItem: (value) => {
          if (done || value?.type !== 'snapshot') return;
          const records = value.records || [];
          let text = '';
          for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            if (rec?.type === 'event' && rec.event?.type === 'assistant/message') {
              text = this._messageText(rec.event.data.message);
              if (text) break;
            }
          }
          finish(text);
        },
        onError: (error) => finish('', error),
      }).then((h) => { handle = h; }, (error) => finish('', error));
    });
  }

  /** journal/流式帧：首帧 snapshot，其后为逐条 event；0.1.3 另有 assistant-stream 呈现帧。 */
  _handleJournalItem(sessionId, value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'assistant-stream' && value.frame) {
      // 0.1.3 assistantStream 订阅的呈现帧：chunk 里的 text-delta 即打字机增量，
      // reasoning-delta 只用作"执行中"状态（不透传思考正文）。
      const frame = value.frame;
      const pending = this.pendingPrompts.get(sessionId);
      if (frame.type === 'start' && pending) {
        pending.onStatus?.({ kind: 'thinking' });
        return;
      }
      if (frame.type === 'chunk' && pending && pending.turn !== null) {
        const chunk = frame.chunk || {};
        if (chunk.type === 'text-delta') {
          const text = chunk.text || '';
          pending.text += text;
          pending.onDelta?.(text);
        } else if (chunk.type === 'reasoning-delta') {
          pending.reasoningChars += (chunk.text || '').length;
          this._emitThinkingStatus(pending);
        }
      }
      return;
    }
    if (value.type === 'snapshot') {
      for (const record of value.records || []) {
        if (record && record.type === 'event') this._handleEvent(sessionId, record.event);
      }
      return;
    }
    if (value.type === 'event') {
      this._handleEvent(sessionId, value.event);
      return;
    }
    if (Array.isArray(value.entries)) {
      for (const entry of value.entries) {
        if (entry && entry.event) this._handleEvent(sessionId, entry.event);
      }
    }
  }

  /** 思考状态节流：每 3 秒至多上报一次，避免刷屏。 */
  _emitThinkingStatus(pending) {
    const now = Date.now();
    if (now - pending.lastThinkingAt < 3000) return;
    pending.lastThinkingAt = now;
    pending.onStatus?.({ kind: 'thinking', chars: pending.reasoningChars });
  }

  _handleEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return;
    const pending = this.pendingPrompts.get(sessionId);
    if (event.type === 'turn/start') {
      this.currentTurns.set(sessionId, event.data?.turn);
      return;
    }
    if (!pending) return;
    if (event.type === 'user/message' && event.data?.source?.rpcId === pending.requestId) {
      pending.turn = this.currentTurns.get(sessionId) ?? null;
      return;
    }
    if (pending.turn === null || event.data?.turn !== pending.turn) return;
    if (event.type === 'tool/call') {
      pending.onStatus?.({ kind: 'tool', name: event.data?.name || 'tool' });
      return;
    }
    if (event.type === 'assistant/chunk' && event.data.chunk?.type === 'text-delta') {
      const text = event.data.chunk.text || '';
      pending.text += text;
      pending.onDelta?.(text);
      return;
    }
    if (event.type === 'assistant/message' && !pending.text) {
      pending.text = this._messageText(event.data.message);
      return;
    }
    if (event.type === 'turn/end') {
      const reason = event.data.reason;
      if (reason?.kind === 'error' && !pending.text) {
        this._settlePrompt(pending, new Error(reason.error?.message || 'DSH turn 失败'));
        return;
      }
      this._settlePrompt(pending, null, { text: pending.text, command: false });
    }
  }

  _handleFollowError(sessionId, error) {
    this.follows.delete(sessionId);
    if (error.code === 'gateway/input-invalid' && /assistantStream/i.test(error.message || '')) {
      // 旧 Host 不认识 assistantStream：记忆并降级重开普通流（快照会补发最近记录）。
      this.noAssistantStream.add(sessionId);
      this._ensureFollow(sessionId).catch((reopenError) => {
        const pending = this.pendingPrompts.get(sessionId);
        if (pending) this._settlePrompt(pending, reopenError);
      });
      return;
    }
    const pending = this.pendingPrompts.get(sessionId);
    if (pending) this._settlePrompt(pending, error);
  }

  _messageText(message) {
    if (!message || !Array.isArray(message.content)) return '';
    return message.content.filter((part) => part.type === 'text').map((part) => part.text || '').join('');
  }

  _settlePrompt(pending, error, value) {
    if (this.pendingPrompts.get(pending.sessionId) !== pending) return;
    clearTimeout(pending.timer);
    this.pendingPrompts.delete(pending.sessionId);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  _assertAuthorized(senderId) {
    if (!this.bindings.isAuthorized(senderId)) throw new Error('无权执行 DSH Session 控制命令');
  }
}

module.exports = { DshControl };
