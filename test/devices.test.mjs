import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuth, deviceName } from '../src/auth.mjs';
import { createWebServer } from '../src/http.mjs';
import { Broker } from '../src/broker.mjs';

const password = 'test-password-not-production', origin = 'https://phone.example';
const request = login => ({ headers: { cookie: login.cookie.split(';')[0] } });

test('devices expose separate public IDs and safe names, track visits and prune expired sessions', async () => {
  let time = 1000;
  const auth = createAuth(password, origin, () => time);
  const first = await auth.login(password, '192.0.2.1', 'Mozilla/5.0 (iPhone) Safari/604.1 private-content');
  time += 1000;
  const second = await auth.login(password, '192.0.2.2', 'Mozilla/5.0 (Windows) Chrome/123');
  const list = auth.list(request(first));
  assert.equal(list.length, 2);
  assert.equal(list[0].current, true);
  assert.equal(list[1].current, false);
  assert.equal(list[0].device, 'Safari · iOS');
  assert.equal(list[1].device, 'Chrome · Windows');
  assert.equal(list[0].createdAt, 1000);
  assert.equal(list[0].expiresAt, 1000 + 8 * 60 * 60 * 1000);
  assert.equal(list[0].idleExpiresAt, 1000 + 30 * 60 * 1000);
  for (const session of list) {
    assert.match(session.id, /^[\da-f-]{36}$/);
    assert.ok(!first.cookie.includes(session.id) && !second.cookie.includes(session.id));
    assert.equal(auth.authenticated({ headers: { cookie: `__Host-codex-phone=${session.id}` } }), false);
  }
  assert.doesNotMatch(JSON.stringify(list), /private-content|Mozilla|test-password/);
  const token = request(second).headers.cookie.split('=')[1];
  assert.equal(auth.revoke(request(first), token).revoked, false);
  time += 20 * 60 * 1000;
  assert.equal(auth.authenticated(request(first)), true);
  assert.equal(auth.list(request(first))[0].lastSeen, time);
  time += 11 * 60 * 1000;
  assert.equal(auth.list(request(first)).length, 1);
  assert.equal(auth.authenticated(request(second)), false);
  assert.equal(deviceName('<script>password</script>'), '其他浏览器 · 未知系统');
});

test('single, current and all-device revocations immediately invalidate only their intended sessions', async () => {
  const auth = createAuth(password, origin);
  const first = await auth.login(password, '192.0.2.1'), second = await auth.login(password, '192.0.2.2');
  assert.deepEqual(auth.revoke(request(first), second.session.id), { revoked: true, current: false });
  assert.equal(auth.authenticated(request(second)), false);
  assert.equal(auth.authenticated(request(first)), true);
  assert.deepEqual(auth.revoke(request(first), first.session.id), { revoked: true, current: true });
  assert.equal(auth.authenticated(request(first)), false);
  assert.throws(() => auth.list(request(first)), /验证/);
  assert.throws(() => auth.revokeAll(request(first)), /验证/);
  const third = await auth.login(password, '192.0.2.3'), fourth = await auth.login(password, '192.0.2.4');
  assert.deepEqual(auth.revokeAll(request(third)), { revoked: 2, current: true });
  assert.equal(auth.authenticated(request(third)), false);
  assert.equal(auth.authenticated(request(fourth)), false);
});

