import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { HistoryPages } from '../public/history-pages.js';
import { Timeline, turnItems, isProcessItem, processAction, operationFailed, processSummary } from '../public/timeline.js';
import { DeliveryState, deliveryLabel } from '../public/delivery-state.js';
import { taskPreferences } from '../public/task-preferences.js';
import { ApprovalState, approvalLabel, isAnswerable } from '../public/approval-state.js';
import { formatBytes } from '../public/attachment-policy.js';

function composer(storage = { getItem() { return null; }, setItem() {} }, session = { removeItem() {}, getItem() { return null; }, setItem() {} }) {
  const elements = new Map();
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.className = '';
      this.value = ''; this.style = {}; this.hidden = false; this.open = false; this.scrollHeight = 44;
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    set id(id) { this._id = id; elements.set(id, this); }
    get id() { return this._id; }
    get options() { return this.children; }
    get textContent() { return (this.text ?? '') + this.children.map(child => child.textContent).join(''); }
    set textContent(text) { this.text = text; this.children = []; }
    setAttribute(name, value) { this[name] = value; }
    getAttribute(name) { return this[name]; }
    append(...nodes) { this.children.push(...nodes); }
    insertBefore(node, reference) {
      node.parentNode?.removeChild(node);
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index, 0, node); node.parentNode = this;
    }
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; }
    replaceChildren(...nodes) { this.text = ''; this.children = nodes; }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
        : selector.startsWith('[data-') ? Object.hasOwn(node.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()))
          : node.tagName === selector.toUpperCase();
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    addEventListener() {}
    focus() {} blur() {} scrollIntoView() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.onclose?.(); }
    click() { if (!this.disabled) return this.onclick?.(); }
  }
  const get = id => {
    if (!elements.has(id)) { const element = new Element(); element.id = id; }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: get, addEventListener() {}, createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element(), { textContent: text }), body: new Element('body') },
    window: { addEventListener() {} },
    sessionStorage: session,
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    ResizeObserver: class { observe() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() {},
    composerMedia: () => ({ render() {}, reading: () => false, hasImages: () => false, input: async () => [], capture: () => ({ threadId: 'thread-1', items: [] }), clear() {} }),
    HistoryPages,
    Timeline, turnItems, isProcessItem, processAction, operationFailed, processSummary,
    DeliveryState, deliveryLabel, devicePanel: () => {},
    ApprovalState, approvalLabel, isAnswerable,
    formatBytes,
    taskPreferences: () => taskPreferences(storage),
    goalPanel: () => ({ open: async () => {}, event() {} }),
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\n/gm, '').split("window.addEventListener('pagehide'")[0], context);
  const run = code => vm.runInContext(code, context);
  run("connected = true; threadId = 'thread-1';");
  return { get, run };
}

test('an explicitly rejected attachment submission clears uncertainty without polling or replay', async () => {
  const { run } = composer();
  run(`globalThis.crypto = { getRandomValues: bytes => bytes };
    globalThis.calls = []; api = async (path, body) => { calls.push({ path, body }); throw Object.assign(Error('attachment rejected'), { submission: 'rejected' }); };`);
  await assert.rejects(run(`command('turn/start', { threadId, input: [{ type: 'mention', name: 'a.txt', path: '/unregistered/a.txt' }] })`), /attachment rejected/);
  assert.equal(run('uncertainSubmission'), false);
  assert.equal(run('delivery.pending'), null);
  assert.equal(run('calls.length'), 1);
});

test('archive confirmation, failure, notification and restored selection preserve drafts and favorites', async () => {
  const { get, run } = composer();
  run(`taskArchive = true; threads.set(threadId, { id: threadId, name: '当前' }); preferences.toggleFavorite(threads.get(threadId));
    globalThis.calls = []; command = async (method, params) => { calls.push({ method, params }); throw Error('archive rejected'); };
    openArchive(threads.get(threadId), false);`);
  get('message').value = '保留草稿';
  get('archive-cancel').onclick();
  assert.equal(run('calls.length'), 0);
  run('openArchive(threads.get(threadId), false)');
  await get('archive-confirm').onclick();
  assert.equal(run('threadId'), 'thread-1');
  assert.equal(run("preferences.isFavorite('thread-1')"), true);
  assert.equal(get('message').value, '保留草稿');
  run(`command = async () => { applyArchive('thread-1', true); return {}; }`);
  await get('archive-confirm').onclick();
  assert.equal(run('threadId'), '');
  assert.equal(run("drafts.get('thread-1')"), '保留草稿');
  assert.equal(run("preferences.isFavorite('thread-1')"), false);
  await assert.rejects(run("select('thread-1')"), /已归档/);
  run(`applyArchive('thread-1', false, { id: 'thread-1', name: '当前' }); command = async () => ({ thread: { id: 'thread-1', turns: [] } });`);
  await run("select('thread-1')");
  assert.equal(get('message').value, '保留草稿');
});

test('unknown archive receipts recover without replay and archived lists exclude active favorites', async () => {
  const { get, run } = composer();
  run(`taskArchive = true; threads.set('thread-1', { id: 'thread-1', name: '当前' });
    delivery.begin('archive-key', 'thread/archive', 'thread-1'); uncertainSubmission = true;
    globalThis.calls = []; api = async path => { calls.push(path); return { status: 'completed', result: {} }; };
    command = async () => { throw Error('must not replay'); };`);
  get('message').value = '未知时保留';
  await run('recoverSubmission()');
  assert.equal(run('calls.length'), 1);
  assert.equal(run('delivery.pending'), null);
  assert.equal(run('threadId'), '');
  assert.equal(run("drafts.get('thread-1')"), '未知时保留');
  run(`preferences.toggleFavorite({ id: 'favorite', name: '收藏' }); archivedView = true;
    command = async (method, params) => { calls.push(params); return { data: [{ id: 'archived', name: '归档' }], nextCursor: 'page-2' }; };
    api = async () => ({ projects: [], assignments: {} });`);
  await run('list()');
  assert.equal(run('calls.at(-1).archived'), true);
  assert.equal(get('task-list').querySelectorAll('.task-card').length, 1);
  assert.equal(get('task-list').querySelectorAll('.task-card')[0].disabled, true);
  await run('list(true)');
  assert.equal(run('calls.at(-1).cursor'), 'page-2');
});

