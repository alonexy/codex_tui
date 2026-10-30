import { chmod, mkdir, open, readFile, lstat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { checkAttachment, maxAttachments, maxTotalBytes } from '../public/attachment-policy.js';
import { validateAttachment } from './attachment-formats.mjs';
import { attachmentRetention } from './attachment-retention.mjs';
import { decodeUpload } from './uploads.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function attachmentStore(directory, options = {}) {
  directory = resolve(directory);
  const retention = attachmentRetention(directory, options);
  const batches = new Map();
  function batchFor(owner, batch, create = true) {
    if (!uuid.test(batch ?? '')) throw Error('无效的附件批次');
    for (const [key, entries] of batches) {
      if (![...entries.values()].some(entry => entry.pending) && (entries.size === 0 || entries.expiresAt <= retention.now())) batches.delete(key);
    }
    const key = `${owner}:${batch}`;
    if (!batches.has(key)) {
      if (!create) return null;
      if (batches.size >= 5000) throw Error('附件批次已满，请清理服务后重试');
      batches.set(key, new Map());
    }
    const entries = batches.get(key);
    entries.expiresAt = retention.now() + retention.stagedTtlMs;
    return entries;
  }
  async function metadata(id) {
    if (!uuid.test(id ?? '')) return null;
    try {
      const value = await retention.readMetadata(id);
      if (!value) return null;
      const path = join(directory, `${id}.${value.extension}`);
      if (value.id !== id || !/^[a-z0-9]+$/.test(value.extension) || value.path !== path) return null;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size !== value.size) return null;
      return value;
    } catch { return null; }
  }
  function publicMetadata(value) {
    const { id, name, size, kind, path } = value;
    return { id, name, size, kind, url: `/api/attachments/${id}`, input: kind === 'image' ? { type: 'localImage', path } : { type: 'mention', name, path } };
  }
  async function fromPath(path) {
    if (typeof path !== 'string' || !path.startsWith(directory + '/')) return null;
    const id = path.slice(directory.length + 1).split('.')[0], value = await metadata(id);
    return value?.path === path ? value : null;
  }
  async function persist(data, name, kind, reservation) {
    let path, created = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const extension = name.split('.').pop().toLowerCase(), savedId = randomUUID(); path = join(directory, `${savedId}.${extension}`);
      const file = await open(path, 'wx', 0o600);
      created = true;
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      const value = { id: savedId, name, size: data.length, kind, path, extension };
      await reservation.finish(value);
      return value;
    } catch (error) {
      if (created) await unlink(path).catch(() => {});
      await reservation.release();
      throw error;
    }
  }
  async function inputValues(input) {
    if (!Array.isArray(input)) return [];
    const attachments = input.filter(item => ['localImage', 'image', 'mention'].includes(item?.type));
    if (attachments.length > maxAttachments) throw Error('每条消息最多 10 个附件');
    let total = 0;
    const values = [];
    for (const item of attachments) {
      const value = await fromPath(item.path);
      if (!value || (item.type === 'localImage') !== (value.kind === 'image') || (item.type === 'mention' && item.name !== value.name)) throw Error('附件引用未登记或类型不匹配，请重新选择附件');
      total += value.size; values.push(value);
    }
    if (total > maxTotalBytes) throw Error('每条消息附件合计最多 50 MiB');
    return values;
  }
  return {
    collect: retention.collect,
    async uploadLegacy(value) {
      const { data, extension } = decodeUpload(value);
      validateAttachment(`image.${extension}`, data);
      const saved = await persist(data, `image.${extension}`, 'image', await retention.reserve(data.length));
      return publicMetadata(saved).input;
    },
    async registerLegacy(input) {
      const name = input.path.slice(directory.length + 1), [id, extension] = name.split('.');
      if (!uuid.test(id) || !['png', 'jpeg', 'webp'].includes(extension) || input.path !== join(directory, `${id}.${extension}`)) throw Error('无效的图片引用');
      const data = await readFile(input.path); validateAttachment(name, data);
      // Old callers have already written the payload. Preserve it conservatively.
      const file = await open(join(directory, `${id}.meta.json`), 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ id, name, extension, size: data.length, kind: 'image', path: input.path, retention: 'retained' })); await file.sync(); }
      finally { await file.close(); }
      return input;
    },
    async upload(req, owner, batch, id, name, authenticated) {
      if (!uuid.test(id ?? '') || typeof name !== 'string' || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) throw Error('无效的文件名称或附件 ID');
      const size = Number(req.headers['content-length']), kind = checkAttachment(name, size);
      const entries = batchFor(owner, batch), old = entries.get(id);
      if (old) {
        if (old.pending) throw Error('此附件仍在上传，请稍后重试');
        const saved = await metadata(old.savedId);
        if (!saved || saved.name !== name || saved.size !== size) throw Error('附件 ID 已使用');
        req.resume(); return publicMetadata(saved);
      }
      if (entries.size >= maxAttachments || [...entries.values()].reduce((sum, entry) => sum + entry.size, 0) + size > maxTotalBytes) throw Error('每条消息最多 10 个附件、合计 50 MiB');
      // Reserve synchronously, before awaiting body or disk I/O, including concurrent uploads.
      entries.set(id, { size, pending: true });
      let reservation;
      try {
        reservation = await retention.reserve(size);
        const chunks = []; let received = 0;
        for await (const chunk of req) { received += chunk.length; if (received > size) throw Error('上传大小不匹配'); chunks.push(chunk); }
        if (received !== size || !authenticated()) throw Error('上传未完成或登录已过期');
        const data = Buffer.concat(chunks); validateAttachment(name, data);
        const value = await persist(data, name, kind, reservation);
        entries.set(id, { size, pending: false, savedId: value.id }); return publicMetadata(value);
      } catch (error) {
        entries.delete(id);
        if (!entries.size) batches.delete(`${owner}:${batch}`);
        await reservation?.release();
        throw error;
      }
    },
    retain(owner, batch, ids) {
      if (!Array.isArray(ids) || ids.length > maxAttachments || ids.some(id => !uuid.test(id))) throw Error('无效的附件列表');
      const entries = batchFor(owner, batch, false);
      if (!entries) return;
      for (const [id, entry] of entries) if (!entry.pending && !ids.includes(id)) entries.delete(id);
      if (!entries.size) batches.delete(`${owner}:${batch}`);
    },
    async download(id) {
      const value = await metadata(id); if (!value) return null;
      const file = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== value.size || stat.size > 20 * 1024 * 1024) return null;
        // A fixed buffer also bounds reads if a local writer grows the inode after fstat.
        const data = Buffer.alloc(stat.size); let offset = 0;
        while (offset < data.length) { const read = await file.read(data, offset, data.length - offset, offset); if (!read.bytesRead) return null; offset += read.bytesRead; }
        return { ...value, data };
      } finally { await file.close(); }
    },
    async validateInput(input) {
      await inputValues(input);
    },
    async prepareInput(input) {
      const values = await inputValues(input);
      if (values.length) return retention.pin(values);
    },
    async register(value) {
      const files = {};
      const retained = new Map();
      const visit = async node => {
        if (!node || typeof node !== 'object') return;
        if (['mention', 'localImage', 'image'].includes(node.type)) {
          const saved = await fromPath(node.path);
          if (saved) { files[node.path] = publicMetadata(saved); retained.set(saved.id, saved); }
        }
        for (const child of Object.values(node)) if (child && typeof child === 'object') await visit(child);
      };
      await visit(value);
      if (retained.size) await retention.pin([...retained.values()]);
      return files;
    },
  };
}
