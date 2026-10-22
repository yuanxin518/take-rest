// 订阅拉取：取 GitHub raw 文本（先直连，失败自动回退系统代理；支持重定向/超时），
// 并支持 file:// 本地订阅源（端到端自检用），最后把 manifest 里的动作包同步到本地缓存。
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const http = require('node:http');
const zlib = require('node:zlib');
const { URL, fileURLToPath } = require('node:url');
const { execSync } = require('node:child_process');

const store = require('./engine/store');

const USER_AGENT = 'gongwei-tixing';
const TIMEOUT_MS = 20000;
const DIRECT_TIMEOUT_MS = 6000; // 直连超时压短：用户在面板点「添加订阅」不能干等
const PROXY_TIMEOUT_MS = 20000;
const DIRECT_FAIL_MEMORY_MS = 90 * 1000; // 直连刚失败过的这段时间内，后续请求直接走代理，不再每条都等 6s

// 直连失败记忆：一台机器上直连坏掉通常是整段时间坏，不是单个 URL 坏。
// 订阅一次要连 manifest + N 个 pack，不记忆的话每个都要先等满直连超时。
const directState = { failedAt: 0 };
function markDirectBroken() {
  directState.failedAt = Date.now();
}
function directRecentlyBroken() {
  return directState.failedAt > 0 && Date.now() - directState.failedAt < DIRECT_FAIL_MEMORY_MS;
}
function resetDirectState() {
  directState.failedAt = 0;
}
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB 上限，防止拉到大文件把内存吃满
const REGISTRY_FORMAT = store.REGISTRY_FORMAT;
const PACK_FORMAT = store.PACK_FORMAT;

