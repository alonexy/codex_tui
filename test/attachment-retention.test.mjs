import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { attachmentStore } from '../src/attachments.mjs';
import { attachmentRetention } from '../src/attachment-retention.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'attachment-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = 100;
  const settings = { stagedTtlMs: 1000, now: () => time, ...options };
  const store = attachmentStore(directory, settings);
  const upload = (name = 'a.txt', bytes = 'hello', batch = randomUUID(), id = randomUUID()) => {
    const request = new PassThrough(); request.headers = { 'content-length': String(Buffer.byteLength(bytes)) }; request.end(bytes);
    return store.upload(request, 'owner', batch, id, name, () => true);
  };
  return { directory, store, settings, upload, advance: ms => { time += ms; } };
}

test('expired drafts are collected after restart while submitted, historical and legacy records survive', async t => {
  const { directory, store, settings, upload, advance } = await fixture(t);
  const draft = await upload(), submitted = await upload('submitted.txt'), historic = await upload('image.png', Buffer.from(png, 'base64'));
  const legacy = await upload('old.txt');
  const oldMetadata = JSON.parse(await readFile(join(directory, `${legacy.id}.meta.json`)));
  delete oldMetadata.retention; delete oldMetadata.expiresAt;
  await writeFile(join(directory, `${legacy.id}.meta.json`), JSON.stringify(oldMetadata));
  await store.prepareInput([submitted.input]);
  assert.equal(JSON.parse(await readFile(join(directory, `${submitted.id}.meta.json`))).retention, 'retained');
  assert.equal((await store.register({ turns: [{ content: [historic.input] }] }))[historic.input.path].id, historic.id);
  advance(1001);
  const restarted = attachmentStore(directory, settings); await restarted.collect();
  assert.equal(await restarted.download(draft.id), null);
  for (const file of [submitted, historic, legacy]) assert.ok(await restarted.download(file.id));
});

test('submission pin and concurrent collection cannot delete a successfully prepared attachment', async t => {
  const { store, upload, advance } = await fixture(t);
  const file = await upload(); advance(1001);
  const results = await Promise.allSettled([store.prepareInput([file.input]), store.collect()]);
  assert.equal(results[1].status, 'fulfilled');
  if (results[0].status === 'fulfilled') assert.ok(await store.download(file.id));
  else assert.match(results[0].reason.message, /过期|未登记/);
  const retained = await upload(); await store.prepareInput([retained.input]); advance(1001);
  await Promise.all([store.collect(), store.prepareInput([retained.input])]);
  assert.ok(await store.download(retained.id));
});

test('invalid inputs are rejected before any valid draft is pinned', async t => {
  const { store, upload, advance } = await fixture(t);
  const draft = await upload();
  await assert.rejects(store.prepareInput([draft.input, { type: 'mention', name: 'bad.txt', path: '/unregistered/bad.txt' }]), /未登记/);
  advance(1001); await store.collect();
  assert.equal(await store.download(draft.id), null);
});

test('a file disappearing before the locked pin does not partially retain earlier drafts', async t => {
  const { directory, settings, upload, advance } = await fixture(t);
  const first = await upload('first.txt'), missing = await upload('missing.txt');
  const records = await Promise.all([first, missing].map(file => readFile(join(directory, `${file.id}.meta.json`), 'utf8').then(JSON.parse)));
  await rm(missing.input.path);
  const retention = attachmentRetention(directory, settings);
  await assert.rejects(retention.pin(records), /已过期/);
  assert.equal(JSON.parse(await readFile(join(directory, `${first.id}.meta.json`))).retention, 'staged');
  advance(1001); await retention.collect();
  await assert.rejects(readFile(first.input.path), { code: 'ENOENT' });
});

test('text-only preparation does not create or scan an upload directory', async t => {
  const { directory } = await fixture(t);
  const absent = join(directory, 'not-created'), store = attachmentStore(absent);
  await store.prepareInput([{ type: 'text', text: 'hello' }]);
  await store.prepareInput();
  await assert.rejects(stat(absent), { code: 'ENOENT' });
});