test('archive notification invalidates an in-flight selection and old bridges explain disabled controls', async () => {
  const { get, run } = composer();
  run(`taskArchive = true; archiveStates.set('other', false); command = async () => new Promise(resolve => globalThis.resolveSelection = resolve);`);
  const selection = run("select('other')");
  run(`applyArchive('other', true); resolveSelection({ thread: { id: 'other', turns: [] } });`);
  await selection;
  assert.equal(run('threadId'), 'thread-1');
  run(`taskArchive = false; threads.set('active-other', { id: 'active-other' }); renderTasks(); updateControls();`);
  assert.equal(get('task-list').querySelectorAll('[data-archive-thread]')[0].disabled, true);
  assert.match(get('archive-support').textContent, /重启/);
});

test('a reconnect rechecks cached active selection and never resumes a now archived saved task', async () => {
  const session = { getItem: key => key === 'codex-thread' ? 'old-task' : null, setItem() {}, removeItem() {} };
  const { run } = composer(undefined, session);
  run(`threadId = 'old-task'; taskArchive = true; archiveStates.set('old-task', false); tasksLoaded = true; bridgeId = 'old';
    globalThis.calls = []; api = async path => path.startsWith('/api/state')
      ? { ready: true, bridgeId: 'new', capabilities: { taskArchive: true }, active: {}, approvals: [], cursor: 10, reset: true, events: [] }
      : { projects: [], assignments: {} };
    command = async (method, params) => { calls.push({ method, params }); if (method !== 'thread/list') throw Error('must not resume archived task'); return { data: [], nextCursor: null }; };`);
  await run('poll()');
  assert.equal(run("calls.every(call => call.method === 'thread/list')"), true);
  assert.equal(run("archiveStates.has('old-task')"), false);
  assert.equal(run('threadId'), '');
});

test('a lost archive receipt can be manually cleared only after explicit status confirmation without replay', () => {
  const { get, run } = composer();
  run(`delivery.begin('archive-lost', 'thread/archive', 'thread-1'); uncertainSubmission = true;
    globalThis.calls = []; command = async (...args) => calls.push(args);
    globalThis.confirm = message => { globalThis.prompt = message; return false; }; updateControls();`);
  get('message').value = '保留草稿';
  assert.match(get('reconcile').textContent, /归档状态/);
  get('reconcile').onclick();
  assert.equal(run('uncertainSubmission'), true);
  assert.match(run('prompt'), /桌面或刷新已归档/);
  run('confirm = () => true');
  get('reconcile').onclick();
  assert.equal(run('delivery.pending'), null);
  assert.equal(run('calls.length'), 0);
  assert.equal(get('message').value, '保留草稿');
});

test('each turn retains one disclosure through completion, refresh and thread switches', () => {
  const { get, run } = composer();
  run(`globalThis.sample = { id: 'thread-1', turns: [{ id: 'turn', status: 'inProgress', items: [
    { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '请检查' }] },
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '正在检查' },
    { id: 'tool', type: 'commandExecution', command: 'npm test', status: 'inProgress', aggregatedOutput: 'testing' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '最终回复' },
    { id: 'unknown', type: 'agentMessage', phase: null, text: '兼容正文' },
    { id: 'question', type: 'agentMessage', phase: 'commentary', questions: [{ id: 'q' }], text: '请选择方案' }
  ] }] }; renderHistory(sample);`);
  const section = get('history').children[0];
  const process = section.querySelector('.turn-process');
  assert.equal(section.querySelectorAll('.turn-process').length, 1);
  assert.equal(process.open, false);
  assert.equal(process.querySelectorAll('.agentMessage').length, 1);
  assert.equal(section.children.filter(node => node.className.includes('agentMessage')).length, 3);
  const tool = process.querySelector('.tool-record');
  assert.equal(tool.querySelector('pre'), null, 'raw output is lazy');
  process.open = true; tool.open = true; tool.ontoggle();
  run(`sample.turns[0].status = 'completed'; sample.turns[0].durationMs = 2000;
    sample.turns[0].items[2].aggregatedOutput = 'done'; renderHistory(sample);`);
  assert.equal(get('history').children[0], section);
  assert.equal(section.querySelector('.turn-process'), process);
  assert.equal(process.open, true);
  assert.equal(process.querySelector('.tool-record'), tool);
  assert.equal(tool.open, true);
  assert.match(tool.querySelector('pre').textContent, /done/);
  assert.match(process.children[0].textContent, /已完成 · 用时 2 秒/);
  run(`renderHistory({ ...sample, id: 'thread-2' });`);
  assert.equal(get('history').querySelector('.turn-process').open, false);
  run('renderHistory(sample)');
  assert.equal(get('history').querySelector('.turn-process'), process);
  assert.equal(process.open, true);
});

test('composer swaps send for stop and shows inline loading through the turn lifecycle', () => {
  const { get, run } = composer();
  run('updateControls()');
  assert.equal(get('send').hidden, false);
  assert.equal(get('turn-loading').hidden, true);
  run('sending = true; updateControls()');
  assert.equal(get('turn-loading-text').textContent, '正在发送…');
  run("sending = false; active[threadId] = 'turn-1'; updateControls()");
  assert.equal(get('send').hidden, false);
  assert.equal(get('stop').disabled, false);
  assert.equal(get('turn-loading').hidden, false);
  get('message').value = '/status';
  run('updateControls()');
  assert.equal(get('send').hidden, false, 'slash commands remain executable during a turn');
  assert.equal(get('send')['aria-label'], '执行命令');
  get('message').value = '';
  run('delete active[threadId]; updateControls()');
  assert.equal(get('send').hidden, false);
  assert.equal(get('stop').hidden, true);
  assert.equal(get('turn-loading').hidden, true);
});

test('IME composition never submits a message', async () => {
  const { get, run } = composer();
  get('message').value = '中文候选';
  run('composingText = true; command = () => { throw Error("must not send"); };');
  await run('send(false)');
  assert.equal(get('message').value, '中文候选');
});

test('command toggle opens and closes without focusing the message input', () => {
  const { get, run } = composer();
  let inputFocused = true;
  get('message').value = '保留草稿';
  get('message').focus = () => { inputFocused = true; };
  get('message').blur = () => { inputFocused = false; };
  get('slash-toggle').focus = () => {};
  get('slash-menu').hidden = true;
  run("showSlashMenu = () => { $('slash-menu').hidden = false; $('slash-toggle').setAttribute('aria-expanded', 'true'); };");
  get('slash-toggle').onclick();
  assert.equal(inputFocused, false, 'opening commands must dismiss the input keyboard');
  assert.equal(get('slash-menu').hidden, false);
  assert.equal(get('message').value, '保留草稿');
  get('slash-toggle').onclick();
  assert.equal(get('slash-menu').hidden, true);
  assert.equal(inputFocused, false);
});

