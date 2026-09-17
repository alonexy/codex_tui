import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanMode } from '../public/plan-mode.js';
import { questionAnswers } from '../public/question-card.js';

const setting = { model: 'current-model', effort: 'xhigh' };
const store = () => { const data = new Map(); return { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) }; };

test('mode changes only affect a new turn and preserve explicitly chosen model and effort', () => {
  const modes = new PlanMode(); modes.choose('one', 'plan');
  const override = { model: 'selected-model', effort: 'high' };
  const params = modes.params('one', setting, override);
  assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: { model: 'selected-model', reasoning_effort: 'high', developer_instructions: null } });
  assert.deepEqual(modes.params('one', setting, override, true), {});
  assert.deepEqual(modes.params('two', setting), {});
  assert.throws(() => modes.params('one', {}), /选择型号/);
  assert.equal(modes.params('one', setting).collaborationMode.settings.reasoning_effort, 'xhigh');
});

test('snapshot and desktop updates never erase unsent choices; unchanged snapshots do not revert receipt evidence', () => {
  const modes = new PlanMode();
  const settings = { one: { collaborationMode: { mode: 'default' } } };
  modes.snapshot(settings); modes.choose('one', 'plan');
  modes.begin('key', 'one', modes.params('one', setting)); modes.finish('key', true);
  modes.snapshot(settings);
  assert.equal(modes.known.get('one'), 'plan');
  assert.equal(modes.choices.has('one'), false);
  modes.choose('one', 'default');
  modes.observe('one', { mode: 'plan' });
  assert.equal(modes.choices.get('one'), 'default');
  modes.snapshot({}, true);
  assert.equal(modes.known.has('one'), false);
  assert.equal(modes.choices.get('one'), 'default');
});

test('failed or recovered submissions retain or settle the right mode; later desktop settings win', () => {
  const storage = store(), modes = new PlanMode(storage);
  modes.choose('one', 'plan'); modes.begin('failed', 'one', modes.params('one', setting)); modes.finish('failed', false);
  assert.equal(modes.choices.get('one'), 'plan');
  modes.begin('pending', 'one', modes.params('one', setting));
  const reloaded = new PlanMode(storage);
  assert.equal(reloaded.known.has('one'), false);
  reloaded.finish('pending', true);
  assert.equal(reloaded.known.get('one'), 'plan');
  assert.equal(reloaded.choices.has('one'), false);
  modes.begin('race', 'one', modes.params('one', setting));
  modes.observe('one', { mode: 'default' }); modes.finish('race', true);
  assert.equal(modes.known.get('one'), 'default');
});

test('current plan and model override are merged; inherited unknown mode is never guessed', () => {
  const modes = new PlanMode(); modes.observe('one', { mode: 'plan' });
  const override = { model: 'new-model', effort: 'medium' };
  assert.equal(modes.params('one', setting, override).collaborationMode.settings.model, 'new-model');
  assert.deepEqual(modes.params('unknown', setting, override), override);
  modes.observe('one', { mode: 'future' }); assert.equal(modes.known.get('one'), null);
});

test('question answers require every nonblank choice/custom value and preserve typed text', () => {
  const questions = [{ id: 'a' }, { id: 'secret', isSecret: true }], drafts = new Map();
  drafts.set('a', { choice: 'First', custom: false, text: '' });
  drafts.set('secret', { custom: true, text: ' ' });
  assert.equal(questionAnswers(questions, drafts), null);
  drafts.get('secret').text = ' typed secret ';
  assert.deepEqual(questionAnswers(questions, drafts), { answers: { a: { answers: ['First'] }, secret: { answers: [' typed secret '] } } });
  drafts.get('a').custom = true;
  assert.equal(questionAnswers(questions, drafts), null);
  assert.equal(questionAnswers([], drafts), null);
  assert.equal(JSON.stringify(questionAnswers([{ id: '__proto__' }], new Map([['__proto__', { choice: 'literal id' }]]))), '{"answers":{"__proto__":{"answers":["literal id"]}}}');
});

test('last-turn evidence displays a mode but never supplies collaborationMode to a model override', () => {
  const modes = new PlanMode();
  modes.acceptRead('one', { threadId: 'one', source: 'last-turn', collaborationMode: { mode: 'plan' } }, modes.token('one'));
  assert.deepEqual(modes.display('one'), { mode: 'plan', source: 'last-turn' });
  const override = { model: 'chosen', effort: 'high' };
  assert.deepEqual(modes.params('one', setting, override), override);
  modes.choose('one', 'default');
  assert.equal(modes.params('one', setting, override).collaborationMode.mode, 'default');
});

test('late mode reads cannot replace newer live settings or bridge generations', () => {
  const modes = new PlanMode(), token = modes.token('one');
  modes.observe('one', { mode: 'default' });
  modes.acceptRead('one', { threadId: 'one', source: 'runtime', collaborationMode: { mode: 'plan' } }, token);
  assert.equal(modes.known.get('one'), 'default');
  const token2 = modes.token('one'); modes.snapshot({}, true);
  modes.acceptRead('one', { threadId: 'one', source: 'last-turn', collaborationMode: { mode: 'plan' } }, token2);
  assert.deepEqual(modes.display('one'), {});
});

test('current turn evidence is authoritative only while its turn identity still matches', () => {
  const modes = new PlanMode();
  const result = { threadId: 'one', source: 'current-turn', turnId: 'turn-1', collaborationMode: { mode: 'plan' } };
  modes.acceptRead('one', result, modes.token('one'), 'turn-2');
  assert.equal(modes.known.has('one'), false);
  assert.equal(modes.display('one').source, 'last-turn');
  modes.acceptRead('one', result, modes.token('one'), 'turn-1');
  assert.equal(modes.known.get('one'), 'plan');
  assert.equal(modes.display('one').source, 'current-turn');
  modes.active({});
  assert.deepEqual(modes.display('one'), { mode: 'plan', source: 'last-turn' });
  const override = { model: 'chosen', effort: 'high' };
  assert.deepEqual(modes.params('one', setting, override), override);
  modes.acceptRead('one', { ...result, turnId: 'turn-2', collaborationMode: { mode: 'default' } }, modes.token('one'), 'turn-2');
  assert.equal(modes.known.get('one'), 'default');
  modes.observe('one', { mode: 'plan' }); modes.active({});
  assert.deepEqual(modes.display('one'), { mode: 'plan', source: 'runtime' });
  modes.observe('one', null);
  modes.acceptRead('one', { ...result, source: 'last-turn' }, modes.token('one'));
  assert.deepEqual(modes.display('one'), { mode: 'plan', source: 'last-turn' });
});
