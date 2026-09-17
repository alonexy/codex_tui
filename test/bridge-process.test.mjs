import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { localRequest } from '../src/local-ipc.mjs';

async function fixture(t) {
  const state = await mkdtemp('/private/tmp/bridge-process-');
  const native = join(state, 'native.mjs');
  await writeFile(native, `#!${process.execPath}
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if (m.id === undefined) return;
  const response = m.method === 'configRequirements/read'
    ? {result:{requirements:{application:{browser:{access:'deny'}}}}}
    : m.method === 'config/read'
      ? {error:{code:-32000,message:'policy unavailable'}}
      : {result:{client:m.params?.clientInfo?.name}};
  console.log(JSON.stringify({id:m.id,...response}));
});
`, { mode: 0o700 });
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async p => {
      if (p.exitCode !== null || p.signalCode !== null) return;
      const exited = once(p, 'exit');
      p.kill('SIGTERM');
      const timer = setTimeout(() => p.kill('SIGKILL'), 2500);
      await exited;
      clearTimeout(timer);
    }));
    await rm(state, { recursive: true, force: true });
  });
  const socket = join(state, 'ipc', 'bridge.sock');
  function launch(name) {
    const p = spawn(process.execPath, ['src/bridge.mjs', 'app-server'], {
      env: { ...process.env, CODEX_REAL_CLI: native, CODEX_PHONE_STATE_DIR: state, CODEX_PHONE_SOCKET: socket },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(p);
    let stderr = '';
    p.stderr.on('data', chunk => { stderr += chunk; });
    const pending = new Map();
    const lines = createInterface({ input: p.stdout });
    lines.on('line', line => {
      const m = JSON.parse(line);
      pending.get(m.id)?.resolve(m);
    });
    p.on('exit', code => {
      for (const waiter of pending.values()) waiter.reject(new Error(`CLI exited ${code}: ${stderr}`));
    });
    const rpc = (id, method, params) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 5000);
      pending.set(id, {
        resolve: value => { clearTimeout(timer); pending.delete(id); resolve(value); },
        reject: error => { clearTimeout(timer); pending.delete(id); reject(error); },
      });
      p.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    return {
      rpc,
      initialize: () => rpc('init', 'initialize', { clientInfo: { name } }),
      initializeWithQueuedRead() {
        p.stdin.cork();
        const initialized = rpc('init', 'initialize', { clientInfo: { name } });
        p.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        const policy = rpc('queued-read', 'configRequirements/read');
        p.stdin.uncork();
        return Promise.all([initialized, policy]);
      },
      async close() {
        const exited = once(p, 'exit');
        p.stdin.end();
        return exited;
      },
    };
  }
  return { launch, socket };
}

test('browser policy helpers coexist with the desktop bridge and preserve policy errors', async t => {
  const { launch, socket } = await fixture(t);
  const desktop = launch('codex_desktop');
  assert.equal((await desktop.initialize()).result.client, 'codex_desktop');
  const before = await localRequest(socket, '/status');
  for (const name of ['codex-browser-use', 'codex-computer-use']) {
    const browser = launch(name);
    assert.equal((await browser.initialize()).result.client, name);
    assert.deepEqual(await browser.rpc('requirements', 'configRequirements/read'), {
      id: 'requirements', result: { requirements: { application: { browser: { access: 'deny' } } } },
    });
    assert.deepEqual(await browser.rpc('config', 'config/read', { includeLayers: false }), {
      id: 'config', error: { code: -32000, message: 'policy unavailable' },
    });
  }
  assert.equal((await localRequest(socket, '/status')).bridgeId, before.bridgeId);
  assert.equal((await desktop.rpc('still-alive', 'initialize', { clientInfo: { name: 'codex_desktop' } })).result.client, 'codex_desktop');
});

for (const name of ['codex_desktop', 'codex-browser-use', 'codex-computer-use']) {
  test(`${name} retains batched startup messages and exits after stdin closes`, { timeout: 10000 }, async t => {
    const { launch } = await fixture(t);
    const client = launch(name);
    const [init, policy] = await client.initializeWithQueuedRead();
    assert.equal(init.result.client, name);
    assert.equal(policy.result.requirements.application.browser.access, 'deny');
    assert.equal((await client.close())[0], 0);
  });
}

test('a second desktop still cannot take over the shared socket', async t => {
  const { launch, socket } = await fixture(t);
  await launch('codex_desktop').initialize();
  const before = await localRequest(socket, '/status');
  await assert.rejects(launch('codex_desktop').initialize(), /本机服务已运行/);
  assert.equal((await localRequest(socket, '/status')).bridgeId, before.bridgeId);
});