test('extended commands use native RPC and old bridges reject without model turns', async () => {
  const { get, run } = composer();
  run('globalThis.calls = []; command = async (method, params) => { calls.push({ method, params }); return {}; };');
  await assert.rejects(run("runSlash('/compact')"), /驻留桥接/);
  assert.equal(run('calls.length'), 0);
  run('taskCommands = true;');
  await run("runSlash('/rename 测试 标题')");
  assert.equal(run('calls[0].method'), 'thread/name/set');
  assert.equal(run('calls[0].params.name'), '测试 标题');
  await run("runSlash('/compact')");
  assert.equal(run('calls[1].method'), 'thread/compact/start');
  run("active[threadId] = 'running'");
  await assert.rejects(run("runSlash('/compact')"), /等待/);
  get('message').value = '/rename 保留';
  run('command = async () => { throw Error("offline"); }');
  await assert.rejects(run("runSlash('/rename 保留')"), /offline/);
  assert.equal(get('message').value, '/rename 保留');
});

test('failed sends retain the draft and expose a failure state', async () => {
  const { get, run } = composer();
  get('message').value = '保留这条消息';
  run('command = async () => { throw Error("offline"); };');
  await assert.rejects(run('send(false)'), /offline/);
  assert.equal(get('message').value, '保留这条消息');
  assert.match(get('delivery-status').textContent, /发送失败/);
});

test('quick messages preserve drafts, steer the current turn, and stop sends a real interrupt', async () => {
  const { get, run } = composer();
  run("globalThis.calls = []; command = async (method, params) => { calls.push({ method, params }); }; poll = async () => {}; active[threadId] = 'turn-1';");
  get('message').value = '尚未发送的草稿';
  await run("send(true, '继续')");
  assert.equal(get('message').value, '尚未发送的草稿');
  assert.equal(run('calls[0].method'), 'turn/steer');
  assert.equal(run('calls[0].params.input[0].text'), '继续');
  assert.equal(run('calls[0].params.expectedTurnId'), 'turn-1');
  await get('stop').onclick();
  assert.equal(run('calls[1].method'), 'turn/interrupt');
  assert.equal(run('calls[1].params.turnId'), 'turn-1');
  run('delete active[threadId]');
  await run("send(false, '批准')");
  assert.equal(run('calls[2].method'), 'turn/start');
  assert.equal(run('calls[2].params.input[0].text'), '批准');
});

test('commands are grouped and unavailable actions expose current reasons', () => {
  const { get, run } = composer();
  run('showSlashMenu(true)');
  assert.deepEqual(get('slash-menu').querySelectorAll('.command-group-title').map(node => node.textContent), ['任务', '目标', '模型与状态']);
  const button = name => get('slash-menu').querySelectorAll('[data-command]').find(node => node.dataset.command === name);
  assert.equal(button('/rename').disabled, true);
  assert.match(button('/rename').textContent, /驻留桥接/);
  run("taskCommands = true; active[threadId] = 'turn'; updateControls()");
  assert.equal(button('/rename').disabled, false);
  assert.equal(button('/compact').disabled, true);
  assert.match(button('/compact').textContent, /等待当前执行结束/);
  assert.equal(button('/stop').disabled, false);
  run('uncertainSubmission = true; updateControls()');
  assert.match(button('/rename').textContent, /查询上次提交结果/);
  run("uncertainSubmission = false; threadId = ''; updateControls()");
  assert.match(button('/model').textContent, /先选择任务/);
});

test('rename forms preserve the message and parameter drafts through cancellation and failure', async () => {
  const { get, run } = composer();
  get('message').value = '原消息草稿';
  run("taskCommands = true; threads.set(threadId, { id: threadId, name: '旧标题' }); openCommandForm('/rename')");
  assert.equal(get('command-argument').value, '旧标题');
  get('command-argument').value = '未提交标题';
  get('command-argument').oninput();
  get('command-cancel').onclick();
  run("openCommandForm('/rename')");
  assert.equal(get('command-argument').value, '未提交标题');
  run('command = async () => { throw Error("offline"); }');
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(get('command-dialog').open, true);
  assert.equal(get('command-argument').value, '未提交标题');
  assert.equal(get('command-error').textContent, 'offline');
  assert.equal(get('message').value, '原消息草稿');
  run('globalThis.calls = []; command = async (method, params) => { calls.push({ method, params }); return {}; };');
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(get('command-dialog').open, false);
  assert.equal(run('calls[0].method'), 'thread/name/set');
  assert.equal(run('calls[0].params.name'), '未提交标题');
  assert.equal(get('message').value, '原消息草稿');
});

test('list rename targets the clicked task without switching, and updates favorites and all current title labels', async () => {
  const { get, run } = composer();
  run(`
    taskCommands = true;
    threads.set('thread-1', { id: 'thread-1', name: '当前会话' });
    threads.set('other', { id: 'other', name: '其他会话' });
    preferences.toggleFavorite(threads.get('other'));
    globalThis.calls = [];
    command = async (method, params) => { calls.push({ method, params }); return {}; };
    composerAttachments.clear = () => { throw Error('must preserve attachments'); };
    renderTasks();
  `);
  get('message').value = '原草稿';
  get('task-list').querySelectorAll('[data-rename-thread]').find(button => button.dataset.renameThread === 'other').onclick();
  assert.equal(get('command-argument').value, '其他会话');
  get('command-argument').value = '   ';
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(run('calls.length'), 0);
  assert.match(get('command-error').textContent, /请输入新标题/);
  get('command-argument').value = '  新  名称  ';
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(run('calls[0].params.threadId'), 'other');
  assert.equal(run('calls[0].params.name'), '新  名称');
  assert.equal(run('threadId'), 'thread-1');
  assert.equal(get('task-list').querySelectorAll('.task-card').every(button => !button.disabled), true);
  assert.equal(run('preferences.favorites()[0].name'), '新  名称');
  assert.equal(get('message').value, '原草稿');
  await run("runSlash('/rename 当前新名称', true)");
  assert.equal(get('conversation-title').textContent, '当前新名称');
  assert.equal(get('conversation-title').title, '当前新名称');
  assert.equal(get('current').textContent, '当前任务：当前新名称');
  assert.equal(run("calls.every(call => call.method === 'thread/name/set')"), true);
});

