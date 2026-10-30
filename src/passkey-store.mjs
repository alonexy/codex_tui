import fs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const unavailable = '通行密钥存储不可用，请使用密码登录';
const maximumBytes = 1024 * 1024, maximumCredentials = 32;
const transports = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card', 'cable']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const encode = value => Buffer.from(value).toString('base64url');

function decode(value, maximum, exact) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('无效的通行密钥');
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > maximum || (exact !== undefined && bytes.length !== exact) || encode(bytes) !== value) throw Error('无效的通行密钥');
  return bytes;
}

function credential(value, serialized = false) {
  if (!exactKeys(value, ['id', 'publicKey', 'counter', 'deviceType', 'backedUp', 'createdAt'], ['transports'])) throw Error('无效的通行密钥');
  decode(value.id, 1024);
  const key = serialized ? decode(value.publicKey, 4096) : value.publicKey;
  if (!(key instanceof Uint8Array) || key.byteLength < 1 || key.byteLength > 4096 || !uint32(value.counter) || !['singleDevice', 'multiDevice'].includes(value.deviceType) || typeof value.backedUp !== 'boolean' || !timestamp(value.createdAt)) throw Error('无效的通行密钥');
  if (value.transports !== undefined && (!Array.isArray(value.transports) || value.transports.length > transports.size || new Set(value.transports).size !== value.transports.length || value.transports.some(item => !transports.has(item)))) throw Error('无效的通行密钥');
  return {
    id: value.id, publicKey: encode(key), counter: value.counter, deviceType: value.deviceType,
    backedUp: value.backedUp, createdAt: value.createdAt,
    ...(value.transports === undefined ? {} : { transports: [...value.transports] }),
  };
}

function document(value) {
  if (!exactKeys(value, ['schema', 'rpID', 'binding', 'userHandle', 'credentials']) || value.schema !== 1 || typeof value.rpID !== 'string' || !value.rpID.length || value.rpID.length > 253 || !exactKeys(value.binding, ['salt', 'hash']) || !Array.isArray(value.credentials) || value.credentials.length > maximumCredentials) throw Error(unavailable);
  decode(value.binding.salt, 32, 32); decode(value.binding.hash, 32, 32); decode(value.userHandle, 32, 32);
  const credentials = value.credentials.map(item => credential(item, true));
  if (new Set(credentials.map(item => item.id)).size !== credentials.length) throw Error(unavailable);
  return { schema: 1, rpID: value.rpID, binding: { ...value.binding }, userHandle: value.userHandle, credentials };
}