function log(...args) {
  try {
    console.log('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

function logWarn(...args) {
  try {
    console.warn('[提醒]', ...args);
  } catch (_e) {
    /* 忽略 */
  }
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 「改用系统代理」日志去重：3 秒内只打一次（同一次同步里 manifest + pack 接连触发） */
let lastProxyLogAt = 0;
function shouldAnnounceProxy() {
  const now = Date.now();
  if (now - lastProxyLogAt < 3000) return false;
  lastProxyLogAt = now;
  return true;
}

/* ------------------------------------------------------------------ *
 * 系统代理发现
 * ------------------------------------------------------------------ */

/** 解析各种代理写法：`http://127.0.0.1:7890` / `127.0.0.1:7890` / `host:port` / 带 auth */
function parseProxy(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  // 去掉可能的 scheme
  let rest = s.replace(/^[a-z]+:\/\//i, '');
  // 去掉路径部分
  rest = rest.split('/')[0];
  let auth = null;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    auth = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host = rest;
  let port = 80;
  const m = /^\[(.+)\]:(\d+)$/.exec(rest) || /^([^:]+):(\d+)$/.exec(rest);
  if (m) {
    host = m[1];
    port = Number(m[2]);
  } else if (rest.startsWith('[') && rest.endsWith(']')) {
    host = rest.slice(1, -1);
  }
  if (!host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return { host, port, auth, raw: s };
}

/**
 * 读注册表：ProxyEnable + ProxyServer（只读，不改用户设置）。
 * 注意：很多代理软件（Clash / v2ray 等）开着端口但 ProxyEnable=0（用户没开「使用系统代理」）。
 * 那种情况下 ProxyServer 里仍有可用地址，作为「弱信号」回退候选返回，标记 enabled:false。
 * 优先级上启用状态优先于未启用状态。
 */
function readWindowsSystemProxy() {
  if (process.platform !== 'win32') return null;
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query = (value) => {
    try {
      const out = execSync(`reg query "${KEY}" /v ${value}`, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      return out || '';
    } catch (_e) {
      return '';
    }
  };

  const enableRaw = query('ProxyEnable');
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableRaw);

  const serverRaw = query('ProxyServer');
  const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(serverRaw);
  if (!m) return null;
  const servers = m[1].trim();

  // ProxyServer 可能是 "127.0.0.1:7890"，也可能是按协议分组的 "http=host:port;https=host:port"
  let parsed = null;
  if (servers.includes('=')) {
    const map = {};
    for (const part of servers.split(';')) {
      const [k, v] = part.split('=');
      if (k && v) map[k.trim().toLowerCase()] = v.trim();
    }
    parsed = parseProxy(map.https || map.http || '');
  } else {
    parsed = parseProxy(servers);
  }
  if (!parsed) return null;
  return { ...parsed, enabled };
}

/**
 * 找出可用的系统代理（按优先级），返回 { host, port, auth, raw, from } 或 null。
 * 顺序：HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy → Windows 注册表（启用优先）。
 */
function detectSystemProxy() {
  const envNames = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
  for (const name of envNames) {
    const val = process.env[name];
    if (val && val.trim()) {
      const proxied = parseProxy(val);
      if (proxied) return { ...proxied, from: `环境变量 ${name}` };
    }
  }
  const fromRegistry = readWindowsSystemProxy();
  if (fromRegistry) {
    return {
      ...fromRegistry,
      from: fromRegistry.enabled ? 'Windows 系统代理' : 'Windows 注册表代理（ProxyEnable=0，仅作回退候选）'
    };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 传输：直连（node:https） + 代理 CONNECT 隧道（手写 HTTP/1.1）
 * ------------------------------------------------------------------ */

/** 把底层错误翻译成人能看懂的中文原因 */
function describeError(e) {
  const code = e && e.code ? e.code : '';
  const map = {
    ETIMEDOUT: '连接超时（ETIMEDOUT）',
    ESOCKETTIMEDOUT: '连接超时（ESOCKETTIMEDOUT）',
    ECONNRESET: '连接被重置（ECONNRESET）',
    ECONNREFUSED: '连接被拒绝（ECONNREFUSED）',
    ENOTFOUND: '域名解析失败（ENOTFOUND）',
    EAI_AGAIN: '域名解析失败（EAI_AGAIN）',
    EHOSTUNREACH: '主机不可达（EHOSTUNREACH）',
    ENETUNREACH: '网络不可达（ENETUNREACH）',
    EPROTO: 'TLS 握手失败（EPROTO）',
    CERT_HAS_EXPIRED: '证书已过期',
    DEPTH_ZERO_SELF_SIGNED_CERT: '证书自签名不受信任',
    ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配'
  };
  if (code && map[code]) return map[code];
  if (code) return `${code}（${(e && e.message) || ''}）`;
  return (e && e.message) || '未知网络错误';
}

/** 解压 gzip/deflate/br 响应体（代理隧道请求会带 Accept-Encoding） */
function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br' && typeof zlib.brotliDecompressSync === 'function') return zlib.brotliDecompressSync(buf);
  } catch (_e) {
    /* 解压失败就按原文返回 */
  }
  return buf;
}

/** URL → 请求行用的 path */
function requestPath(parsed) {
  return `${parsed.pathname || '/'}${parsed.search || ''}`;
}

/**
 * 直连：用 node:http / node:https 发 GET。
 * 超时用独立的硬计时器（req.setTimeout 只在 socket 空闲时触发，DNS/TCP 卡住时不会响）。
 * @returns {Promise<{ok:boolean, status:number, headers:object, body:Buffer, error?:string, code?:string, via:string}>}
 */
function httpsDirect(parsed, headers, timeoutMs) {
  return new Promise((resolve) => {
    const mod = parsed.protocol === 'http:' ? http : https;
    let settled = false;
    let req = null;
    let hardTimer = null;

    const done = (r) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (req && (r.code === 'ETIMEDOUT' || r.error)) {
        try {
          req.destroy();
        } catch (_e) {
          /* 忽略 */
        }
      }
      resolve({ via: 'direct', ...r });
    };

    // 硬超时：覆盖 DNS 解析 / TCP 握手 / TLS 握手全阶段
    hardTimer = setTimeout(() => {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: '连接超时（ETIMEDOUT）', code: 'ETIMEDOUT' });
    }, timeoutMs);

    try {
      req = mod.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || undefined,
          path: requestPath(parsed),
          method: 'GET',
          headers,
          // 让 TCP 连接阶段也受控（默认 OS 级超时太长）
          agent: false
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy();
              done({ ok: false, status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.alloc(0), error: `响应超过 ${MAX_BODY_BYTES} 字节上限`, code: 'TOO_LARGE' });
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            done({
              ok: true,
              status: res.statusCode || 0,
              headers: res.headers || {},
              body: decodeBody(raw, res.headers && res.headers['content-encoding'])
            });
          });
          res.on('error', (e) => done({ ok: false, status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.alloc(0), error: describeError(e), code: (e && e.code) || 'RES_ERROR' }));
        }
      );
    } catch (e) {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: describeError(e), code: (e && e.code) || 'REQ_ERROR' });
      return;
    }

    req.setTimeout(timeoutMs, () => {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: '连接超时（ETIMEDOUT）', code: 'ETIMEDOUT' });
    });
    req.on('error', (e) => done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: describeError(e), code: (e && e.code) || 'REQ_ERROR' }));
    req.end();
  });
}

/**
 * 代理：HTTP CONNECT 打隧道 → tls.connect → 手写最小 HTTP/1.1 请求 → 按 Content-Length / chunked 收 body。
 * 零依赖实现，只用 node:net / node:tls / node:http。
 */
