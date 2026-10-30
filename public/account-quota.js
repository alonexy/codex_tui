// Only display documented quota metadata; never infer a model-to-limit mapping.
export function quotaMetadata(result) {
  const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
  const bucket = value => {
    if (!value || typeof value !== 'object') return null;
    const selected = pick(value, ['limitId', 'limitName', 'planType', 'spendControlReached', 'rateLimitReachedType']);
    for (const [field, keys] of [['credits', ['hasCredits', 'unlimited', 'balance']], ['individualLimit', ['limit', 'used', 'remainingPercent', 'resetsAt']]]) {
      if (Object.hasOwn(value, field)) selected[field] = value[field] && typeof value[field] === 'object' ? pick(value[field], keys) : null;
    }
    for (const field of ['primary', 'secondary']) if (Object.hasOwn(value, field)) {
      selected[field] = value[field] && typeof value[field] === 'object' ? pick(value[field], ['usedPercent', 'windowDurationMins', 'resetsAt']) : null;
    }
    return selected;
  };
  const selected = {};
  if (Object.hasOwn(result ?? {}, 'ordinaryUsageAllowed')) selected.ordinaryUsageAllowed = typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null;
  if (Object.hasOwn(result ?? {}, 'rateLimits')) selected.rateLimits = bucket(result.rateLimits);
  if (result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object') selected.rateLimitsByLimitId = Object.fromEntries(Object.entries(result.rateLimitsByLimitId).map(([id, value]) => [id, bucket(value)]));
  return selected;
}

export function mergeRateLimits(previous, update) {
  const primaryId = update?.rateLimits?.limitId ?? previous?.rateLimits?.limitId ?? 'default';
  const buckets = { ...(previous?.rateLimitsByLimitId ?? {}) };
  if (previous?.rateLimits) buckets[previous.rateLimits.limitId ?? 'default'] = previous.rateLimits;
  const merge = (id, value) => {
    if (value === null) { delete buckets[id]; return; }
    if (!value || typeof value !== 'object') return;
    const prior = buckets[id] ?? {}, next = { ...prior, ...value };
    // Nullable account metadata in a rolling update means unavailable, not recovery.
    for (const field of ['limitId', 'limitName', 'planType', 'primary', 'secondary', 'credits', 'individualLimit', 'spendControlReached', 'rateLimitReachedType']) {
      if (value[field] == null && Object.hasOwn(prior, field)) next[field] = prior[field];
    }
    for (const field of ['primary', 'secondary', 'credits', 'individualLimit']) {
      if (value[field] && typeof value[field] === 'object') next[field] = { ...prior[field], ...value[field] };
    }
    buckets[id] = next;
  };
  if (Object.hasOwn(update ?? {}, 'rateLimits')) merge(primaryId, update.rateLimits);
  for (const [key, value] of Object.entries(update?.rateLimitsByLimitId ?? {})) merge(value?.limitId ?? key, value);
  return { rateLimits: buckets[primaryId] ?? null, rateLimitsByLimitId: buckets,
    ordinaryUsageAllowed: typeof update?.ordinaryUsageAllowed === 'boolean' ? update.ordinaryUsageAllowed : previous?.ordinaryUsageAllowed ?? null };
}

export function normalizeRateLimits(result) {
  const buckets = new Map();
  const entries = Object.entries(result?.rateLimitsByLimitId ?? {});
  if (result?.rateLimits) entries.unshift([result.rateLimits.limitId ?? 'default', result.rateLimits]);
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const windows = ['primary', 'secondary'].flatMap(name => {
      const window = value[name];
      if (!window || typeof window !== 'object') return [];
      const used = window.usedPercent;
      return [{ remaining: typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? Math.round((100 - used) * 10) / 10 : null,
        minutes: Number.isFinite(window.windowDurationMins) && window.windowDurationMins > 0 ? window.windowDurationMins : null,
        resetsAt: Number.isFinite(window.resetsAt) && window.resetsAt > 0 && window.resetsAt < 8640000000000 ? window.resetsAt * 1000 : null }];
    });
    buckets.set(value.limitId ?? key, { id: value.limitId ?? key, name: typeof value.limitName === 'string' && value.limitName.trim() ? value.limitName : typeof (value.limitId ?? key) === 'string' && (value.limitId ?? key) !== 'default' ? value.limitId ?? key : '未命名额度分组', windows,
      planType: typeof value.planType === 'string' ? value.planType : null, credits: value.credits ?? null, individualLimit: value.individualLimit ?? null,
      restricted: value.spendControlReached === true || value.rateLimitReachedType != null,
      restriction: value.spendControlReached === true ? '已达到消费限制' : typeof value.rateLimitReachedType === 'string' ? `服务限制：${value.rateLimitReachedType}` : value.rateLimitReachedType != null ? '服务报告额度限制' : '' });
  }
  return [...buckets.values()];
}

