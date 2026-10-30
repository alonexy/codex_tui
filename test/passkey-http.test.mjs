import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createWebServer } from '../src/http.mjs';
import { Broker } from '../src/broker.mjs';
import { softwareAuthenticator, withCookies } from './helpers/passkey-authenticator.mjs';

const password = 'passkey-http-test-password', origin = 'https://phone.example';
const cookies = (response, previous = '') => withCookies({ headers: { cookie: previous } }, ...response.headers.getSetCookie()).headers.cookie;

async function fixture(t, settings = {}) {
  const dir = await mkdtemp('/private/tmp/passkey-http-'), passkeyPath = join(dir, 'passkeys.json');
  const sent = [], broker = new Broker(message => sent.push(message)); broker.ready = true;
  const server = createWebServer(broker, { password, origin, passkeyPath, uploadDirectory: join(dir, 'uploads'), ...settings });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: settings.origin ?? origin, 'Content-Type': 'application/json' };
  const get = (path, cookie) => fetch(base + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  const post = (path, data = {}, cookie, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(data) });
  async function login(previous) {
    const response = await post('/api/login', { password }, previous);
    assert.equal(response.status, 200); return cookies(response, previous);
  }
  async function register(owner) {
    const authenticator = softwareAuthenticator();
    const options = await post('/api/passkeys/register/options', { password }, owner);
    assert.equal(options.status, 200);
    const ceremony = await options.json(), flow = cookies(options, owner);
    const response = authenticator.registration(ceremony.options, headers.Origin);
    const verified = await post('/api/passkeys/register/verify', { response }, flow);
    assert.equal(verified.status, 200);
    return { authenticator, userHandle: ceremony.options.user.id };
  }
  async function assertion(authenticator, userHandle, counter = 1) {
    const options = await post('/api/passkeys/authenticate/options');
    assert.equal(options.status, 200);
    const ceremony = await options.json();
    return { flow: cookies(options), response: authenticator.authentication(ceremony.options, headers.Origin, userHandle, { counter }), challenge: ceremony.options.challenge };
  }
  return { dir, passkeyPath, server, broker, sent, base, headers, get, post, login, register, assertion };
}

test('HTTP registers a real passkey, authenticates after logout and removes its linked sessions', async t => {
  const { get, post, login, register, assertion } = await fixture(t);
  const status = await get('/api/passkeys/status');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { enabled: true, rpID: 'phone.example' });
  const owner = await login(), { authenticator, userHandle } = await register(owner);
  const listed = await (await post('/api/passkeys/list', {}, owner)).json();
  assert.equal(listed.credentials.length, 1);
  assert.deepEqual(Object.keys(listed.credentials[0]).sort(), ['backedUp', 'createdAt', 'deviceType', 'id']);
  assert.equal((await post('/api/logout', {}, owner)).status, 200);
  assert.equal((await get('/api/state', owner)).status, 401);
  const first = await assertion(authenticator, userHandle);
  const verify = await post('/api/passkeys/authenticate/verify', { response: first.response }, first.flow);
  assert.equal(verify.status, 200);
  assert.ok(verify.headers.getSetCookie().some(value => value.startsWith('__Host-codex-phone=') && /HttpOnly; SameSite=Strict.*Secure/.test(value)));
  const session = cookies(verify, first.flow);
  assert.equal((await get('/api/state', session)).status, 200);
  assert.equal((await post('/api/passkeys/authenticate/verify', { response: first.response }, first.flow)).status, 400);
  const removed = await post('/api/passkeys/remove', { id: authenticator.id }, session);
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { removed: true, current: true });
  assert.equal((await get('/api/state', session)).status, 401);
  const second = await assertion(authenticator, userHandle, 2);
  assert.equal((await post('/api/passkeys/authenticate/verify', { response: second.response }, second.flow)).status, 400);
  const passwordSession = await login();
  assert.equal((await get('/api/state', passwordSession)).status, 200);
});