test('named creation retries only naming after partial success and preserves the original task draft', async () => {
  const { get, run } = composer();
  get('message').value = '原任务草稿';
  get('project-path').value = '/work';
  get('new-name').value = '  新会话名称  ';
  get('new-dialog').showModal();
  run(`
    taskCommands = true; globalThis.calls = []; globalThis.rejectName = true;
    composerAttachments.clear = () => { throw Error('must preserve attachments'); };
    command = async (method, params, sessionName) => {
      calls.push({ method, params, sessionName });
      if (method === 'thread/start') return { thread: { id: 'created', cwd: '/work', turns: [] } };
      if (rejectName) throw Error('rename rejected');
      return {};
    };
  `);
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.equal(get('new-dialog').open, false);
  assert.equal(get('command-dialog').open, true);
  assert.equal(get('command-argument').value, '新会话名称');
  assert.match(get('command-error').textContent, /会话已创建/);
  assert.equal(run('threadId'), 'created');
  assert.equal(run("drafts.get('thread-1')"), '原任务草稿');
  assert.equal(run('calls[0].sessionName'), '新会话名称');
  assert.equal(run("Object.hasOwn(calls[0].params, 'name')"), false);
  run('rejectName = false');
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(run("calls.filter(call => call.method === 'thread/start').length"), 1);
  assert.equal(run("calls.filter(call => call.method === 'thread/name/set').length"), 2);
  assert.equal(get('conversation-title').textContent, '新会话名称');
  assert.equal(run("freshThreads.get('created').name"), '新会话名称');
});

test('unknown create recovery offers only naming and unknown rename recovery never resends', async () => {
  const { get, run } = composer();
  run(`
    taskCommands = true;
    delivery.begin('create-key', 'thread/start', undefined, '待确认名称'); uncertainSubmission = true;
    api = async () => ({ status: 'completed', result: { thread: { id: 'created', cwd: '/work', turns: [] } } });
    command = async () => { throw Error('must not replay'); };
    composerAttachments.clear = () => { throw Error('must preserve attachments'); };
  `);
  get('new-dialog').showModal();
  await run('recoverSubmission()');
  assert.equal(get('new-dialog').open, false);
  assert.equal(get('command-dialog').open, true);
  assert.equal(get('command-argument').value, '待确认名称');
  assert.equal(run('threadId'), 'created');
  run(`
    delivery.begin('rename-key', 'thread/name/set', 'created', '待确认名称'); uncertainSubmission = true;
    api = async () => ({ status: 'pending' }); updateControls();
  `);
  await run('recoverSubmission()');
  assert.equal(get('command-save').disabled, true);
  assert.equal(get('command-check-receipt').hidden, false);
  run("api = async () => ({ status: 'completed', result: {} })");
  await run('recoverSubmission()');
  assert.equal(get('command-dialog').open, false);
  assert.equal(get('conversation-title').textContent, '待确认名称');
  assert.equal(run("freshThreads.has('created')"), true, 'rename must not force resume before the first turn exists');
  assert.equal(run('needsHistoryRefresh'), false, 'naming alone must not request nonexistent rollout history');
});

test('confirmed creation closes the creation form even when selection fails', async () => {
  const { get, run } = composer();
  get('new-dialog').showModal();
  run(`
    taskCommands = true;
    delivery.begin('create-key', 'thread/start', undefined, '名称'); uncertainSubmission = true;
    api = async () => ({ status: 'completed', result: { thread: { id: 'created', cwd: '/work', turns: [] } } });
    select = async () => { throw Error('selection failed'); };
  `);
  await run('recoverSubmission()');
  assert.equal(get('new-dialog').open, false);
  assert.equal(get('command-dialog').open, true);
  assert.equal(get('command-dialog').dataset.threadId, 'created');
  assert.equal(run('delivery.createdNaming.threadId'), 'created');
  assert.match(get('error').textContent, /selection failed/);
});

test('reload between creation and naming restores a fresh thread without resuming or creating again', async () => {
  const local = new Map();
  const session = { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) };
  const receipt = new DeliveryState(session);
  receipt.begin('create-key', 'thread/start', undefined, '恢复名称');
  receipt.settle('create-key', 'completed', { thread: { id: 'created', cwd: '/work', projectId: 'native-project', turns: [] } });
  const { get, run } = composer(undefined, session);
  run(`
    tasksLoaded = true;
    api = async () => ({ ready: true, capabilities: { taskCommands: true }, events: [], approvals: [], active: {}, cursor: 0 });
    command = async () => { throw Error('must not resume or replay'); };
  `);
  await run('poll()');
  assert.equal(run('threadId'), 'created');
  assert.equal(get('command-dialog').open, true);
  assert.equal(get('command-argument').value, '恢复名称');
  assert.equal(run("threads.get('created').cwd"), '/work');
  get('command-cancel').onclick();
  assert.equal(run('threadId'), 'created');
  assert.equal(get('command-dialog').open, false);
  assert.equal(new DeliveryState(session).createdNaming, null, 'explicit cancel clears only the unsent naming intent');
  run("openCommandForm('/rename', undefined, 'created')");
  assert.equal(get('command-argument').value, '恢复名称', 'cancellation retains the in-page name draft');
});

test('rename prefills generated previews and closing unknown naming retains its receipt', () => {
  const { get, run } = composer();
  run("taskCommands = true; threads.set('other', { id: 'other', preview: '首条消息生成的标题' }); openCommandForm('/rename', undefined, 'other')");
  assert.equal(get('command-argument').value, '首条消息生成的标题');
  assert.equal(get('command-hint').textContent.includes('other'), false);
  run("delivery.begin('rename-key', 'thread/name/set', 'other', '新名称'); uncertainSubmission = true; updateControls()");
  get('command-cancel').onclick();
  assert.equal(run('delivery.pending.key'), 'rename-key');
});

