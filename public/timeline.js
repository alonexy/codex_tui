const keyFor = (turnId, itemId) => JSON.stringify([turnId ?? '', itemId]);
const sameUserMessage = (a, b) => a.type === 'userMessage' && b.type === 'userMessage' &&
  JSON.stringify(a.content) === JSON.stringify(b.content) &&
  (String(a.id).startsWith('item-') || String(b.id).startsWith('item-'));

const terminal = status => ['completed', 'failed', 'interrupted'].includes(status);
const metadataFor = turn => Object.fromEntries(['status', 'error', 'startedAt', 'completedAt', 'durationMs']
  .filter(key => turn[key] !== undefined).map(key => [key, turn[key]]));

// Item pages may overlap, and started/completed notifications share an ID.
export function turnItems(turn) {
  const items = new Map();
  for (const [index, item] of (turn.items ?? []).entries()) items.set(item.id ?? `missing-${index}`, item);
  return [...items.values()];
}

export function isProcessItem(item) {
  if (item.type === 'userMessage') return false;
  if (item.type === 'agentMessage') return item.phase === 'commentary' && !item.questions?.length;
  return true;
}

export function operationFailed(item) {
  return ['failed', 'declined'].includes(item.status) || item.success === false ||
    (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0);
}

export function processAction(item, withDetail = true) {
  if (!item) return '等待新的进展';
  const labels = { commandExecution: '执行命令', fileChange: '修改文件', agentMessage: '进度',
    plan: '计划', reasoning: '分析', mcpToolCall: '调用工具', dynamicToolCall: '调用工具',
    collabAgentToolCall: '协作', subAgentActivity: '子任务', webSearch: '搜索',
    imageView: '查看图片', imageGeneration: '生成图片', contextCompaction: '整理上下文', sleep: '等待' };
  const label = labels[item.type] ?? '执行详情';
  if (!withDetail) return label;
  const preview = item.type === 'commandExecution' ? item.command
    : ['agentMessage', 'plan'].includes(item.type) ? item.text
      : item.type === 'fileChange' ? item.changes?.map(change => change.path).filter(Boolean).join('、')
        : item.tool ?? item.query ?? '';
  const text = typeof preview === 'string' ? preview.replace(/\s+/g, ' ').trim() : '';
  return text ? `${label}：${text.length > 100 ? text.slice(0, 100) + '…' : text}` : label;
}

export function processSummary(turn, running = false) {
  const items = turnItems(turn).filter(isProcessItem);
  const status = turn.status ?? (running ? 'inProgress' : undefined);
  const state = { inProgress: '进行中', completed: '已完成', failed: '执行失败', interrupted: '已停止' }[status];
  const parts = ['执行过程', ...(state ? [state] : [])];
  const duration = Number.isFinite(turn.durationMs) && turn.durationMs >= 0 ? turn.durationMs
    : Number.isFinite(turn.startedAt) && Number.isFinite(turn.completedAt) && turn.completedAt >= turn.startedAt
      ? (turn.completedAt - turn.startedAt) * 1000 : null;
  if (terminal(status) && duration !== null) {
    const seconds = Math.round(duration / 1000);
    parts.push(seconds < 1 ? '用时不足 1 秒' : seconds < 60 ? `用时 ${seconds} 秒` : `用时 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`);
  }
  const paths = new Set(items.filter(item => item.type === 'fileChange' && item.status === 'completed')
    .flatMap(item => item.changes ?? []).map(change => change.path).filter(path => typeof path === 'string' && path.trim()));
  if (paths.size) parts.push(`修改 ${paths.size} 个文件${turn.itemsView === 'full' ? '' : '（已加载记录）'}`);
  const failed = items.some(operationFailed);
  if (failed) parts.push('有操作未成功');
  return { text: parts.join(' · '), action: status === 'inProgress' ? processAction(items.at(-1), false) : '',
    attention: failed || ['failed', 'interrupted'].includes(status),
    error: status === 'failed' ? turn.error?.message ?? '' : '', status };
}

export class Timeline {
  constructor() { this.histories = new Map(); this.live = new Map(); this.turnMetadata = new Map(); this.observedTurns = new Map(); }
  metadata(id, turns) {
    const metadata = this.turnMetadata.get(id) ?? new Map();
    this.turnMetadata.set(id, metadata);
    for (const turn of turns) {
      if (!turn.id) continue;
      const previous = metadata.get(turn.id) ?? {};
      const incoming = metadataFor(turn);
      // An older read or a partial item page cannot undo a completed event.
      if (terminal(previous.status) && !terminal(incoming.status)) continue;
      for (const field of ['startedAt', 'completedAt', 'durationMs']) {
        if (incoming[field] === null && previous[field] != null) delete incoming[field];
      }
      metadata.set(turn.id, { ...previous, ...incoming });
    }
  }
  snapshot(id, thread) {
    this.metadata(id, thread.turns ?? []);
    this.histories.set(id, thread);
    return this.thread(id, true);
  }
  event(event) {
    const p = event.params ?? {};
    if (!p.threadId) return;
    if (['turn/started', 'turn/completed'].includes(event.method) && p.turn?.id) {
      const turns = this.observedTurns.get(p.threadId) ?? new Set();
      turns.add(p.turn.id); this.observedTurns.set(p.threadId, turns);
      this.metadata(p.threadId, [{ ...p.turn, status: p.turn.status ?? (event.method === 'turn/started' ? 'inProgress' : undefined) }]);
      return;
    }
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
    const turns = (history.turns ?? []).map(turn => ({ ...turn, items: turnItems(turn).map(item => {
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
    for (const [turnId, metadata] of this.turnMetadata.get(id) ?? []) {
      let turn = turns.find(turn => turn.id === turnId);
      // Metadata-only pages also contain turns whose messages were not requested.
      if (!turn && !this.observedTurns.get(id)?.has(turnId)) continue;
      if (!turn) { turn = { id: turnId, items: [] }; turns.push(turn); }
      Object.assign(turn, metadata);
    }
    return { ...history, turns };
  }
}
