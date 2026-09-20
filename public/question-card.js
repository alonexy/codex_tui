export function questionAnswers(questions, drafts) {
  const answers = [];
  for (const question of questions) {
    const draft = drafts.get(question.id);
    const value = draft?.custom ? draft.text : draft?.choice;
    if (typeof value !== 'string' || !value.trim()) return null;
    answers.push([question.id, { answers: [value] }]);
  }
  return questions.length ? { answers: Object.fromEntries(answers) } : null;
}

// The card owns its in-memory draft until the server removes this request.
export function questionCard(questions, submit, saved, autoCollapseMs = 0) {
  const form = document.createElement('form'); form.className = 'question-form'; form.noValidate = true;
  const drafts = new Map(questions.map(question => [question.id, saved?.drafts.get(question.id) ?? { choice: '', text: '', custom: question.isSecret || !question.options?.length }]));
  let current = Math.max(0, questions.findIndex(question => question.id === saved?.currentId)), locked = false, collapsed = saved?.collapsed ?? false;
  let resolved = new Set();
  let active = false, idleTimer = null;
  const canCollapse = () => autoCollapseMs && active && form.isConnected && !locked && !collapsed && !form.querySelector('input:focus');
  function resetIdle() {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    if (!canCollapse()) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!canCollapse()) return;
      const restoreFocus = body.contains(document.activeElement);
      collapsed = true; refresh();
      if (restoreFocus) collapse.focus({ preventScroll: true });
    }, autoCollapseMs);
  }
  const remaining = () => questions.filter(question => !resolved.has(question.id));
  const visibleIndices = () => questions.flatMap((question, index) => resolved.has(question.id) ? [] : [index]);
  const top = document.createElement('div'); top.className = 'question-top';
  const progress = document.createElement('span'); progress.className = 'muted small'; progress.setAttribute('role', 'status');
  const collapse = document.createElement('button'); collapse.type = 'button'; collapse.className = 'secondary question-collapse'; collapse.textContent = '收起';
  top.append(progress, collapse);
  const body = document.createElement('div'); body.className = 'question-body';
  const scroll = document.createElement('div'); scroll.className = 'question-scroll';
  const tabs = document.createElement('div'); tabs.className = 'question-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '选择问题');
  const panels = [], tabButtons = [];
  for (const [index, question] of questions.entries()) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'secondary';
    tab.onclick = () => { current = index; refresh(); }; tabs.append(tab); tabButtons.push(tab);
    const panel = document.createElement('section'); panel.className = 'question-panel';
    const header = document.createElement('p'); header.className = 'question-header'; header.textContent = question.header || `问题 ${index + 1}`;
    const title = document.createElement('h3'); title.textContent = question.question;
    panel.append(header, title);
    const draft = drafts.get(question.id), options = [];
    if (!question.isSecret) for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'question-option secondary';
      const number = document.createElement('span'); number.className = 'question-number'; number.textContent = optionIndex + 1;
      const content = document.createElement('span');
      const label = document.createElement('strong'); label.textContent = option.label;
      const description = document.createElement('span'); description.className = 'question-description'; description.textContent = option.description || '';
      content.append(label, description); button.append(number, content);
      button.onclick = () => { draft.choice = option.label; draft.custom = false; refresh(); };
      options.push([button, option.label]); panel.append(button);
    }
    const custom = document.createElement('button'); custom.type = 'button'; custom.className = 'question-option secondary'; custom.textContent = `${options.length + 1} · 自行填写`;
    custom.hidden = !options.length;
    custom.onclick = () => { draft.custom = true; refresh(); input.focus({ preventScroll: true }); };
    const label = document.createElement('label'); label.textContent = question.isSecret ? '填写私密回答' : '你的回答';
    const input = document.createElement('input'); input.type = question.isSecret ? 'password' : 'text'; input.autocomplete = 'off'; input.spellcheck = !question.isSecret;
    input.dataset.questionId = question.id; input.value = draft.text;
    input.setAttribute('aria-label', `${question.header || `问题 ${index + 1}`}：${question.isSecret ? '私密回答' : '自行填写'}`);
    input.oninput = () => { draft.text = input.value; refresh(); };
    label.append(input); panel.append(custom, label);
    panel.update = () => {
      panel.hidden = current !== index || resolved.has(question.id);
      for (const [button, value] of options) button.setAttribute('aria-pressed', String(!draft.custom && draft.choice === value));
      custom.setAttribute('aria-pressed', String(draft.custom)); label.hidden = !draft.custom;
    };
    panels.push(panel);
  }
  const navigation = document.createElement('div'); navigation.className = 'question-navigation';
  const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'secondary'; previous.textContent = '上一题';
  const next = document.createElement('button'); next.type = 'button'; next.className = 'secondary'; next.textContent = '下一题';
  const send = document.createElement('button'); send.type = 'submit'; send.textContent = '发送全部回答'; send.className = 'question-send';
  previous.onclick = () => { const indices = visibleIndices(); current = indices[indices.indexOf(current) - 1] ?? current; refresh(); };
  next.onclick = () => { const indices = visibleIndices(); current = indices[indices.indexOf(current) + 1] ?? current; refresh(); };
  collapse.onclick = () => { collapsed = !collapsed; refresh(); };
  navigation.append(previous, next);
  const footer = document.createElement('div'); footer.className = 'question-footer'; footer.append(navigation, send);
  scroll.append(...panels); body.append(tabs, scroll, footer); form.append(top, body);
  if (autoCollapseMs) {
    for (const event of ['pointerdown', 'pointerup', 'click', 'keydown', 'input', 'focusin', 'wheel', 'touchmove']) {
      form.addEventListener(event, resetIdle);
    }
    form.addEventListener('focusout', event => { if (event.target.tagName === 'INPUT') queueMicrotask(resetIdle); });
  }
  function refresh() {
    for (const control of form.querySelectorAll('button, input')) control.disabled = locked;
    const indices = visibleIndices(), available = remaining();
    if (!indices.includes(current)) current = indices[0] ?? 0;
    const answered = available.filter(question => questionAnswers([question], drafts)).length;
    progress.textContent = collapsed ? `待回答 · 共 ${available.length} 题` : `${Math.max(0, indices.indexOf(current) + 1)} / ${available.length} · 已回答 ${answered} 题`;
    form.classList.toggle('collapsed', collapsed);
    body.hidden = collapsed; collapse.textContent = collapsed ? '展开回答' : '收起'; collapse.setAttribute('aria-expanded', String(!collapsed));
    tabButtons.forEach((tab, index) => {
      tab.hidden = resolved.has(questions[index].id);
      tab.textContent = `${index + 1}${questionAnswers([questions[index]], drafts) ? ' ✓' : ''}`;
      tab.setAttribute('aria-label', `问题 ${index + 1}：${questions[index].header || '回答'}${questionAnswers([questions[index]], drafts) ? '，已回答' : ''}`);
      tab.setAttribute('aria-pressed', String(current === index));
    });
    panels.forEach(panel => panel.update());
    previous.disabled = locked || indices.indexOf(current) <= 0; next.disabled = locked || indices.indexOf(current) >= indices.length - 1;
    send.disabled = locked || !questionAnswers(available, drafts);
  }
  form.onsubmit = event => {
    event.preventDefault();
    const result = questionAnswers(remaining(), drafts);
    if (!locked && result) submit(result);
  };
  refresh();
  return {
    form,
    capture() { return { drafts, currentId: questions[current]?.id, collapsed }; },
    setActive(value) { if (active !== value) { active = value; resetIdle(); } },
    setLocked(value) { const changed = locked !== value; locked = value; refresh(); if (changed) resetIdle(); },
    setResolved(ids) { resolved = new Set(ids); refresh(); },
  };
}
