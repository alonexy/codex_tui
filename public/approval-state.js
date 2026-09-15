const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
export const isAnswerable = request => approvalMethods.has(request.method) || request.method === 'item/tool/requestUserInput';
const kind = request => request.method === 'item/tool/requestUserInput' ? 'waitingOnUserInput' : 'waitingOnApproval';
const waitingFlags = status => status?.type === 'active' && Array.isArray(status.activeFlags)
  ? status.activeFlags.filter(flag => ['waitingOnApproval', 'waitingOnUserInput'].includes(flag)) : [];

// In-memory only: snapshots own request lifetimes; native flags supplement desktop-only waits.
export class ApprovalState {
  requests = [];
  native = new Map();
  online = false;
  revision = 0;
  generation = 0;
  seen = new Map();
  cursor = null;

  token() { return { generation: this.generation, revision: this.revision }; }

  disconnect() {
    this.online = false;
    for (const value of this.native.values()) value.uncertain = true;
  }

  thread(id, status, token = this.token()) {
    if (!id || !status || token.generation !== this.generation || token.revision < (this.seen.get(id) ?? 0)) return;
    this.seen.set(id, this.revision);
    if (status.type === 'notLoaded' || status.type === 'systemError') {
      if (this.native.has(id)) this.native.get(id).uncertain = true;
      return;
    }
    if (status.type !== 'idle' && status.type !== 'active') return;
    const flags = waitingFlags(status);
    if (flags.length) this.native.set(id, { flags, uncertain: !this.online });
    else this.native.delete(id);
  }

  snapshot(state, changed = false) {
    this.revision++;
    const replay = !changed && Number.isSafeInteger(state.cursor) && state.cursor === this.cursor;
    if ((state.reset && !replay) || changed) {
      this.generation++;
      this.seen.clear();
      for (const value of this.native.values()) value.uncertain = true;
    }
    if (!state.ready) { this.disconnect(); return; }
    this.online = true;
    this.cursor = state.cursor ?? null;
    const previous = changed ? [] : this.requests;
    this.requests = [...new Map((state.approvals ?? []).map(request => [JSON.stringify(request.id), request])).values()];
    const resolved = request => {
      const id = request.params?.threadId, value = this.native.get(id);
      if (!value || this.requests.some(next => next.params?.threadId === id && kind(next) === kind(request))) return;
      this.seen.set(id, this.revision);
      value.flags = value.flags.filter(flag => flag !== kind(request));
      if (!value.flags.length) this.native.delete(id);
    };
    // A vanished supported request must not leave its old native waiting flag behind.
    for (const request of previous) if (!this.requests.some(next => next.id === request.id)) resolved(request);
    // Apply later native events in order, including a new desktop wait after resolution.
    for (const event of replay ? [] : state.events ?? []) {
      if (event.method === 'thread/status/changed') this.thread(event.params?.threadId, event.params?.status);
      if (event.method === 'serverRequest/resolved') {
        const request = previous.find(item => item.id === event.params?.requestId);
        if (request) resolved(request);
      }
    }
  }

  entries() {
    const entries = new Map();
    const entry = id => {
      if (!entries.has(id)) entries.set(id, { id, requests: [], flags: [], desktop: [], uncertain: !this.online });
      return entries.get(id);
    };
    for (const request of this.requests) entry(request.params?.threadId ?? '').requests.push(request);
    for (const [id, value] of this.native) {
      const current = entry(id);
      current.flags = value.flags;
      current.desktop = value.flags.filter(flag => !current.requests.some(request => kind(request) === flag));
      if (current.desktop.length && value.uncertain) current.uncertain = true;
    }
    return entries;
  }

  get(id) { return this.entries().get(id); }
}

export function approvalLabel(entry) {
  if (!entry) return '';
  const parts = [];
  const approvals = entry.requests.filter(request => kind(request) === 'waitingOnApproval').length;
  const answers = entry.requests.length - approvals;
  if (approvals) parts.push(`${approvals} 项待批准`);
  if (answers) parts.push(`${answers} 项待回答`);
  if (entry.desktop.length) parts.push(`${entry.desktop.map(flag => flag === 'waitingOnApproval' ? '待批准' : '待回答').join(' / ')} · 需在桌面处理`);
  else if (entry.requests.some(request => !isAnswerable(request))) parts.push('需在桌面处理');
  return `${entry.uncertain ? '待核对 · ' : ''}${parts.join(' · ')}`;
}
