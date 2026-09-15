import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';

const actions = new Set(['login', 'logout', 'session.revoke', 'session.revoke_all', 'rpc.submit', 'approval.answer']);
const results = new Set(['success', 'failed', 'limited', 'accepted', 'revoked', 'missing', 'denied']);
const publicId = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value) ? value : null;
const device = value => typeof value === 'string' && /^(Edge|Firefox|Chrome|Safari|其他浏览器) · (iOS|Android|Windows|macOS|Linux|未知系统)$/.test(value) ? value : '其他浏览器 · 未知系统';

// An allowlist is applied even when restoring our own log: no arbitrary request
// fields, error text, credentials, task identifiers or RPC parameters can enter it.
function eventRecord(value, time) {
  if (!value || !actions.has(value.action) || !results.has(value.result)) return null;
  return {
    time, source: typeof value.source === 'string' && isIP(value.source) ? value.source : 'unknown',
    device: device(value.device), sessionId: publicId(value.sessionId), targetId: publicId(value.targetId),
    action: value.action, result: value.result,
  };
}

export function createAudit({ path, now = Date.now, maxEvents = 300, maxBytes = 256 * 1024 } = {}) {
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 1000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1024 * 1024) throw new Error('无效的安全记录上限');
  const events = [], recent = new Map();
  let persistent = Boolean(path), suppressed = 0, windowStart = now(), ordinary = 0, critical = 0;
  const retain = event => { events.push(event); if (events.length > maxEvents) events.shift(); };
  function open(filename, create = true) {
    const fd = openSync(filename, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) throw new Error('安全记录必须为独立普通文件');
      fchmodSync(fd, 0o600);
      if (info.size > maxBytes) ftruncateSync(fd, 0);
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const filename of [path + '.1', path]) {
        let fd;
        try { fd = open(filename, filename === path); }
        catch (error) { if (filename !== path && error.code === 'ENOENT') continue; throw error; }
        try {
          const content = readFileSync(fd), complete = content.lastIndexOf(10) + 1;
          if (complete < content.length) ftruncateSync(fd, complete);
          for (const line of content.subarray(0, complete).toString('utf8').split('\n')) {
            try {
              const value = JSON.parse(line);
              if (!Number.isFinite(value.time)) continue;
              const event = eventRecord(value, value.time);
              if (event) retain(event);
            } catch { /* Ignore a partial line left by an interrupted write. */ }
          }
        } finally { closeSync(fd); }
      }
    } catch { persistent = false; }
  }
  function append(event) {
    if (!persistent) return;
    let fd;
    try {
      const line = Buffer.from(JSON.stringify(event) + '\n');
      fd = open(path);
      if (fstatSync(fd).size + line.length > maxBytes) {
        closeSync(fd); fd = undefined;
        renameSync(path, path + '.1');
        fd = open(path);
      }
      // Synchronous appends serialize this Web process's concurrent requests;
      // rate limits bound disk work. There is one Web writer per state directory.
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset, line.length - offset);
    } catch { persistent = false; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return {
    record(value) {
      const time = now(), event = eventRecord(value, time);
      if (!event) return false;
      if (time - windowStart >= 60000 || time < windowStart) {
        windowStart = time; ordinary = 0; critical = 0; recent.clear();
      }
      const isNoise = event.result === 'denied' || (event.action === 'login' && event.result !== 'success');
      const key = `${event.source}|${event.action}|${event.result}`;
      if ((isNoise && time - (recent.get(key) ?? -Infinity) < 10000) || (isNoise ? ordinary >= 180 : critical >= 60)) {
        suppressed = Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1); return false;
      }
      if (isNoise) { ordinary++; recent.set(key, time); } else critical++;
      retain(event); append(event); return true;
    },
    list() {
      return {
        events: events.toReversed().map(event => ({ ...event })), suppressed,
        persistence: path ? (persistent ? 'enabled' : 'unavailable') : 'memory-only',
        maxEvents, maxFileBytes: maxBytes, retainedFiles: path ? 2 : 0,
      };
    },
  };
}
