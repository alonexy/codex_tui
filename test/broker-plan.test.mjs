import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.mjs';

function fixture() {
  const upstream = [];
  const broker = new Broker(message => upstream.push(message));
  broker.ready = true;
  return { broker, upstream };
}

const request = {
  id: 'questions', method: 'item/tool/requestUserInput',
  params: { threadId: 'task', questions: [{ id: 'scope' }, { id: 'approach' }] },
};
const response = { answers: { scope: { answers: ['Entire project'] }, approach: { answers: ['Option A', 'Additional detail'] } } };

test('native thread settings survive retention gaps and preserve unknown collaboration modes', () => {
  const { broker } = fixture();
  assert.deepEqual(broker.snapshot().threadSettings, {});
  assert.equal(broker.snapshot().capabilities.threadSettings, true);
  const metadata = { model: 'model-a', effort: 'high', collaborationMode: { mode: 'plan', settings: { model: 'model-a', reasoning_effort: 'high' } } };
  const instructions = 'private-developer-instructions'.repeat(1000);
  const plan = {
    ...metadata, unknownSetting: instructions,
    collaborationMode: { ...metadata.collaborationMode, unknownModeField: instructions,
      settings: { ...metadata.collaborationMode.settings, developer_instructions: instructions, unknownNestedField: instructions } },
  };
  broker.receive({ method: 'thread/settings/updated', params: { threadId: 'task', threadSettings: plan } });
  assert.deepEqual(broker.snapshot().events[0].params.threadSettings, plan);
  const current = broker.snapshot(broker.cursor);
  assert.deepEqual(current.threadSettings.task, metadata);
  assert.equal(JSON.stringify(current).includes(instructions), false);
  broker.receive({ method: 'thread/settings/updated', params: { threadId: 'unknown', threadSettings: { model: 'model-b' } } });
  for (let i = 0; i < 1001; i++) broker.record('delta', { delta: 'x' });
  const snapshot = broker.snapshot();
  assert.equal(snapshot.reset, true);
  assert.equal(snapshot.events.some(event => event.method === 'thread/settings/updated'), false);
  assert.deepEqual(snapshot.threadSettings, { task: metadata, unknown: { model: 'model-b' } });
  assert.equal(JSON.stringify(snapshot).includes(instructions), false);
  broker.receive({ method: 'thread/settings/updated', params: { threadId: 'task', threadSettings: { model: 'model-c', collaborationMode: null } } });
  assert.deepEqual(broker.snapshot(broker.cursor).threadSettings.task, { model: 'model-c', collaborationMode: null });
});

test('turn/start forwards complete native collaboration mode without synthesizing observed settings', () => {
  const { broker, upstream } = fixture();
  const params = {
    threadId: 'task', input: [{ type: 'text', text: 'Make a plan' }],
    model: 'selected-model', effort: 'high',
    collaborationMode: { mode: 'plan', settings: { model: 'selected-model', reasoning_effort: 'high', developer_instructions: null } },
  };
  const receipt = broker.submit('plan-turn-001', 'turn/start', params);
  assert.equal(broker.submit('plan-turn-001', 'turn/start', params), receipt);
  assert.equal(upstream.length, 1);
  assert.deepEqual(upstream[0].params, params);
  broker.receive({ id: upstream[0].id, result: { turn: { id: 'turn' } } });
  assert.deepEqual(broker.snapshot().threadSettings, {});
});

test('invalid question responses preserve the pending request and never go upstream', () => {
  const invalid = [
    undefined, {}, { answers: [] }, { answers: 'text' }, { answers: {} },
    { answers: { scope: { answers: ['yes'] } } },
    { answers: { ...response.answers, unknown: { answers: ['yes'] } } },
    { answers: { ...response.answers, scope: ['yes'] } },
    { answers: { ...response.answers, scope: { answers: 'yes' } } },
    { answers: { ...response.answers, scope: { answers: [] } } },
    { answers: { ...response.answers, scope: { answers: [''] } } },
    { answers: { ...response.answers, scope: { answers: ['  \n '] } } },
    { answers: { ...response.answers, scope: { answers: ['yes', 1] } } },
  ];
  const { broker, upstream } = fixture();
  broker.receive(request);
  for (const result of invalid) {
    assert.throws(() => broker.answer(request.id, result));
    assert.deepEqual(broker.snapshot().approvals, [request]);
    assert.equal(upstream.length, 0);
  }
  broker.answer(request.id, response);
  assert.deepEqual(upstream, [{ id: request.id, result: response }]);
  assert.deepEqual(broker.snapshot().approvals, []);
  assert.deepEqual(broker.snapshot(1).events.map(({ method, params }) => ({ method, params })), [
    { method: 'bridge/approvalAnswered', params: { id: request.id } },
  ]);
  assert.throws(() => broker.answer(request.id, response), /已处理/);
  assert.equal(upstream.length, 1);
});

test('desktop and server resolution prevent a second phone answer', () => {
  for (const source of ['phone', 'desktop', 'server']) {
    const { broker, upstream } = fixture();
    broker.receive(request);
    if (source === 'server') broker.receive({ method: 'serverRequest/resolved', params: { requestId: request.id } });
    else if (source === 'desktop') broker.fromDesktop({ id: request.id, result: response });
    else {
      broker.answer(request.id, response);
      broker.fromDesktop({ id: request.id, result: response });
    }
    assert.throws(() => broker.answer(request.id, response), /已处理/);
    assert.equal(upstream.length, source === 'server' ? 0 : 1);
    assert.deepEqual(broker.snapshot().approvals, []);
  }
});

test('malformed native questions cannot authorize arbitrary answer IDs', () => {
  for (const questions of [undefined, [], [{ id: 'scope' }, { id: 'scope' }], [{}]]) {
    const { broker, upstream } = fixture();
    broker.receive({ ...request, params: { questions } });
    assert.throws(() => broker.answer(request.id, response));
    assert.equal(broker.snapshot().approvals.length, 1);
    assert.equal(upstream.length, 0);
  }
});
