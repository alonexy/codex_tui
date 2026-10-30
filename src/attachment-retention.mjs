import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Shared by uploads, submission pinning and collection: a collector cannot race a pin.
export function attachmentRetention(directory, options = {}) {
  const { maxDiskBytes = 1024 ** 3, maxFiles = 5000, stagedTtlMs = 24 * 60 * 60 * 1000, now = Date.now } = options;
  for (const value of [maxDiskBytes, maxFiles, stagedTtlMs]) if (!Number.isSafeInteger(value) || value <= 0) throw Error('无效的附件保留配置');
  let queue = Promise.resolve(), initialized = false, usedBytes = 0, usedFiles = 0, lastCollection = -Infinity;
  const payloads = new Map();
  const pins = new Map();
  function locked(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function readMetadata(id) {
    let file;
    try {
      file = await open(join(directory, `${id}.meta.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096) return null;
      return JSON.parse(await file.readFile('utf8'));
    } catch { return null; }
    finally { await file?.close(); }
  }
  async function replaceMetadata(value) {
    const temporary = join(directory, `${value.id}.${randomUUID()}.meta.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(directory, `${value.id}.meta.json`));
      const folder = await open(directory, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  async function initialize() {
    if (initialized) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const existing = new Map();
    for (const name of await readdir(directory)) {
      if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(name)) continue;
      const stat = await lstat(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (stat?.isFile()) existing.set(name, stat.size);
    }
    for (const [name, size] of existing) { payloads.set(name, size); usedBytes += size; usedFiles++; }
    initialized = true;
  }
  async function collectLocked(force = false) {
    await initialize();
    if (!force && now() - lastCollection < Math.min(60000, stagedTtlMs)) return;
    lastCollection = now();
    for (const [name, size] of payloads) {
      const id = name.split('.')[0], value = await readMetadata(id);
      // Missing/old metadata is deliberately retained: it may belong to task history.
      if (value?.retention !== 'staged' || !Number.isFinite(value.expiresAt) || value.expiresAt > now() || value.id !== id || value.path !== join(directory, name)) continue;
      await unlink(join(directory, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await unlink(join(directory, `${id}.meta.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      payloads.delete(name); usedBytes -= size; usedFiles--;
      pins.delete(id);
    }
  }
  return {
    now, stagedTtlMs,
    readMetadata,
    async collect() { return locked(() => collectLocked(true)); },
    async reserve(size) {
      return locked(async () => {
        await collectLocked();
        if (usedBytes + size > maxDiskBytes || usedFiles + 1 > maxFiles) {
          await collectLocked(true);
          if (usedBytes + size > maxDiskBytes || usedFiles + 1 > maxFiles) throw Error('附件存储容量已满，请清理过期暂存附件或增加存储容量；已提交附件会保留');
        }
        usedBytes += size; usedFiles++;
        let settled = false;
        return {
          async finish(value) {
            return locked(async () => {
              if (settled) throw Error('附件预留已完成');
              await replaceMetadata({ ...value, retention: 'staged', expiresAt: now() + stagedTtlMs });
              payloads.set(value.path.slice(directory.length + 1), size); settled = true;
            });
          },
          async release() { return locked(() => { if (!settled) { usedBytes -= size; usedFiles--; settled = true; } }); },
        };
      });
    },
    async pin(values) {
      if (!values.length) return;
      return locked(async () => {
        const token = Symbol('attachment submission'), staged = new Map();
        const existing = new Map();
        // Validate every file before changing any retention marker.
        for (const value of values) {
          const current = await readMetadata(value.id);
          const stat = await lstat(value.path).catch(() => null);
          if (!current || current.path !== value.path || !stat?.isFile() || stat.size !== value.size) throw Error('附件已过期，请重新选择附件');
          existing.set(value.id, current);
        }
        // Pin before collection, including a draft whose TTL just elapsed.
        for (const [id, current] of existing) {
          // Even an already retained file invalidates an older submission's rollback.
          pins.set(id, token);
          if (current.retention === 'retained') continue;
          if (current.retention === 'staged') staged.set(id, current);
          await replaceMetadata({ ...current, retention: 'retained', expiresAt: undefined });
        }
        await collectLocked();
        let rejected = false;
        return {
          async reject() {
            return locked(async () => {
              if (rejected) return;
              for (const [id, original] of staged) {
                if (pins.get(id) !== token) continue;
                const current = await readMetadata(id);
                if (current?.retention !== 'retained' || current.path !== original.path) continue;
                await replaceMetadata(original);
                pins.delete(id);
              }
              rejected = true;
            });
          },
        };
      });
    },
  };
}
