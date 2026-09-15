import { randomUUID } from 'node:crypto';
import { listenLocal, localRequest } from './local-ipc.mjs';

export function serveBridge(broker, socketPath, mode) {
  const bridgeId = randomUUID();
  return listenLocal(socketPath, (method, path, data) => {
    if (method === 'GET' && path === '/status') return { service: 'codex-bridge', version: 1, pid: process.pid, bridgeId, mode, ready: broker.snapshot().ready };
    if (method === 'POST' && path === '/state') return { ...broker.snapshot(data.after), bridgeId, mode };
    if (method === 'POST' && path === '/command') return broker.getCommand(data.key);
    if (method === 'POST' && path === '/submit') return broker.submit(data.key, data.method, data.params);
    if (method === 'POST' && path === '/answer') { broker.answer(data.id, data.result); return { ok: true }; }
    throw new Error('不支持的本机桥接操作');
  });
}

export function connectBridge(socketPath) {
  return {
    async snapshot(after) {
      try { return await localRequest(socketPath, '/state', { after }); }
      catch { return { ready: false, mode: 'disconnected', cursor: after, events: [], active: {}, approvals: [], reset: false }; }
    },
    getCommand: key => localRequest(socketPath, '/command', { key }),
    submit: (key, method, params) => localRequest(socketPath, '/submit', { key, method, params }),
    answer: (id, result) => localRequest(socketPath, '/answer', { id, result }),
  };
}
