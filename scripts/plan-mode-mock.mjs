import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function createPlanMock() {
  const tasks = new Map([
    ['plan-demo', { id: 'plan-demo', name: '计划与问题卡片验收', cwd: '/mock/project', turns: [], model: 'mock-model', reasoningEffort: 'xhigh' }],
    ['other-demo', { id: 'other-demo', name: '另一条会话', cwd: '/mock/project', turns: [], model: 'mock-model', reasoningEffort: 'medium' }],
  ]);
  const questions = [
    { id: 'scope', header: '交付范围', question: '这次计划先覆盖哪些使用场景？', isOther: true, options: [
      { label: '先完成核心流程（推荐）', description: '优先打通可独立验收的路径，保留后续扩展空间。' },
      { label: '一次覆盖全部场景', description: '同时考虑边界条件与完整体验，需要更多实现时间。' },
    ] },
    { id: 'style', header: '交互偏好', question: '你希望如何浏览多个待回答问题？', isOther: true, options: [
      { label: '逐题卡片（推荐）', description: '每次专注一个问题，可前后切换并保留草稿。' },
      { label: '显示完整列表', description: '集中查看所有问题，自由决定回答顺序。' },
    ] },
    { id: 'private', header: '私密回答', question: '请填写用于验收密码框的任意模拟文本。', isSecret: true, options: null },
  ];
  const state = { ready: true, mode: 'desktop-shared', bridgeId: 'isolated-plan-mock', capabilities: { taskCommands: true, threadSettings: true, threadMode: true }, active: {}, approvals: [], cursor: 0, events: [], threadSettings: {} };
  const modeRead = new Map();
  const calls = [], answers = [], receipts = new Map();
  let rejectTurn = false, rejectAnswer = false, holdReceipt = false, held = null;
  const event = (method, params) => { state.events.push({ cursor: ++state.cursor, method, params }); };
  const addQuestions = () => {
    state.approvals = [{ id: `mock-question-${state.cursor}`, method: 'item/tool/requestUserInput', params: { threadId: 'plan-demo', turnId: 'mock-turn', itemId: 'mock-item', isBlocking: true, questions } }];
    event('thread/status/changed', { threadId: 'plan-demo', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
  };
  const settings = (id, mode = 'default', model = 'mock-model', effort = 'xhigh') => {
    const value = { model, effort, collaborationMode: { mode, settings: { model, reasoning_effort: effort } } };
    state.threadSettings[id] = value;
    Object.assign(tasks.get(id), { model, reasoningEffort: effort });
    event('thread/settings/updated', { threadId: id, threadSettings: value });
  };
  settings('plan-demo'); settings('other-demo', 'default', 'mock-model', 'medium'); addQuestions();
  const server = http.createServer(async (request, response) => {
    const json = (data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
    try {
      const url = new URL(request.url, 'http://localhost');
      let body;
      if (request.method === 'POST') { const chunks = []; for await (const chunk of request) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
      if (url.pathname === '/api/state') return json({ ...state, events: state.events.filter(value => value.cursor > Number(url.searchParams.get('after'))) });
      if (url.pathname === '/api/thread-mode') {
        const threadId = url.searchParams.get('threadId');
        return json(modeRead.get(threadId) ?? { threadId, collaborationMode: state.threadSettings[threadId]?.collaborationMode ?? null, source: 'runtime' });
      }
      if (url.pathname === '/api/projects') return json({ projects: [], assignments: {} });
      if (url.pathname === '/api/models') return json({ source: 'desktop-cache', fetchedAt: new Date().toISOString(), stale: false, models: [
        { id: 'mock-model', displayName: '模拟模型', supportedReasoningEfforts: ['medium', 'high', 'xhigh'].map(effort => ({ effort, description: effort })), defaultReasoningEffort: 'medium' },
        { id: 'mock-other', displayName: '另一模拟模型', supportedReasoningEfforts: [{ effort: 'high', description: '高强度' }], defaultReasoningEffort: 'high' },
      ] });
      if (url.pathname === '/mock/control') {
        if (body.action === 'questions') addQuestions();
        if (body.action === 'resolve') { state.approvals = []; event('thread/status/changed', { threadId: 'plan-demo', status: { type: 'idle' } }); }
        if (body.action === 'settings') settings(body.id || 'plan-demo', body.mode, body.model, body.effort);
        if (body.action === 'idle') { state.active = {}; event('turn/completed', { threadId: 'plan-demo', turn: { id: 'mock-turn', status: 'completed' } }); }
        if (body.action === 'ready') state.ready = body.value;
        if (body.action === 'reject-turn') rejectTurn = true;
        if (body.action === 'reject-answer') rejectAnswer = true;
        if (body.action === 'hold-receipt') holdReceipt = true;
        if (body.action === 'release-receipt' && held) { receipts.set(held.key, held.record); held = null; holdReceipt = false; }
        return json({ ok: true });
      }
      if (url.pathname === '/mock/inspect') return json({ calls, answers, pending: state.approvals.length });
      if (url.pathname === '/api/commands') {
        calls.push(body);
        const { method, params, key } = body;
        let result = {}, status = 'completed';
        if (method === 'thread/list') result = { data: [...tasks.values()], nextCursor: null };
        else if (method === 'thread/read' || method === 'thread/resume') result = { thread: tasks.get(params.threadId), model: tasks.get(params.threadId)?.model, reasoningEffort: tasks.get(params.threadId)?.reasoningEffort, initialTurnsPage: { data: [] } };
        else if (method === 'turn/start') {
          if (rejectTurn) { status = 'failed'; rejectTurn = false; }
          else {
            state.active[params.threadId] = 'mock-turn'; result = { turn: { id: 'mock-turn' } };
            if (params.collaborationMode) settings(params.threadId, params.collaborationMode.mode, params.collaborationMode.settings.model, params.collaborationMode.settings.reasoning_effort);
          }
        } else if (method === 'turn/steer') result = { turnId: 'mock-turn' };
        else if (method === 'turn/interrupt') state.active = {};
        else if (method === 'thread/name/set') tasks.get(params.threadId).name = params.name;
        else return json({ error: `Unsupported mock method: ${method}`, submission: 'rejected' }, 400);
        const record = { status, result, ...(status === 'failed' ? { error: { message: '模拟发送失败' } } : {}) };
        if (method === 'turn/start' && holdReceipt) { held = { key, record }; receipts.set(key, { status: 'pending' }); }
        else receipts.set(key, record);
        return json({ status: 'pending' });
      }
      if (url.pathname.startsWith('/api/commands/')) return json(receipts.get(url.pathname.split('/').pop()) ?? { status: 'unknown' });
      if (url.pathname === '/api/answer') {
        if (rejectAnswer) { rejectAnswer = false; return json({ error: '模拟回答失败，选择保留' }, 503); }
        if (!state.approvals.some(value => value.id === body.id)) return json({ error: '请求已处理' }, 400);
        answers.push(body); state.approvals = []; event('thread/status/changed', { threadId: 'plan-demo', status: { type: 'idle' } });
        return json({ ok: true });
      }
      if (url.pathname === '/api/attachment-batches') return json({ ok: true });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!/^[\w.-]+$/.test(file)) return json({ error: 'Not found' }, 404);
      const content = await readFile(new URL(`../public/${file}`, import.meta.url));
      response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' }); response.end(content);
    } catch (error) { json({ error: error.message }, 500); }
  });
  return { server, state, calls, answers, modeRead };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createPlanMock();
  server.listen(Number(process.env.PLAN_MOCK_PORT || 9799), '127.0.0.1', () => console.log(`Isolated plan mock: http://127.0.0.1:${server.address().port} (no real Codex connection)`));
}