test('known failed rename receipts restore name input and desktop events update noncurrent names', async () => {
  const { get, run } = composer();
  run(`
    taskCommands = true;
    threads.set('other', { id: 'other', name: '旧名称' });
    delivery.begin('rename-key', 'thread/name/set', 'other', '保留名称'); uncertainSubmission = true;
    api = async () => ({ status: 'failed', error: { message: 'denied' } });
  `);
  await run('recoverSubmission()');
  assert.equal(get('command-argument').value, '保留名称');
  assert.match(get('command-error').textContent, /denied/);
  assert.equal(get('command-save').disabled, false);
  assert.equal(run('threadId'), 'thread-1');
  get('command-cancel').onclick();
  run(`
    tasksLoaded = true;
    api = async () => ({ ready: true, capabilities: { taskCommands: true }, events: [
      { method: 'thread/name/updated', params: { threadId: 'other', threadName: '桌面名称' } },
      { method: 'thread/name/updated', params: { threadId: 'thread-1', threadName: '当前桌面名称' } }
    ], active: {}, approvals: [], cursor: 2 });
  `);
  await run('poll()');
  assert.equal(run("threads.get('other').name"), '桌面名称');
  assert.equal(get('conversation-title').textContent, '当前桌面名称');
  assert.equal(get('current').textContent, '当前任务：当前桌面名称');
});

test('old bridges reject named creation before starting but retain blank-name creation', async () => {
  const { get, run } = composer();
  get('project-path').value = '/work';
  get('new-name').value = '新名称';
  run(`globalThis.calls = []; command = async (method, params) => { calls.push({ method, params }); return { thread: { id: 'created', turns: [] } }; };`);
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.equal(run('calls.length'), 0);
  assert.match(get('new-error').textContent, /驻留桥接/);
  assert.equal(get('new-name').value, '新名称');
  get('new-name').value = '   ';
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.equal(run('calls.length'), 1);
  assert.equal(run('calls[0].method'), 'thread/start');
});

const modelDirectory = { source: 'desktop-cache', fetchedAt: '2026-09-15T01:00:00Z', stale: false, models: [
  { id: 'desktop-model', displayName: 'Desktop Model', description: 'Original model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ effort: 'medium', description: 'Balanced' }, { effort: 'high', description: 'More reasoning' }] },
  { id: 'selected-model', displayName: 'Selected Model', description: 'Another model', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ effort: 'low', description: 'Fast' }, { effort: 'future-effort', description: 'Future option' }] },
] };
function setupModels(app) {
  app.run(`const catalogFixture = ${JSON.stringify(modelDirectory)}; api = async () => catalogFixture;
    defaultModels.set(threadId, 'desktop-model'); taskStatus.set(threadId, { model: 'desktop-model', reasoningEffort: 'high' });
    command = async (method, params) => {
      if (method !== 'thread/read') throw Error('Unexpected fixture RPC: ' + method);
      return { thread: { id: params.threadId, model: taskStatus.get(params.threadId)?.model ?? null, reasoningEffort: taskStatus.get(params.threadId)?.reasoningEffort ?? null } };
    };`);
}

test('model picker links supported efforts, preserves drafts and resets both fields explicitly', async () => {
  const { get, run } = composer();
  setupModels({ run });
  get('message').value = '消息草稿';
  await run("openCommandForm('/model')");
  assert.equal(get('model-choice').value, 'desktop-model');
  assert.equal(get('effort-choice').value, 'high');
  get('model-choice').value = 'selected-model'; get('model-choice').onchange();
  assert.equal(get('effort-choice').value, 'low', 'changing model must discard unsupported old effort');
  assert.deepEqual(get('effort-choice').options.map(option => option.value), ['low', 'future-effort']);
  assert.equal(get('effort-description').textContent, 'Fast');
  assert.match(get('effort-choice').options[0].textContent, /低（模型默认）/);
  await get('model-form').onsubmit({ preventDefault() {} });
  assert.equal(run('JSON.stringify(modelOverrides.get(threadId))'), JSON.stringify({ model: 'selected-model', effort: 'low' }));
  assert.equal(run('taskStatus.get(threadId).model'), 'desktop-model');
  assert.equal(run('taskStatus.get(threadId).reasoningEffort'), 'high');
  assert.equal(get('message').value, '消息草稿');
  assert.match(get('model-label').textContent, /下轮.*selected-model.*低/);
  await run("runSlash('/status')");
  assert.match(get('status-details').textContent, /当前模型（最近同步）：desktop-model.*下轮模型与强度：下轮（尚未发送）：selected-model · 低/);
  get('status-dialog').close();
  await run("runSlash('/model default')");
  assert.equal(run('JSON.stringify(modelOverrides.get(threadId))'), JSON.stringify({ model: 'desktop-model', effort: 'medium' }));
  assert.match(get('command-feedback').textContent, /首次连接的型号及该型号的目录默认强度/);
  await assert.rejects(run("runSlash('/model unknown')"), /不在可选目录/);
  assert.equal(run('modelOverrides.get(threadId).effort'), 'medium');
  get('message').value = '/rename 标题';
  await assert.rejects(run('send(false)'), /驻留桥接/);
  assert.equal(get('message').value, '/rename 标题');
});

test('cancel and session switches keep model choices isolated', async () => {
  const { get, run } = composer(); setupModels({ run });
  await run("runSlash('/model selected-model')");
  await run("openCommandForm('/model')");
  get('model-choice').value = 'desktop-model'; get('model-choice').onchange();
  get('model-cancel').click();
  assert.equal(run('modelOverrides.get(threadId).model'), 'selected-model');
  await run("openCommandForm('/model')");
  assert.equal(get('model-choice').value, 'selected-model');
  get('model-cancel').click();
  await run("threadId = 'other'; taskStatus.set(threadId, { model: 'desktop-model', reasoningEffort: 'medium' }); openCommandForm('/model')");
  assert.equal(get('model-choice').value, 'desktop-model');
  assert.equal(get('effort-choice').value, 'medium');
  get('model-form').onsubmit({ preventDefault() {} });
  assert.equal(run("modelOverrides.get('thread-1').model"), 'selected-model');
  assert.equal(run("modelOverrides.get('other').model"), 'desktop-model');
});

