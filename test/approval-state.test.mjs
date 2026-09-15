import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalState, approvalLabel, isAnswerable } from '../public/approval-state.js';

const request = (id, threadId, question = false) => ({ id, method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: { threadId } });
const status = (threadId, activeFlags) => ({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags } } });
const snapshot = (state, approvals = [], events = [], extra = {}) => state.snapshot({ ready: true, approvals, events, ...extra });

test('global counts stay assigned to threads and native waits supplement known requests without double counting', () => {
  const state = new ApprovalState();
  const command = request('command', 'one'), answer = request('answer', 'one', true);
  snapshot(state, [command, command, answer, request('other', 'two')], [status('one', ['waitingOnApproval', 'waitingOnUserInput']), status('unloaded', ['waitingOnApproval'])]);
  assert.equal(state.entries().size, 3);
  assert.equal(state.get('one').requests.length, 2);
  assert.deepEqual(state.get('one').desktop, []);
  assert.equal(approvalLabel(state.get('one')), '1 项待批准 · 1 项待回答');
  assert.match(approvalLabel(state.get('unloaded')), /需在桌面处理/);
  assert.equal(isAnswerable({ method: 'item/permissions/requestApproval' }), false);
});

test('desktop resolution and authoritative snapshots clear associated native waits', () => {
  const state = new ApprovalState();
  snapshot(state, [request(7, 'one')], [status('one', ['waitingOnApproval'])]);
  snapshot(state, [], [{ method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 7 } }]);
  assert.equal(state.get('one'), undefined);
  snapshot(state, [request('input', 'one', true)], [status('one', ['waitingOnUserInput'])]);
  snapshot(state);
  assert.equal(state.get('one'), undefined);
  snapshot(state, [], [status('two', ['waitingOnApproval'])]);
  snapshot(state, [], [status('two', [])]);
  assert.equal(state.entries().size, 0);
});

test('disconnect retains unresolved requests as uncertain and reconnection replaces them', () => {
  const state = new ApprovalState();
  snapshot(state, [request('one', 'one')], [status('desktop', ['waitingOnApproval'])]);
  state.snapshot({ ready: false, approvals: [], events: [] });
  assert.equal(state.get('one').requests.length, 1);
  assert.match(approvalLabel(state.get('one')), /待核对/);
  assert.match(approvalLabel(state.get('desktop')), /待核对/);
  snapshot(state);
  assert.equal(state.get('one'), undefined);
  assert.equal(state.get('desktop').uncertain, true);
  state.thread('desktop', { type: 'idle' });
  assert.equal(state.entries().size, 0);
});

test('a new native wait after a resolved request survives, while reverse event order clears it', () => {
  for (const newWaitLast of [true, false]) {
    const state = new ApprovalState();
    snapshot(state, [request('old', 'one')], [status('one', ['waitingOnApproval'])]);
    const resolved = { method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'old' } };
    const waiting = status('one', ['waitingOnApproval']);
    snapshot(state, [], newWaitLast ? [resolved, waiting] : [waiting, resolved]);
    if (newWaitLast) assert.match(approvalLabel(state.get('one')), /需在桌面处理/);
    else assert.equal(state.get('one'), undefined);
  }
});

test('replayed events after a slow or abandoned history read do not resurrect resolved waits', () => {
  const state = new ApprovalState();
  snapshot(state, [request('old', 'one')], [status('one', ['waitingOnApproval'])], { cursor: 10 });
  const events = [status('one', ['waitingOnApproval']), { method: 'serverRequest/resolved', params: { threadId: 'one', requestId: 'old' } }];
  snapshot(state, [], events, { cursor: 11 });
  snapshot(state, [], events, { cursor: 11 });
  assert.equal(state.get('one'), undefined);
});

test('reset and bridge changes invalidate old read results; newer status events beat late list or resume', () => {
  const state = new ApprovalState();
  snapshot(state, [], [status('one', ['waitingOnApproval'])]);
  const oldRead = state.token();
  snapshot(state, [], [status('one', [])]);
  state.thread('one', { type: 'active', activeFlags: ['waitingOnApproval'] }, oldRead);
  assert.equal(state.get('one'), undefined);
  const oldBridge = state.token();
  state.snapshot({ ready: true, approvals: [], events: [], reset: true });
  state.thread('one', { type: 'active', activeFlags: ['waitingOnApproval'] }, oldBridge);
  assert.equal(state.get('one'), undefined);
  snapshot(state, [request('old', 'one')], [status('desktop', ['waitingOnApproval'])]);
  state.snapshot({ ready: true, approvals: [], events: [] }, true);
  assert.equal(state.get('one'), undefined);
  assert.equal(state.get('desktop').uncertain, true);
  state.thread('desktop', { type: 'notLoaded' });
  assert.equal(state.get('desktop').uncertain, true);
  state.thread('desktop', { type: 'idle' });
  assert.equal(state.entries().size, 0);
});