async function fixture(t) {
  const dir = await mkdtemp('/private/tmp/phone-devices-'), auditPath = join(dir, 'security-audit.jsonl');
  const sent = [], broker = new Broker(message => sent.push(message)); broker.ready = true;
  const server = createWebServer(broker, { password, origin, auditPath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (iPhone) Safari/604.1' };
  const post = (path, data = {}, cookie, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: JSON.stringify(data) });
  const login = async () => {
    const response = await post('/api/login', { password });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { base, server, post, login, broker, sent, auditPath, headers };
}

test('device APIs enforce authentication and Origin; revocation leaves running tasks, receipts and approvals intact', async t => {
  const { base, post, login, broker, sent } = await fixture(t);
  const first = await login(), second = await login();
  for (const path of ['/api/sessions/list', '/api/sessions/revoke', '/api/sessions/revoke-all', '/api/security-audit/list']) {
    assert.equal((await post(path)).status, 401);
    assert.equal((await post(path, {}, first, { Origin: '' })).status, 403);
    assert.equal((await post(path, {}, first, { Origin: 'https://other.example' })).status, 403);
  }
  const list = await (await post('/api/sessions/list', {}, first)).json();
  assert.equal(list.sessions.length, 2);
  assert.equal(list.sessions.filter(session => session.current).length, 1);
  assert.ok(!JSON.stringify(list).includes(first.split('=')[1]));
  const payload = { key: 'device-turn-001', method: 'turn/start', params: { threadId: 'owned', input: [{ type: 'text', text: 'private task' }] } };
  assert.equal((await post('/api/commands', payload, second)).status, 202);
  broker.receive({ id: sent[0].id, result: { turn: { id: 'running' } } });
  broker.receive({ method: 'turn/started', params: { threadId: 'owned', turn: { id: 'running' } } });
  broker.receive({ id: 'approval-private', method: 'item/commandExecution/requestApproval', params: { threadId: 'owned' } });
  const snapshot = broker.snapshot(), command = broker.getCommand(payload.key);
  const id = list.sessions.find(session => !session.current).id;
  assert.equal((await post('/api/sessions/revoke', { id: second.split('=')[1] }, first)).status, 400);
  const revoked = await post('/api/sessions/revoke', { id }, first);
  assert.deepEqual(await revoked.json(), { revoked: true, current: false });
  assert.equal((await post('/api/commands', { ...payload, key: 'device-turn-002' }, second)).status, 401);
  assert.equal((await post('/api/answer', { id: 'approval-private', result: { decision: 'accept' } }, second)).status, 401);
  assert.deepEqual(broker.snapshot(), snapshot);
  assert.deepEqual(broker.getCommand(payload.key), command);
  assert.equal(sent.length, 1);
  assert.equal((await post('/api/sessions/revoke', { id }, first)).status, 404);
  const all = await post('/api/sessions/revoke-all', {}, first);
  assert.equal(all.status, 200);
  assert.match(all.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await post('/api/sessions/list', {}, first)).status, 401);
  assert.deepEqual(broker.snapshot(), snapshot);
  const fresh = await login();
  const sessions = await (await post('/api/sessions/list', {}, fresh)).json();
  const self = await post('/api/sessions/revoke', { id: sessions.sessions[0].id }, fresh);
  assert.equal((await self.json()).current, true);
  assert.match(self.headers.get('set-cookie'), /Max-Age=0/);
  for (const asset of ['/task-preferences.js', '/delivery-state.js', '/device-panel.js']) {
    assert.equal((await fetch(base + asset)).status, 401);
  }
});

test('revocation while a control request body is arriving blocks upstream submission', async t => {
  const { base, server, post, login, sent, headers } = await fixture(t);
  const first = await login(), second = await login();
  const sessions = await (await post('/api/sessions/list', {}, first)).json();
  const id = sessions.sessions.find(session => !session.current).id;
  const started = new Promise(resolve => server.on('request', req => { if (req.headers['x-test-slow']) resolve(); }));
  let pending;
  const response = new Promise((resolve, reject) => {
    pending = http.request(base + '/api/commands', { method: 'POST', headers: { ...headers, Cookie: second, 'X-Test-Slow': '1' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    pending.on('error', reject);
    pending.write('{"key":');
  });
  await started;
  assert.equal((await post('/api/sessions/revoke', { id }, first)).status, 200);
  pending.end('"slow-turn-001","method":"thread/list","params":{}}');
  assert.equal(await response, 401);
  assert.equal(sent.length, 0);
});

test('HTTP security audit covers outcomes without passwords, cookies, task inputs or upstream error text', async t => {
  const { post, login, broker, sent, auditPath } = await fixture(t);
  const cookie = await login();
  const secret = 'secret-body-rpc-error-or-approval';
  assert.equal((await post('/api/login', { password: secret })).status, 401);
  for (let i = 0; i < 5; i++) await post('/api/login', { password: secret });
  await post('/api/commands', { key: 'audit-key-001', method: 'thread/name/set', params: { threadId: 'owned', name: secret } }, cookie);
  broker.receive({ id: sent[0].id, error: { code: -1, message: secret } });
  await post('/api/commands', { key: 'audit-key-001', method: 'thread/name/set', params: { threadId: 'owned', name: secret } }, cookie);
  broker.receive({ id: secret, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q' }] } });
  assert.equal((await post('/api/answer', { id: secret, result: { answers: { q: { answers: [secret] } } } }, cookie)).status, 200);
  assert.equal((await post('/api/answer', { id: secret, result: { answers: secret } }, cookie)).status, 400);
  const audit = await (await post('/api/security-audit/list', {}, cookie)).json();
  for (const [action, result] of [['login', 'success'], ['login', 'failed'], ['login', 'limited'], ['rpc.submit', 'accepted'], ['rpc.submit', 'failed'], ['approval.answer', 'success'], ['approval.answer', 'failed']]) {
    assert.ok(audit.events.some(event => event.action === action && event.result === result), `${action}: ${result}`);
  }
  const persisted = await readFile(auditPath, 'utf8');
  for (const value of [secret, password, cookie, cookie.split('=')[1], 'audit-key-001']) {
    assert.ok(!persisted.includes(value));
    assert.ok(!JSON.stringify(audit).includes(value));
  }
  assert.equal((await stat(auditPath)).mode & 0o777, 0o600);
});

test('read-only RPC traffic neither creates control audit entries nor consumes their reserved budget', async t => {
  const { post, login } = await fixture(t);
  const cookie = await login();
  const methods = ['thread/list', 'thread/read', 'thread/resume', 'thread/items/list', 'thread/turns/list', 'thread/goal/get'];
  for (let i = 0; i < 72; i++) {
    assert.equal((await post('/api/commands', { key: `read-key-${i}`, method: methods[i % methods.length], params: { threadId: 'owned' } }, cookie)).status, 202);
  }
  assert.equal((await post('/api/commands', { key: 'control-key-001', method: 'thread/name/set', params: { threadId: 'owned', name: 'updated' } }, cookie)).status, 202);
  const audit = await (await post('/api/security-audit/list', {}, cookie)).json();
  assert.deepEqual(audit.events.filter(event => event.action === 'rpc.submit').map(event => event.result), ['accepted']);
  assert.equal(audit.suppressed, 0);
});
