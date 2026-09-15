import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createWebServer } from './http.mjs';
import { connectBridge } from './bridge-api.mjs';
import { listenLocal } from './local-ipc.mjs';
import { serviceConfig } from './service-config.mjs';

const config = serviceConfig();
let web, control;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const server of [web, control]) { server?.close(); server?.closeAllConnections(); }
}
try {
  if (statSync(config.passwordPath).mode & 0o077) throw new Error('密码文件权限必须为 600');
  const password = readFileSync(config.passwordPath, 'utf8').trim();
  web = createWebServer(connectBridge(config.bridgeSocket), { password, origin: config.origin, allowLanHttp: config.allowLanHttp, additionalOrigins: config.additionalOrigins, allowHttpOrigins: config.allowHttpOrigins, trustedProxyAddresses: config.trustedProxyAddresses, auditPath: join(config.state, 'security-audit.jsonl') });
  await new Promise((resolve, reject) => { web.once('error', reject); web.listen(config.port, '0.0.0.0', resolve); });
  const instanceId = randomUUID();
  control = await listenLocal(config.webSocket, (method, path) => {
    if (method === 'GET' && path === '/status') return { service: 'codex-web', version: 1, pid: process.pid, instanceId, origin: config.origin, listenHost: '0.0.0.0', port: config.port, bridgeSocket: config.bridgeSocket };
    if (method === 'POST' && path === '/stop') { setImmediate(stop); return { ok: true }; }
    throw new Error('不支持的 Web 管理操作');
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(`Web 已启动：${config.origin}；退出 Web 不会停止桌面任务。`);
} catch (error) {
  stop();
  console.error(error.message);
  process.exitCode = 1;
}
