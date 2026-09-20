import test from 'node:test';
import assert from 'node:assert/strict';
import { questionsForItem, parseQuestionReply, serializeQuestionReply, replyForItem, collectAsyncQuestions } from '../public/async-questions.js';
import { questionAnswers } from '../public/question-card.js';

const idFor = (itemId = 'source', index = 0) => JSON.stringify(['request_user_input_async', itemId, index]);
const source = (id = 'source', titles = ['选择方式']) => ({ id, type: 'agentMessage',
  questions: titles.map(title => ({ title, options: ['自动', '手动'] })) });
const reply = (itemId = 'source', answer = '手动', index = 0) => ({ questionItemId: idFor(itemId, index), question: '选择方式', answer });
const wrap = value => `<send_user_message_question_reply>${JSON.stringify(value)}</send_user_message_question_reply>`;
const user = (value, id = 'reply') => ({ id, type: 'userMessage', content: [{ type: 'text', text: wrap(value) }] });
const thread = (...turns) => ({ turns: turns.map(([id, items]) => ({ id, items })) });

test('native agent questions retain their source identity and original question index', () => {
  assert.deepEqual(questionsForItem(source()), [{ id: idFor(), header: '问题 1', question: '选择方式',
    options: [{ label: '自动', description: '' }, { label: '手动', description: '' }] }]);
  const item = source();
  item.questions.unshift({ title: 'invalid', options: [{ label: 'wrong shape' }] });
  assert.equal(questionsForItem(item)[0].id, idFor('source', 1));
  assert.deepEqual(questionsForItem({ ...source(), type: 'userMessage' }), []);
  assert.deepEqual(questionsForItem({ type: 'agentMessage', text: '1. choose\n2. other' }), []);
  assert.deepEqual(questionsForItem({ ...source(), id: '' }), []);
  assert.deepEqual(questionsForItem({ ...source(), questions: [{ title: 'free text', options: [] }] })[0].options, []);
});

test('strict protocol accepts a single object or a nonempty array', () => {
  assert.deepEqual(parseQuestionReply(wrap(reply())), [reply()]);
  assert.deepEqual(parseQuestionReply(`\n ${wrap([reply(), reply('second')])}\n`), [reply(), reply('second')]);
});

test('missing or null options support pure freeform questions and malformed options are rejected', () => {
  for (const nativeQuestion of [{ title: '补充说明' }, { title: '补充说明', options: null }]) {
    const questions = questionsForItem({ ...source(), questions: [nativeQuestion] });
    assert.deepEqual(questions, [{ id: idFor(), header: '问题 1', question: '补充说明', options: [] }]);
    const result = questionAnswers(questions, new Map([[idFor(), { custom: true, text: '自由回答' }]]));
    assert.deepEqual(parseQuestionReply(serializeQuestionReply(questions, result)), [
      { questionItemId: idFor(), question: '补充说明', answer: '自由回答' }
    ]);
  }
  for (const options of ['choice', {}, false, 0]) {
    assert.deepEqual(questionsForItem({ ...source(), questions: [{ title: '补充说明', options }] }), []);
  }
});

test('malformed or mixed protocol returns null and leaves the original message intact', () => {
  const texts = ['plain text', `preface ${wrap(reply())}`, `${wrap(reply())} trailing`, `${wrap(reply())}${wrap(reply())}`,
    '<send_user_message_question_reply>{bad json}</send_user_message_question_reply>', wrap([]), wrap(null),
    wrap({ ...reply(), answer: '  ' }), wrap({ ...reply(), question: '' }), wrap({ ...reply(), extra: true }),
    wrap([reply(), { ...reply(), answer: 42 }])];
  for (const text of texts) {
    const item = { type: 'userMessage', content: [{ type: 'text', text }] };
    assert.equal(parseQuestionReply(text), null, text);
    assert.equal(replyForItem(item), null, text);
    assert.equal(item.content[0].text, text);
  }
});

test('reply IDs require the exact native tuple representation', () => {
  for (const questionItemId of ['source', JSON.stringify(['other', 'source', 0]), JSON.stringify(['request_user_input_async', '', 0]),
    JSON.stringify(['request_user_input_async', 'source', -1]), JSON.stringify(['request_user_input_async', 'source', 0.5]),
    JSON.stringify(['request_user_input_async', 'source', '0']), JSON.stringify(['request_user_input_async', 'source', 0, 'extra']),
    '["request_user_input_async", "source", 0]']) {
    assert.equal(parseQuestionReply(wrap({ ...reply(), questionItemId })), null, questionItemId);
  }
});

