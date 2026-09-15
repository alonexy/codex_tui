// Persist receipt identifiers and optional session names, never messages, attachments or credentials.
export class DeliveryState {
  constructor(storage) {
    this.storage = storage;
    this.pending = null;
    this.createdNaming = null;
    try {
      const created = JSON.parse(storage.getItem('codex-created-name') || 'null');
      if (created && typeof created.threadId === 'string' && typeof created.name === 'string') this.createdNaming = created;
    } catch { /* A missing naming draft does not authorize replaying an execution. */ }
    try {
      const raw = storage.getItem('codex-pending');
      if (raw) {
        try { this.pending = JSON.parse(raw); } catch { this.pending = { key: raw }; }
        if (!this.pending || typeof this.pending.key !== 'string') this.pending = { key: raw };
      }
    } catch { /* Browsers may deny storage. begin() fails before sending in that case. */ }
  }
  begin(key, method, threadId, name) {
    if (this.pending) throw Error('上次提交结果待确认，请先查询发送结果');
    const pending = { key, method, threadId, createdAt: Date.now() };
    if (['thread/start', 'thread/name/set'].includes(method) && typeof name === 'string' && name.trim()) pending.name = name.trim();
    try {
      if (method === 'thread/name/set' && this.createdNaming?.threadId === threadId && pending.name) {
        const created = { ...this.createdNaming, name: pending.name };
        this.storage.setItem('codex-created-name', JSON.stringify(created));
        this.createdNaming = created;
      }
      this.storage.setItem('codex-pending', JSON.stringify(pending));
    }
    catch { throw Error('浏览器无法保存提交回执，请允许此网站使用会话存储后再发送'); }
    this.pending = pending;
  }
  settle(key, status, result) {
    if (this.pending?.key !== key || !['completed', 'failed'].includes(status)) return false;
    if (status === 'completed' && this.pending.method === 'thread/start' && this.pending.name && result?.thread) {
      const { id: threadId, cwd, projectId } = result.thread;
      const created = { threadId, name: this.pending.name, cwd, projectId };
      // Save the next step before clearing the creation receipt, including across reloads.
      this.storage.setItem('codex-created-name', JSON.stringify(created));
      this.createdNaming = created;
    }
    if (status === 'completed' && this.pending.method === 'thread/name/set') this.finishNaming(this.pending.threadId);
    this.clear();
    return true;
  }
  finishNaming(threadId) {
    if (this.createdNaming?.threadId !== threadId) return;
    this.storage.removeItem('codex-created-name');
    this.createdNaming = null;
  }
  clear() {
    this.storage.removeItem('codex-pending');
    this.pending = null;
  }
}

export function deliveryLabel({ connected, pending, sending, running, stopping, outcome }) {
  if (pending && !sending) return connected ? '结果待确认 · 正在查询回执' : '连接中断 · 发送结果待确认';
  if (!connected) return '连接中断 · 正在重连';
  if (stopping) return '正在停止…';
  if (sending) return '发送中…';
  if (running) return '执行中';
  return outcome || '';
}
