import { randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const lifetime = 8 * 60 * 60 * 1000;
const idle = 30 * 60 * 1000;
const windowMs = 60 * 1000;

// Retain only recognizable device categories, never the caller-controlled UA text.
export function deviceName(userAgent = '') {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 2048) : '';
  const os = /iPad|iPhone|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS'
      : /Linux/.test(ua) ? 'Linux' : '未知系统';
  const browser = /Edg(?:e|A|iOS)?\//.test(ua) ? 'Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '其他浏览器';
  return `${browser} · ${os}`;
}

export function createAuth(password, origin, now = Date.now, { allowLanHttp = false, additionalOrigins = [], allowHttpOrigins = [] } = {}) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('访问密码需要至少 12 个字符，且不超过 1024 字节');
  }
  const url = new URL(origin);
  if (!Array.isArray(additionalOrigins) || !Array.isArray(allowHttpOrigins)) throw Error('来源配置必须为数组');
  for (const value of [origin, ...additionalOrigins]) {
    const candidate = new URL(value);
    if (candidate.protocol !== url.protocol) throw Error('同时允许的来源必须使用相同协议');
    if (candidate.origin !== value || !['http:', 'https:'].includes(candidate.protocol)) throw new Error('CODEX_PHONE_ORIGIN 必须是完整来源地址，不含路径');
    const octets = candidate.hostname.split('.').map(Number);
    const privateIp = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
      (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
    if (candidate.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(candidate.hostname) && !(allowLanHttp && privateIp) && !allowHttpOrigins.includes(value)) {
      throw new Error('手机远程访问必须使用 HTTPS 来源地址');
    }
  }
  const secure = url.protocol === 'https:';
  const name = secure ? '__Host-codex-phone' : 'codex-phone';
  const salt = randomBytes(32);
  const expected = scryptSync(password, salt, 32);
  password = undefined;
  const sessions = new Map();
  const attempts = new Map();
  let verifying = 0;
  const cookie = (value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const sessionId = req => (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const prune = () => {
    for (const [id, session] of sessions) {
      if (session.expires <= now() || session.lastSeen + idle <= now()) sessions.delete(id);
    }
  };
  const sessionFor = req => { prune(); return sessions.get(sessionId(req)); };
  const describe = (session, current = false) => ({
    id: session.publicId, device: session.device, source: session.source,
    createdAt: session.createdAt, lastSeen: session.lastSeen, expiresAt: session.expires,
    idleExpiresAt: Math.min(session.expires, session.lastSeen + idle), current,
  });
  return {
    async login(value, source = 'local', userAgent = '') {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return { status: 401, error: '密码不正确，请重新输入' };
      const time = now();
      for (const [key, times] of attempts) {
        const recent = times.filter(at => at > time - windowMs);
        if (recent.length) attempts.set(key, recent);
        else attempts.delete(key);
      }
      const recent = attempts.get(source) ?? [];
      if (recent.length >= 5) return { status: 429, error: '此来源尝试过于频繁，请稍后再试', retryAfter: Math.max(1, Math.ceil((recent[0] + windowMs - time) / 1000)) };
      // Bound expensive work and source bookkeeping without a global minute-long lockout.
      if (verifying >= 2 || (!attempts.has(source) && attempts.size >= 1024)) return { status: 429, error: '登录服务繁忙，请稍后再试', retryAfter: 1 };
      recent.push(time);
      attempts.set(source, recent);
      verifying++;
      let valid;
      try { valid = timingSafeEqual(await derive(value, salt, 32), expected); }
      finally { verifying--; }
      if (!valid) return { status: 401, error: '密码不正确，请重新输入' };
      prune();
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString('hex');
      const createdAt = now();
      const session = { publicId: randomUUID(), device: deviceName(userAgent), source, createdAt, expires: createdAt + lifetime, lastSeen: createdAt };
      sessions.set(id, session);
      return { status: 200, cookie: cookie(id, lifetime / 1000), session: describe(session, true) };
    },
    authenticated(req) {
      const session = sessionFor(req);
      if (!session) return false;
      session.lastSeen = now();
      return true;
    },
    session(req) {
      const session = sessionFor(req);
      return session ? describe(session, true) : null;
    },
    list(req) {
      const current = sessionFor(req);
      if (!current) throw new Error('请先验证访问密码');
      return [...sessions.values()].map(session => describe(session, session === current));
    },
    revoke(req, publicId) {
      const current = sessionFor(req);
      if (!current) throw new Error('请先验证访问密码');
      for (const [id, session] of sessions) {
        if (session.publicId !== publicId) continue;
        sessions.delete(id);
        return { revoked: true, current: session === current };
      }
      return { revoked: false, current: false };
    },
    revokeAll(req) {
      if (!sessionFor(req)) throw new Error('请先验证访问密码');
      const revoked = sessions.size;
      sessions.clear();
      return { revoked, current: true };
    },
    logout(req) {
      sessions.delete(sessionId(req));
      return cookie('', 0);
    },
  };
}
