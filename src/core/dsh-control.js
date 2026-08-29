'use strict';

const { randomUUID } = require('node:crypto');
const { deriveScopeKey } = require('./session-bindings');

/** 通过 DSH Web Host 官方 RPC 控制共享 Session。 */
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
    this.connection = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.pendingPrompts = new Map();
    this.currentTurns = new Map();
  }

  /** 启动 mux 事件连接。 */
  async start() {
    if (this.connection) return;
    this.stopped = false;
    await this._connect();
  }

  /** 停止事件连接并拒绝未完成的调用。 */
  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connection?.close();
    this.connection = null;
    for (const pending of this.pendingPrompts.values()) pending.reject(new Error('DSH 控制服务已停止'));
    this.pendingPrompts.clear();
  }

  /** 列出 DSH Host 中的 Session。 */
  async listSessions() {
    const result = await this.api.call('session.list', {});
    return result.value.items;
  }

  /** 创建一个正式 DSH Session。 */
  async createSession(options = {}) {
    const result = await this.api.call('session.create', options);
    return result.value.sessionId;
  }

  /** 解析当前飞书范围绑定的 DSH Session。 */
  async resolveSession(message, accountId, fallbackSessionId) {
    return this.bindings.resolve(deriveScopeKey(message, accountId), fallbackSessionId);
  }

  /** 将当前飞书范围切换到一个已存在的 DSH Session。 */
  async switchSession(message, accountId, sessionId) {
    this._assertAuthorized(message.senderId);
    const sessions = await this.listSessions();
    if (!sessions.some((item) => item.sessionId === sessionId)) throw new Error(`DSH Session 不存在: ${sessionId}`);
    return this.bindings.bind(deriveScopeKey(message, accountId), sessionId);
  }

  /** 读取一个 Session 可选择的模型目录。 */
  async models(sessionId) {
    return (await this.api.call('session.models', { sessionId })).value;
  }

  /** 修改一个 Session 的模型。 */
  async selectModel(sessionId, selection) {
    const result = await this.api.call('session.selectModel', { sessionId, ...selection });
    return result.value.selected;
  }

  /** 向共享 Session 发送文本，并收集该 turn 的流式输出。 */
  async prompt(sessionId, text, handlers = {}) {
    if (this.pendingPrompts.has(sessionId)) throw new Error(`DSH Session 正在处理另一条消息: ${sessionId}`);
    const rpcId = this.rpcIdFactory();
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const pending = {
      rpcId,
      sessionId,
      turn: null,
      text: '',
      onDelta: handlers.onDelta,
      onApproval: handlers.onApproval,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timer: null,
    };
    pending.timer = setTimeout(() => {
      this._settlePrompt(pending, new Error(`DSH 响应超时: ${sessionId}`));
    }, this.promptTimeoutMs);
    this.pendingPrompts.set(sessionId, pending);

    try {
      const result = await this.api.call('session.prompt', {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, { rpcId });
      if (result.value.command) {
        const commandText = result.value.command.text || '命令已执行';
        this._settlePrompt(pending, null, { text: commandText, command: true });
      } else if (!result.value.accepted) {
        this._settlePrompt(pending, new Error('DSH 未接受消息'));
      }
    } catch (error) {
      this._settlePrompt(pending, error);
    }
    return completion;
  }

  /** 回答 DSH 的一次原生工具审批。 */
  async answerApproval(request, outcome) {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') throw new Error(`不支持的审批结果: ${outcome}`);
    return this.api.respond(request.rpcId, {
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      outcome,
    });
  }

  async _connect() {
    this.connection = await this.api.connectMux({
      onFrame: (frame) => this._handleFrame(frame),
      onClose: () => this._handleDisconnect(),
      onError: (error) => this.log(`[dsh-control] mux 错误: ${error.message}`),
      onInvalidFrame: (error) => this.log(`[dsh-control] 忽略无效 mux 消息: ${error.message}`),
    });
  }

  _handleDisconnect() {
    this.connection = null;
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this._connect();
      } catch (error) {
        this.log(`[dsh-control] mux 重连失败: ${error.message}`);
        this._handleDisconnect();
      }
    }, this.reconnectDelayMs);
  }

  _handleFrame(envelope) {
    const frame = envelope.payload;
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'approval/requested') {
      const pending = this.pendingPrompts.get(frame.sessionId);
      pending?.onApproval?.({ rpcId: envelope.rpcId, ...frame });
      return;
    }
    if (frame.type !== 'session/event') return;
    const pending = this.pendingPrompts.get(frame.sessionId);
    const event = frame.event;
    if (event.type === 'turn/start') {
      this.currentTurns.set(frame.sessionId, event.data.turn);
      return;
    }
    if (!pending) return;
    if (event.type === 'user/message' && event.data.source?.rpcId === pending.rpcId) {
      pending.turn = this.currentTurns.get(frame.sessionId);
      return;
    }
    if (pending.turn === null || event.data.turn !== pending.turn) return;
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
      this._settlePrompt(pending, null, { text: pending.text, command: false });
    }
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
