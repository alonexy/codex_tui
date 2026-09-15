import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAudit } from '../src/audit.mjs';

const sessionId = 'bb100c74-0802-4f6d-8f9a-adf4b5c6623b';
const valid = { action: 'rpc.submit', result: 'accepted', source: '192.0.2.1', device: 'Safari · iOS', sessionId };
const fields = ['action', 'device', 'result', 'sessionId', 'source', 'targetId', 'time'];
async function directory(t) {
  const dir = await mkdtemp('/private/tmp/phone-audit-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('audit records only fixed safe fields, never arbitrary device/source/id values or errors', () => {
  const audit = createAudit({ now: () => 100 });
  const secret = 'sensitive-password-cookie-task-rpc-parameter';
  assert.equal(audit.record({ ...valid, password: secret, error: secret, params: { text: secret } }), true);
  audit.record({ ...valid, source: secret, device: secret, sessionId: secret, targetId: secret });
  assert.equal(audit.record({ ...valid, action: secret }), false);
  assert.equal(audit.record({ ...valid, result: secret }), false);
  const events = audit.list().events;
  assert.equal(events.length, 2);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), fields);
  assert.equal(events[0].sessionId, null);
  assert.equal(events[0].source, 'unknown');
  assert.equal(events[1].sessionId, sessionId);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(secret));
  events[0].source = secret;
  assert.equal(audit.list().events[0].source, 'unknown', 'readers cannot mutate retained events');
});

test('failure floods are sampled and bounded while authenticated actions retain a separate budget', () => {
  let time = 1000;
  const audit = createAudit({ now: () => time, maxEvents: 10 });
  for (let i = 0; i < 10000; i++) audit.record({ ...valid, action: 'login', result: 'failed' });
  assert.equal(audit.list().events.length, 1);
  assert.equal(audit.list().suppressed, 9999);
  for (let i = 0; i < 1000; i++) audit.record({ ...valid, source: `192.0.${Math.floor(i / 250)}.${i % 250}`, action: 'login', result: 'limited' });
  assert.equal(audit.record({ ...valid, action: 'session.revoke', result: 'revoked', targetId: sessionId }), true);
  assert.equal(audit.list().events[0].action, 'session.revoke');
  assert.equal(audit.list().events.length, 10);
  for (let i = 0; i < 1000; i++) audit.record(valid);
  const suppressed = audit.list().suppressed;
  assert.equal(audit.record(valid), false);
  assert.equal(audit.list().suppressed, suppressed + 1);
  time += 60000;
  assert.equal(audit.record(valid), true);
});

test('concurrent records remain valid JSON with 0600 permissions, size rotation and bounded restoration', async t => {
  const path = join(await directory(t), 'security-audit.jsonl');
  let time = 0;
  const audit = createAudit({ path, now: () => ++time, maxEvents: 3, maxBytes: 1024 });
  await Promise.all(Array.from({ length: 50 }, async () => audit.record(valid)));
  assert.equal(audit.list().events.length, 3);
  assert.equal(audit.list().persistence, 'enabled');
  for (const filename of [path, path + '.1']) {
    const info = await stat(filename);
    assert.equal(info.mode & 0o777, 0o600);
    assert.ok(info.size <= 1024);
    const lines = (await readFile(filename, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(lines.length > 0);
    for (const event of lines) assert.deepEqual(Object.keys(event).sort(), fields);
  }
  const restored = createAudit({ path, now: () => time, maxEvents: 3, maxBytes: 1024 });
  assert.deepEqual(restored.list().events, audit.list().events);
});

test('audit refuses symlinks and degrades visibly without touching the linked file', async t => {
  const dir = await directory(t), target = join(dir, 'unrelated'), path = join(dir, 'security-audit.jsonl');
  await writeFile(target, 'do not change', { mode: 0o644 });
  await symlink(target, path);
  const audit = createAudit({ path });
  audit.record(valid);
  assert.equal(audit.list().persistence, 'unavailable');
  assert.equal(audit.list().events.length, 1);
  assert.equal(await readFile(target, 'utf8'), 'do not change');
  assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('oversized preexisting logs are bounded and unsafe restored fields are discarded', async t => {
  const path = join(await directory(t), 'security-audit.jsonl');
  await writeFile(path, 'x'.repeat(5000), { mode: 0o644 });
  const bounded = createAudit({ path, maxBytes: 1024 });
  assert.equal((await stat(path)).size, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  bounded.record(valid);
  await writeFile(path, JSON.stringify({ ...valid, time: 1, password: 'secret', sessionId: 'cookie-token' }) + '\npartial');
  const restored = createAudit({ path, maxBytes: 1024 });
  assert.equal(restored.list().events.length, 1);
  assert.equal(restored.list().events[0].sessionId, null);
  assert.deepEqual(Object.keys(restored.list().events[0]).sort(), fields);
  restored.record(valid);
  assert.equal(createAudit({ path, maxBytes: 1024 }).list().events.length, 2, 'new events must not join an interrupted JSON line');
});
