import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createPasskeyStore } from './passkey-store.mjs';

const flowLifetime = 120000, cookieName = '__Host-codex-passkey-flow';
const failure = (message = '通行密钥验证失败，请重试或使用密码登录', status = 400) => Object.assign(new Error(message), { status });
const flowId = req => (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
const cookie = value => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${value ? 120 : 0}`;
function sameFrame(response) {
  const encoded = response?.response?.clientDataJSON;
  if (typeof encoded !== 'string' || encoded.length > 16384) throw failure();
  const data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (data.crossOrigin === true || data.topOrigin !== undefined) throw failure();
}

export function passkeyOrigins(origin, additionalOrigins = []) {
  const url = new URL(origin), rpID = url.hostname;
  const domain = value => !isIP(value) && value !== 'localhost' && !value.endsWith('.localhost') && value.includes('.') && value.length <= 253 && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (url.protocol !== 'https:' || !domain(rpID)) return null;
  const origins = new Set([origin, ...additionalOrigins].filter(value => {
    const candidate = new URL(value);
    return candidate.protocol === 'https:' && domain(candidate.hostname) && (candidate.hostname === rpID || candidate.hostname.endsWith('.' + rpID));
  }));
  return { rpID, origins };
}

export function createPasskeys({ auth, password, origin, additionalOrigins = [], path, now = Date.now }) {
  const realm = passkeyOrigins(origin, additionalOrigins);
  // HTTP/IP never loads or creates a credential database.
  const store = realm ? createPasskeyStore({ path, password, rpID: realm.rpID, now }) : null;
  const flows = new Map(), attempts = new Map();
  let active = 0, generation = 0, closed = false;
  function status() {
    if (!realm) return { enabled: false, reason: '通行密钥需要 HTTPS 域名；当前地址请使用访问密码。' };
    const state = store.status();
    return state.available && !closed ? { enabled: true, rpID: realm.rpID } : { enabled: false, reason: state.reason ?? '通行密钥服务不可用，请使用访问密码。' };
  }
  function available(req) {
    const state = status();
    if (!state.enabled) throw failure(state.reason, 503);
    if (!realm.origins.has(req.headers.origin)) throw failure('当前来源不在通行密钥域名范围内', 403);
  }
  function prune() {
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
    for (const [source, times] of attempts) {
      const recent = times.filter(time => time > now() - 60000);
      if (recent.length) attempts.set(source, recent); else attempts.delete(source);
    }
  }
  async function work(req, source, action) {
    available(req); prune();
    const times = attempts.get(source) ?? [];
    if (active >= 4 || times.length >= 20 || (!attempts.has(source) && attempts.size >= 1024)) throw failure('通行密钥请求过于频繁，请稍后再试', 429);
    times.push(now()); attempts.set(source, times); active++;
    const currentGeneration = generation;
    try { return await action(() => { if (closed || generation !== currentGeneration) throw failure('验证已取消，请重新开始'); }); }
    finally { active--; }
  }
  function cancel(req) { flows.delete(flowId(req)); return realm ? cookie('') : undefined; }
  function createFlow(req, kind, challenge, version, sessionId) {
    cancel(req); prune();
    if (closed || flows.size >= 256) throw failure('通行密钥服务繁忙，请稍后再试', 429);
    const id = randomBytes(32).toString('base64url');
    flows.set(id, { kind, challenge, version, origin: req.headers.origin, sessionId, expires: now() + flowLifetime, consumed: false });
    return cookie(id);
  }
  function consume(req, kind) {
    const id = flowId(req), flow = flows.get(id);
    if (!flow || flow.consumed || flow.expires <= now() || flow.kind !== kind || flow.origin !== req.headers.origin) throw failure('验证已过期或已使用，请重新开始');
    flow.consumed = true; // Consume before the first await; keep identity so logout can cancel in flight.
    return { flow, current() {
      if (closed || flows.get(id) !== flow || flow.expires <= now()) throw failure('验证已取消或过期，请重新开始');
      if (flow.sessionId && auth.session(req)?.id !== flow.sessionId) throw failure('登录会话已失效，请重新输入访问密码', 401);
    }, finish() { if (flows.get(id) === flow) flows.delete(id); } };
  }
  return {
    status, cancel,
    invalidateAll() { generation++; flows.clear(); },
    close() { closed = true; generation++; flows.clear(); },
    list() {
      if (!status().enabled) return { ...status(), credentials: [] };
      return { enabled: true, credentials: store.snapshot().credentials.map(({ id, createdAt, deviceType, backedUp }) => ({ id, createdAt, deviceType, backedUp })) };
    },
    registrationOptions(req, passwordValue, source) {
      return work(req, source, async current => {
        const sessionId = auth.session(req)?.id;
        if (!sessionId) throw failure('请先使用访问密码登录', 401);
        const result = await auth.verifyPassword(passwordValue, source);
        if (result.status !== 200) throw failure(result.error, result.status === 401 ? 403 : result.status);
        current();
        if (auth.session(req)?.id !== sessionId) throw failure('登录会话已失效，请重新输入访问密码', 401);
        const snapshot = store.snapshot();
        if (snapshot.credentials.length >= 32) throw failure('最多保存 32 个通行密钥，请先删除旧密钥');
        const options = await generateRegistrationOptions({ rpName: 'Codex Phone', rpID: realm.rpID, userID: new Uint8Array(Buffer.from(snapshot.userHandle, 'base64url')), userName: 'Codex Phone owner',
          attestationType: 'none', timeout: flowLifetime, supportedAlgorithmIDs: [-7, -257],
          excludeCredentials: snapshot.credentials.map(({ id, transports }) => ({ id, transports })),
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' } });
        current();
        if (auth.session(req)?.id !== sessionId) throw failure('登录会话已失效，请重新输入访问密码', 401);
        return { options, cookie: createFlow(req, 'registration', options.challenge, snapshot.version, sessionId) };
      });
    },
    verifyRegistration(req, response, source) {
      return work(req, source, async current => {
        const ceremony = consume(req, 'registration'), { flow } = ceremony;
        try {
          ceremony.current();
          sameFrame(response);
          const result = await verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: realm.rpID, expectedType: 'webauthn.create', requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
          current(); ceremony.current();
          if (!result.verified || !result.registrationInfo.userVerified) throw failure();
          const info = result.registrationInfo;
          store.register({ ...info.credential, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, createdAt: now() }, flow.version);
          return { ok: true, cookie: cookie('') };
        } catch (error) { if (error.status) throw error; throw failure(); }
        finally { ceremony.finish(); }
      });
    },
    authenticationOptions(req, source) {
      return work(req, source, async current => {
        const snapshot = store.snapshot(), sessionId = auth.session(req)?.id;
        const options = await generateAuthenticationOptions({ rpID: realm.rpID, userVerification: 'required', timeout: flowLifetime });
        current();
        if (sessionId && auth.session(req)?.id !== sessionId) throw failure('登录会话已失效，请重新开始', 401);
        return { options, cookie: createFlow(req, 'authentication', options.challenge, snapshot.version, sessionId) };
      });
    },
    verifyAuthentication(req, response, source, userAgent) {
      return work(req, source, async current => {
        const ceremony = consume(req, 'authentication'), { flow } = ceremony;
        try {
          ceremony.current();
          sameFrame(response);
          const snapshot = store.snapshot(), credential = snapshot.credentials.find(value => value.id === response?.id);
          if (!credential || snapshot.version !== flow.version || response?.response?.userHandle !== snapshot.userHandle) throw failure();
          const result = await verifyAuthenticationResponse({ response, credential, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: realm.rpID, expectedType: 'webauthn.get', requireUserVerification: true });
          current(); ceremony.current();
          if (!result.verified || !result.authenticationInfo.userVerified) throw failure();
          store.updateCounter(credential.id, result.authenticationInfo.newCounter, flow.version);
          // No awaits between durable counter update and issuing the new session.
          const session = auth.issuePasskeySession(req, credential.id, source, userAgent);
          return { ...session, flowCookie: cookie('') };
        } catch (error) { if (error.status) throw error; throw failure(); }
        finally { ceremony.finish(); }
      });
    },
    remove(req, id) {
      available(req);
      if (typeof id !== 'string' || id.length > 1400) throw failure('无效的通行密钥');
      const removed = store.remove(id);
      if (removed) { generation++; flows.clear(); auth.revokeCredential(id); }
      return { removed, current: !auth.session(req) };
    },
  };
}
