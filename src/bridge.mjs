#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, mkdirSync, existsSync, appendFileSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Broker } from './broker.mjs';
import { serveBridge } from './bridge-api.mjs';
import { serviceConfig } from './service-config.mjs';

const args = process.argv.slice(2);
const standalone = args[0] === '--standalone';
const executable = process.env.CODEX_REAL_CLI ?? '/Applications/ChatGPT.app/Contents/Resources/codex';
const subcommands = ['daemon', 'proxy', 'generate-ts', 'generate-json-schema', 'help'];
const passthrough = !args.includes('app-server') || args.some(arg => ['--help', '-h', '--version'].includes(arg))
  || args.slice(args.indexOf('app-server') + 1).some(arg => subcommands.includes(arg));
// The desktop also invokes the CLI for non-server commands. Preserve those calls.
if (!standalone && passthrough) {
  const child = spawn(executable, args, { stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  let releaseOwnership = () => {};
  let spawned = false;
  try {
    const config = serviceConfig();
    const listenIndex = args.indexOf('--listen');
    const listen = args.find(a => a.startsWith('--listen='))?.slice('--listen='.length)
      ?? (listenIndex < 0 ? 'stdio://' : args[listenIndex + 1]);
    if (!standalone && listen !== 'stdio://') {
      throw new Error('桥接器只支持桌面 stdio App Server');
    }
    let child;
    let ownedThreads = null;
    let saveOwnedThread;
    if (standalone) {
      const stateDirectory = config.state;
      mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
      const lock = resolve(stateDirectory, 'run.lock');
      try { mkdirSync(lock, { mode: 0o700 }); }
      catch { throw new Error(`独立服务状态目录已锁定：${lock}；请先确认没有其他实例运行`); }
      releaseOwnership = () => { if (existsSync(lock)) rmdirSync(lock); };
      const registry = resolve(stateDirectory, 'threads.jsonl');
      ownedThreads = new Set(existsSync(registry) ? readFileSync(registry, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
      saveOwnedThread = id => appendFileSync(registry, `${JSON.stringify(id)}\n`, { mode: 0o600 });
    }
    const broker = new Broker(
      message => child.stdin.write(`${JSON.stringify(message)}\n`),
      message => { if (!standalone) process.stdout.write(`${JSON.stringify(message)}\n`); },
      { ownedThreads, saveOwnedThread },
    );
    const server = await serveBridge(broker, config.bridgeSocket, standalone ? 'standalone' : 'desktop-shared');
    const childEnv = { ...process.env };
    // Child tools must not recursively enter this wrapper or inherit the phone credential path.
    delete childEnv.CODEX_CLI_PATH;
    delete childEnv.CODEX_PHONE_TOKEN_FILE;
    delete childEnv.CODEX_PHONE_PASSWORD_FILE;
    child = spawn(executable, standalone ? ['app-server', '--listen', 'stdio://'] : args, {
      stdio: ['pipe', 'pipe', 'inherit'], env: childEnv,
    });
    spawned = true;
    let stopping = false;
    const stop = (code = 0) => {
      if (stopping) return;
      stopping = true;
      broker.close();
      server.close();
      server.closeAllConnections();
      child.kill('SIGTERM');
      process.exitCode = code;
      setTimeout(() => { child.kill('SIGKILL'); process.exit(code); }, 2000).unref();
    };
    child.on('error', error => { console.error(error.message); releaseOwnership(); stop(1); });
    child.stdin.on('error', error => { console.error(error.message); stop(1); });
    child.on('exit', code => { releaseOwnership(); stop(code ?? 1); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try { broker.receive(JSON.parse(line)); }
      catch (error) { console.error(`App Server 协议错误：${error.message}`); stop(1); }
    });
    if (standalone) {
      try { await broker.initialize(); }
      catch (error) { stop(1); throw error; }
    }
    else {
      const desktop = createInterface({ input: process.stdin });
      desktop.on('line', line => {
        try { broker.fromDesktop(JSON.parse(line)); }
        catch (error) { console.error(`桌面协议错误：${error.message}`); stop(1); }
      });
      desktop.on('close', () => stop());
    }
    process.on('SIGINT', () => stop());
    process.on('SIGTERM', () => stop());
    console.error(`Codex 常驻桥接已启动，Web 服务可独立重启。模式：${standalone ? '独立' : '桌面共享'}`);
  } catch (error) {
    if (!spawned) releaseOwnership();
    console.error(error.message);
    process.exitCode = 1;
  }
}
