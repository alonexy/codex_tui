import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { localRequest } from '../src/local-ipc.mjs';
import { serviceConfig, projectRoot } from '../src/service-config.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 100));
export async function webStatus(config) {
  try {
    const status = await localRequest(config.webSocket, '/status');
    if (status.service !== 'codex-web' || status.version !== 1) throw new Error('Web 管理接口不兼容');
    return status;
  } catch (error) {
    // A graceful stop can close the control listener between connect and read.
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) return null;
    throw error;
  }
}

export async function manageWeb(action = 'start', config = serviceConfig()) {
  if (!['start', 'restart', 'stop', 'status'].includes(action)) throw new Error('操作应为 start/restart/stop/status');
  let status = await webStatus(config);
  if (action === 'status') return status;
  if (status && ['restart', 'stop'].includes(action)) {
    await localRequest(config.webSocket, '/stop', {});
    for (let i = 0; i < 100; i++) {
      status = await webStatus(config);
      if (!status) break;
      await pause();
    }
    if (status) throw new Error('Web 未能停止；没有对桌面进程执行任何操作');
  }
  if (action === 'stop') return null;
  if (status) {
    if (status.port !== config.port || status.origin !== config.origin || status.bridgeSocket !== config.bridgeSocket) throw new Error('Web 配置已变化，请运行 npm run web:restart');
    return status;
  }
  mkdirSync(config.state, { recursive: true, mode: 0o700 });
  if (!existsSync(config.passwordPath)) {
    mkdirSync(dirname(config.passwordPath), { recursive: true, mode: 0o700 });
    writeFileSync(config.passwordPath, randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
  }
  const logPath = join(config.state, 'web.log');
  const log = openSync(logPath, 'a', 0o600);
  chmodSync(logPath, 0o600);
  const child = spawn(process.execPath, [join(projectRoot, 'src/web.mjs')], {
    cwd: projectRoot, detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, CODEX_PHONE_STATE_DIR: config.state, CODEX_PHONE_PASSWORD_FILE: config.passwordPath, CODEX_PHONE_PORT: String(config.port), CODEX_PHONE_ORIGIN: config.origin, CODEX_PHONE_ALLOW_LAN_HTTP: config.allowLanHttp ? '1' : '0', CODEX_PHONE_SOCKET: config.bridgeSocket },
  });
  closeSync(log);
  let failure;
  child.on('error', error => { failure = error; });
  child.on('exit', () => { failure = new Error(`Web 启动失败；请检查 ${logPath}。若端口由旧版桥接占用，需先完成一次迁移。`); });
  child.unref();
  for (let i = 0; i < 100; i++) {
    if (failure) throw failure;
    status = await webStatus(config);
    if (status) return status;
    await pause();
  }
  throw new Error(`Web 启动超时；请检查 ${logPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = serviceConfig();
  manageWeb(process.argv[2], config).then(status => console.log(status ? `Web 已运行：${status.origin}\n密码文件：${config.passwordPath}` : 'Web 已停止；桌面任务不受影响。')).catch(error => { console.error(error.message); process.exitCode = 1; });
}