test('failed, empty, stale and unknown catalogs never fabricate choices and can retry', async () => {
  const { get, run } = composer(); setupModels({ run });
  await run("api = async () => { throw Error('目录暂不可用'); }; openCommandForm('/model')");
  assert.match(get('model-error').textContent, /目录暂不可用/);
  assert.equal(get('model-save').disabled, true);
  assert.equal(run('modelOverrides.size'), 0);
  run("api = async () => ({ ...catalogFixture, models: [] });");
  await get('model-reload').click();
  assert.match(get('model-error').textContent, /没有可展示/);
  assert.equal(get('model-save').disabled, true);
  get('model-cancel').click();
  await run("taskStatus.set(threadId, { model: 'outside-catalog', reasoningEffort: 'unlisted' }); api = async () => ({ ...catalogFixture, stale: true }); openCommandForm('/model')");
  assert.match(get('model-error').textContent, /outside-catalog.*支持强度未知/);
  assert.match(get('model-source').textContent, /上次同步.*过期/);
  assert.equal(get('model-choice').value, '');
  assert.equal(get('model-save').disabled, true);
  get('model-choice').value = 'selected-model'; get('model-choice').onchange();
  assert.equal(get('effort-choice').value, 'low');
  get('effort-choice').value = 'future-effort'; get('effort-choice').onchange();
  get('model-form').onsubmit({ preventDefault() {} });
  assert.equal(run('modelOverrides.get(threadId).effort'), 'future-effort');
  await run("api = async () => ({ ...catalogFixture, models: [{ ...catalogFixture.models[1], supportedReasoningEfforts: [], defaultReasoningEffort: null }] }); openCommandForm('/model')");
  assert.equal(get('model-save').disabled, true);
  assert.equal(get('effort-choice').value, '');
  await run("api = async () => ({ ...catalogFixture, models: [{ ...catalogFixture.models[1], supportedReasoningEfforts: [{ effort: 'low', description: 'Fast' }], defaultReasoningEffort: null }] }); openCommandForm('/model')");
  assert.equal(get('model-save').disabled, true, 'missing default must require an explicit effort choice');
  get('effort-choice').value = 'low'; get('effort-choice').onchange();
  assert.equal(get('model-save').disabled, false);
  get('model-cancel').click();
  await assert.rejects(run("runSlash('/model selected-model')"), /未提供.*默认强度/);
  assert.equal(run('modelOverrides.get(threadId).effort'), 'future-effort');
});

test('late model responses cannot replace a reopened dialog or a different session', async () => {
  const { get, run } = composer(); setupModels({ run });
  run('const responses = []; api = () => new Promise((resolve, reject) => responses.push({ resolve, reject }));');
  const first = run("openCommandForm('/model')");
  get('model-cancel').click();
  const reopened = run("openCommandForm('/model')");
  get('model-dialog').onclose(); // Native close events can arrive after an immediate reopen.
  run('responses[1].resolve(catalogFixture)'); await reopened;
  run("responses[0].reject(Error('old error'))"); await first;
  assert.equal(get('model-choice').value, 'desktop-model');
  assert.equal(get('model-error').textContent, '');
  const reload = get('model-reload').click();
  run("threadId = 'other'; updateControls()");
  run('responses[2].resolve(catalogFixture)'); await reload;
  assert.equal(get('model-save').disabled, true);
  assert.equal(get('model-choice').options.some(option => option.value === 'desktop-model'), false);
  get('model-form').onsubmit({ preventDefault() {} });
  assert.equal(run('modelOverrides.size'), 0);
});

test('new turns send model and effort together while steer omits both, including after send failure', async () => {
  const { get, run } = composer(); setupModels({ run });
  await run("runSlash('/model selected-model')");
  run("const calls = []; command = async (method, params) => { calls.push({ method, params }); }; poll = async () => {};");
  get('message').value = 'new turn'; await run('send(false)');
  assert.equal(run('calls[0].method'), 'turn/start');
  assert.equal(run('calls[0].params.model'), 'selected-model');
  assert.equal(run('calls[0].params.effort'), 'low');
  run("active[threadId] = 'turn-1'");
  get('message').value = 'steer turn'; await run('send(true)');
  assert.equal(run('calls[1].method'), 'turn/steer');
  assert.equal(run("Object.hasOwn(calls[1].params, 'model')"), false);
  assert.equal(run("Object.hasOwn(calls[1].params, 'effort')"), false);
  await run("runSlash('/model selected-model')");
  run("command = async () => { throw Error('model rejected'); }");
  get('message').value = 'preserved after failure';
  await assert.rejects(run('send(false)'), /model rejected/);
  assert.equal(get('message').value, 'preserved after failure');
  assert.equal(run('modelOverrides.get(threadId).effort'), 'low');
});

test('model picker refreshes current thread settings instead of displaying an old xhigh snapshot', async () => {
  const { get, run } = composer(); setupModels({ run });
  run(`catalogFixture.models[0].supportedReasoningEfforts.push({ effort: 'xhigh', description: 'More' });
    taskStatus.set(threadId, { model: 'desktop-model', reasoningEffort: 'xhigh' });
    const reads = []; command = async (method, params) => {
      reads.push({ method, params });
      return { thread: { id: threadId, model: 'desktop-model', reasoningEffort: 'medium' } };
    };`);
  await run("openCommandForm('/model')");
  assert.equal(get('effort-choice').value, 'medium', 'desktop thread is medium; opening the picker must not show old xhigh');
  assert.equal(run('reads[0].method'), 'thread/read');
  assert.equal(run('reads[0].params.includeTurns'), false);
});

test('desktop settings updates replace an old xhigh snapshot before the picker opens', async () => {
  const { get, run } = composer(); setupModels({ run });
  run(`catalogFixture.models[0].supportedReasoningEfforts.push({ effort: 'xhigh', description: 'More' });
    taskStatus.set(threadId, { model: 'desktop-model', reasoningEffort: 'xhigh' }); tasksLoaded = true;
    api = async path => path === '/api/models' ? catalogFixture : { ready: true, cursor: 1, events: [
      { method: 'thread/settings/updated', params: { threadId, threadSettings: { model: 'desktop-model', effort: 'medium' } } }
    ] };
    command = async () => ({ thread: { id: threadId, model: 'desktop-model', reasoningEffort: 'medium' } });`);
  await run('poll()');
  assert.equal(run('currentModelSetting(threadId).effort'), 'medium', 'desktop settings events must update the current configured effort');
  await run("openCommandForm('/model')");
  assert.equal(get('effort-choice').value, 'medium');
});

test('confirmed model submissions stop shadowing subsequent desktop settings', async () => {
  const { get, run } = composer(); setupModels({ run });
  await run("runSlash('/model selected-model')");
  run("command = async () => ({}); poll = async () => {};");
  get('message').value = 'fixture turn'; await run('send(false)');
  assert.equal(run('modelOverrides.has(threadId)'), false, 'an accepted setting is no longer an unsent override');
  run("command = async () => ({ thread: { id: threadId, model: 'desktop-model', reasoningEffort: 'medium' } });");
  await run("openCommandForm('/model')");
  assert.equal(get('model-choice').value, 'desktop-model');
  assert.equal(get('effort-choice').value, 'medium');
});