test('passkey HTTP endpoints preserve authentication, JSON and exact Origin checks', async t => {
  const { post, get, login } = await fixture(t);
  const owner = await login();
  for (const path of ['/api/passkeys/list', '/api/passkeys/remove', '/api/passkeys/register/options', '/api/passkeys/register/verify']) assert.equal((await post(path)).status, 401, path);
  for (const path of ['/api/passkeys/register/options', '/api/passkeys/register/verify', '/api/passkeys/authenticate/options', '/api/passkeys/authenticate/verify', '/api/passkeys/remove', '/api/passkeys/cancel']) {
    assert.equal((await post(path, {}, owner, { Origin: '' })).status, 403, path);
    assert.equal((await post(path, {}, owner, { Origin: 'https://attacker.example' })).status, 403, path);
  }
  for (const path of ['/api/passkeys/register/options', '/api/passkeys/register/verify', '/api/passkeys/authenticate/options', '/api/passkeys/authenticate/verify']) assert.equal((await post(path, {}, owner, { 'Content-Type': 'text/plain' })).status, 415, path);
  assert.equal((await post('/api/passkeys/register/options', { password: 'incorrect' }, owner)).status, 403);
  assert.equal((await get('/passkey-settings.js')).status, 401);
  assert.equal((await get('/passkey-client.js')).status, 200);
  assert.equal((await get('/vendor/webauthn-browser.js')).status, 200);
  assert.equal((await post('/api/passkeys/authenticate/verify', { response: 'x'.repeat(70000) })).status, 400);
});

test('current HTTP/IP deployment disables passkeys while password login remains usable', async t => {
  const { get, post, login, passkeyPath } = await fixture(t, { origin: 'http://127.0.0.1:8787' });
  const status = await (await get('/api/passkeys/status')).json();
  assert.equal(status.enabled, false); assert.match(status.reason, /HTTPS/);
  assert.equal((await post('/api/passkeys/authenticate/options')).status, 503);
  const owner = await login();
  assert.equal((await post('/api/passkeys/register/options', { password }, owner)).status, 503);
  assert.equal((await get('/api/state', owner)).status, 200);
  await assert.rejects(readFile(passkeyPath), { code: 'ENOENT' });
});

test('an unavailable credential file disables passkeys without breaking password fallback', async t => {
  const { get, post, login } = await fixture(t, { passkeyPath: undefined });
  assert.deepEqual(await (await get('/api/passkeys/status')).json(), { enabled: false, reason: '通行密钥存储不可用，请使用密码登录' });
  assert.equal((await post('/api/passkeys/authenticate/options')).status, 503);
  const owner = await login(); assert.equal((await get('/api/state', owner)).status, 200);
});

test('configured sibling origins cannot enlarge the RP and accepted child origins remain ceremony-specific', async t => {
  const { post, login } = await fixture(t, { additionalOrigins: ['https://child.phone.example', 'https://sibling.example'] });
  const owner = await login();
  assert.equal((await post('/api/passkeys/authenticate/options', {}, undefined, { Origin: 'https://sibling.example' })).status, 403);
  const started = await post('/api/passkeys/register/options', { password }, owner, { Origin: 'https://child.phone.example' });
  assert.equal(started.status, 200);
  const { options } = await started.json(), authenticator = softwareAuthenticator();
  assert.equal(options.rp.id, 'phone.example');
  const response = authenticator.registration(options, 'https://child.phone.example');
  assert.equal((await post('/api/passkeys/register/verify', { response }, cookies(started, owner))).status, 400);
  assert.equal((await post('/api/passkeys/register/verify', { response }, cookies(started, owner), { Origin: 'https://child.phone.example' })).status, 200);
});

test('cancel, logout and revoke-all invalidate browser flow cookies before a signed response is submitted', async t => {
  const { post, login, register, assertion } = await fixture(t);
  const owner = await login(), { authenticator, userHandle } = await register(owner);
  for (const action of ['/api/passkeys/cancel', '/api/logout', '/api/sessions/revoke-all']) {
    const ceremony = await assertion(authenticator, userHandle);
    assert.equal((await post(action, {}, action.endsWith('revoke-all') ? owner : ceremony.flow)).status, 200);
    assert.equal((await post('/api/passkeys/authenticate/verify', { response: ceremony.response }, ceremony.flow)).status, 400);
  }
});

