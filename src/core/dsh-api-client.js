'use strict';

const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const WebSocket = require('ws');

const CREDENTIALS_KEY = 'client-connection/browser-session';
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** DSH 返回的业务错误。 */
class DshApiError extends Error {
  constructor(error) {
    super(error.message || error.code || 'DSH API 请求失败');
    this.name = 'DshApiError';
    this.code = error.code || 'internal';
    this.details = error.details || {};
  }
}

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** dsh 0.1.2 browser-auth 的 Cookie 名：dsh-auth-<base64url(sha256(authority))>。 */
function sessionCookieName(authority) {
  return 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
}

/**
 * 按同样公式离线铸造 dsh 0.1.2 的浏览器会话 Cookie（无需 launch token 交换）。
 * @param {string} authority - 请求 Host 头 authority（如 127.0.0.1:3081）。
 * @param {string} secretB64url - 凭据存储中的 base64url 32 字节签名密钥。
 * @param {number} nowMs - 签发时间戳。
 * @returns {{cookie: string, expiresAt: number}} 可直接放入 Cookie 头的键值。
 */
function mintSessionCookie(authority, secretB64url, nowMs, ttlMs = COOKIE_TTL_MS) {
  const secret = Buffer.from(secretB64url, 'base64');
  if (secret.byteLength !== 32) throw new Error('browser-session secret 必须是 base64url 编码的 32 字节');
  const payload = { version: 1, authority, issuedAt: nowMs, expiresAt: nowMs + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = b64url(createHmac('sha256', secret).update(body).digest());
  const name = sessionCookieName(authority);
  return { cookie: `${name}=v1.${body}.${signature}`, expiresAt: nowMs + ttlMs };
}

/**
 * 从 $DSH_HOME/.credentials.yaml 提取 browser-session 签名密钥。
 * 只做定向解析（键行之后的第一个 secret: 行），不引入 YAML 依赖。
 */
function parseCredentialsSecret(text, key = CREDENTIALS_KEY) {
  const lines = String(text).split(/\r?\n/);
  const keyLine = lines.findIndex((line) => line.trim() === `${key}:`);
  if (keyLine === -1) return undefined;
  for (let i = keyLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^\s+secret:\s*(\S+)\s*$/);
    if (match) return match[1];
    // 进入下一条同级记录仍未命中则放弃（secret 只出现在自身 payload 内）。
    if (i > keyLine && /^\S/.test(lines[i])) return undefined;
  }
  return undefined;
}

/** DSH Web Host (dsh >= 0.1.2 Gateway wire) 的认证 RPC + 流客户端。 */
class DshApiClient {
  constructor(options) {
    if (!options || !options.baseUrl) throw new Error('DshApiClient 需要 baseUrl');
    this.baseUrl = String(options.baseUrl).replace(/\/+$/, '');
    this.dshHome = options.dshHome || '';
    this.token = options.token || '';
    this.username = options.username || '';
    this.password = options.password || '';
    this.fetch = options.fetch || globalThis.fetch;
    this.webSocketFactory = options.webSocketFactory || ((url, wsOptions) => new WebSocket(url, wsOptions));
    this.rpcIdFactory = options.rpcIdFactory || randomUUID;
    this.readCredentialsFile = options.readCredentialsFile
      || ((file) => fs.readFileSync(file, 'utf8'));
    this.log = options.log || (() => {});
    this.cookie = '';
    this.loginPromise = null;
    this.socket = null;
    this.socketOpening = null;
    this.streams = new Map();
    if (typeof this.fetch !== 'function') throw new Error('当前 Node.js 环境不支持 fetch');
  }

  /** 解析请求 authority（与 dsh browser-auth 的 Host 头规则一致）。 */
  _authority() {
    return new URL(this.baseUrl).host;
  }

