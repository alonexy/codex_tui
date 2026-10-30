import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createAuth, deviceName } from './auth.mjs';
import { createAudit } from './audit.mjs';
import { taskImages } from './images.mjs';
import { desktopProjects } from './projects.mjs';
import { desktopModels } from './models.mjs';
import { attachmentStore } from './attachments.mjs';
import { serviceConfig } from './service-config.mjs';
import { join } from 'node:path';
import { loginSource } from './login-source.mjs';
import { threadModes } from './thread-mode.mjs';
import { createPasskeys } from './passkeys.mjs';

const readOnlyRpc = new Set(['thread/list', 'thread/read', 'thread/resume', 'thread/items/list', 'thread/turns/list', 'thread/goal/get']);
const compress = promisify(gzip);

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/account-quota.js', ['account-quota.js', 'text/javascript; charset=utf-8']],
  ['/image-preview.js', ['image-preview.js', 'text/javascript; charset=utf-8']],
  ['/mermaid.js', ['mermaid.js', 'text/javascript; charset=utf-8']],
  ['/approval-state.js', ['approval-state.js', 'text/javascript; charset=utf-8']],
  ['/plan-mode.js', ['plan-mode.js', 'text/javascript; charset=utf-8']],
  ['/question-card.js', ['question-card.js', 'text/javascript; charset=utf-8']],
  ['/async-questions.js', ['async-questions.js', 'text/javascript; charset=utf-8']],
  ['/composer-media.js', ['composer-media.js', 'text/javascript; charset=utf-8']],
  ['/attachment-policy.js', ['attachment-policy.js', 'text/javascript; charset=utf-8']],
  ['/history-pages.js', ['history-pages.js', 'text/javascript; charset=utf-8']],
  ['/session-loader.js', ['session-loader.js', 'text/javascript; charset=utf-8']],
  ['/timeline.js', ['timeline.js', 'text/javascript; charset=utf-8']],
  ['/goal-panel.js', ['goal-panel.js', 'text/javascript; charset=utf-8']],
  ['/task-preferences.js', ['task-preferences.js', 'text/javascript; charset=utf-8']],
  ['/delivery-state.js', ['delivery-state.js', 'text/javascript; charset=utf-8']],
  ['/device-panel.js', ['device-panel.js', 'text/javascript; charset=utf-8']],
  ['/passkey-settings.js', ['passkey-settings.js', 'text/javascript; charset=utf-8']],
  ['/passkey-client.js', ['passkey-client.js', 'text/javascript; charset=utf-8']],
  ['/vendor/webauthn-browser.js', ['vendor/webauthn-browser.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/apple-touch-icon.png', ['apple-touch-icon.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
]);

async function body(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function createWebServer(broker, { password, origin, mode, now, allowLanHttp = false, additionalOrigins = [], allowHttpOrigins = [], trustedProxyAddresses = [], auditPath, passkeyPath, audit = createAudit({ path: auditPath, now }), uploadDirectory = join(serviceConfig().state, 'uploads'), attachmentOptions = {}, readModels = desktopModels, modes = threadModes() }) {
  const auth = createAuth(password, origin, now, { allowLanHttp, additionalOrigins, allowHttpOrigins });
  const passkeys = createPasskeys({ auth, password, origin, additionalOrigins, path: passkeyPath, now });
  const source = loginSource(trustedProxyAddresses);
  const allowedOrigins = new Set([origin, ...additionalOrigins]);
  const images = taskImages();
  const attachments = attachmentStore(uploadDirectory, attachmentOptions);
  const server = http.createServer(async (req, res) => {
    let action, audited = false, protectedRequest = false;
    const record = (result, session = auth.session(req), targetId = null) => {
      if (!action || audited) return;
      audited = true;
      let address = 'unknown';
      try { address = source(req); } catch { /* Never store an invalid proxy header. */ }
      audit.record({ action, result, source: address, device: deviceName(req.headers['user-agent']), sessionId: session?.id, targetId });
    };
    const json = (status, data) => {
      if (protectedRequest && !auth.authenticated(req)) {
        status = 401; data = { error: '会话已锁定或失效，请重新验证' };
        // A download may have prepared representation headers before a lock.
        for (const name of ['Content-Disposition', 'Content-Encoding', 'Content-Length']) res.removeHeader(name);
      }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const send = data => {
      if (protectedRequest && !auth.authenticated(req)) return json(401, { error: '会话已锁定或失效，请重新验证' });
      res.end(data);
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') action = ({
        '/api/login': 'login', '/api/logout': 'logout', '/api/sessions/revoke': 'session.revoke',
        '/api/sessions/revoke-all': 'session.revoke_all', '/api/commands': 'rpc.submit', '/api/answer': 'approval.answer',
        '/api/passkeys/register/options': 'passkey.register', '/api/passkeys/register/verify': 'passkey.register',
        '/api/passkeys/authenticate/options': 'passkey.login', '/api/passkeys/authenticate/verify': 'passkey.login', '/api/passkeys/remove': 'passkey.remove',
      })[url.pathname];
      // Never accept credentials from URLs. Strip legacy leaked query strings.
      if (req.method === 'GET' && url.pathname === '/login' && url.search) {
        res.writeHead(303, { Location: '/login' });
        return res.end();
      }
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) { record('denied'); return json(403, { error: '来源不匹配' }); }
      if (req.method === 'POST' && !allowedOrigins.has(req.headers.origin)) { record('denied'); return json(403, { error: '缺少有效来源' }); }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!req.headers['content-type']?.startsWith('application/json')) { record('failed'); return json(415, { error: '需要 JSON' }); }
        const result = await auth.login((await body(req))?.password, source(req), req.headers['user-agent'], req);
        record(result.status === 200 ? 'success' : result.status === 429 ? 'limited' : 'failed', result.session);
        if (result.cookie) res.setHeader('Set-Cookie', [result.cookie, passkeys.cancel(req)].filter(Boolean));
        if (result.retryAfter) res.setHeader('Retry-After', result.retryAfter);
        return json(result.status, result.error ? { error: result.error } : { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/passkeys/status') return json(200, passkeys.status());
      if (req.method === 'POST' && url.pathname === '/api/passkeys/cancel') {
        const cleared = passkeys.cancel(req); if (cleared) res.setHeader('Set-Cookie', cleared);
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && ['/api/passkeys/authenticate/options', '/api/passkeys/authenticate/verify'].includes(url.pathname)) {
        if (!req.headers['content-type']?.startsWith('application/json')) { record('failed'); return json(415, { error: '需要 JSON' }); }
        const data = await body(req);
        const result = url.pathname.endsWith('/options') ? await passkeys.authenticationOptions(req, source(req)) : await passkeys.verifyAuthentication(req, data?.response, source(req), req.headers['user-agent']);
        res.setHeader('Set-Cookie', result.flowCookie ? [result.cookie, result.flowCookie] : result.cookie);
        record(result.options ? 'accepted' : 'success', result.session);
        return json(200, result.options ? { options: result.options } : { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        record('success');
        res.setHeader('Set-Cookie', [auth.logout(req), passkeys.cancel(req)].filter(Boolean));
        return json(200, { ok: true });
      }
      const authenticated = auth.authenticated(req);
      const publicAsset = ['/login', '/login.js', '/passkey-client.js', '/vendor/webauthn-browser.js', '/style.css', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-512.png'].includes(url.pathname);
      if (!authenticated && !publicAsset) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(303, { Location: '/login' });
          return res.end();
        }
        record('denied'); return json(401, { error: '请先验证访问密码' });
      }
      if (authenticated && url.pathname === '/login') {
        res.writeHead(303, { Location: '/' });
        return res.end();
      }
      protectedRequest = !publicAsset;
      if (req.method === 'GET' && url.pathname === '/mermaid-renderer') {
        // Only trusted, generated code enters this document. Graph source travels
        // via postMessage, never via HTML. Inline the bundle to avoid sending
        // authenticated subrequests from the opaque sandbox origin.
        const script = await readFile(new URL('../public/vendor/mermaid-renderer.js', import.meta.url), 'utf8');
        const nonce = randomBytes(24).toString('base64');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-scripts`);
        const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script nonce="${nonce}">${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
        res.setHeader('Vary', 'Accept-Encoding');
        if (/\bgzip\b(?!\s*;\s*q=0(?:\.0*)?(?:\s*,|\s*$))/i.test(req.headers['accept-encoding'] ?? '')) {
          const compressed = await compress(html);
          if (!auth.authenticated(req)) return json(401, { error: '会话已锁定或失效，请重新验证' });
          res.setHeader('Content-Encoding', 'gzip'); send(compressed);
        } else send(html);
        return;
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        res.setHeader('Content-Type', type);
        send(await readFile(new URL(`../public/${name}`, import.meta.url)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = await broker.snapshot(Number(url.searchParams.get('after')) || 0);
        return json(200, { ...state, capabilities: { ...state.capabilities, threadMode: true }, ...(mode ? { mode } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, await desktopProjects());
      if (req.method === 'GET' && url.pathname === '/api/account-rate-limits') {
        const state = await broker.snapshot(Number.MAX_SAFE_INTEGER);
        if (!state.ready) return json(503, { error: '连接恢复后可重新读取额度' });
        if (!state.capabilities?.accountRateLimits || !broker.readRateLimits) return json(409, { error: '当前桥接仅支持额度通知，等待桌面同步；新读取能力将在桌面下次正常启动后可用' });
        try { const value = await broker.readRateLimits(); return json(200, { ...value, bridgeId: value.bridgeId ?? state.bridgeId }); }
        catch (error) { return json(503, { error: error.message }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        try { return json(200, await readModels()); }
        catch { return json(503, { error: '模型目录暂不可用，请在桌面完成模型同步后重试。' }); }
      }
      if (req.method === 'GET' && url.pathname === '/api/thread-mode') {
        const threadId = url.searchParams.get('threadId');
        if (!threadId || url.searchParams.has('path')) return json(400, { error: '请先打开会话以同步模式' });
        const result = await modes.read(threadId, await broker.snapshot(Number.MAX_SAFE_INTEGER));
        return result ? json(200, result) : json(404, { error: '请先打开会话以同步模式' });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/images/')) {
        const image = await images.read(url.pathname.slice('/api/images/'.length));
        if (!image) return json(404, { error: '图片未关联到当前任务记录' });
        res.setHeader('Content-Type', image.type);
        send(image.data); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
        const file = await attachments.download(url.pathname.slice('/api/attachments/'.length));
        if (!file) return json(404, { error: '未找到已登记附件' });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="attachment.${file.extension}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`);
        send(file.data); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/commands/')) {
        const command = await broker.getCommand(url.pathname.slice('/api/commands/'.length));
        if (command?.status === 'completed' && ['thread/read', 'thread/resume', 'thread/start'].includes(command.method)) modes.register(command.result);
        return json(command ? 200 : 404, command ? { ...command, media: images.register(command.result), files: await attachments.register(command.result) } : { error: '没有此提交记录；请核对任务历史，勿盲目重发' });
      }
      if (req.method === 'POST') {
        if (url.pathname === '/api/attachments') {
          if (req.headers['content-type'] !== 'application/octet-stream') return json(415, { error: '需要二进制文件' });
          return json(201, await attachments.upload(req, auth.session(req).id, url.searchParams.get('batch'), url.searchParams.get('id'), decodeURIComponent(req.headers['x-attachment-name'] ?? ''), () => auth.authenticated(req)));
        }
        if (!req.headers['content-type']?.startsWith('application/json')) { record('failed'); return json(415, { error: '需要 JSON' }); }
        if (url.pathname === '/api/uploads') {
          const data = await body(req, 12 * 1024 * 1024);
          if (!auth.authenticated(req)) return json(401, { error: '请先验证访问密码' });
          return json(201, await attachments.uploadLegacy(data.image));
        }
        const data = await body(req);
        // Revocation/expiry can occur while the request body is still arriving.
        if (!auth.authenticated(req)) { record('denied'); return json(401, { error: '请先验证访问密码' }); }
        if (url.pathname === '/api/passkeys/list') return json(200, passkeys.list());
        if (['/api/passkeys/register/options', '/api/passkeys/register/verify'].includes(url.pathname)) {
          const result = url.pathname.endsWith('/options') ? await passkeys.registrationOptions(req, data?.password, source(req)) : await passkeys.verifyRegistration(req, data?.response, source(req));
          res.setHeader('Set-Cookie', result.cookie); record(result.options ? 'accepted' : 'success');
          return json(200, result.options ? { options: result.options } : { ok: true });
        }
        if (url.pathname === '/api/passkeys/remove') {
          const result = passkeys.remove(req, data?.id); record(result.removed ? 'revoked' : 'missing');
          if (result.current) { protectedRequest = false; res.setHeader('Set-Cookie', [auth.logout(req), passkeys.cancel(req)].filter(Boolean)); }
          return json(200, result);
        }
        if (url.pathname === '/api/commands' && readOnlyRpc.has(data?.method)) action = undefined;
        if (url.pathname === '/api/attachment-batches') {
          attachments.retain(auth.session(req).id, data.batch, data.keep);
          return json(200, { ok: true });
        }
        if (url.pathname === '/api/sessions/list') return json(200, { sessions: auth.list(req) });
        if (url.pathname === '/api/security-audit/list') return json(200, audit.list());
        if (url.pathname === '/api/sessions/revoke') {
          if (typeof data?.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(data.id)) throw new Error('无效的设备 ID');
          const session = auth.session(req), result = auth.revoke(req, data.id);
          record(result.revoked ? 'revoked' : 'missing', session, data.id);
          if (!result.revoked) return json(404, { error: '此设备已退出或过期，请刷新列表' });
          if (result.current) res.setHeader('Set-Cookie', [auth.logout(req), passkeys.cancel(req)].filter(Boolean));
          if (result.current) protectedRequest = false;
          return json(200, result);
        }
        if (url.pathname === '/api/sessions/revoke-all') {
          const session = auth.session(req), result = auth.revokeAll(req);
          passkeys.invalidateAll();
          record('revoked', session);
          res.setHeader('Set-Cookie', [auth.logout(req), passkeys.cancel(req)].filter(Boolean));
          protectedRequest = false;
          return json(200, result);
        }
        if (url.pathname === '/api/commands') {
          const session = auth.session(req);
          let prepared;
          if (['turn/start', 'turn/steer'].includes(data.method)) {
            try { prepared = await attachments.prepareInput(data.params?.input); }
            catch (error) { record('failed'); return json(400, { error: error.message, submission: 'rejected' }); }
          }
          if (!auth.authenticated(req)) {
            await prepared?.reject(); record('denied');
            return json(401, { error: '会话已锁定或失效，请重新验证', submission: 'rejected' });
          }
          let command;
          try { command = await broker.submit(data.key, data.method, data.params); }
          catch (error) {
            if (error.submission === 'rejected') {
              try { await prepared?.reject(); }
              catch { error.message += '；附件暂存恢复失败，文件仍保留'; }
            }
            throw error;
          }
          record(command.status === 'failed' ? 'failed' : command.status === 'completed' ? 'success' : 'accepted', session);
          return json(202, command);
        }
        if (url.pathname === '/api/answer') {
          const session = auth.session(req);
          await broker.answer(data.id, data.result);
          record('success', session);
          return json(200, { ok: true });
        }
      }
      json(404, { error: '未找到' });
    } catch (error) {
      record(error.status === 429 ? 'limited' : 'failed');
      if (error.status === 429) res.setHeader('Retry-After', '60');
      json(error.status ?? 400, { error: error.message, ...(error.submission === 'rejected' ? { submission: 'rejected' } : {}) });
    }
  });
  // Cancel before waiting for in-flight HTTP requests to drain on Web reload.
  const close = server.close;
  server.close = function(...args) { passkeys.close(); return close.apply(this, args); };
  server.once('close', () => passkeys.close());
  return server;
}
