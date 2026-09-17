const validMode = mode => mode === 'plan' || mode === 'default';
export const modeLabel = mode => mode === 'plan' ? '计划' : mode === 'default' ? '执行' : '未知';

// Persist only mode/settings metadata, never message text or question answers.
export class PlanMode {
  known = new Map();
  choices = new Map();
  revisions = new Map();
  snapshots = new Map();
  evidence = new Map();
  sources = new Map();
  turns = new Map();
  epoch = 0;
  pending = null;
  constructor(storage) {
    this.storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem('codex-plan-mode') ?? 'null');
      for (const [id, mode] of saved?.choices ?? []) if (validMode(mode)) this.choices.set(id, mode);
      if (saved?.pending?.key && validMode(saved.pending.mode)) this.pending = saved.pending;
    } catch { /* The current native setting remains unknown until observed. */ }
  }
  save() {
    try { this.storage?.setItem('codex-plan-mode', JSON.stringify({ choices: [...this.choices], pending: this.pending })); }
    catch { /* Mode drafts can still be used in this page. Execution receipts are saved separately. */ }
  }
  choose(id, mode) {
    if (validMode(mode)) this.choices.set(id, mode);
    else this.choices.delete(id);
    this.save();
  }
  observe(id, collaborationMode, source = 'runtime') {
    this.known.set(id, validMode(collaborationMode?.mode) ? collaborationMode.mode : null);
    this.sources.set(id, source);
    this.turns.delete(id);
    this.evidence.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }
  expireTurn(id, activeTurn) {
    if (this.sources.get(id) !== 'current-turn' || this.turns.get(id) === activeTurn) return;
    if (validMode(this.known.get(id))) this.evidence.set(id, { mode: this.known.get(id), source: 'last-turn' });
    this.known.delete(id); this.sources.delete(id); this.turns.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }
  active(turns) { for (const id of this.turns.keys()) this.expireTurn(id, turns[id]); }
  token(id) { return { epoch: this.epoch, revision: this.revisions.get(id) ?? 0 }; }
  acceptRead(id, result, token, activeTurn) {
    if (result?.threadId !== id || token.epoch !== this.epoch || token.revision !== (this.revisions.get(id) ?? 0)) return;
    this.expireTurn(id, activeTurn);
    let source = result.source;
    if (source === 'current-turn' && (!result.turnId || result.turnId !== activeTurn)) source = 'last-turn';
    if (source === 'runtime' || source === 'current-turn') {
      this.observe(id, result.collaborationMode, source);
      if (source === 'current-turn') this.turns.set(id, result.turnId);
    }
    else if (source === 'last-turn' && validMode(result.collaborationMode?.mode)) this.evidence.set(id, { mode: result.collaborationMode.mode, source });
    else this.evidence.delete(id);
  }
  display(id) {
    return validMode(this.known.get(id)) ? { mode: this.known.get(id), source: this.sources.get(id) } : this.evidence.get(id) ?? {};
  }
  snapshot(settings, reset = false) {
    if (reset) { this.known.clear(); this.snapshots.clear(); this.revisions.clear(); this.evidence.clear(); this.sources.clear(); this.turns.clear(); this.epoch++; }
    for (const [id, value] of Object.entries(settings ?? {})) {
      const signature = JSON.stringify(value);
      if (this.snapshots.get(id) === signature) continue;
      this.snapshots.set(id, signature);
      if (Object.hasOwn(value, 'collaborationMode')) this.observe(id, value.collaborationMode);
    }
  }
  params(id, current, modelOverride, steer = false) {
    if (steer) return {};
    const mode = this.choices.get(id) ?? this.known.get(id);
    const setting = modelOverride ?? current;
    if (!validMode(mode)) return { ...modelOverride };
    if (!this.choices.has(id) && !modelOverride) return {};
    if (!setting?.model) throw Error('请先用 /model 选择型号，再发送模式设置');
    return {
      ...modelOverride,
      collaborationMode: { mode, settings: { model: setting.model, reasoning_effort: setting.effort ?? null, developer_instructions: null } },
    };
  }
  begin(key, id, params) {
    if (!params.collaborationMode) return;
    this.pending = { key, id, mode: params.collaborationMode.mode, revision: this.revisions.get(id) ?? 0 };
    this.save();
  }
  finish(key, success) {
    const pending = this.pending;
    if (pending?.key !== key) return;
    if (success) {
      if ((this.revisions.get(pending.id) ?? 0) === pending.revision) this.observe(pending.id, { mode: pending.mode });
      if (this.choices.get(pending.id) === pending.mode) this.choices.delete(pending.id);
    }
    this.pending = null;
    this.save();
  }
}
