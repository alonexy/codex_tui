const labels = { active: '进行中', paused: '已暂停', blocked: '受阻', usageLimited: '用量限制', budgetLimited: '预算已用尽', complete: '已完成' };

export function goalPanel({ command, available, getThread }) {
  const $ = id => document.getElementById(id);
  let id = '', goal = null, busy = false, loaded = false;
  function render() {
    $('goal-state').textContent = !loaded ? (busy ? '正在读取目标…' : '目标尚未读取成功') : goal ? `${labels[goal.status] ?? goal.status} · 已使用 ${goal.tokensUsed ?? 0} Token · ${goal.timeUsedSeconds ?? 0} 秒` : '当前任务尚未设置目标';
    for (const button of $('goal-dialog').querySelectorAll('button')) button.disabled = busy;
    $('goal-save').disabled = busy || !loaded;
    $('goal-objective').disabled = busy; $('goal-budget').disabled = busy;
    for (const action of ['pause', 'resume', 'clear']) $('goal-' + action).hidden = !goal;
    $('goal-pause').hidden = !goal || goal.status !== 'active';
    $('goal-resume').hidden = !goal || goal.status === 'active' || goal.status === 'complete';
    $('goal-save').textContent = goal ? '保存并启动目标' : '创建并启动目标';
  }
  async function perform(action) {
    if (busy) return;
    busy = true; $('goal-error').textContent = ''; render();
    try { await action(); }
    catch (error) { $('goal-error').textContent = error.message; }
    finally { busy = false; render(); }
  }
  $('goal-close').onclick = () => $('goal-dialog').close();
  $('goal-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('goal-form').onsubmit = event => {
    event.preventDefault();
    perform(async () => {
      const objective = $('goal-objective').value.trim();
      const raw = $('goal-budget').value.trim(), budget = raw ? Number(raw) : null;
      if (!objective || objective.length > 4000) throw Error('请输入 1–4000 字的目标');
      if (budget !== null && (!Number.isSafeInteger(budget) || budget <= 0)) throw Error('Token 预算必须为正整数');
      const result = await command('thread/goal/set', { threadId: id, objective, status: 'active', tokenBudget: budget });
      goal = result.goal;
    });
  };
  for (const [action, status] of [['pause', 'paused'], ['resume', 'active']]) {
    $('goal-' + action).onclick = () => perform(async () => {
      const result = await command('thread/goal/set', { threadId: id, status }); goal = result.goal;
    });
  }
  $('goal-clear').onclick = () => {
    if (!window.confirm('清除当前目标？对话记录会保留。')) return;
    perform(async () => { await command('thread/goal/clear', { threadId: id }); goal = null; $('goal-objective').value = ''; $('goal-budget').value = ''; });
  };
  return {
    async open(objective = '') {
      available();
      id = getThread();
      if (!id) throw Error('请先选择任务');
      goal = null; loaded = false; $('goal-objective').value = objective; $('goal-budget').value = '';
      $('goal-dialog').showModal();
      await perform(async () => {
        const result = await command('thread/goal/get', { threadId: id }); goal = result.goal; loaded = true;
        $('goal-objective').value = objective || goal?.objective || '';
        $('goal-budget').value = goal?.tokenBudget ?? '';
      });
    },
    event(event) {
      if (!$('goal-dialog').open || event.params?.threadId !== id) return;
      if (event.method === 'thread/goal/updated') goal = event.params.goal;
      else if (event.method === 'thread/goal/cleared') goal = null;
      else return;
      render();
    },
  };
}