test('unknown current effort is not presented as the catalog default', async () => {
  const { get, run } = composer(); setupModels({ run });
  run("taskStatus.set(threadId, { model: 'desktop-model', reasoningEffort: null }); command = async () => ({ thread: { id: threadId, model: 'desktop-model', reasoningEffort: null } });");
  await run("openCommandForm('/model')");
  assert.equal(get('effort-choice').value, '', 'unknown current effort must remain unknown until explicitly chosen');
  assert.equal(get('model-save').disabled, true);
});

test('current settings read failures do not reuse cached effort and retry reads the thread again', async () => {
  const { get, run } = composer(); setupModels({ run });
  run("command = async () => { throw Error('read unavailable'); }");
  await run("openCommandForm('/model')");
  assert.match(get('model-current').textContent, /未知型号.*强度未知/);
  assert.match(get('model-error').textContent, /设置读取失败/);
  assert.equal(get('model-choice').value, '');
  assert.equal(get('model-save').disabled, true);
  run("command = async () => ({ thread: { id: threadId, model: 'desktop-model', reasoningEffort: 'medium' } });");
  await get('model-reload').click();
  assert.equal(get('effort-choice').value, 'medium');
});

test('settings events win over older reads without overwriting an edited model draft', async () => {
  const { get, run } = composer(); setupModels({ run });
  run(`let resolveRead; command = () => new Promise(resolve => { resolveRead = resolve; }); tasksLoaded = true;
    api = async path => path === '/api/models' ? catalogFixture : { ready: true, cursor: 1, events: [
      { method: 'thread/settings/updated', params: { threadId, threadSettings: { model: 'desktop-model', effort: 'medium' } } }
    ] };`);
  const opening = run("openCommandForm('/model')");
  await run('poll()');
  run("resolveRead({ thread: { id: threadId, model: 'desktop-model', reasoningEffort: 'high' } })"); await opening;
  assert.equal(get('effort-choice').value, 'medium');
  get('effort-choice').value = 'high'; get('effort-choice').onchange();
  await run('poll()');
  assert.equal(get('effort-choice').value, 'high', 'a desktop event updates current state, not a user-edited draft');
  assert.match(get('model-current').textContent, /当前会话：desktop-model · 中/);
  assert.equal(run('modelOverrides.size'), 0);
});

test('settings events remain usable when the model catalog could not load', async () => {
  const { get, run } = composer(); setupModels({ run });
  run("api = async () => { throw Error('catalog unavailable'); };");
  await run("openCommandForm('/model')");
  run(`tasksLoaded = true; api = async () => ({ ready: true, cursor: 1, events: [
    { method: 'thread/settings/updated', params: { threadId, threadSettings: { model: 'desktop-model', effort: 'medium' } } }
  ] });`);
  await run('poll()');
  assert.match(get('model-current').textContent, /desktop-model · 中/);
  assert.match(get('model-error').textContent, /catalog unavailable/);
  assert.equal(get('error').textContent, '');
  assert.equal(get('model-save').disabled, true);
});

test('native thread fields take precedence over resume defaults, including null effort', async () => {
  const { run } = composer(); setupModels({ run });
  run("command = async () => ({ model: 'desktop-model', reasoningEffort: 'high', thread: { id: threadId, model: 'selected-model', reasoningEffort: 'low', turns: [] } });");
  await run('select(threadId)');
  assert.equal(run('currentModelSetting(threadId).model'), 'selected-model');
  assert.equal(run('currentModelSetting(threadId).effort'), 'low');
  run("command = async () => ({ model: 'desktop-model', reasoningEffort: 'high', thread: { id: threadId, model: null, reasoningEffort: null, turns: [] } });");
  await run('select(threadId)');
  assert.equal(run('currentModelSetting(threadId).model'), null);
  assert.equal(run('currentModelSetting(threadId).effort'), null);
});

test('unknown and late model receipts retain newer unsent choices and failed settings', async () => {
  for (const status of ['completed', 'failed']) {
    const { get, run } = composer(); setupModels({ run });
    await run("runSlash('/model selected-model')");
    run(`command = async () => {
      submittedModelSetting.key = 'model-receipt'; delivery.begin('model-receipt', 'turn/start', threadId);
      uncertainSubmission = true; throw Error('receipt unavailable');
    };`);
    get('message').value = 'fixture turn'; await assert.rejects(run('send(false)'), /receipt unavailable/);
    assert.equal(run('modelOverrides.get(threadId).model'), 'selected-model');
    assert.match(get('model-label').textContent, /设置提交待确认/);
    if (status === 'completed') await run("runSlash('/model desktop-model')");
    run(`api = async () => ({ status: '${status}', result: {} });`);
    await run('recoverSubmission()');
    assert.equal(run('modelOverrides.get(threadId).model'), status === 'completed' ? 'desktop-model' : 'selected-model');
    assert.match(get('model-label').textContent, /尚未发送/);
    assert.equal(run('submittedModelSetting'), null);
  }
});

test('a completed late receipt clears only its submitted model choice', async () => {
  const { get, run } = composer(); setupModels({ run });
  await run("runSlash('/model selected-model')");
  run(`command = async () => {
    submittedModelSetting.key = 'model-receipt'; delivery.begin('model-receipt', 'turn/start', threadId);
    uncertainSubmission = true; throw Error('receipt unavailable');
  };`);
  get('message').value = 'fixture turn'; await assert.rejects(run('send(false)'), /receipt unavailable/);
  run("api = async () => ({ status: 'completed', result: {} });"); await run('recoverSubmission()');
  assert.equal(run('modelOverrides.has(threadId)'), false);
  assert.equal(run('submittedModelSetting'), null);
});

test('new tasks select a project and keep remembered starting directories optional', () => {
  const local = new Map();
  const storage = { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) };
  const setup = app => app.run("desktopProjectList = [{ id: 'a', name: '项目 A', roots: ['/a/web', '/a/api'] }, { id: 'b', name: '项目 B', roots: ['/b'] }];");
  const first = composer(storage); setup(first);
  first.get('new').onclick();
  first.get('workspace-choice').value = '/a/api'; first.get('workspace-choice').onchange();
  first.get('project-choice').value = 'b'; first.get('project-choice').onchange();
  first.get('project-choice').value = 'a'; first.get('project-choice').onchange();
  assert.equal(first.get('workspace-choice').value, '/a/api');
  const restored = composer(storage); setup(restored); restored.get('new').onclick();
  assert.equal(restored.get('project-choice').value, 'a');
  assert.equal(restored.get('workspace-choice').value, '/a/api');
  assert.equal(restored.get('new-summary').textContent, '项目 A · 包含 2 个目录，可跨目录工作');
  assert.equal(restored.get('project-workspace').open, false);
  restored.run("desktopProjectList[0].roots = ['/a/replacement']; projectChoice()");
  assert.equal(restored.get('workspace-choice').value, '/a/replacement', 'removed roots must not stay selected');
});

