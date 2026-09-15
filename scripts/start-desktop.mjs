import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { serviceConfig } from '../src/service-config.mjs';
import { localRequest } from '../src/local-ipc.mjs';
import { manageWeb, webStatus } from './web-service.mjs';

const exec = promisify(execFile);
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const root = fileURLToPath(new URL('../', import.meta.url));

export async function waitForExit({ pids, pause: delay = pause, attempts = 180 }) {
  for (let i = 0; i < attempts; i++) {
    if ((await pids()).length === 0) return;
    await delay();
  }
  throw new Error('桌面 App 仍未退出。请保存任务并用 Cmd+Q 完全退出，再运行此命令。');
}

export async function waitForReady({ probe, exited, pause: delay = pause, attempts = 60 }) {
  for (let i = 0; i < attempts; i++) {
    if (await probe()) return;
    if (exited() !== null) throw new Error('桌面进程提前退出，可能复用了现有实例；Web 服务没有启动成功。');
    await delay();
  }
  throw new Error('等待 Web 服务就绪超时。桌面可能未加载桥接器，请检查本机日志。');
}

async function appPids() {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm=']);
  return stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match?.[2] === app ? [Number(match[1])] : [];
  });
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('桌面启动器目前仅支持 macOS。');
  const checkOnly = process.argv.includes('--check');
  const config = serviceConfig();
  const { state, passwordPath, origin } = config;
  if (!existsSync(passwordPath)) {
    if (checkOnly) throw new Error('尚未配置密码文件；运行 npm run desktop 会生成密码。');
    mkdirSync(dirname(passwordPath), { recursive: true, mode: 0o700 });
    writeFileSync(passwordPath, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  if (statSync(passwordPath).mode & 0o077) throw new Error('密码文件权限必须为 600。');
  const password = readFileSync(passwordPath, 'utf8').trim();
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('密码需要至少12个字符，不超过1024字节。');
  let bridgePresent = false;
  const probe = async () => {
    let status;
    try {
      status = await localRequest(config.bridgeSocket, '/status');
    } catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return false;
      throw error;
    }
    if (status.service !== 'codex-bridge' || status.version !== 1) throw new Error('常驻桥接版本不兼容');
    if (status.mode !== 'desktop-shared') throw new Error('常驻桥接运行于独立模式，请先停止该独立实例');
    bridgePresent = true;
    return status.ready === true;
  };
  if (await probe()) {
    if (checkOnly && !await webStatus(config)) throw new Error('桌面桥接已就绪，Web 未启动；运行 npm run web 即可，无需退出桌面。');
    if (!checkOnly) await manageWeb('start', config);
    console.log(`桌面共享服务已就绪：${origin}\n密码文件：${passwordPath}`);
    return;
  }
  if (bridgePresent) {
    if (checkOnly) throw new Error('常驻桥接已运行，正在等待初始化；无需退出桌面。');
    await manageWeb('start', config);
    console.log('常驻桥接已运行，等待初始化；不会重启桌面。');
    await waitForReady({ probe, exited: () => null });
    console.log(`启动成功：${origin}\n密码文件：${passwordPath}`);
    return;
  }
  const running = await appPids();
  if (checkOnly) throw new Error(`新版常驻桥接未就绪；桌面主进程：${running.join(', ') || '未运行'}。${running.length ? '首次迁移需要一次退出加载新版；日常 Web 重启无需退出。' : ''}`);
  if (running.length) {
    console.log('现有桌面尚未加载新版常驻桥接。首次迁移请保存任务并 Cmd+Q 退出一次。\n此命令会等待，退出后自动继续；以后 Web 更新使用 npm run web:restart，不再退出桌面。');
    await waitForExit({ pids: appPids });
  }
  mkdirSync(state, { recursive: true, mode: 0o700 });
  await manageWeb('start', config);
  const bridge = join(root, 'src/bridge.mjs');
  chmodSync(bridge, 0o755);
  const logPath = join(state, 'desktop.log');
  const log = openSync(logPath, 'a', 0o600);
  chmodSync(logPath, 0o600);
  const child = spawn(app, [], {
    cwd: root, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, CODEX_CLI_PATH: bridge, CODEX_PHONE_STATE_DIR: state, CODEX_PHONE_SOCKET: config.bridgeSocket, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` },
  });
  closeSync(log);
  let exit = null;
  child.on('exit', code => { exit = code ?? -1; });
  child.on('error', () => { exit = -1; });
  child.unref();
  console.log(`正在启动并检查服务…\n本机日志：${logPath}`);
  await waitForReady({ probe, exited: () => exit });
  console.log(`启动成功：${origin}\n密码文件：${passwordPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