test('only accepted steering input is an answer', () => {
  for (const status of ['pending', 'rejected', undefined]) {
    assert.equal(replyForItem({ type: 'steeringUserMessage', status, input: user(reply()).content }), null);
  }
  assert.deepEqual(replyForItem({ type: 'steeringUserMessage', status: 'accepted', input: user(reply()).content }), [reply()]);
  assert.equal(replyForItem({ type: 'agentMessage', content: user(reply()).content }), null);
});

test('multiple content parts must all be complete protocol text', () => {
  const item = user(reply());
  item.content.push(...user(reply('second')).content);
  assert.deepEqual(replyForItem(item), [reply(), reply('second')]);
  for (const part of [{ type: 'text', text: 'also do this' }, { type: 'image', url: 'attachment' }]) {
    assert.equal(replyForItem({ ...item, content: [...item.content, part] }), null);
  }
  assert.equal(replyForItem({ ...item, content: [] }), null);
});

test('selection and custom answers round trip through the question card shape', () => {
  const questions = questionsForItem(source('source', ['选择方式', '补充说明']));
  const custom = '自填 "引号"\n换行 </send_user_message_question_reply> 与中文';
  const drafts = new Map([[questions[0].id, { choice: '手动' }], [questions[1].id, { custom: true, text: custom }]]);
  const result = questionAnswers(questions, drafts);
  assert.deepEqual(parseQuestionReply(serializeQuestionReply(questions, result)), [reply(),
    { questionItemId: idFor('source', 1), question: '补充说明', answer: custom }]);
  assert.equal(serializeQuestionReply(questions, {}), null);
  assert.equal(serializeQuestionReply([], result), null);
  result.answers[questions[0].id].answers.push('another');
  assert.equal(serializeQuestionReply(questions, result), null);
});

test('same wording from different IDs remains separately pending', () => {
  const collected = collectAsyncQuestions(thread(['turn', [source('first'), source('second'), user(reply('first'))]]));
  assert.equal(collected.questions.size, 2);
  assert.deepEqual([...collected.answered.keys()], [idFor('first')]);
  assert.deepEqual(collected.pending.map(group => group.itemId), ['second']);
});

test('unloaded sources do not create answered associations or eliminate pending questions', () => {
  const item = user(reply('missing'));
  const collected = collectAsyncQuestions(thread(['turn', [source(), item]]));
  assert.deepEqual(replyForItem(item), [reply('missing')]);
  assert.equal(collected.answered.size, 0);
  assert.equal(collected.pending.length, 1);
});

test('all loaded turns contribute associations, while pending uses active or latest turn only', () => {
  const history = thread(['old', [source('old-source')]], ['current', [source('new-source'), user(reply('old-source'))]]);
  const idle = collectAsyncQuestions(history);
  assert.equal(idle.questions.size, 2);
  assert.equal(idle.answered.size, 1);
  assert.deepEqual(idle.pending.map(group => group.turnId), ['current']);
  assert.deepEqual(collectAsyncQuestions(history, 'old').pending, []);
  assert.deepEqual(collectAsyncQuestions(history, 'unloaded-active').pending, []);
  assert.deepEqual(collectAsyncQuestions(thread(['old', [source()]], ['latest', []])).pending, []);
  assert.deepEqual(collectAsyncQuestions({}).pending, []);
});

test('repeated IDs and accepted reply echoes converge without duplicate pending groups', () => {
  const item = source('source', ['选择方式', '选择方式']);
  const history = thread(['turn', [item, item, user(reply(), 'echo-1'), user(reply(), 'echo-2')]]);
  const before = structuredClone(history);
  const collected = collectAsyncQuestions(history, 'turn');
  assert.equal(collected.questions.size, 2);
  assert.equal(collected.answered.size, 1);
  assert.deepEqual(collected.pending[0].questions.map(question => question.id), [idFor('source', 1)]);
  assert.equal(collected.pending.length, 1);
  assert.deepEqual(history, before);
});

test('pending and rejected steering echoes keep their question pending', () => {
  for (const status of ['pending', 'rejected', 'accepted']) {
    const item = { id: 'steer', type: 'steeringUserMessage', status, input: user(reply()).content };
    const collected = collectAsyncQuestions(thread(['turn', [source(), item]]));
    assert.equal(collected.pending.length, status === 'accepted' ? 0 : 1);
  }
});