// A single Web process owns this store. Any outside replacement/edit disables it;
// optimistic versions guard asynchronous WebAuthn ceremonies within that process.
export function createPasskeyStore({ path, password, rpID, now = Date.now } = {}) {
  let available = false, state, version = 0, expected, file, directory, parent, parentIdentity;
  const fail = () => { available = false; throw Error(unavailable); };
  const identity = stat => `${stat.dev}:${stat.ino}`;
  const fingerprint = stat => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const owner = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
  function checkDirectory() {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owner(stat) || (stat.mode & 0o022) || fs.realpathSync(parent) !== directory || identity(stat) !== parentIdentity) throw Error(unavailable);
  }
  function read() {
    checkDirectory();
    let fd;
    try {
      const candidate = fs.lstatSync(file);
      if (!candidate.isFile() || candidate.nlink !== 1 || !owner(candidate) || (candidate.mode & 0o777) !== 0o600 || candidate.size < 1 || candidate.size > maximumBytes) throw Error(unavailable);
      // NONBLOCK also covers replacement with a FIFO between lstat and open.
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owner(stat) || (stat.mode & 0o777) !== 0o600 || fingerprint(stat) !== fingerprint(candidate)) throw Error(unavailable);
      // A bounded read does not allocate from a concurrently growing file size.
      const bytes = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
        if (!count) break;
        size += count;
      }
      const after = fs.fstatSync(fd), linked = fs.lstatSync(file);
      if (size !== stat.size || fingerprint(after) !== fingerprint(stat) || identity(linked) !== identity(stat) || !linked.isFile() || linked.nlink !== 1) throw Error(unavailable);
      return { text: bytes.subarray(0, size).toString('utf8'), fingerprint: fingerprint(after) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function unchanged() {
    if (!expected) {
      checkDirectory();
      try { fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw Error(unavailable);
    }
    const actual = read();
    if (actual.fingerprint !== expected.fingerprint || actual.text !== expected.text) throw Error(unavailable);
  }
  function persist(next) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > maximumBytes) throw Error('通行密钥存储已满');
    let temporary, fd;
    try {
      unchanged();
      temporary = join(directory, `.${basename(file)}.${randomBytes(16).toString('hex')}.tmp`);
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, text); fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || !owner(stat) || (stat.mode & 0o777) !== 0o600) throw Error(unavailable);
      fs.closeSync(fd); fd = undefined;
      unchanged();
      fs.renameSync(temporary, file); temporary = undefined;
      const saved = read();
      if (saved.text !== text) throw Error(unavailable);
      fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      expected = saved; state = next;
    } catch { fail(); }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Already unavailable. */ } }
      if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Never trust a partial write. */ } }
    }
  }
  function ensure() {
    if (!available) throw Error(unavailable);
    try { unchanged(); } catch { fail(); }
  }
  function checkVersion(value) {
    if (!Number.isSafeInteger(value) || value !== version) throw Error('通行密钥已变化，请重新验证');
  }
  try {
    if (typeof path !== 'string' || !path || typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024 || typeof rpID !== 'string' || !rpID.length || rpID.length > 253 || !timestamp(now())) throw Error(unavailable);
    parent = dirname(resolve(path));
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(parent);
    directory = fs.realpathSync(parent); parentIdentity = identity(stat);
    checkDirectory(); file = join(directory, basename(path));
    let existing;
    try { existing = read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) { state = document(JSON.parse(existing.text)); expected = existing; }
    const salt = state ? decode(state.binding.salt, 32, 32) : randomBytes(32);
    const hash = scryptSync(password, salt, 32);
    if (!state || state.rpID !== rpID || !timingSafeEqual(hash, decode(state.binding.hash, 32, 32))) {
      const nextSalt = state ? randomBytes(32) : salt;
      persist({ schema: 1, rpID, binding: { salt: encode(nextSalt), hash: encode(state ? scryptSync(password, nextSalt, 32) : hash) }, userHandle: encode(randomBytes(32)), credentials: [] });
    }
    available = true;
  } catch { available = false; }
  password = undefined;
  return {
    status() {
      if (available) { try { ensure(); } catch { /* Password login remains available. */ } }
      return available ? { available: true } : { available: false, reason: unavailable };
    },
    snapshot() {
      ensure();
      return { version, userHandle: state.userHandle, credentials: state.credentials.map(value => ({ ...value, publicKey: Uint8Array.from(decode(value.publicKey, 4096)), ...(value.transports === undefined ? {} : { transports: [...value.transports] }) })) };
    },
    register(value, expectedVersion) {
      ensure(); checkVersion(expectedVersion);
      const entry = credential(value);
      if (state.credentials.length >= maximumCredentials) throw Error('通行密钥数量已达上限');
      if (state.credentials.some(item => item.id === entry.id)) throw Error('通行密钥已登记');
      persist({ ...state, credentials: [...state.credentials, entry] }); version++;
    },
    updateCounter(id, newCounter, expectedVersion) {
      ensure(); checkVersion(expectedVersion);
      const entry = state.credentials.find(item => item.id === id);
      if (!entry || !uint32(newCounter) || newCounter < entry.counter) throw Error('无效的通行密钥计数器');
      persist({ ...state, credentials: state.credentials.map(item => item.id === id ? { ...item, counter: newCounter } : item) }); version++;
    },
    remove(id) {
      ensure();
      if (!state.credentials.some(item => item.id === id)) return false;
      persist({ ...state, credentials: state.credentials.filter(item => item.id !== id) }); version++;
      return true;
    },
  };
}
