import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createAuth } from '../src/auth.mjs';
import { createPasskeys, passkeyOrigins } from '../src/passkeys.mjs';
import { softwareAuthenticator, withCookies } from './helpers/passkey-authenticator.mjs';

const password = 'passkey-protocol-password', origin = 'https://phone.example';
const request = (sourceOrigin = origin) => ({ headers: { origin: sourceOrigin } });
const rejected = promise => assert.rejects(promise, error => Number.isInteger(error.status) && error.status >= 400);

async function fixture(t) {
  const directory = await mkdtemp('/private/tmp/passkey-protocol-'), path = join(directory, 'credentials.json');
  let time = 1000;
  const auth = createAuth(password, origin, () => time);
  const passkeys = createPasskeys({ auth, password, origin, path, now: () => time });
  t.after(async () => { passkeys.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = withCookies(request(), (await auth.login(password, 'password-owner')).cookie);
  async function register() {
    const authenticator = softwareAuthenticator();
    const registration = await passkeys.registrationOptions(owner, password, 'registration-owner');
    const req = withCookies(owner, registration.cookie);
    assert.equal((await passkeys.verifyRegistration(req, authenticator.registration(registration.options, origin), 'registration-owner')).ok, true);
    return { authenticator, userHandle: registration.options.user.id };
  }
  async function assertion(authenticator, userHandle, changes = {}, start = request(), source = 'login-owner') {
    const ceremony = await passkeys.authenticationOptions(start, source);
    return { req: withCookies(start, ceremony.cookie), response: authenticator.authentication(ceremony.options, start.headers.origin, userHandle, changes), options: ceremony.options };
  }
  return { auth, passkeys, owner, register, assertion, path, advance: amount => { time += amount; }, now: () => time };
}

test('real attestation and signed assertion persist across restart and removing a key revokes its sessions', async t => {
  const { auth, passkeys, owner, register, assertion, path, now } = await fixture(t);
  const { authenticator, userHandle } = await register();
  const first = await assertion(authenticator, userHandle);
  const logged = await passkeys.verifyAuthentication(first.req, first.response, 'login-owner', 'Safari/1');
  assert.equal(logged.status, 200);
  const loggedReq = withCookies(request(), logged.cookie);
  assert.equal(auth.authenticated(loggedReq), true);
  assert.deepEqual(Object.keys(passkeys.list().credentials[0]).sort(), ['backedUp', 'createdAt', 'deviceType', 'id']);
  passkeys.close();
  const newAuth = createAuth(password, origin, now);
  const restarted = createPasskeys({ auth: newAuth, password, origin, path, now });
  t.after(() => restarted.close());
  const next = await restarted.authenticationOptions(request(), 'after-restart');
  const accepted = await restarted.verifyAuthentication(withCookies(request(), next.cookie), authenticator.authentication(next.options, origin, userHandle, { counter: 2 }), 'after-restart');
  const freshReq = withCookies(request(), accepted.cookie);
  assert.equal(newAuth.authenticated(freshReq), true);
  assert.deepEqual(restarted.remove(freshReq, authenticator.id), { removed: true, current: true });
  assert.equal(newAuth.authenticated(freshReq), false);
  assert.deepEqual(restarted.list().credentials, []);
  assert.equal(auth.authenticated(owner), true, 'passkey removal does not revoke independent password sessions');
});

test('registration requires an authenticated session and fresh password confirmation with strict options', async t => {
  const { auth, passkeys, owner } = await fixture(t);
  await rejected(passkeys.registrationOptions(request(), password, 'anonymous'));
  await rejected(passkeys.registrationOptions(owner, 'wrong', 'wrong-password'));
  assert.deepEqual(passkeys.list().credentials, []);
  const result = await passkeys.registrationOptions(owner, password, 'good-password');
  assert.deepEqual(result.options.authenticatorSelection, { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
  assert.equal(result.options.rp.id, 'phone.example');
  assert.match(result.cookie, /HttpOnly; SameSite=Strict; Secure/);
  assert.equal(auth.list(owner).length, 1, 'password confirmation must not create another login session');
});

for (const [name, changes] of [
  ['challenge', { client: { challenge: 'different-challenge' } }],
  ['origin', { client: { origin: 'https://attacker.example' } }],
  ['RP ID', { rpID: 'attacker.example' }],
  ['ceremony type', { client: { type: 'webauthn.get' } }],
  ['user verification', { flags: 0x41 }],
  ['user presence', { flags: 0x44 }],
]) {
  test(`registration rejects altered ${name} and consumes its challenge`, async t => {
    const { passkeys, owner } = await fixture(t), authenticator = softwareAuthenticator();
    const ceremony = await passkeys.registrationOptions(owner, password, name), req = withCookies(owner, ceremony.cookie);
    await rejected(passkeys.verifyRegistration(req, authenticator.registration(ceremony.options, origin, changes), name));
    await rejected(passkeys.verifyRegistration(req, authenticator.registration(ceremony.options, origin), name));
    assert.deepEqual(passkeys.list().credentials, []);
  });
}

for (const [name, changes] of [
  ['challenge', { client: { challenge: 'different-challenge' } }],
  ['origin', { client: { origin: 'https://attacker.example' } }],
  ['RP ID', { rpID: 'attacker.example' }],
  ['ceremony type', { client: { type: 'webauthn.create' } }],
  ['user verification', { flags: 0x01 }],
  ['user presence', { flags: 0x04 }],
  ['signature', { invalidSignature: true }],
]) {
  test(`authentication rejects altered ${name} using real signature verification`, async t => {
    const { auth, passkeys, register, assertion, owner } = await fixture(t);
    const { authenticator, userHandle } = await register();
    const ceremony = await assertion(authenticator, userHandle, changes);
    await rejected(passkeys.verifyAuthentication(ceremony.req, ceremony.response, name));
    await rejected(passkeys.verifyAuthentication(ceremony.req, authenticator.authentication(ceremony.options, origin, userHandle), name));
    assert.equal(auth.list(owner).length, 1);
  });
}

test('userHandle binding, cookie isolation, exact origin, flow type, expiry and replay are enforced', async t => {
  const { passkeys, owner, register, assertion, advance } = await fixture(t);
  const { authenticator, userHandle } = await register();
  const invalidHandle = await assertion(authenticator, 'not-the-owner');
  await rejected(passkeys.verifyAuthentication(invalidHandle.req, invalidHandle.response, 'handle'));
  const a = await assertion(authenticator, userHandle), b = await assertion(authenticator, userHandle);
  await rejected(passkeys.verifyAuthentication(request(), a.response, 'no-cookie'));
  await rejected(passkeys.verifyAuthentication(b.req, a.response, 'cross-cookie'));
  await rejected(passkeys.verifyAuthentication({ headers: { ...a.req.headers, origin: 'https://other.example' } }, a.response, 'cross-origin'));
  assert.equal((await passkeys.verifyAuthentication(a.req, a.response, 'valid')).status, 200);
  await rejected(passkeys.verifyAuthentication(a.req, a.response, 'replay'));
  const wrongType = await passkeys.registrationOptions(owner, password, 'wrong-type');
  await rejected(passkeys.verifyAuthentication(withCookies(owner, wrongType.cookie), a.response, 'wrong-type'));
  const expired = await assertion(authenticator, userHandle, { counter: 2 });
  advance(120000);
  await rejected(passkeys.verifyAuthentication(expired.req, expired.response, 'expired'));
});

for (const mutation of ['cancel', 'logout', 'revoke-all', 'remove', 'close', 'expiry']) {
  test(`a signed assertion in flight cannot create a session after ${mutation}`, async t => {
    const { auth, passkeys, owner, register, assertion, advance } = await fixture(t);
    const { authenticator, userHandle } = await register();
    const ceremony = await assertion(authenticator, userHandle);
    const pending = passkeys.verifyAuthentication(ceremony.req, ceremony.response, mutation);
    if (mutation === 'cancel') passkeys.cancel(ceremony.req);
    if (mutation === 'logout') { auth.logout(ceremony.req); passkeys.cancel(ceremony.req); }
    if (mutation === 'revoke-all') { auth.revokeAll(owner); passkeys.invalidateAll(); }
    if (mutation === 'remove') passkeys.remove(owner, authenticator.id);
    if (mutation === 'close') passkeys.close();
    if (mutation === 'expiry') advance(120000);
    await rejected(pending);
    if (mutation !== 'revoke-all') assert.equal(auth.list(owner).length, 1);
    else assert.equal(auth.session(owner), null);
  });
}

test('revoking the password session during registration prevents durable enrollment', async t => {
  const { auth, passkeys, owner } = await fixture(t), authenticator = softwareAuthenticator();
  const ceremony = await passkeys.registrationOptions(owner, password, 'enroll');
  const req = withCookies(owner, ceremony.cookie);
  const pending = passkeys.verifyRegistration(req, authenticator.registration(ceremony.options, origin), 'enroll');
  auth.logout(owner);
  await rejected(pending);
  assert.deepEqual(passkeys.list().credentials, []);
});

test('pending assertions bound to an existing session cannot revive it after revocation', async t => {
  const { auth, passkeys, owner, register, assertion } = await fixture(t);
  const { authenticator, userHandle } = await register();
  const ceremony = await assertion(authenticator, userHandle, {}, owner);
  const pending = passkeys.verifyAuthentication(ceremony.req, ceremony.response, 'existing');
  auth.logout(owner);
  await rejected(pending);
  assert.equal(auth.session(owner), null);
});

test('parallel ceremonies share optimistic counter version and cannot both issue sessions', async t => {
  const { auth, passkeys, owner, register, assertion } = await fixture(t);
  const { authenticator, userHandle } = await register();
  const first = await assertion(authenticator, userHandle), second = await assertion(authenticator, userHandle);
  const results = await Promise.allSettled([passkeys.verifyAuthentication(first.req, first.response, 'one'), passkeys.verifyAuthentication(second.req, second.response, 'two')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(auth.list(owner).length, 2);
});

test('the same challenge is consumed before asynchronous signature verification begins', async t => {
  const { auth, passkeys, owner, register, assertion } = await fixture(t);
  const { authenticator, userHandle } = await register(), ceremony = await assertion(authenticator, userHandle);
  const pending = passkeys.verifyAuthentication(ceremony.req, ceremony.response, 'first');
  await rejected(passkeys.verifyAuthentication(ceremony.req, ceremony.response, 'second'));
  assert.equal((await pending).status, 200);
  assert.equal(auth.list(owner).length, 2);
  const repeatedCounter = await assertion(authenticator, userHandle);
  await rejected(passkeys.verifyAuthentication(repeatedCounter.req, repeatedCounter.response, 'same-counter'));
});

for (const changes of [{ password: 'rotated-passkey-password' }, { origin: 'https://replacement.example' }]) {
  test(`a ${changes.password ? 'password' : 'RP domain'} rotation prevents old credential authentication`, async t => {
    const { passkeys, register, path, now } = await fixture(t), { authenticator, userHandle } = await register();
    passkeys.close();
    const nextPassword = changes.password ?? password, nextOrigin = changes.origin ?? origin;
    const auth = createAuth(nextPassword, nextOrigin, now);
    const replacement = createPasskeys({ auth, password: nextPassword, origin: nextOrigin, path, now });
    t.after(() => replacement.close());
    assert.deepEqual(replacement.list().credentials, []);
    const req = request(nextOrigin), started = await replacement.authenticationOptions(req, 'replacement');
    await rejected(replacement.verifyAuthentication(withCookies(req, started.cookie), authenticator.authentication(started.options, nextOrigin, userHandle), 'replacement'));
    assert.equal(auth.session(req), null);
  });
}

test('failed durable counter persistence cannot issue an authenticated session', async t => {
  const { auth, passkeys, owner, register, assertion, path } = await fixture(t);
  const { authenticator, userHandle } = await register(), ceremony = await assertion(authenticator, userHandle);
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path) throw Error('simulated private filesystem failure');
    return rename(source, target);
  });
  await rejected(passkeys.verifyAuthentication(ceremony.req, ceremony.response, 'write-failure'));
  mocked.mock.restore();
  assert.equal(auth.list(owner).length, 1);
  assert.equal(passkeys.status().enabled, false);
  assert.equal((await auth.login(password, 'password-fallback')).status, 200);
});

test('HTTP/IP realms are disabled and additional origins stay inside the canonical RP domain', async t => {
  const { auth, path } = await fixture(t);
  for (const sourceOrigin of ['http://192.168.1.2:8787', 'https://192.168.1.2', 'http://phone.example', 'https://localhost', 'https://[::1]']) {
    assert.equal(passkeyOrigins(sourceOrigin), null);
    const disabled = createPasskeys({ auth, password, origin: sourceOrigin, path });
    assert.equal(disabled.status().enabled, false);
    await rejected(disabled.authenticationOptions(request(sourceOrigin), 'disabled'));
    await rejected(disabled.registrationOptions(request(sourceOrigin), password, 'disabled'));
  }
  const realm = passkeyOrigins(origin, ['https://child.phone.example', 'https://other.example', 'https://evilphone.example', 'http://phone.example']);
  assert.deepEqual([...realm.origins], [origin, 'https://child.phone.example']);
});

test('source quotas, four-operation concurrency and 256-flow capacity are bounded', async t => {
  const { passkeys, advance } = await fixture(t);
  const parallel = Array.from({ length: 5 }, (_, index) => passkeys.authenticationOptions(request(), `parallel-${index}`));
  const results = await Promise.allSettled(parallel);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 429);
  for (let index = 0; index < 20; index++) await passkeys.authenticationOptions(request(), 'limited');
  await assert.rejects(passkeys.authenticationOptions(request(), 'limited'), { status: 429 });
  advance(120000);
  for (let index = 0; index < 256; index++) await passkeys.authenticationOptions(request(), `capacity-${index}`);
  await assert.rejects(passkeys.authenticationOptions(request(), 'capacity-overflow'), { status: 429 });
  advance(120000);
  assert.ok((await passkeys.authenticationOptions(request(), 'after-expiry')).options.challenge);
});
