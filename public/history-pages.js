// Pages are fetched newest-first, then displayed in chronological order.
export class HistoryPages {
  constructor(command, onMetadata = () => {}) {
    this.command = command; this.onMetadata = onMetadata;
    this.pages = new Map(); this.pending = new Map();
    this.metadata = new Map(); this.metadataPending = new Map();
    this.metadataQueued = new Set();
  }
  read(threadId, older = false) {
    const request = (this.pending.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => this.load(threadId, older));
    this.pending.set(threadId, request);
    request.finally(() => { if (this.pending.get(threadId) === request) this.pending.delete(threadId); }).catch(() => {});
    return request;
  }
  async load(threadId, older) {
    const previous = this.pages.get(threadId);
    if (older && !previous?.cursor) return previous;
    const response = await this.command('thread/items/list', {
      threadId, limit: 100, sortDirection: 'desc',
      ...(older ? { cursor: previous.cursor } : {}),
    });
    const incoming = [...response.data].reverse();
    const anchor = !older && incoming.length && previous ? previous.entries.findIndex(entry => entry.turnId === incoming[0].turnId && entry.item.id === incoming[0].item.id) : -1;
    const entries = older ? [...incoming, ...previous.entries] : anchor >= 0 ? [...previous.entries.slice(0, anchor), ...incoming] : incoming;
    const seen = new Set();
    const unique = entries.filter(entry => {
      const key = JSON.stringify([entry.turnId, entry.item.id]);
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const turns = [];
    for (const entry of unique) {
      let turn = turns.find(turn => turn.id === entry.turnId);
      if (!turn) {
        turn = { ...this.metadata.get(threadId)?.get(entry.turnId), id: entry.turnId, items: [], itemsView: 'partial' };
        turns.push(turn);
      }
      turn.items.push(entry.item);
    }
    const result = { entries: unique, cursor: anchor >= 0 ? previous.cursor : response.nextCursor, thread: { id: threadId, turns } };
    this.pages.set(threadId, result);
    // Supplementary timing/status must never delay or fail a successful item page.
    this.refreshMetadata(threadId);
    return result;
  }
  refreshMetadata(threadId) {
    if (this.metadataPending.has(threadId)) { this.metadataQueued.add(threadId); return; }
    const request = this.loadMetadata(threadId).catch(() => {}).finally(() => {
      this.metadataPending.delete(threadId);
      if (this.metadataQueued.delete(threadId)) this.refreshMetadata(threadId);
    });
    this.metadataPending.set(threadId, request);
  }
  async loadMetadata(threadId) {
    const cache = this.metadata.get(threadId) ?? new Map();
    this.metadata.set(threadId, cache);
    const needed = new Set(this.pages.get(threadId).thread.turns
      .filter(turn => !['completed', 'failed', 'interrupted'].includes(cache.get(turn.id)?.status)).map(turn => turn.id));
    let cursor;
    const visited = new Set();
    // Bound best-effort reads even when a provider omits an old turn entirely.
    while (needed.size && !visited.has(cursor) && visited.size < 4) {
      visited.add(cursor);
      const response = await this.command('thread/turns/list', {
        threadId, limit: 50, sortDirection: 'desc', itemsView: 'notLoaded', ...(cursor ? { cursor } : {}),
      });
      const loaded = [];
      for (const { items, itemsView, ...metadata } of response.data ?? []) {
        if (!needed.delete(metadata.id)) continue;
        cache.set(metadata.id, metadata); loaded.push(metadata);
      }
      const page = this.pages.get(threadId);
      for (const turn of page.thread.turns) Object.assign(turn, cache.get(turn.id));
      if (loaded.length) this.onMetadata(threadId, loaded);
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
  }
}
