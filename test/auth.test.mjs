import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../src/auth.mjs';

const password = 'test-password-not-production';
test('password and remote HTTPS requirements fail closed', () => {
  assert.throws(() => createAuth('short', 'http://localhost:8787'), /12/);
  assert.throws(() => createAuth(password, 'http://phone.example'), /HTTPS/);
  assert.throws(() => createAuth(password, 'https://phone.example/path'), /来源/);
});

test('LAN HTTP requires explicit opt-in and never allows public IPs or arbitrary domains', () => {
  assert.throws(() => createAuth(password, 'http://192.168.1.100:8787'), /HTTPS/);
  assert.doesNotThrow(() => createAuth(password, 'http://192.168.1.100:8787', Date.now, { allowLanHttp: true }));
  for (const host of ['8.8.8.8', 'phone.example', '172.32.0.1']) {
    assert.throws(() => createAuth(password, `http://${host}:8787`, Date.now, { allowLanHttp: true }), /HTTPS/);
  }
});

test('session expires after eight hours even with activity; a restart revokes it', async () => {
  let now = 0;
  const auth = createAuth(password, 'https://phone.example', () => now);
  const result = await auth.login(password);
  const request = { headers: { cookie: result.cookie.split(';')[0] } };
  for (let i = 0; i < 47; i++) {
    now += 10 * 60 * 1000;
    assert.equal(auth.authenticated(request), true);
  }
  now += 10 * 60 * 1000;
  assert.equal(auth.authenticated(request), false);
  const restarted = createAuth(password, 'https://phone.example');
  assert.equal(restarted.authenticated(request), false);
});

test('simultaneous password guesses are bounded', async () => {
  const auth = createAuth(password, 'https://phone.example');
  const first = auth.login('wrong', 'attacker');
  const second = auth.login(password, 'owner');
  assert.equal((await auth.login('wrong', 'third')).status, 429);
  assert.equal((await first).status, 401);
  assert.equal((await second).status, 200);
  assert.equal((await auth.login(password, 'third')).status, 200);
});

test('invalid structures do not consume quota; one source cannot lock another', async () => {
  let now = 0;
  const auth = createAuth(password, 'https://phone.example', () => now);
  for (const value of [undefined, null, {}, [], 123, 'x'.repeat(1025)]) {
    assert.equal((await auth.login(value, 'owner')).status, 401);
  }
  assert.equal((await auth.login(password, 'owner')).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await auth.login('wrong', 'attacker')).status, 401);
  assert.equal((await auth.login(password, 'attacker')).status, 429);
  assert.equal((await auth.login(password, 'owner')).status, 200);
  assert.equal((await auth.login('wrong', 'attacker')).status, 429, 'other successes do not reset attacker budget');
  now = 30000;
  assert.equal((await auth.login(password, 'attacker')).retryAfter, 30);
  now = 60000;
  assert.equal((await auth.login(password, 'attacker')).status, 200);
});
