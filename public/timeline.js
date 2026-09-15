const keyFor = (turnId, itemId) => JSON.stringify([turnId ?? '', itemId]);
const sameUserMessage = (a, b) => a.type === 'userMessage' && b.type === 'userMessage' &&
  JSON.stringify(a.content) === JSON.stringify(b.content) &&
  (String(a.id).startsWith('item-') || String(b.id).startsWith('item-'));

export class Timeline {
  constructor() { this.histories = new Map(); this.live = new Map(); }
  snapshot(id, thread) {
    this.histories.set(id, thread);
    return this.thread(id, true);
  }
  event(event) {
    const p = event.params ?? {};
    if (!p.threadId) return;
    let live = this.live.get(p.threadId);
    if (!live) { live = new Map(); this.live.set(p.threadId, live); }
    if (['item/started', 'item/completed'].includes(event.method) && p.item?.id) {
      live.set(keyFor(p.turnId, p.item.id), { turnId: p.turnId ?? '', item: p.item }); return;
    }
    if (!p.itemId || typeof p.delta !== 'string') return;
    const type = event.method === 'item/agentMessage/delta' ? 'agentMessage'
      : event.method === 'item/commandExecution/outputDelta' ? 'commandExecution' : null;
    if (!type) return;
    const key = keyFor(p.turnId, p.itemId);
    const historical = this.histories.get(p.threadId)?.turns?.filter(turn => (turn.id ?? '') === (p.turnId ?? '')).flatMap(turn => turn.items ?? []).find(item => item.id === p.itemId);
    const item = { ...(live.get(key)?.item ?? historical ?? { id: p.itemId, type }) };
    const field = type === 'agentMessage' ? 'text' : 'aggregatedOutput';
    item[field] = (item[field] ?? '') + p.delta;
    live.set(key, { turnId: p.turnId ?? '', item });
  }
  thread(id, consume = false) {
    const history = this.histories.get(id) ?? { id, turns: [] };
    const live = new Map(this.live.get(id));
    const turns = (history.turns ?? []).map(turn => ({ ...turn, items: (turn.items ?? []).map(item => {
      const exact = keyFor(turn.id, item.id);
      // Some active-turn snapshots use temporary item-N IDs. Match occurrences
      // within that turn only; identical submissions in other turns stay distinct.
      const match = live.has(exact) ? exact : [...live].find(([, entry]) => entry.turnId === (turn.id ?? '') && sameUserMessage(item, entry.item))?.[0];
      const updated = live.get(match)?.item;
      live.delete(match);
      if (consume) this.live.get(id)?.delete(match);
      return consume ? item : updated ?? item;
    }) }));
    for (const { turnId, item } of live.values()) {
      let turn = turns.find(turn => (turn.id ?? '') === turnId);
      if (!turn) { turn = { id: turnId, items: [] }; turns.push(turn); }
      turn.items.push(item);
    }
    return { ...history, turns };
  }
}
