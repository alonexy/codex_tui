import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountQuota, normalizeRateLimits, quotaPeriod, quotaMetadata } from '../public/account-quota.js';
import { Broker } from '../src/broker.mjs';
import { createWebServer } from '../src/http.mjs';

const quota = (usedPercent = 20) => ({ rateLimits: { limitId: 'main', primary: { usedPercent, windowDurationMins: 10080, resetsAt: 2000000000 }, secondary: null } });

test('quota uses actual periods, remaining percentage and distinct buckets without model guesses', () => {
  const buckets = normalizeRateLimits({ ...quota(), rateLimitsByLimitId: {
    main: { ...quota(30).rateLimits, limitName: 'Main' }, extra: { primary: { usedPercent: 100, windowDurationMins: 90 }, secondary: { usedPercent: null } },
  } });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].windows[0].remaining, 70);
  assert.equal(buckets[0].windows[0].resetsAt, 2000000000000);
  assert.equal(buckets[1].windows[0].remaining, 0);
  assert.equal(buckets[1].windows[1].remaining, null);
  assert.equal(quotaPeriod(buckets[0].windows[0].minutes), '7 天');
  assert.equal(quotaPeriod(300), '5 小时');
  assert.equal(quotaPeriod(90), '90 分钟');
  assert.equal(quotaPeriod(null), '周期未提供');
  for (const invalid of [null, -1, 101, '25', NaN]) assert.equal(normalizeRateLimits(quota(invalid))[0].windows[0].remaining, null);
  assert.deepEqual(normalizeRateLimits({ rateLimits: null }), []);
});

test('quota distinguishes zero, absent, expired, disconnected, restricted and changed-account states', () => {
  const state = new AccountQuota();
  state.accept({ rateLimits: { ...quota(100).rateLimits, limitId: 'codex' } }, 1000);
  assert.equal(state.summary(1001), '账号 7 天 0%');
  assert.equal(state.summary(301001), '账号额度 · 旧数据');
  state.disconnect(); assert.equal(state.summary(1001), '账号额度未完整同步');
  state.clear(); assert.equal(state.summary(), '账号额度未完整同步'); assert.equal(state.receivedAt, null);
  state.accept({ rateLimits: { ...quota(0).rateLimits, spendControlReached: true } }, Date.now());
  assert.equal(state.buckets[0].restricted, true);
  assert.doesNotMatch(state.summary(), /%/);
  state.accept({ rateLimits: { ...quota(0).rateLimits, limitId: 'codex', primary: { usedPercent: 0, resetsAt: 1 } } });
  assert.equal(state.isStale(), true);
});

test('sparse notifications preserve queried buckets and unavailable windows without extending query freshness', () => {
  const state = new AccountQuota();
  state.accept({ ...quota(), rateLimitsByLimitId: { extra: { limitId: 'extra', primary: { usedPercent: 90, windowDurationMins: 300 } } } });
  state.update({ rateLimits: { limitId: 'main', primary: { usedPercent: 30 } } });
  assert.equal(state.summary(), '账号额度未提供', 'non-codex groups cannot stand in for the account');
  const queriedAt = state.queriedAt;
  assert.equal(state.buckets.find(bucket => bucket.windows[0]?.remaining === 70).windows[0].minutes, 10080);
  state.update({ rateLimits: { primary: { usedPercent: 40 } } });
  assert.equal(state.buckets.length, 2, 'missing id retains confirmed legacy alias');
  assert.equal(state.buckets.some(bucket => bucket.windows[0]?.remaining === 60), true);
  state.update({ rateLimits: { limitId: 'main', primary: null } });
  assert.equal(state.buckets.some(bucket => bucket.windows[0]?.remaining === 60), true);
  assert.equal(state.queriedAt, queriedAt);
  state.accept(quota(30)); assert.equal(state.buckets.length, 1, 'account read replaces the old buckets');
  state.clear(); state.update(quota(0)); assert.equal(state.summary(), '账号额度未完整同步');
});

test('only an explicitly identified codex bucket supplies account periods and other buckets cannot affect freshness', () => {
  const state = new AccountQuota();
  state.accept({ rateLimits: { ...quota(0).rateLimits, limitId: 'gpt-reserve', primary: { usedPercent: 0, resetsAt: 1 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 28, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 }, credits: { balance: '999' } },
  } });
  assert.equal(state.summary(), '账号 5 小时 72% · 7 天 60%');
  assert.equal(state.account.id, 'codex');
  assert.equal(state.isStale(), false, 'an expired reserve bucket does not stale the account display');
  state.accept({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } });
  assert.equal(state.account, null); assert.equal(state.summary(), '账号额度未提供', 'unidentified legacy view is not an account source');
  state.accept({ rateLimitsByLimitId: { codex: { limitId: 'gpt-reserve', primary: { usedPercent: 0 } } } });
  assert.equal(state.account, null, 'conflicting identity fails closed');
  state.clear(); state.update({ rateLimits: { ...quota(0).rateLimits, limitId: 'codex' } });
  assert.equal(state.summary(), '账号额度未完整同步', 'even identified notification data is not a completed account query');
});

test('quota metadata strips unrelated account fields at every nesting level', () => {
  const value = quota(); value.accountId = 'secret'; value.rateLimits.email = 'secret'; value.rateLimits.primary.accountId = 'secret';
  assert.doesNotMatch(JSON.stringify(quotaMetadata(value)), /secret|accountId|email/);
  assert.equal(quotaMetadata(value).rateLimits.primary.usedPercent, 20);
});

