// Pages are fetched newest-first, then displayed in chronological order.
export class HistoryPages {
  constructor(command) { this.command = command; this.pages = new Map(); this.pending = new Map(); }
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
      const key = `${entry.turnId}:${entry.item.id}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    const turns = [];
    for (const entry of unique) {
      let turn = turns.find(turn => turn.id === entry.turnId);
      if (!turn) { turn = { id: entry.turnId, items: [] }; turns.push(turn); }
      turn.items.push(entry.item);
    }
    const result = { entries: unique, cursor: anchor >= 0 ? previous.cursor : response.nextCursor, thread: { id: threadId, turns } };
    this.pages.set(threadId, result);
    return result;
  }
}
