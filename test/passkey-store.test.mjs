import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createPasskeyStore } from '../src/passkey-store.mjs';

const password = 'isolated-passkey-store-password', rpID = 'phone.example';
const reason = '通行密钥存储不可用，请使用密码登录';
const key = (id = 1) => ({ id: Buffer.from(`credential-${id}`).toString('base64url'), publicKey: Uint8Array.from([1, 2, 3, id]), counter: 0, transports: ['internal', 'hybrid'], deviceType: 'multiDevice', backedUp: true, createdAt: 1234 });

function fixture(t) {
  const directory = fs.mkdtempSync('/private/tmp/passkey-store-'), path = join(directory, 'keys.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const open = overrides => createPasskeyStore({ path, password, rpID, now: () => 1234, ...overrides });
  return { directory, path, open };
}

function unavailable(store) {
  assert.deepEqual(store.status(), { available: false, reason });
  for (const method of [() => store.snapshot(), () => store.register(key(), 0), () => store.updateCounter(key().id, 1, 0), () => store.remove(key().id)]) assert.throws(method, error => error.message === reason);
}

test('new storage is private, bounded, password-free and survives restart with its stable handle', t => {
  const { open, path } = fixture(t), first = open();
  assert.deepEqual(first.status(), { available: true });
  const empty = first.snapshot();
  assert.equal(empty.version, 0); assert.deepEqual(empty.credentials, []);
  assert.equal(Buffer.from(empty.userHandle, 'base64url').length, 32);
  first.register(key(), empty.version);
  assert.equal(first.snapshot().version, 1);
  const bytes = fs.readFileSync(path, 'utf8'), saved = JSON.parse(bytes);
  assert.ok(!bytes.includes(password)); assert.ok(Buffer.byteLength(bytes) < 1024 * 1024);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(Buffer.from(saved.binding.salt, 'base64url').length, 32);
  assert.equal(Buffer.from(saved.binding.hash, 'base64url').length, 32);
  assert.equal(typeof saved.credentials[0].publicKey, 'string');
  const restarted = open().snapshot();
  assert.equal(restarted.userHandle, empty.userHandle);
  assert.deepEqual(restarted.credentials, [key()]);
});

test('password or RP changes atomically rotate handle and remove previous credentials', t => {
  const { open, path } = fixture(t), store = open();
  store.register(key(), 0);
  const original = store.snapshot(), oldBinding = JSON.parse(fs.readFileSync(path, 'utf8')).binding;
  const rotated = open({ password: 'new-isolated-access-password' });
  assert.deepEqual(rotated.status(), { available: true });
  assert.notEqual(rotated.snapshot().userHandle, original.userHandle);
  assert.deepEqual(rotated.snapshot().credentials, []);
  const newBinding = JSON.parse(fs.readFileSync(path, 'utf8')).binding;
  assert.notEqual(newBinding.salt, oldBinding.salt); assert.notEqual(newBinding.hash, oldBinding.hash);
  unavailable(store);
  rotated.register(key(2), 0);
  const beforeRP = rotated.snapshot().userHandle;
  const newRP = open({ password: 'new-isolated-access-password', rpID: 'other.example' });
  assert.deepEqual(newRP.snapshot().credentials, []);
  assert.notEqual(newRP.snapshot().userHandle, beforeRP);
  unavailable(rotated);
});

test('schema corruption never becomes an empty store, including during password rotation', t => {
  const { open, path } = fixture(t);
  open();
  const valid = JSON.parse(fs.readFileSync(path, 'utf8'));
  for (const malformed of ['{broken', JSON.stringify({ ...valid, credentials: 'wrong' }), JSON.stringify({ ...valid, unexpected: 'metadata' }), JSON.stringify({ ...valid, userHandle: 'not-32-bytes' }), JSON.stringify({ ...valid, binding: { salt: valid.binding.salt, hash: 'bad' } }), JSON.stringify({ ...valid, credentials: [{ ...key(), publicKey: 'AQ', secret: true }] })]) {
    fs.writeFileSync(path, malformed);
    unavailable(open({ password: 'rotated-password-still-denied' }));
    assert.equal(fs.readFileSync(path, 'utf8'), malformed);
  }
});

test('snapshots and registered input are deep copies rather than writable store references', t => {
  const { open } = fixture(t), store = open(), input = key();
  store.register(input, 0);
  input.publicKey.fill(255); input.transports.push('usb'); input.counter = 99;
  const snapshot = store.snapshot();
  snapshot.credentials[0].publicKey.fill(100); snapshot.credentials[0].transports.push('ble');
  snapshot.credentials[0].counter = 42; snapshot.credentials.push(key(2)); snapshot.userHandle = 'changed';
  assert.deepEqual(store.snapshot().credentials, [key()]);
  assert.notEqual(store.snapshot().userHandle, snapshot.userHandle);
});

test('versions serialize registration, counter updates and deletion without disabling a valid store', t => {
  const { open } = fixture(t), store = open();
  store.register(key(), 0);
  assert.throws(() => store.register(key(2), 0), /已变化/);
  assert.throws(() => store.updateCounter(key().id, 1, 0), /已变化/);
  assert.equal(store.snapshot().version, 1);
  store.updateCounter(key().id, 0, 1);
  store.updateCounter(key().id, 4, 2);
  assert.throws(() => store.updateCounter(key().id, 3, 3), /计数器/);
  assert.throws(() => store.updateCounter(key().id, 0x100000000, 3), /计数器/);
  assert.throws(() => store.updateCounter('missing', 5, 3), /计数器/);
  assert.equal(store.snapshot().credentials[0].counter, 4);
  assert.equal(store.remove('missing'), false); assert.equal(store.snapshot().version, 3);
  assert.equal(store.remove(key().id), true); assert.equal(store.snapshot().version, 4);
  assert.deepEqual(store.snapshot().credentials, []);
  assert.deepEqual(store.status(), { available: true });
  assert.deepEqual(open().snapshot().credentials, []);
});

test('registration rejects duplicate IDs, excess metadata, invalid lengths and unsupported values', t => {
  const { open } = fixture(t), store = open();
  const invalid = [
    { ...key(), id: '' }, { ...key(), id: 'YQ==' }, { ...key(), id: Buffer.alloc(1025).toString('base64url') },
    { ...key(), publicKey: [] }, { ...key(), publicKey: new Uint8Array(0) }, { ...key(), publicKey: new Uint8Array(4097) },
    { ...key(), transports: ['arbitrary'] }, { ...key(), transports: ['usb', 'usb'] },
    { ...key(), counter: -1 }, { ...key(), counter: 0.5 }, { ...key(), counter: 0x100000000 },
    { ...key(), backedUp: 'true' }, { ...key(), deviceType: 'unknown' }, { ...key(), createdAt: NaN },
    { ...key(), privateKey: 'must-never-persist' },
  ];
  for (const entry of invalid) assert.throws(() => store.register(entry, 0), /无效/);
  assert.deepEqual(store.snapshot().credentials, []);
  const largest = { ...key(), id: Buffer.alloc(1024, 1).toString('base64url'), publicKey: new Uint8Array(4096) };
  store.register(largest, 0);
  assert.throws(() => store.register(largest, 1), /已登记/);
  assert.deepEqual(store.status(), { available: true });
});

test('credential and file size limits reject excess data without retaining partial additions', t => {
  const { open, path } = fixture(t), store = open();
  for (let index = 0; index < 32; index++) store.register(key(index), index);
  assert.equal(store.snapshot().credentials.length, 32);
  const before = fs.readFileSync(path, 'utf8');
  assert.throws(() => store.register(key(33), 32), /上限/);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  assert.deepEqual(store.status(), { available: true });
  fs.writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
  unavailable(open()); unavailable(store);
});

test('missing configuration stays unavailable without throwing during Web startup', () => {
  for (const settings of [undefined, {}, { password, rpID }, { path: '', password, rpID }, { path: '/unused', password: null, rpID }]) {
    let store; assert.doesNotThrow(() => { store = createPasskeyStore(settings); }); unavailable(store);
  }
});

test('symlinks, hardlinks and non-regular credential paths are rejected without altering targets', t => {
  const { open, path, directory } = fixture(t), target = join(directory, 'target');
  fs.writeFileSync(target, 'protected-target', { mode: 0o600 });
  fs.symlinkSync(target, path); unavailable(open());
  assert.equal(fs.readFileSync(target, 'utf8'), 'protected-target');
  fs.unlinkSync(path); fs.linkSync(target, path); unavailable(open());
  assert.equal(fs.readFileSync(target, 'utf8'), 'protected-target');
  fs.unlinkSync(path); fs.mkdirSync(path); unavailable(open());
});

test('a FIFO is rejected before opening and cannot block password-only Web startup', { skip: process.platform === 'win32' }, t => {
  const { open, path } = fixture(t);
  execFileSync('mkfifo', [path]);
  const original = fs.openSync;
  let fifoOpens = 0;
  const mocked = t.mock.method(fs, 'openSync', (target, ...args) => {
    if (target === path) { fifoOpens++; throw Error('Refuse to block opening the test FIFO'); }
    return original(target, ...args);
  });
  unavailable(open()); mocked.mock.restore();
  assert.equal(fifoOpens, 0, 'non-regular files must be rejected before open');
});

test('unsafe parent directories and permissive files fail closed', t => {
  const { open, path, directory } = fixture(t);
  open(); fs.chmodSync(path, 0o644); unavailable(open());
  fs.chmodSync(path, 0o600); fs.chmodSync(directory, 0o777); unavailable(open());
  fs.chmodSync(directory, 0o700);
  const alias = join(directory, 'alias'); fs.symlinkSync(directory, alias);
  unavailable(open({ path: join(alias, 'other.json') }));
  assert.equal(fs.existsSync(join(directory, 'other.json')), false);
});

test('every operation detects external edits, replacements, deletions and new hardlinks', t => {
  const { open, path, directory } = fixture(t);
  for (const mutation of ['edit', 'replace', 'delete', 'link']) {
    const target = join(directory, `${mutation}.json`), store = open({ path: target });
    const saved = fs.readFileSync(target);
    if (mutation === 'edit') fs.writeFileSync(target, saved.toString().replace('phone.example', 'other.example'));
    if (mutation === 'replace') { const replacement = target + '.next'; fs.writeFileSync(replacement, saved, { mode: 0o600 }); fs.renameSync(replacement, target); }
    if (mutation === 'delete') fs.unlinkSync(target);
    if (mutation === 'link') fs.linkSync(target, target + '.link');
    unavailable(store);
  }
  assert.equal(fs.existsSync(path), false);
});

test('parent directory replacement invalidates an existing store even with identical file bytes', t => {
  const { open, directory } = fixture(t), parent = join(directory, 'state'), path = join(parent, 'keys.json');
  const store = open({ path }), saved = fs.readFileSync(path);
  fs.renameSync(parent, parent + '.old'); fs.mkdirSync(parent, { mode: 0o700 }); fs.writeFileSync(path, saved, { mode: 0o600 });
  unavailable(store);
});

test('atomic rename failure retains old disk contents, reports no success and removes its temporary file', t => {
  const { open, path, directory } = fixture(t), store = open(), before = fs.readFileSync(path, 'utf8');
  const rename = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path) throw Object.assign(new Error('private-filesystem-failure'), { code: 'EIO' });
    return rename(source, target);
  });
  assert.throws(() => store.register(key(), 0), error => error.message === reason);
  assert.equal(fs.readFileSync(path, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(directory), ['keys.json']);
  unavailable(store); mocked.mock.restore();
  assert.deepEqual(open().snapshot().credentials, []);
});

test('startup write failure only disables passkeys, and a counter write failure cannot report success', t => {
  const { open, path } = fixture(t), store = open(); store.register(key(), 0);
  const before = fs.readFileSync(path, 'utf8'), write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (typeof args[0] === 'number') throw new Error('sensitive-disk-error');
    return write(...args);
  });
  assert.throws(() => store.updateCounter(key().id, 1, 1), error => error.message === reason);
  assert.equal(fs.readFileSync(path, 'utf8'), before); unavailable(store);
  unavailable(open({ path: path + '.fresh' }));
  assert.equal(fs.existsSync(path + '.fresh'), false);
  mocked.mock.restore();
  assert.equal(open().snapshot().credentials[0].counter, 0);
});
