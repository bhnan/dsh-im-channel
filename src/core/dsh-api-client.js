'use strict';

const { randomUUID } = require('node:crypto');
const WebSocket = require('ws');

/** DSH 返回的业务错误。 */
class DshApiError extends Error {
  constructor(error) {
    super(error.message || error.code || 'DSH API 请求失败');
    this.name = 'DshApiError';
    this.code = error.code || 'internal';
    this.details = error.details || {};
  }
}

/** DSH Web Host 的认证 RPC 客户端。 */
class DshApiClient {
  constructor(options) {
    if (!options || !options.baseUrl) throw new Error('DshApiClient 需要 baseUrl');
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    this.username = options.username || '';
    this.password = options.password || '';
    this.fetch = options.fetch || globalThis.fetch;
    this.webSocketFactory = options.webSocketFactory || ((url, wsOptions) => new WebSocket(url, wsOptions));
    this.rpcIdFactory = options.rpcIdFactory || randomUUID;
    this.cookie = '';
    this.loginPromise = null;
    if (typeof this.fetch !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  }

  /** 调用一个 DSH unary RPC，并返回关联 id 与业务值。 */
  async call(method, payload = {}, options = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(method)) throw new Error(`非法 DSH API 方法: ${method}`);
    const rpcId = options.rpcId || this.rpcIdFactory();
    const body = { type: 'client-request', rpcId, method, payload };
    const response = await this._post(`/api/${method}`, body, options.signal);
    const envelope = await this._readJson(response, method);

    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !envelope.result) {
      throw new Error(`DSH API ${method} 返回了无效的 RPC 响应`);
    }
    if (!envelope.result.ok) throw new DshApiError(envelope.result.error || {});
    return { rpcId, value: envelope.result.value };
  }

  /** 回答 DSH 发起的审批或提问。 */
  async respond(rpcId, value, options = {}) {
    const body = { type: 'client-response', rpcId, result: { ok: true, value } };
    const response = await this._post('/api/respond', body, options.signal);
    return this._readJson(response, 'respond');
  }

  /** 连接 DSH mux WebSocket，并把合法 server-request 交给调用方。 */
  async connectMux(handlers = {}, options = {}) {
    const signal = options.signal;
    if (this.username && this.password && !this.cookie) await this._login(signal);

    const url = new URL(`${this.baseUrl}/api/events.mux`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = this.cookie ? { Cookie: this.cookie } : {};
    const socket = this.webSocketFactory(url.toString(), { headers });

    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanupOpening();
        resolve();
      };
      const onError = (error) => {
        cleanupOpening();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => {
        cleanupOpening();
        socket.close();
        reject(signal.reason || new Error('DSH mux 连接已取消'));
      };
      const cleanupOpening = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const onMessage = (data) => {
      try {
        const envelope = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
        if (envelope.type !== 'server-request' || !envelope.rpcId || !envelope.method) return;
        handlers.onFrame?.({ rpcId: envelope.rpcId, method: envelope.method, payload: envelope.payload });
      } catch (error) {
        handlers.onInvalidFrame?.(error);
      }
    };
    const onClose = (code, reason) => handlers.onClose?.(code, Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || ''));
    const onError = (error) => handlers.onError?.(error);
    const onAbort = () => socket.close();
    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    handlers.onOpen?.();

    return {
      socket,
      close() {
        signal?.removeEventListener('abort', onAbort);
        socket.close();
      },
    };
  }

  async _post(path, body, signal) {
    let response = await this._fetchJson(path, body, signal);
    if (response.status !== 401) return this._requireTransportSuccess(response, path);
    await this._login(signal);
    response = await this._fetchJson(path, body, signal);
    return this._requireTransportSuccess(response, path);
  }

  async _fetchJson(path, body, signal) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    return this.fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  async _login(signal) {
    if (!this.username || !this.password) {
      throw new Error('DSH Web Host 需要认证，请配置 dshApiUsername 和 dshApiPassword');
    }
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this._performLogin(signal).finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async _performLogin(signal) {
    const response = await this.fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal,
    });
    this._requireTransportSuccess(response, 'auth/login');
    const setCookie = response.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0].trim();
    if (!cookie) throw new Error('DSH 登录成功但未返回会话 Cookie');
    this.cookie = cookie;
  }

  _requireTransportSuccess(response, path) {
    if (response.ok) return response;
    throw new Error(`DSH API ${path} 请求失败: HTTP ${response.status}`);
  }

  async _readJson(response, method) {
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`DSH API ${method} 返回了无效 JSON: ${error.message}`);
    }
  }
}

module.exports = { DshApiClient, DshApiError };