test('quota reads coalesce, cache failures, invalidate account changes and reject late reads', async () => {
  const sent = [], broker = new Broker(message => sent.push(message), () => {}, { ownedThreads: new Set() }); broker.ready = true;
  broker.receive({ method: 'account/rateLimits/updated', params: quota(0) });
  const first = broker.readRateLimits(), duplicate = broker.readRateLimits();
  assert.equal(first, duplicate); assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'account/rateLimits/read');
  assert.deepEqual(sent[0].params, { excludeResetCreditDetails: true });
  broker.receive({ id: sent[0].id, result: quota() });
  assert.equal((await first).result.rateLimits.primary.usedPercent, 20);
  await broker.readRateLimits(); assert.equal(sent.length, 1);
  broker.receive({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  const stale = broker.readRateLimits();
  const rejected = assert.rejects(stale, /已变化/);
  broker.receive({ method: 'account/updated', params: {} });
  broker.receive({ method: 'account/rateLimits/updated', params: quota(75) });
  broker.receive({ id: sent[1].id, result: quota(5) });
  await rejected;
  const failed = broker.readRateLimits();
  broker.receive({ id: sent[2].id, error: { message: 'unsupported upstream detail' } });
  await assert.rejects(failed, /账号未提供/);
  await assert.rejects(broker.readRateLimits(), /账号未提供/); assert.equal(sent.length, 3);
  broker.close(); await assert.rejects(broker.readRateLimits(), /尚未连接/);
});

test('rolling updates do not postpone complete reads and in-flight updates merge into all returned groups', async () => {
  const sent = [], broker = new Broker(message => sent.push(message)); broker.ready = true;
  broker.receive({ method: 'account/rateLimits/updated', params: quota(0) });
  const read = broker.readRateLimits();
  broker.receive({ method: 'account/rateLimits/updated', params: quota(40) });
  broker.receive({ id: sent[0].id, result: { ...quota(10), rateLimitsByLimitId: { extra: { primary: { usedPercent: 80, windowDurationMins: 300 } } } } });
  const value = await read;
  assert.equal(value.result.rateLimits.primary.usedPercent, 40);
  assert.equal(value.result.rateLimitsByLimitId.extra.primary.usedPercent, 80);
  assert.ok(value.queriedAt);
  broker.quotaCache.queriedAt -= 60001;
  broker.receive({ method: 'account/rateLimits/updated', params: quota(50) });
  const refresh = broker.readRateLimits();
  assert.equal(sent.length, 2, 'recent notification must not extend account query TTL');
  broker.receive({ id: sent[1].id, result: quota(60) }); await refresh;
});

test('null rolling account metadata cannot imply ordinary usage or credits recovered', () => {
  const state = new AccountQuota();
  state.accept(quotaMetadata({ ...quota(0), ordinaryUsageAllowed: false, rateLimits: { ...quota(0).rateLimits, planType: 'pro', credits: { hasCredits: false, unlimited: false, balance: '0', email: 'secret' }, spendControlReached: true } }));
  const queriedAt = state.queriedAt;
  state.update({ ordinaryUsageAllowed: null, rateLimits: { credits: null, planType: null, spendControlReached: null } });
  assert.equal(state.result.ordinaryUsageAllowed, false);
  assert.equal(state.buckets[0].credits.hasCredits, false);
  assert.equal(state.buckets[0].restricted, true);
  assert.equal(state.queriedAt, queriedAt);
  assert.doesNotMatch(JSON.stringify(state.result), /secret|email/);
});

test('buffered events covered by the read cursor cannot overwrite its response; newer events still win', () => {
  const state = new AccountQuota();
  const first = state.startRead();
  state.event({ cursor: 5, method: 'account/rateLimits/updated', params: quota(20) });
  state.acceptRead({ result: quota(80), cursor: 5, receivedAt: Date.now(), queriedAt: Date.now() }, first);
  state.finishRead(first);
  assert.equal(state.buckets[0].windows[0].remaining, 20);
  const second = state.startRead();
  state.event({ cursor: 6, method: 'account/rateLimits/updated', params: quota(50) });
  state.acceptRead({ result: quota(80), cursor: 5, receivedAt: Date.now(), queriedAt: Date.now() }, second);
  state.finishRead(second);
  assert.equal(state.buckets[0].windows[0].remaining, 50);
});

test('quota endpoint requires authentication and origin, and gates old bridges before any RPC', async t => {
  const sent = [], broker = new Broker(message => { sent.push(message); queueMicrotask(() => broker.receive({ id: message.id, result: quota(75) })); }); broker.ready = true;
  let legacy = true;
  const snapshot = broker.snapshot.bind(broker);
  broker.snapshot = after => { const state = snapshot(after); if (legacy) delete state.capabilities.accountRateLimits; return state; };
  const origin = 'https://phone.example', password = 'quota-test-password';
  const server = createWebServer(broker, { password, origin });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/account-rate-limits`)).status, 401);
  assert.equal((await fetch(`${base}/account-quota.js`)).status, 401);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal((await fetch(`${base}/api/account-rate-limits`, { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/account-rate-limits`, { headers })).status, 409); assert.equal(sent.length, 0);
  legacy = false;
  broker.receive({ method: 'account/rateLimits/updated', params: quota(75) });
  const response = await fetch(`${base}/api/account-rate-limits`, { headers });
  assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
  const value = await response.json();
  assert.equal(value.result.rateLimits.primary.usedPercent, 75); assert.equal(sent.length, 1); assert.ok(value.queriedAt);
  broker.ready = false;
  assert.equal((await fetch(`${base}/api/account-rate-limits`, { headers })).status, 503);
});