test('explicit rejection restores newly pinned drafts with their original expiry across restart', async t => {
  const { directory, settings, store, upload, advance } = await fixture(t);
  const file = await upload();
  const original = JSON.parse(await readFile(join(directory, `${file.id}.meta.json`)));
  const prepared = await store.prepareInput([file.input, file.input]);
  advance(500); await prepared.reject(); await prepared.reject();
  assert.deepEqual(JSON.parse(await readFile(join(directory, `${file.id}.meta.json`))), original);
  advance(501); const restarted = attachmentStore(directory, settings); await restarted.collect();
  assert.equal(await restarted.download(file.id), null);
});

test('later submissions and historical registration invalidate an earlier rejection rollback', async t => {
  const { store, upload, advance } = await fixture(t);
  const submitted = await upload('submitted.txt'), historical = await upload('historical.txt'), old = await upload('old.txt');
  const first = await store.prepareInput([submitted.input]);
  await store.prepareInput([submitted.input]);
  const second = await store.prepareInput([historical.input]);
  await store.register({ content: [historical.input] });
  await store.prepareInput([old.input]);
  const laterRejection = await store.prepareInput([old.input]);
  await Promise.all([first.reject(), second.reject(), laterRejection.reject()]);
  advance(1001); await store.collect();
  for (const file of [submitted, historical, old]) assert.ok(await store.download(file.id));
});

test('global disk reservations include pending uploads from different batches and release failures', async t => {
  const { directory, store, upload } = await fixture(t, { maxDiskBytes: 5 });
  const request = new PassThrough(); request.headers = { 'content-length': '4' };
  const first = store.upload(request, 'owner', randomUUID(), randomUUID(), 'a.txt', () => true);
  await assert.rejects(upload('b.txt', 'xx'), /存储容量已满/);
  const rejected = assert.rejects(first, /上传未完成/); request.end('bad'); await rejected;
  const file = await upload('c.txt', 'hello');
  assert.equal((await readFile(file.input.path)).length, 5);
  await store.prepareInput([file.input]);
  const restarted = attachmentStore(directory, { maxDiskBytes: 5 });
  await assert.rejects(restarted.uploadLegacy(`data:image/png;base64,${png}`), /存储容量已满/);
});

test('expired payloads free byte and file budgets but retained files are never evicted to make space', async t => {
  const { store, upload, advance } = await fixture(t, { maxDiskBytes: 5, maxFiles: 1 });
  await upload(); await assert.rejects(upload(), /存储容量已满/);
  advance(1001); const file = await upload();
  await store.prepareInput([file.input]); advance(1001);
  await assert.rejects(upload(), /存储容量已满/);
  assert.ok(await store.download(file.id));
});

test('empty retains do not consume batch capacity and expired batches release message quotas', async t => {
  const { store, upload, advance } = await fixture(t);
  for (let i = 0; i < 5001; i++) store.retain('owner', randomUUID(), []);
  const batch = randomUUID(), ids = Array.from({ length: 10 }, () => randomUUID());
  for (const id of ids) await upload('a.txt', 'a', batch, id);
  await assert.rejects(upload('a.txt', 'a', batch), /50 MiB/);
  advance(1001);
  assert.equal((await upload('a.txt', 'a', batch)).size, 1);
});

test('legacy uploads reserve budget and temporary files expire; symlink sidecars never enable deletion', async t => {
  const { directory, store, upload, advance } = await fixture(t, { maxDiskBytes: 100 });
  const image = await store.uploadLegacy(`data:image/png;base64,${png}`);
  advance(1001); await store.collect();
  await assert.rejects(readFile(image.path), { code: 'ENOENT' });
  const file = await upload();
  const outside = join(directory, 'untrusted-sidecar');
  const sidecar = join(directory, `${file.id}.meta.json`);
  await writeFile(outside, await readFile(sidecar)); await rm(sidecar); await symlink(outside, sidecar);
  advance(1001); await store.collect();
  assert.equal(await readFile(file.input.path, 'utf8'), 'hello');
  assert.equal(await store.download(file.id), null);
});