  /**
   * 确保已持有会话 Cookie。按优先级：
   * launch token 交换 → 用户名/密码登录（auth-basic 兼容）→ 凭据文件离线铸造。
   */
  async ensureAuth(signal) {
    if (this.cookie) return;
    if (!this.loginPromise) {
      this.loginPromise = this._authenticate(signal).finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  async _authenticate(signal) {
    const cookies = [];
    const errors = [];
    if (this.token) {
      try {
        const cookie = await this._exchangeToken(signal);
        if (cookie) cookies.push(cookie);
        else errors.push('launch token 交换失败（token 已随 Host 重启失效？请更新 dshApiToken）');
      } catch (error) {
        errors.push(`launch token 交换失败: ${error.message}`);
      }
    }
    if (this.username && this.password) {
      try {
        await this._legacyLogin(signal);
        if (this.cookie) cookies.push(this.cookie);
      } catch (error) {
        errors.push(`账号密码登录失败: ${error.message}`);
      }
    }
    // 双层鉴权主机：auth-basic 的会话 Cookie 过守卫，核心 browser-auth 还要
    // 自己的 dsh-auth- Cookie——凭据文件可用时铸造一枚补上。
    if (this.dshHome) {
      try {
        const minted = this._mintCookieFromCredentials();
        if (!cookies.some((cookie) => cookie.startsWith('dsh-auth-'))) cookies.push(minted);
      } catch (e) {
        this.log(`[dsh-api] 核心 Cookie 铸造跳过: ${e.message}`);
      }
    }
    if (!cookies.length) {
      throw new Error(`DSH Web Host 认证失败：${errors.join('；') || '无可用认证方式'}`);
    }
    this.cookie = cookies.join('; ');
  }

  /** 用配置中的 launch token 换取持久 Cookie（GET /?token= → Set-Cookie）。 */
  async _exchangeToken(signal) {
    const response = await this.fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.token)}`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal,
    });
    await response.arrayBuffer().catch(() => {});
    if (response.status !== 303) return '';
    return (response.headers.get('set-cookie') || '').split(';')[0].trim();
  }

  /** 旧 auth-basic 插件主机的用户名/密码登录（核心 dsh 无此路由，仅兼容保留）。 */
  async _legacyLogin(signal) {
    const response = await this.fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal,
    });
    this._requireTransportSuccess(response, 'auth/login');
    const cookie = (response.headers.get('set-cookie') || '').split(';')[0].trim();
    if (!cookie) throw new Error('DSH 登录成功但未返回会话 Cookie');
    this.cookie = cookie;
  }

  /** 从 $DSH_HOME/.credentials.yaml 的 browser-session 记录离线铸造 Cookie。 */
  _mintCookieFromCredentials() {
    if (!this.dshHome) {
      throw new Error('DSH Web Host 需要认证：请配置 dshApiToken（launch token）或 dshApiUsername/dshApiPassword，或确保 dshHome 可读');
    }
    const file = `${this.dshHome.replace(/\/+$/, '')}/.credentials.yaml`;
    let secret;
    try {
      secret = parseCredentialsSecret(this.readCredentialsFile(file));
    } catch (error) {
      throw new Error(`DSH Web Host 认证失败：无法读取 ${file} (${error.message})`);
    }
    if (!secret) {
      throw new Error(`DSH Web Host 认证失败：${file} 中没有 ${CREDENTIALS_KEY} 记录（Host 至少启动过一次后才会生成）`);
    }
    const { cookie } = mintSessionCookie(this._authority(), secret, Date.now());
    return cookie;
  }

  /** 调用一个 DSH unary RPC（Gateway wire：POST /api/<namespace>/<method>，args 单对象），返回业务值。 */
  async call(method, args = {}, options = {}) {
    if (!/^[a-zA-Z][a-zA-Z0-9_$.~/-]*$/.test(method)) throw new Error(`非法 DSH API 方法: ${method}`);
    // 预认证失败不在此处报错：无认证配置的部署靠 401 重试路径暴露真实原因。
    await this.ensureAuth(options.signal).catch(() => {});
    const rpcId = options.rpcId || this.rpcIdFactory();
    const body = { type: 'client-request', rpcId, method, payload: { args } };
    let response = await this._post(`/api/${method}`, body, options.signal);
    let envelope = await this._readJson(response, method);
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || !envelope.result) {
      throw new Error(`DSH API ${method} 返回了无效的 RPC 响应`);
    }
    if (!envelope.result.ok) throw new DshApiError(envelope.result.error || {});
    return { rpcId, value: envelope.result.value };
  }

  /**
   * 打开（或复用已连接的）Gateway WebSocket mux 上的一个 Remote 流。
   * @returns {{streamId: string, close: () => void}} close 发送 cancel 并解除本地路由。
   */
  async openStream(endpoint, args, handlers = {}) {
    await this.ensureAuth();
    const streamId = this.rpcIdFactory();
    const socket = await this._ensureSocket();
    const stream = { endpoint, args, handlers };
    this.streams.set(streamId, stream);
    this._send(socket, { type: 'open', streamId, endpoint, payload: { args } });
    return {
      streamId,
      close: () => {
        if (!this.streams.has(streamId)) return;
        this.streams.delete(streamId);
        if (socket.readyState === 1) this._send(socket, { type: 'cancel', streamId });
      },
    };
  }

  /** 关闭全部流与底层连接（停止桥接时调用）。 */
  closeStreams() {
    for (const [streamId] of this.streams) {
      if (this.socket && this.socket.readyState === 1) this._send(this.socket, { type: 'cancel', streamId });
    }
    this.streams.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
      this.socketOpening = null;
    }
  }

  _send(socket, message) {
    socket.send(JSON.stringify(message));
  }

  _ensureSocket() {
    if (this.socket && this.socket.readyState === 1) return Promise.resolve(this.socket);
    if (this.socketOpening) return this.socketOpening;
    const url = new URL(`${this.baseUrl}/api/remote.mux`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = this.webSocketFactory(url.toString(), { headers: { cookie: this.cookie } });
    this.socket = socket;
    this.socketOpening = new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error) => {
        cleanup();
        this.socket = null;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    socket.on('message', (data) => this._handleSocketMessage(socket, data));
    socket.on('close', () => this._handleSocketClose());
    socket.on('error', (error) => this.log(`[dsh-api] mux 连接错误: ${error.message}`));
    return this.socketOpening;
  }

  _handleSocketMessage(socket, data) {
    let frame;
    try {
      frame = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch (error) {
      this.log(`[dsh-api] 忽略无效 mux 消息: ${error.message}`);
      return;
    }
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    if (frame.type === 'item') {
      try {
        stream.handlers.onItem?.(frame.value);
      } catch (error) {
        this.log(`[dsh-api] 流 ${frame.streamId} 处理帧失败: ${error.message}`);
      }
      return;
    }
    if (frame.type === 'error') {
      this.streams.delete(frame.streamId);
      stream.handlers.onError?.(new DshApiError(frame.error || {}));
    }
  }

  _handleSocketClose() {
    this.socket = null;
    this.socketOpening = null;
    const broken = [...this.streams.values()];
    this.streams.clear();
    for (const stream of broken) {
      stream.handlers.onError?.(new DshApiError({ code: 'disconnected', message: 'DSH mux 连接已断开' }));
    }
  }

  async _post(path, body, signal) {
    let response = await this._fetchJson(path, body, signal);
    if (response.status !== 401) return this._requireTransportSuccess(response, path);
    // Cookie 失效（Host 重启换密钥等）：清空后重认证再试一次。
    this.cookie = '';
    await this.ensureAuth(signal);
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

  /** 旧 auth-basic 插件主机的登录流程。 */
  async _legacyLogin(signal) {
    if (!this.username || !this.password) {
      throw new Error('DSH Web Host 需要认证，请配置 dshApiUsername 和 dshApiPassword');
    }
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

module.exports = {
  DshApiClient,
  DshApiError,
  mintSessionCookie,
  parseCredentialsSecret,
  sessionCookieName,
};