function httpsViaProxy(parsed, headers, proxy, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const done = (r) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        if (socket) socket.destroy();
      } catch (_e) {
        /* 忽略 */
      }
      resolve({ via: 'proxy', proxy: `${proxy.host}:${proxy.port}`, ...r });
    };

    if (!proxy) {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: '没有可用的系统代理', code: 'NO_PROXY' });
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const targetPort = Number(parsed.port) || (isHttps ? 443 : 80);
    const targetHost = parsed.hostname;

    timer = setTimeout(() => {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `${describeError({ code: 'ETIMEDOUT' })}（代理 ${proxy.host}:${proxy.port}）`, code: 'ETIMEDOUT' });
    }, timeoutMs);

    // 1) 建 CONNECT 隧道
    const connectHeaders = { Host: `${targetHost}:${targetPort}`, 'User-Agent': USER_AGENT };
    if (proxy.auth) {
      connectHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth, 'utf8').toString('base64')}`;
    }

    let connectReq;
    try {
      connectReq = http.request({
        method: 'CONNECT',
        host: proxy.host,
        port: proxy.port,
        path: `${targetHost}:${targetPort}`,
        headers: connectHeaders
      });
    } catch (e) {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `代理请求创建失败：${describeError(e)}`, code: (e && e.code) || 'PROXY_REQ_ERROR' });
      return;
    }

    connectReq.on('connect', (res, proxySocket, head) => {
      socket = proxySocket;
      if (res.statusCode !== 200) {
        done({ ok: false, status: res.statusCode || 0, headers: {}, body: Buffer.alloc(0), error: `代理拒绝了 CONNECT（HTTP ${res.statusCode}）`, code: 'PROXY_CONNECT_DENIED' });
        return;
      }
      startTunnel(head);
    });
    connectReq.on('error', (e) => {
      done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `${describeError(e)}`, code: (e && e.code) || 'PROXY_ERROR' });
    });
    connectReq.end();

    // 2) 隧道建好后：TLS 握手（https）或直接明文（http），再手写请求
    function startTunnel(head) {
      let stream;
      if (isHttps) {
        try {
          stream = tls.connect({ socket, servername: targetHost, ALPNProtocols: ['http/1.1'] }, onTlsReady);
        } catch (e) {
          done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `TLS 握手失败：${describeError(e)}`, code: (e && e.code) || 'TLS_ERROR' });
          return;
        }
        stream.on('error', (e) => done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `TLS 握手失败：${describeError(e)}`, code: (e && e.code) || 'TLS_ERROR' }));
        socket.removeAllListeners('error');
        socket.on('error', (e) => done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `代理隧道出错：${describeError(e)}`, code: (e && e.code) || 'TUNNEL_ERROR' }));
      } else {
        stream = socket;
        onTlsReady();
      }

      function onTlsReady() {
        if (head && head.length) {
          // CONNECT 响应里可能已经带了起始字节
          stream.unshift ? stream.unshift(head) : null;
        }
        const reqHeaders = {
          Host: parsed.host || targetHost,
          'User-Agent': USER_AGENT,
          Accept: 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'close',
          ...headers
        };
        // 逐行拼请求（不依赖 http 库）
        const lines = [`GET ${requestPath(parsed)} HTTP/1.1`];
        for (const [k, v] of Object.entries(reqHeaders)) {
          if (v === undefined || v === null) continue;
          lines.push(`${k}: ${v}`);
        }
        const payload = `${lines.join('\r\n')}\r\n\r\n`;
        try {
          stream.write(payload);
        } catch (e) {
          done({ ok: false, status: 0, headers: {}, body: Buffer.alloc(0), error: `发送请求失败：${describeError(e)}`, code: (e && e.code) || 'WRITE_ERROR' });
          return;
        }
        collectResponse(stream);
      }
    }

    // 3) 手写响应解析：状态行 + 头 + body（Content-Length / chunked / 读到关闭）
    function collectResponse(stream) {
      let buf = Buffer.alloc(0);
      let headersDone = false;
      let status = 0;
      let resHeaders = {};
      let bodyChunks = [];
      let bodyLen = 0;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        const body = decodeBody(Buffer.concat(bodyChunks), resHeaders['content-encoding']);
        done({ ok: true, status, headers: resHeaders, body });
      };

      stream.on('data', (chunk) => {
        if (finished) return;
        buf = Buffer.concat([buf, chunk]);
        if (bodyLen + buf.length > MAX_BODY_BYTES * 2) {
          done({ ok: false, status, headers: resHeaders, body: Buffer.alloc(0), error: `响应超过 ${MAX_BODY_BYTES} 字节上限`, code: 'TOO_LARGE' });
          return;
        }

        if (!headersDone) {
          const sep = buf.indexOf('\r\n\r\n');
          if (sep < 0) return;
          const headText = buf.slice(0, sep).toString('utf8');
          buf = buf.slice(sep + 4);
          const headLines = headText.split('\r\n');
          const statusLine = headLines.shift() || '';
          const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine);
          status = m ? Number(m[1]) : 0;
          resHeaders = {};
          for (const line of headLines) {
            const idx = line.indexOf(':');
            if (idx <= 0) continue;
            const k = line.slice(0, idx).trim().toLowerCase();
            const v = line.slice(idx + 1).trim();
            resHeaders[k] = resHeaders[k] ? `${resHeaders[k]}, ${v}` : v;
          }
          headersDone = true;
        }

        if (!headersDone) return;

        const te = String(resHeaders['transfer-encoding'] || '').toLowerCase();
        const cl = resHeaders['content-length'] !== undefined ? Number(resHeaders['content-length']) : null;

        if (te.includes('chunked')) {
          // 增量解析 chunked
          const parsedChunks = [];
          let pos = 0;
          let complete = false;
          while (pos < buf.length) {
            const lineEnd = buf.indexOf('\r\n', pos);
            if (lineEnd < 0) break;
            const sizeLine = buf.slice(pos, lineEnd).toString('ascii').trim();
            const size = parseInt(sizeLine.split(';')[0], 16);
            if (!Number.isFinite(size)) { complete = true; break; }
            if (size === 0) { complete = true; pos = lineEnd + 2; break; }
            const dataStart = lineEnd + 2;
            if (dataStart + size + 2 > buf.length) break; // 数据没到齐
            parsedChunks.push(buf.slice(dataStart, dataStart + size));
            pos = dataStart + size + 2;
          }
          if (complete) {
            bodyChunks = parsedChunks;
            finish();
          } else {
            // 没解析完：先只保留已解析数据，继续等
            bodyChunks = parsedChunks;
            buf = buf.slice(pos);
          }
          return;
        }

        if (cl !== null && Number.isFinite(cl)) {
          bodyChunks = [buf];
          bodyLen = buf.length;
          if (bodyLen >= cl) {
            bodyChunks = [buf.slice(0, cl)];
            finish();
          }
          return;
        }

        // 没有长度信息：读到连接关闭为止
        bodyChunks = [buf];
        buf = Buffer.alloc(0);
      });

      stream.on('end', () => {
        if (!finished && headersDone) {
          const cl = resHeaders['content-length'] !== undefined ? Number(resHeaders['content-length']) : null;
          const full = Buffer.concat(bodyChunks);
          finishWith(full, cl);
        }
      });
      const finishWith = (full, cl) => {
        if (finished) return;
        finished = true;
        const body = decodeBody(cl !== null && Number.isFinite(cl) ? full.slice(0, cl) : full, resHeaders['content-encoding']);
        done({ ok: true, status, headers: resHeaders, body });
      };
      stream.on('error', (e) => done({ ok: false, status, headers: resHeaders, body: Buffer.alloc(0), error: `代理隧道读取失败：${describeError(e)}`, code: (e && e.code) || 'TUNNEL_READ_ERROR' }));
    }
  });
}

/**
 * GET 一个文本资源，返回 { ok, status, url, text }（永不 reject，便于直接当 IPC 返回值）。
 * 传输策略：先直连（默认 6s 短超时），失败后自动回退系统代理（CONNECT 隧道）；跟随 3xx（最多 5 跳）。
 * 另外支持 file:// 协议：只读本地文件返回文本，status 视作 200；读不到返回 status: null + 中文 error。
 * @param {string} url http/https/file 地址，file 也接受 file:///C:/a/b.json 与 file:///C:/a/（目录自动补 manifest.json）
 * @param {object} [options] { timeoutMs, directTimeoutMs, maxRedirects, headers, proxy }
 *        proxy 显式传入则跳过自动探测；传 false 表示强制不走代理（仅测直连用）
 */
function ghFetchText(url, options) {
  const opts = isObj(options) ? options : {};
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : TIMEOUT_MS;
  const directTimeoutMs =
    typeof opts.directTimeoutMs === 'number' && opts.directTimeoutMs > 0 ? opts.directTimeoutMs : DIRECT_TIMEOUT_MS;
  const maxRedirects = typeof opts.maxRedirects === 'number' && opts.maxRedirects >= 0 ? opts.maxRedirects : MAX_REDIRECTS;

  // 代理：显式传入优先，否则自动探测（环境变量 → Windows 注册表）
  let proxy = null;
  if (opts.proxy === false) proxy = null;
  else if (opts.proxy && typeof opts.proxy === 'object') proxy = opts.proxy;
  else proxy = detectSystemProxy();

  return new Promise((resolve) => {
    let redirects = 0;
    let proxyAnnounced = false; // 「改用系统代理」日志只打一次（manifest + 各 pack 共用）

    const fail = (error, status) => resolve({ ok: false, status: status || 0, url: String(url || ''), text: '', error });

    // file:// 走同步读文件，语义与 HTTP 分支对齐（成功 status 200 / 失败 status null）
    const fileFail = (error, target) =>
      resolve({ ok: false, status: null, url: String(target || url || ''), text: '', error });

    const readLocalFile = (target) => {
      let parsed;
      try {
        parsed = new URL(String(target));
      } catch (_e) {
        fileFail(`本地文件地址不合法：${String(target)}`, target);
        return;
      }
      if (parsed.protocol !== 'file:') {
        fileFail(`不是本地文件地址：${String(target)}`, target);
        return;
      }

      let filePath;
      try {
        filePath = fileURLToPath(parsed);
      } catch (e) {
        fileFail(`本地文件路径无法解析：${String(target)}（${e && e.message}）`, target);
        return;
      }

      const readOne = (p) => {
        const buf = fs.readFileSync(p);
        let text = buf.toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
        return text;
      };

      let text = null;
      let usedPath = filePath;
      try {
        let stat = null;
        try {
          stat = fs.statSync(filePath);
        } catch (_e) {
          stat = null;
        }
        if (stat && stat.isDirectory()) {
          // 目录订阅源：自动补 manifest.json
          usedPath = require('node:path').join(filePath, 'manifest.json');
        }
        text = readOne(usedPath);
      } catch (e) {
        const code = e && e.code ? e.code : '未知';
        let reason;
        if (code === 'ENOENT') reason = `本地文件不存在：${usedPath}`;
        else if (code === 'EISDIR') reason = `这是一个目录，不是文件：${usedPath}`;
        else if (code === 'EACCES' || code === 'EPERM') reason = `没有读取权限：${usedPath}`;
        else reason = `读取本地文件失败（${code}）：${usedPath}：${e && e.message}`;
        fileFail(reason, target);
        logWarn(`本地订阅源读取失败：${reason}`);
        return;
      }

      resolve({ ok: true, status: 200, url: parsed.toString(), text, filePath: usedPath });
    };

    /**
     * 一次 GET：先直连（短超时），失败后回退系统代理。
     * @param {string} target
     * @param {{viaProxy?:boolean}} [how] 重定向时沿用上一跳的成功方式
     */
    const request = (target, how) => {
      let parsed;
      try {
        parsed = new URL(String(target));
      } catch (_e) {
        fail(`网址不合法：${String(target)}`);
        return;
      }
      // 本地文件：不经 HTTP，直接读盘
      if (parsed.protocol === 'file:') {
        readLocalFile(target);
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        fail(`不支持的协议：${parsed.protocol}（只允许 http/https/file）`);
        return;
      }

      const headers = {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        ...(isObj(opts.headers) ? opts.headers : {})
      };

      // 已经确认走代理的（重定向后又一个 URL），就不再浪费一次直连超时；
      // 另外直连在最近 90 秒内已经失败过，也直接走代理（订阅要连好几次）
      const forceProxy = !!(how && how.viaProxy && proxy) || (!!proxy && directRecentlyBroken() && opts.forceDirect !== true);

      const handleResult = (res) => {
        const status = res.status || 0;

        // 3xx 重定向
        if (status >= 300 && status < 400 && res.headers && res.headers.location) {
          if (redirects >= maxRedirects) {
            fail(`重定向次数超过 ${maxRedirects} 次`, status);
            return;
          }
          redirects += 1;
          let next;
          try {
            next = new URL(res.headers.location, parsed).toString();
          } catch (_e) {
            fail(`重定向地址不合法：${res.headers.location}`, status);
            return;
          }
          const nextProtocol = new URL(next).protocol;
          request(next, { viaProxy: nextProtocol === 'https:' ? res.via === 'proxy' : false });
          return;
        }

        const text = res.body ? res.body.toString('utf8') : '';
        if (status >= 200 && status < 300) {
          resolve({ ok: true, status, url: parsed.toString(), text, via: res.via });
        } else if (status === 404) {
          resolve({ ok: false, status, url: parsed.toString(), text, error: `404 找不到资源：${parsed.toString()}`, via: res.via });
        } else if (status === 0) {
          resolve({ ok: false, status: 0, url: parsed.toString(), text: '', error: res.error || '请求失败', via: res.via });
        } else {
          resolve({ ok: false, status, url: parsed.toString(), text, error: `HTTP ${status}`, via: res.via });
        }
      };

      const tryProxy = (directError) => {
        if (!proxy) {
          // 没有代理可回退：把直连原因如实报出去
          fail(`${directError.error}（未检测到系统代理，可设置 HTTPS_PROXY 后重试）`);
          return;
        }
        markDirectBroken(); // 记住：直连坏了，后续请求别再一条条等超时
        const directCode = directError.code || directError.error;
        // 同一次同步里只提示一次，避免 manifest + 每个 pack 各刷一行
        if (!proxyAnnounced && shouldAnnounceProxy()) {
          proxyAnnounced = true;
          log(`直连失败（${directCode}），改用系统代理 ${proxy.host}:${proxy.port} 重试`);
        }
        httpsViaProxy(parsed, headers, proxy, PROXY_TIMEOUT_MS).then((res) => {
          if (res.ok && res.status > 0) {
            handleResult(res);
            return;
          }
          // 两边都失败：把两个原因都写进错误里，面板上能直接看出是哪一段断了
          const proxyReason = String(res.error || '失败');
          const prefix = `${proxy.host}:${proxy.port}`;
          fail(
            `直连 ${directError.error}；代理 ${proxyReason.startsWith(prefix) || proxyReason.startsWith('代理') ? proxyReason : `${prefix} ${proxyReason}`}`
          );
        });
      };

      if (forceProxy) {
        httpsViaProxy(parsed, headers, proxy, PROXY_TIMEOUT_MS).then((res) => {
          if (res.ok && res.status > 0) {
            handleResult(res);
            return;
          }
          fail(`代理 ${proxy.host}:${proxy.port} 不可用：${res.error || '失败'}`);
        });
        return;
      }

      httpsDirect(parsed, headers, directTimeoutMs).then((res) => {
        // 直连拿到有效 HTTP 状态码就算通（包括 404，那是业务错误不是网络问题）
        if (res.ok && res.status > 0) {
          handleResult(res);
          return;
        }
        tryProxy(res);
      });
    };

    request(url);
  });
}

/** 解析 manifest 文本，校验 format */
function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
  } catch (e) {
    return { error: `manifest.json 不是合法 JSON：${e.message}` };
  }
  if (!isObj(data)) return { error: 'manifest.json 顶层不是对象' };
  if (data.format !== REGISTRY_FORMAT) {
    return { error: `manifest.json 的 format 应为 ${REGISTRY_FORMAT}，实际 ${String(data.format)}` };
  }
  const packs = Array.isArray(data.packs) ? data.packs.filter((p) => typeof p === 'string' && p.trim()) : [];
  if (packs.length === 0) return { error: 'manifest.json 里 packs 为空' };
  return { manifest: { ...data, packs } };
}

/**
 * 由订阅源推出 manifest 地址。
 * 支持三种写法：
 *   1. GitHub 仓库地址        https://github.com/{owner}/{repo} → raw .../HEAD/manifest.json
 *   2. 直接的 manifest 地址    http(s)://…/manifest.json
 *   3. 本地目录 / 本地文件     file:///path/to/某目录/            → 该目录下的 manifest.json
 *                              file:///path/to/某目录/manifest.json / 普通路径 D:\… 也接受
 */
function manifestUrlOf(source) {
  const raw = store.rawManifestUrl(source);
  if (raw) return raw;
  const s = typeof source === 'string' ? source.trim() : '';
  if (!s) return null;
  if (/^file:\/\//i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) {
    // Windows 本地路径 → file:// URL
    try {
      return require('node:url').pathToFileURL(s).toString();
    } catch (_e) {
      return null;
    }
  }
  return null;
}

/** 常见分支名的兜底探测顺序（GitHub API 拿不到分支列表时用） */
const FALLBACK_BRANCHES = ['packs', 'data', 'actions', 'main', 'master'];

/** 从 raw URL 里抠出分支名：…/{owner}/{repo}/{branch}/path */
function branchOfRawUrl(url) {
  const m = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//i.exec(String(url || ''));
  return m ? m[1] : '';
}

/**
 * 找 manifest.json。仓库形态支持跨分支找（默认分支放代码、动作包放别的分支）。
 * @returns {Promise<{manifestText:string, manifestUrl:string, branch:string, error:string}>}
 */
async function locateManifest(source, manifestUrl) {
  const tried = new Set();
  const tryUrl = async (url) => {
    if (!url || tried.has(url)) return null;
    tried.add(url);
    const res = await ghFetchText(url);
    if (res.ok && typeof res.text === 'string') return { manifestText: res.text, manifestUrl: url };
    return null;
  };

  // 第 1 步：按地址形式（仓库 → HEAD/main/master；raw → 它自己）
  const first = await tryUrl(manifestUrl);
  if (first) {
    return { ...first, branch: branchOfRawUrl(first.manifestUrl) || 'HEAD', error: '' };
  }

  // 不是仓库地址 / 本地源：到此为止
  const repo = store.githubRepo(source);
  if (!repo) {
    return { manifestText: '', manifestUrl, branch: '', error: `拉取 manifest 失败（${manifestUrl}）` };
  }

  // 第 2 步：问 GitHub API 有哪些分支，逐个分支找
  const base = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}`;
  /** 测试桩：允许把 GitHub 域名整体指向本地假服务器（默认不生效） */
  const mapped = typeof locateManifest.__mapUrl === 'function' ? locateManifest.__mapUrl : null;
  const mapUrl = (u) => (mapped ? mapped(u) : u);
  let branchNote = '';
  let branches = [];
  const apiUrl = mapUrl(`https://api.github.com/repos/${repo.owner}/${repo.repo}/branches?per_page=100`);
  const apiRes = await ghFetchText(apiUrl);
  if (apiRes.ok) {
    try {
      const list = JSON.parse(apiRes.text);
      if (Array.isArray(list)) {
        branches = list.map((b) => (b && typeof b.name === 'string' ? b.name.trim() : '')).filter(Boolean);
      }
    } catch (_e) {
      branchNote = '分支列表不是合法 JSON';
    }
  } else {
    branchNote = `GitHub API 不可用（${apiRes.error || apiRes.status}）`;
  }

  const queue = [
    ...branches.map((n) => ({ name: n, viaApi: true })),
    ...FALLBACK_BRANCHES.map((n) => ({ name: n, viaApi: false }))
  ];
  for (const { name, viaApi } of queue) {
    if (!name) continue;
    const url = mapUrl(`${base}/${name}/manifest.json`);
    if (tried.has(url)) continue;
    const hit = await tryUrl(url);
    if (hit) {
      if (!viaApi && !branches.length) branchNote = branchNote || '按常见分支名探测成功';
      log(`订阅 ${repo.owner}/${repo.repo}：默认分支没有 manifest.json，改用分支 ${name}`);
      return { ...hit, branch: name, error: '' };
    }
    void viaApi;
  }

  const notFound = [...tried].every((u) => true);
  void notFound;
  return {
    manifestText: '',
    manifestUrl,
    branch: '',
    error:
      `仓库 ${repo.owner}/${repo.repo} 的所有分支里都没找到 manifest.json` +
      `（已试 ${tried.size} 个地址）。如果动作包放在单独分支上，可以直接粘贴那个分支的 raw 地址。` +
      (branchNote ? `（${branchNote}）` : '')
  };
}