export function quotaPeriod(minutes) {
  if (!minutes) return '周期未提供';
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export class AccountQuota {
  buckets = [];
  receivedAt = null;
  revision = 0;
  stale = false;
  error = '';
  result = null;
  queriedAt = null;
  epoch = 0;
  read = null;
  cursor = 0;
  clear() { this.result = null; this.buckets = []; this.receivedAt = null; this.queriedAt = null; this.cursor = 0; this.error = ''; this.stale = false; this.revision++; this.epoch++; }
  disconnect() { this.stale = true; this.queriedAt = null; this.revision++; this.epoch++; }
  startRead() { return (this.read = { epoch: this.epoch, updates: [] }); }
  finishRead(token) { if (this.read === token) this.read = null; }
  acceptRead(value, token) {
    if (token.epoch !== this.epoch) return;
    const updates = token.updates.filter(update => update.cursor == null || update.cursor > (value.cursor ?? 0));
    this.accept(updates.reduce((result, update) => mergeRateLimits(result, update.params), value.result), value.receivedAt, value.queriedAt ?? null);
    this.cursor = Math.max(this.cursor, value.cursor ?? 0);
  }
  event(event) {
    if (event.cursor <= this.cursor) return;
    if (event.method === 'account/updated') this.clear();
    else if (event.method === 'account/rateLimits/updated') this.update(event.params, Date.now(), event.cursor);
    this.cursor = event.cursor;
  }
  accept(result, receivedAt = Date.now(), queriedAt = receivedAt) {
    this.result = result;
    this.buckets = normalizeRateLimits(result);
    this.receivedAt = receivedAt;
    this.queriedAt = queriedAt;
    this.stale = false; this.error = ''; this.revision++;
  }
  update(result, receivedAt = Date.now(), cursor = null) {
    if (this.read?.epoch === this.epoch) this.read.updates.push({ params: result, cursor });
    const stale = this.stale;
    this.accept(mergeRateLimits(this.result, result), receivedAt, this.queriedAt);
    this.stale = stale;
  }
  isStale(now = Date.now()) {
    return this.stale || (this.receivedAt != null && now - this.receivedAt > 300000) || (this.queriedAt != null && now - this.queriedAt > 300000) ||
      (this.account?.windows.some(window => window.resetsAt != null && window.resetsAt <= now) ?? false);
  }
  summary(now = Date.now()) {
    if (this.queriedAt == null) return '账号额度未完整同步';
    const windows = this.account?.windows ?? [];
    if (!windows.length) return '账号额度未提供';
    return this.isStale(now) ? '账号额度 · 旧数据' : `账号 ${windows.map(window => `${quotaPeriod(window.minutes)} ${window.remaining == null ? '未提供' : `${window.remaining}%`}`).join(' · ')}`;
  }
  get account() { return this.buckets.find(bucket => bucket.id === 'codex') ?? null; }
}
