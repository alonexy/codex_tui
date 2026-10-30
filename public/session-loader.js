// Independent reads cannot hold the state cursor. Refresh bursts collapse into
// one follow-up read; callers guard commits with their selection and revision.
export class SessionLoader {
  constructor() { this.pending = new Map(); this.queued = new Map(); }
  run(key, job) {
    if (this.pending.has(key)) return this.pending.get(key);
    const request = Promise.resolve().then(() => {
      if (this.pending.get(key) === request) return job();
    }).finally(() => {
      if (this.pending.get(key) !== request) return;
      this.pending.delete(key);
      const next = this.queued.get(key);
      this.queued.delete(key);
      if (next) this.run(key, next).catch(() => {});
    });
    this.pending.set(key, request);
    return request;
  }
  invalidateReads() {
    for (const key of this.pending.keys()) if (key !== 'recovery') this.pending.delete(key);
    this.queued.clear();
  }
  refresh(key, job) {
    if (this.pending.has(key)) { this.queued.set(key, job); return; }
    this.run(key, job).catch(() => {});
  }
  history({ key = 'history', load, revision, valid, commit, error }) {
    const refresh = async () => {
      if (!valid()) return;
      const before = revision();
      try {
        const result = await load();
        if (!valid()) return;
        if (before !== revision()) { this.refresh(key, refresh); return; }
        commit(result);
      } catch (failure) { if (valid()) error(failure); }
    };
    this.refresh(key, refresh);
  }
}

export function trimSessions(map, protectedIds, limit = 6, remove = id => map.delete(id)) {
  let remaining = [...map.keys()].filter(id => !protectedIds.has(id)).length;
  for (const id of map.keys()) {
    if (remaining <= limit) break;
    if (!protectedIds.has(id)) { remove(id); remaining--; }
  }
}