/** 相对路径 → 绝对 URL（相对 manifest 所在目录） */
function resolvePackUrl(ref, baseUrl) {  try {
    // 本地 file:// 源里的包名可能带中文，new URL 会自动百分号编码
    return new URL(ref, baseUrl).toString();
  } catch (_e) {
    return null;
  }
}

/** 由来源推出缓存目录名：owner-repo；本地路径取末级目录名 */
function sourceDirName(source) {
  const repo = store.githubRepo(source);
  if (repo) return `${repo.owner}-${repo.repo}`;
  const s = typeof source === 'string' ? source.trim() : '';
  if (s && (/^file:\/\//i.test(s) || /^[a-zA-Z]:[\\/]/.test(s))) {
    try {
      const u = /^file:\/\//i.test(s) ? new URL(s) : null;
      let p = u ? fileURLToPath(u) : s;
      // 去掉末尾分隔符后取末级目录名
      p = p.replace(/[\\/]+$/, '');
      const seg = p.split(/[\\/]/).filter(Boolean);
      const tail = seg[seg.length - 1] || 'local-sub';
      return store.safeDirName(tail.replace(/\.json$/i, ''));
    } catch (_e) {
      return store.safeDirName(s);
    }
  }
  try {
    const u = new URL(String(source));
    const seg = u.pathname.split('/').filter(Boolean);
    const tail = seg.length > 1 ? `${seg[seg.length - 2]}-${seg[seg.length - 1]}` : seg[0] || u.hostname;
    return store.safeDirName(tail.replace(/\.json$/i, ''));
  } catch (_e) {
    return store.safeDirName(String(source || 'sub'));
  }
}

/**
 * 同步一个订阅源：拉 manifest.json → 逐个拉 pack → 校验 format → 写订阅缓存目录。
 * 任何一步失败只记录错误（写进 subscriptions 索引），**绝不清空已有动作**。
 *
 * 分支感知：仓库约定「默认分支放代码、单独一个分支放动作包」，所以粘仓库地址时
 * 默认分支上没有 manifest.json 是正常的。会依次尝试：
 *   HEAD → main → master → github API 列出的其余分支 → 常见分支名（packs/data/actions）
 *
 * @param {string} source GitHub 仓库地址或直接的 manifest JSON 地址
 * @returns {Promise<{ok:boolean, source?:string, name?:string, dir?:string, branch?:string,
 *            packs?:Array<{id:string,file:string}>, packCount?:number, error?:string, errors?:string[]}>}
 */
async function syncSource(source) {
  const srcRaw = typeof source === 'string' ? source.trim() : '';
  const finish = (result) => {
    if (!result.ok) {
      logWarn(`订阅同步失败（${srcRaw || '空地址'}）：${result.error}`);
      store.recordSync({ ok: false, error: result.error, source: srcRaw });
    } else {
      log(`订阅同步成功（${srcRaw}，分支 ${result.branch || 'HEAD'}）：${result.packCount} 个动作包 → ${result.dir}`);
      store.recordSync({ ok: true, source: srcRaw });
    }
    return result;
  };

  if (!srcRaw) return finish({ ok: false, error: '订阅地址为空' });
  const manifestUrl = manifestUrlOf(srcRaw);
  if (!manifestUrl) return finish({ ok: false, error: `无法从地址推出 manifest.json：${srcRaw}` });

  // 1. 找 manifest：先按地址形式试，仓库形态再跨分支找
  const found = await locateManifest(srcRaw, manifestUrl);
  if (!found.manifestText) {
    return finish({ ok: false, error: found.error || `拉取 manifest 失败（${manifestUrl}）` });
  }
  const { manifest, error: manifestError } = parseManifest(found.manifestText);
  if (manifestError) return finish({ ok: false, error: manifestError });
  const manifestRes = { url: found.manifestUrl };

  // manifest 里若自带 name 就沿用，否则用 owner-repo
  const dirName = store.safeDirName(manifest.name || sourceDirName(srcRaw));

  // 3. 逐个拉 pack + 校验 format
  // 相对路径的基准：HTTP 用 manifest 的最终 URL；本地 file 源用 manifest 实际所在目录（已补 manifest.json 的情况也能算对）
  const errors = [];
  const packs = [];
  let baseUrl = manifestRes.url || manifestUrl;
  if (manifestRes.filePath) {
    try {
      baseUrl = require('node:url').pathToFileURL(manifestRes.filePath).toString();
    } catch (_e) {
      baseUrl = manifestRes.url || manifestUrl;
    }
  }
  for (const ref of manifest.packs) {
    const packUrl = resolvePackUrl(ref, baseUrl);
    if (!packUrl) {
      errors.push(`包路径不合法：${ref}`);
      continue;
    }
    const packRes = await ghFetchText(packUrl);
    if (!packRes.ok) {
      errors.push(`${ref}：${packRes.error || '下载失败'}`);
      continue;
    }
    let data;
    try {
      data = JSON.parse(String(packRes.text || '').replace(/^\uFEFF/, ''));
    } catch (e) {
      errors.push(`${ref}：JSON 解析失败（${e.message}）`);
      continue;
    }
    if (!isObj(data) || data.format !== PACK_FORMAT) {
      errors.push(`${ref}：format 应为 ${PACK_FORMAT}，实际 ${String(isObj(data) ? data.format : typeof data)}`);
      continue;
    }
    packs.push(data);
  }

  if (packs.length === 0) {
    // 一个合法包都没拉到：保留旧缓存，只记错误
    return finish({
      ok: false,
      error: `一个动作包都没拉到（${errors.slice(0, 3).join('；') || 'manifest 无内容'}）`,
      errors
    });
  }

  // 3. 写缓存（只有至少一个包合法时才落盘，失败场景上面已经提前返回）
  const installed = store.installSubscription(dirName, packs);
  if (!installed.ok) return finish({ ok: false, error: installed.error || '写入订阅缓存失败' });
  if (errors.length > 0) logWarn(`订阅「${dirName}」部分包跳过：${errors.join('；')}`);

  store.upsertSubscriptionSource({
    name: manifest.name || dirName,
    source: srcRaw,
    dir: installed.dir,
    packs: packs.map((p) => p.id)
  });

  return finish({
    ok: true,
    source: srcRaw,
    name: manifest.name || dirName,
    dir: installed.dir,
    branch: found.branch || 'HEAD',
    manifestUrl: manifestRes.url,
    packs: installed.packs,
    packCount: packs.length,
    errors
  });
}

/**
 * 同步索引里登记过的全部订阅源。任一失败不影响其他源。
 */
async function syncAll() {
  const sources = store.listSubscriptionSources().filter((s) => typeof s.source === 'string' && s.source);
  const results = [];
  for (const s of sources) {
    // eslint-disable-next-line no-await-in-loop
    const r = await syncSource(s.source);
    results.push({ source: s.source, ...r });
  }
  return results;
}

module.exports = {
  ghFetchText,
  syncSource,
  syncAll,
  parseManifest,
  manifestUrlOf,
  sourceDirName,
  resolvePackUrl,
  detectSystemProxy,
  parseProxy,
  httpsDirect,
  httpsViaProxy,
  markDirectBroken,
  resetDirectState,
  directRecentlyBroken,
  locateManifest,
  branchOfRawUrl,
  FALLBACK_BRANCHES,
  USER_AGENT,
  TIMEOUT_MS,
  DIRECT_TIMEOUT_MS
};
