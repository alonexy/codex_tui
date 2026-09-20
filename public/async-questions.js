import { turnItems } from './timeline.js';

const replyStart = '<send_user_message_question_reply>';
const replyEnd = '</send_user_message_question_reply>';
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

function validQuestionId(id) {
  if (!nonempty(id)) return false;
  try {
    const parts = JSON.parse(id);
    return Array.isArray(parts) && parts.length === 3 && parts[0] === 'request_user_input_async' &&
      nonempty(parts[1]) && Number.isSafeInteger(parts[2]) && parts[2] >= 0 && JSON.stringify(parts) === id;
  } catch { return false; }
}

export function questionsForItem(item) {
  if (item?.type !== 'agentMessage' || !nonempty(item.id) || !Array.isArray(item.questions)) return [];
  return item.questions.flatMap((question, index) => {
    const options = question?.options ?? [];
    if (!nonempty(question?.title) || !Array.isArray(options) || !options.every(nonempty)) return [];
    return [{ id: JSON.stringify(['request_user_input_async', item.id, index]), header: `问题 ${index + 1}`,
      question: question.title, options: options.map(label => ({ label, description: '' })) }];
  });
}

export function parseQuestionReply(text) {
  if (typeof text !== 'string') return null;
  const wrapped = text.trim();
  if (!wrapped.startsWith(replyStart) || !wrapped.endsWith(replyEnd)) return null;
  try {
    const value = JSON.parse(wrapped.slice(replyStart.length, -replyEnd.length));
    const replies = Array.isArray(value) ? value : [value];
    if (!replies.length || !replies.every(reply => reply && typeof reply === 'object' && !Array.isArray(reply) &&
      Object.keys(reply).length === 3 && validQuestionId(reply.questionItemId) && nonempty(reply.question) && nonempty(reply.answer))) return null;
    return replies;
  } catch { return null; }
}

export function serializeQuestionReply(questions, result) {
  if (!Array.isArray(questions) || !questions.length) return null;
  const replies = [];
  for (const question of questions) {
    const answers = result?.answers?.[question?.id]?.answers;
    if (!validQuestionId(question?.id) || !nonempty(question.question) || !Array.isArray(answers) ||
      answers.length !== 1 || !nonempty(answers[0])) return null;
    replies.push({ questionItemId: question.id, question: question.question, answer: answers[0] });
  }
  return `${replyStart}${JSON.stringify(replies)}${replyEnd}`;
}

export function replyForItem(item) {
  const content = item?.type === 'userMessage' ? item.content
    : item?.type === 'steeringUserMessage' && item.status === 'accepted' ? item.input : null;
  if (!Array.isArray(content) || !content.length) return null;
  const replies = [];
  for (const part of content) {
    const parsed = part?.type === 'text' ? parseQuestionReply(part.text) : null;
    if (!parsed) return null;
    replies.push(...parsed);
  }
  return replies;
}

export function collectAsyncQuestions(thread, activeTurnId) {
  const turns = thread?.turns ?? [];
  const questions = new Map(), answered = new Map(), sources = new Map(), replies = [];
  for (const turn of turns) {
    for (const item of turnItems(turn)) {
      for (const question of questionsForItem(item)) {
        questions.set(question.id, question);
        sources.set(question.id, { itemId: item.id, turnId: turn.id });
      }
      replies.push(...(replyForItem(item) ?? []));
    }
  }
  for (const reply of replies) {
    if (questions.has(reply.questionItemId)) answered.set(reply.questionItemId, reply);
  }
  const pendingTurnId = activeTurnId ?? turns.at(-1)?.id;
  const pending = new Map();
  for (const [id, question] of questions) {
    const source = sources.get(id);
    if (source.turnId !== pendingTurnId || answered.has(id)) continue;
    if (!pending.has(source.itemId)) pending.set(source.itemId, { ...source, questions: [] });
    pending.get(source.itemId).questions.push(question);
  }
  return { questions, answered, pending: [...pending.values()] };
}
