import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWebServer } from '../src/http.mjs';
import { attachmentStore } from '../src/attachments.mjs';
import { Broker } from '../src/broker.mjs';
import { connectBridge, serveBridge } from '../src/bridge-api.mjs';

async function fixture(t, broker, attachmentOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'phone-optimization-http-'));
  const origin = 'http://127.0.0.1:8787';
  const password = 'isolated-optimization-test';
  const server = createWebServer(broker, { password, origin, uploadDirectory: directory, attachmentOptions });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (path, data) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(data) });
  const upload = async name => {
    const response = await fetch(`${base}/api/attachments?batch=${randomUUID()}&id=${randomUUID()}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Attachment-Name': encodeURIComponent(name) }, body: 'isolated attachment',
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  return { directory, close, post, upload };
}

test('HTTP pins attachments before forwarding and restart collection preserves unknown submissions', async t => {
  let time = 1000, forwarded = 0;
  const options = { stagedTtlMs: 100, now: () => time };
  const broker = { async submit(key, method, params) {
    forwarded++;
    const path = params.input[0].path;
    const id = basename(path).split('.')[0];
    const metadata = JSON.parse(await readFile(join(dirname(path), `${id}.meta.json`), 'utf8'));
    assert.equal(metadata.retention, 'retained', 'retention must be durable before the upstream may accept');
    return { key, method, status: 'unknown' };
  } };
  const { directory, close, post, upload } = await fixture(t, broker, options);
  const submitted = await upload('submitted.txt');
  const abandoned = await upload('abandoned.txt');
  const response = await post('/api/commands', { key: 'unknown-attachment-001', method: 'turn/start', params: { threadId: 'task', input: [submitted.input] } });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'unknown');
  assert.equal(forwarded, 1);
  await close();
  time += 101;
  await attachmentStore(directory, options).collect();
  assert.equal(await readFile(submitted.input.path, 'utf8'), 'isolated attachment');
  await assert.rejects(readFile(abandoned.input.path), { code: 'ENOENT' });
});

test('legacy HTTP image upload respects the same disk budget before writing bytes', async t => {
  const { directory, post } = await fixture(t, {}, { maxDiskBytes: 1 });
  const response = await post('/api/uploads', { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /容量/);
  assert.deepEqual(await readdir(directory), []);
});

test('known capacity rejection survives local IPC and HTTP without an unknown receipt', async t => {
  const sent = [];
  const broker = new Broker(message => sent.push(message), () => {}, { maxWriteReceipts: 1 });
  broker.ready = true;
  const params = { threadId: 'task', name: 'existing' };
  broker.submit('existing-write', 'thread/name/set', params);
  broker.receive({ id: sent[0].id, result: {} });
  const directory = await mkdtemp(join(tmpdir(), 'phone-optimization-ipc-'));
  const socket = join(directory, 'bridge.sock');
  const local = await serveBridge(broker, socket, 'desktop-shared');
  t.after(async () => {
    broker.close(); local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const { post } = await fixture(t, connectBridge(socket), {});
  const response = await post('/api/commands', { key: 'refused-write', method: 'turn/start', params: { threadId: 'task', input: [] } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).submission, 'rejected');
  assert.equal(broker.getCommand('refused-write'), null);
  assert.equal(sent.length, 1);
  const replay = await post('/api/commands', { key: 'existing-write', method: 'thread/name/set', params });
  assert.equal(replay.status, 202);
  assert.equal((await replay.json()).status, 'completed');
  assert.equal(sent.length, 1);
});

test('HTTP restores staged retention only when upstream admission explicitly rejects the submission', async t => {
  let time = 1000;
  const options = { stagedTtlMs: 100, now: () => time };
  const broker = { submit() { throw Object.assign(new Error('known admission rejection'), { submission: 'rejected' }); } };
  const { directory, close, post, upload } = await fixture(t, broker, options);
  const file = await upload('rejected.txt');
  const response = await post('/api/commands', { key: 'rejected-attachment', method: 'turn/start', params: { threadId: 'task', input: [file.input] } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).submission, 'rejected');
  await close();
  time += 101;
  await attachmentStore(directory, options).collect();
  await assert.rejects(readFile(file.input.path), { code: 'ENOENT' });
});