test('security audit records passkey events without password, challenge, userHandle or signature', async t => {
  const { post, login, register, assertion } = await fixture(t);
  const owner = await login(), { authenticator, userHandle } = await register(owner);
  const ceremony = await assertion(authenticator, userHandle);
  assert.equal((await post('/api/passkeys/authenticate/verify', { response: ceremony.response }, ceremony.flow)).status, 200);
  await post('/api/passkeys/remove', { id: authenticator.id }, owner);
  const audit = await (await post('/api/security-audit/list', {}, owner)).json();
  for (const action of ['passkey.register', 'passkey.login', 'passkey.remove']) assert.ok(audit.events.some(event => event.action === action));
  const text = JSON.stringify(audit);
  for (const secret of [password, userHandle, ceremony.challenge, ceremony.response.response.signature, '"publicKey"']) assert.ok(!text.includes(secret));
});

for (const fails of [false, true]) {
  test(`revocation during a delayed ${fails ? 'failed' : 'successful'} content request removes its private payload`, async t => {
    const { get, post, login, broker } = await fixture(t);
    const owner = await login();
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    broker.snapshot = () => { started(); return new Promise((resolve, reject) => { release = () => fails ? reject(Error('private-snapshot-failure')) : resolve({ capabilities: {}, privateTask: 'private-snapshot-content' }); }); };
    const pending = get('/api/state', owner); await waiting;
    assert.equal((await post('/api/logout', {}, owner)).status, 200); release();
    const response = await pending;
    assert.equal(response.status, 401); assert.doesNotMatch(await response.text(), /private-snapshot/);
  });
}

test('revoking access during attachment download removes filename headers and private body', async t => {
  const { post, get, login, dir } = await fixture(t), owner = await login();
  const id = 'da56b17c-1fe0-4f56-b71f-50e60b2cebb4', directory = join(dir, 'uploads'), path = join(directory, `${id}.txt`);
  const name = 'private-client-name.txt', content = 'private-attachment-body';
  await mkdir(directory); await writeFile(path, content);
  await writeFile(join(directory, `${id}.meta.json`), JSON.stringify({ id, path, name, extension: 'txt', size: Buffer.byteLength(content), kind: 'file', retention: 'retained' }));
  const authorized = await get(`/api/attachments/${id}`, owner);
  assert.equal(authorized.status, 200); assert.ok(authorized.headers.get('content-disposition').includes(name)); assert.equal(await authorized.text(), content);
  const originalOpen = fs.open;
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { started = resolve; });
  fs.open = async (...args) => { if (args[0] === path) { started(); await gate; } return originalOpen(...args); };
  syncBuiltinESMExports();
  try {
    const pending = get(`/api/attachments/${id}`, owner);
    await Promise.race([waiting, pending.then(() => { throw Error('Download completed before file-open gate'); })]);
    assert.equal((await post('/api/logout', {}, owner)).status, 200); release();
    const response = await pending;
    assert.equal(response.status, 401); assert.equal(response.headers.get('content-disposition'), null); assert.equal(response.headers.get('content-encoding'), null);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    const body = await response.text(); assert.ok(!body.includes(name)); assert.ok(!body.includes(content));
  } finally { release(); fs.open = originalOpen; syncBuiltinESMExports(); }
});

test('revoking access while a control body arrives prevents upstream submission', async t => {
  const { post, login, server, base, headers, sent } = await fixture(t), owner = await login();
  const started = new Promise(resolve => server.on('request', req => { if (req.headers['x-test-slow']) resolve(); }));
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = http.request(base + '/api/commands', { method: 'POST', headers: { ...headers, Cookie: owner, 'X-Test-Slow': '1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    pending.on('error', reject); pending.write('{"key":');
  });
  await started; assert.equal((await post('/api/logout', {}, owner)).status, 200);
  pending.end('"revoked-slow-command","method":"thread/list","params":{}}');
  assert.equal(await response, 401); assert.equal(sent.length, 0);
});