test('project creation includes all roots even when the optional starting directory changes', async () => {
  const { get, run } = composer();
  run(`desktopProjectList = [{ id: 'project', serverId: 'native-project', name: '组合项目', roots: ['/repo/frontend', '/services/backend'] }];
    globalThis.calls = []; command = async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: 'new-' + calls.length, cwd: params.cwd, projectId: params.projectId, turns: [] } };
    };`);
  get('new').onclick();
  assert.equal(get('project-workspace').open, false);
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(run('JSON.stringify(calls[0])')), {
    method: 'thread/start', params: { cwd: '/repo/frontend', projectId: 'native-project', runtimeWorkspaceRoots: ['/repo/frontend', '/services/backend'] },
  });
  get('new').onclick();
  get('workspace-choice').value = '/services/backend';
  get('workspace-choice').onchange();
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(run('JSON.stringify(calls[1].params)')), {
    cwd: '/services/backend', projectId: 'native-project', runtimeWorkspaceRoots: ['/repo/frontend', '/services/backend'],
  });
  get('new').onclick();
  get('workspace-choice').value = '/outside';
  await get('new-form').onsubmit({ preventDefault() {} });
  assert.equal(run('calls.length'), 2);
  assert.match(get('new-error').textContent, /起始目录已失效/);
});

test('saved tasks remain reachable outside recent results with accessible favorites and live states', () => {
  const { get, run } = composer();
  run("preferences.toggleFavorite({ id: 'older', name: '旧收藏', cwd: '/work' }); threads.set('recent', { id: 'recent', name: '最近任务', cwd: '/work' }); renderTasks()");
  const cards = get('task-list').querySelectorAll('.task-card');
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /旧收藏/);
  const favorites = get('task-list').querySelectorAll('.task-favorite');
  assert.equal(favorites[0]['aria-pressed'], 'true');
  favorites[1].onclick();
  assert.equal(run("preferences.isFavorite('recent')"), true);
  run("active.older = 'turn'; updateControls()");
  assert.equal(get('task-list').querySelectorAll('[data-task-status]')[0].textContent, '运行中');
  run('active = {}; updateControls()');
  assert.equal(get('task-list').querySelectorAll('[data-task-status]')[0].textContent, '空闲');
  const group = get('task-list').querySelector('.project-group');
  group.querySelector('summary').onclick();
  run('renderTasks()');
  assert.equal(get('task-list').querySelector('.project-group').open, false);
});

test('late receipts acknowledge the submitted attachments even after text edits or task switches', async () => {
  for (const switched of [false, true]) {
    const { get, run } = composer();
    run(`
      globalThis.sentMedia = { threadId: 'thread-1', items: [{ name: 'sent.png' }] };
      delivery.begin('key', 'turn/start', 'thread-1'); uncertainSubmission = true;
      submittedDraft = { key: 'key', threadId: 'thread-1', text: 'sent text', media: sentMedia };
      api = async () => ({ status: 'completed', result: {} });
      composerAttachments.clear = snapshot => { globalThis.clearedMedia = snapshot; };
      drafts.set('thread-1', 'sent text');
    `);
    if (switched) run("threadId = 'thread-2'");
    get('message').value = 'new draft';
    await run('recoverSubmission()');
    assert.equal(run('clearedMedia === sentMedia'), true, 'cleanup must target the original attachment snapshot');
    assert.equal(get('message').value, 'new draft');
    assert.equal(run('delivery.pending'), null);
  }
});

test('a failed receipt preserves the submitted draft and attachments', async () => {
  const { get, run } = composer();
  get('message').value = 'retry later';
  run(`
    delivery.begin('key', 'turn/start', 'thread-1'); uncertainSubmission = true;
    submittedDraft = { key: 'key', threadId: 'thread-1', text: 'retry later' };
    api = async () => ({ status: 'failed', error: { message: 'rejected' } });
    composerAttachments.clear = () => { throw Error('must preserve attachments'); };
  `);
  await run('recoverSubmission()');
  assert.equal(get('message').value, 'retry later');
  assert.equal(run('uncertainSubmission'), false);
});

test('an unavailable saved task keeps the healthy connection usable and still checks receipts', async () => {
  const { get, run } = composer();
  run(`
    sessionStorage.getItem = () => 'removed-task';
    globalThis.resumes = 0; globalThis.recoveries = 0;
    api = async () => ({ ready: true, events: [], active: {}, approvals: [], cursor: 0 });
    list = async () => {};
    select = async () => { resumes++; throw Error('task no longer exists'); };
    recoverSubmission = async () => { recoveries++; };
    renderHistory = () => {}; renderApprovals = () => {};
  `);
  await run('poll()');
  await run('poll()');
  assert.equal(run('connected'), true);
  assert.equal(get('new').disabled, false);
  assert.equal(run('resumes'), 1, 'do not retry an unavailable task every second');
  assert.equal(run('recoveries'), 2);
  assert.match(get('error').textContent, /task no longer exists/);
});

test('a failed history reload still consumes a reset cursor and refreshes approvals', async () => {
  const { run } = composer();
  run(`
    threadId = 'removed-task'; cursor = 2000;
    sessionStorage.getItem = () => threadId;
    globalThis.resumes = 0; globalThis.approvalRenders = 0;
    api = async () => ({ ready: true, reset: cursor !== 5, events: [], active: {}, approvals: [], cursor: 5 });
    list = async () => {};
    command = async () => { resumes++; throw Error('task no longer exists'); };
    renderHistory = () => {}; renderApprovals = () => { approvalRenders++; };
  `);
  await run('poll()');
  await run('poll()');
  assert.equal(run('cursor'), 5);
  assert.equal(run('resumes'), 2, 'one selection and history attempt, without repeating on the next poll');
  assert.equal(run('approvalRenders'), 2);
  assert.equal(run('connected'), true);
});
