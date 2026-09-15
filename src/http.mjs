import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAuth, deviceName } from './auth.mjs';
import { createAudit } from './audit.mjs';
import { taskImages } from './images.mjs';
import { desktopProjects } from './projects.mjs';
import { desktopModels } from './models.mjs';
import { saveUpload } from './uploads.mjs';
import { serviceConfig } from './service-config.mjs';
import { join } from 'node:path';
import { loginSource } from './login-source.mjs';

const readOnlyRpc = new Set(['thread/list', 'thread/read', 'thread/resume', 'thread/items/list', 'thread/turns/list', 'thread/goal/get']);

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/approval-state.js', ['approval-state.js', 'text/javascript; charset=utf-8']],
  ['/composer-media.js', ['composer-media.js', 'text/javascript; charset=utf-8']],
  ['/history-pages.js', ['history-pages.js', 'text/javascript; charset=utf-8']],
  ['/timeline.js', ['timeline.js', 'text/javascript; charset=utf-8']],
  ['/goal-panel.js', ['goal-panel.js', 'text/javascript; charset=utf-8']],
  ['/task-preferences.js', ['task-preferences.js', 'text/javascript; charset=utf-8']],
  ['/delivery-state.js', ['delivery-state.js', 'text/javascript; charset=utf-8']],
  ['/device-panel.js', ['device-panel.js', 'text/javascript; charset=utf-8']],
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

export function createWebServer(broker, { password, origin, mode, now, allowLanHttp = false, additionalOrigins = [], allowHttpOrigins = [], trustedProxyAddresses = [], auditPath, audit = createAudit({ path: auditPath, now }), uploadDirectory = join(serviceConfig().state, 'uploads'), readModels = desktopModels }) {
  const auth = createAuth(password, origin, now, { allowLanHttp, additionalOrigins, allowHttpOrigins });
  const source = loginSource(trustedProxyAddresses);
  const allowedOrigins = new Set([origin, ...additionalOrigins]);
  const images = taskImages();
  return http.createServer(async (req, res) => {
    let action, audited = false;
    const record = (result, session = auth.session(req), targetId = null) => {
      if (!action || audited) return;
      audited = true;
      let address = 'unknown';
      try { address = source(req); } catch { /* Never store an invalid proxy header. */ }
      audit.record({ action, result, source: address, device: deviceName(req.headers['user-agent']), sessionId: session?.id, targetId });
    };
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
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
        const result = await auth.login((await body(req))?.password, source(req), req.headers['user-agent']);
        record(result.status === 200 ? 'success' : result.status === 429 ? 'limited' : 'failed', result.session);
        if (result.cookie) res.setHeader('Set-Cookie', result.cookie);
        if (result.retryAfter) res.setHeader('Retry-After', result.retryAfter);
        return json(result.status, result.error ? { error: result.error } : { ok: true });
      }
      const authenticated = auth.authenticated(req);
      const publicAsset = ['/login', '/login.js', '/style.css', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-512.png'].includes(url.pathname);
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
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        record('success');
        res.setHeader('Set-Cookie', auth.logout(req));
        return json(200, { ok: true });
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        res.setHeader('Content-Type', type);
        res.end(await readFile(new URL(`../public/${name}`, import.meta.url)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return json(200, { ...await broker.snapshot(Number(url.searchParams.get('after')) || 0), ...(mode ? { mode } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, await desktopProjects());
      if (req.method === 'GET' && url.pathname === '/api/models') {
        try { return json(200, await readModels()); }
        catch { return json(503, { error: '模型目录暂不可用，请在桌面完成模型同步后重试。' }); }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/images/')) {
        const image = await images.read(url.pathname.slice('/api/images/'.length));
        if (!image) return json(404, { error: '图片未关联到当前任务记录' });
        res.setHeader('Content-Type', image.type);
        res.end(image.data); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/commands/')) {
        const command = await broker.getCommand(url.pathname.slice('/api/commands/'.length));
        return json(command ? 200 : 404, command ? { ...command, media: images.register(command.result) } : { error: '没有此提交记录；请核对任务历史，勿盲目重发' });
      }
      if (req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) { record('failed'); return json(415, { error: '需要 JSON' }); }
        if (url.pathname === '/api/uploads') {
          const data = await body(req, 12 * 1024 * 1024);
          if (!auth.authenticated(req)) return json(401, { error: '请先验证访问密码' });
          return json(201, await saveUpload(uploadDirectory, data.image));
        }
        const data = await body(req);
        // Revocation/expiry can occur while the request body is still arriving.
        if (!auth.authenticated(req)) { record('denied'); return json(401, { error: '请先验证访问密码' }); }
        if (url.pathname === '/api/commands' && readOnlyRpc.has(data?.method)) action = undefined;
        if (url.pathname === '/api/sessions/list') return json(200, { sessions: auth.list(req) });
        if (url.pathname === '/api/security-audit/list') return json(200, audit.list());
        if (url.pathname === '/api/sessions/revoke') {
          if (typeof data?.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(data.id)) throw new Error('无效的设备 ID');
          const session = auth.session(req), result = auth.revoke(req, data.id);
          record(result.revoked ? 'revoked' : 'missing', session, data.id);
          if (!result.revoked) return json(404, { error: '此设备已退出或过期，请刷新列表' });
          if (result.current) res.setHeader('Set-Cookie', auth.logout(req));
          return json(200, result);
        }
        if (url.pathname === '/api/sessions/revoke-all') {
          const session = auth.session(req), result = auth.revokeAll(req);
          record('revoked', session);
          res.setHeader('Set-Cookie', auth.logout(req));
          return json(200, result);
        }
        if (url.pathname === '/api/commands') {
          const session = auth.session(req);
          const command = await broker.submit(data.key, data.method, data.params);
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
      record('failed');
      json(400, { error: error.message });
    }
  });
}
