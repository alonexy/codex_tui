import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import { manageWeb } from './web-service.mjs';
import { localRequest } from '../src/local-ipc.mjs';

// Read-only live test: initialize and list only. Never start or resume a task.
const temporary = await mkdtemp(join(tmpdir(), 'codex-phone-smoke-'));
const token = randomBytes(32).toString('hex');
const tokenPath = join(temporary, 'token');
await writeFile(tokenPath, token, { mode: 0o600 });
const probe = net.createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const config = { state: temporary, port, origin: `http://127.0.0.1:${port}`, passwordPath: tokenPath, bridgeSocket: join(temporary, 'ipc/bridge.sock'), webSocket: join(temporary, 'ipc/web.sock') };
const child = spawn(process.execPath, ['src/bridge.mjs', 'app-server'], {
  env: { ...process.env, CODEX_PHONE_STATE_DIR: temporary, CODEX_PHONE_SOCKET: config.bridgeSocket },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const message = JSON.parse(line);
  const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); callback(message); }
});
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const call = message => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`RPC timeout: ${message.method}`)), 15000);
  pending.set(message.id, result => { clearTimeout(timer); result.error ? reject(new Error(result.error.message)) : resolve(result.result); });
  send(message);
});
const headers = { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' };
try {
  await call({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_phone_smoke', version: '0.1.0' } } });
  // Match the desktop client: a successful initialize response without an initialized notification.
  await manageWeb('start', config);
  const before = await localRequest(config.bridgeSocket, '/status');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password: token }) });
  assert.equal(login.status, 200);
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const desktopRead = call({ id: 1, method: 'thread/list', params: { limit: 1 } });
  desktopRead.catch(() => {});
  const post = await fetch(`${base}/api/commands`, { method: 'POST', headers, body: JSON.stringify({ key: 'smoke-web-001', method: 'thread/list', params: { limit: 1 } }) });
  assert.equal(post.status, 202);
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(`${base}/api/commands/smoke-web-001`, { headers })).json();
    if (result.status !== 'pending') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(result.status, 'completed');
  assert.ok(Array.isArray((await desktopRead).data));
  assert.ok(Array.isArray(result.result.data));
  await manageWeb('restart', config);
  const after = await localRequest(config.bridgeSocket, '/status');
  assert.equal(before.bridgeId, after.bridgeId);
  assert.equal(before.pid, after.pid);
  const retained = await localRequest(config.bridgeSocket, '/command', { key: 'smoke-web-001' });
  assert.equal(retained.status, 'completed');
  assert.ok(Array.isArray((await call({ id: 2, method: 'thread/list', params: { limit: 1 } })).data));
  console.log('PASS: real App Server initialized once; Web restarted independently; bridge PID and receipts unchanged; desktop can still list tasks. No task was started or resumed.');
} catch (error) {
  console.error(error.message);
  // No message bodies, credentials or history are printed by this test.
  console.error(stderr);
  process.exitCode = 1;
} finally {
  await manageWeb('stop', config).catch(() => {});
  child.stdin.end();
  await new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000).unref();
  });
  await rm(temporary, { recursive: true, force: true });
}
