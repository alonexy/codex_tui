import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function serviceConfig() {
  const state = resolve(process.env.CODEX_PHONE_STATE_DIR ?? join(projectRoot, '.codex-phone'));
  let access = {};
  try { access = JSON.parse(readFileSync(join(state, 'access.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.CODEX_PHONE_PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  return {
    state, port,
    origin: process.env.CODEX_PHONE_ORIGIN ?? access.origin ?? `http://127.0.0.1:${port}`,
    additionalOrigins: access.additionalOrigins ?? [],
    allowHttpOrigins: access.allowHttpOrigins ?? [],
    trustedProxyAddresses: access.trustedProxyAddresses ?? [],
    allowLanHttp: process.env.CODEX_PHONE_ALLOW_LAN_HTTP === undefined ? access.allowLanHttp === true : process.env.CODEX_PHONE_ALLOW_LAN_HTTP === '1',
    passwordPath: resolve(process.env.CODEX_PHONE_PASSWORD_FILE ?? process.env.CODEX_PHONE_TOKEN_FILE ?? join(state, 'password')),
    bridgeSocket: process.env.CODEX_PHONE_SOCKET ?? join(state, 'ipc', 'bridge.sock'),
    webSocket: join(state, 'ipc', 'web.sock'),
  };
}
