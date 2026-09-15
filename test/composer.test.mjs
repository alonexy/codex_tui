import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { HistoryPages } from '../public/history-pages.js';
import { Timeline } from '../public/timeline.js';
import { DeliveryState, deliveryLabel } from '../public/delivery-state.js';
import { taskPreferences } from '../public/task-preferences.js';

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
    document: { getElementById: get, addEventListener() {}, createElement: tag => new Element(tag), body: new Element('body') },
    window: { addEventListener() {} },
    sessionStorage: session,
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    ResizeObserver: class { observe() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() {},
    composerMedia: () => ({ render() {}, reading: () => false, hasImages: () => false, input: async () => [], capture: () => ({ threadId: 'thread-1', items: [] }), clear() {} }),
    HistoryPages,
    Timeline,
    DeliveryState, deliveryLabel, devicePanel: () => {},
    taskPreferences: () => taskPreferences(storage),
    goalPanel: () => ({ open: async () => {}, event() {} }),
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\n/gm, '').split("window.addEventListener('pagehide'")[0], context);
  const run = code => vm.runInContext(code, context);
  run("connected = true; threadId = 'thread-1';");
  return { get, run };
}

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

test('model forms apply to later turns and slash errors reach the send caller', async () => {
  const { get, run } = composer();
  get('message').value = '消息草稿';
  run("defaultModels.set(threadId, 'desktop-model'); openCommandForm('/model')");
  get('command-argument').value = 'selected-model';
  await get('command-form').onsubmit({ preventDefault() {} });
  assert.equal(run('modelOverrides.get(threadId)'), 'selected-model');
  assert.equal(get('message').value, '消息草稿');
  await run("runSlash('/model default')");
  assert.equal(run('modelOverrides.get(threadId)'), 'desktop-model');
  get('message').value = '/rename 标题';
  await assert.rejects(run('send(false)'), /驻留桥接/);
  assert.equal(get('message').value, '/rename 标题');
});

test('new tasks remember each project component and show its path before creation', () => {
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
  assert.equal(restored.get('new-summary').textContent, '项目 A → /a/api');
  restored.run("desktopProjectList[0].roots = ['/a/replacement']; projectChoice()");
  assert.equal(restored.get('workspace-choice').value, '/a/replacement', 'removed roots must not stay selected');
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
