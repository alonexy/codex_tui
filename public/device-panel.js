const actions = { login: '登录', logout: '退出登录', 'session.revoke': '撤销设备', 'session.revoke_all': '撤销全部设备', 'rpc.submit': '控制指令提交', 'approval.answer': '审批或回答提交' };
const results = { success: '成功', failed: '失败', limited: '已限流', accepted: '已接收', revoked: '已撤销', missing: '设备已失效', denied: '已拒绝' };
const date = value => Number.isFinite(value) ? new Date(value).toLocaleString() : '未知';

export function devicePanel({ api }) {
  const entry = document.getElementById('manage-devices');
  if (!entry) return;
  const make = (tag, text, id) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (id) element.id = id;
    return element;
  };
  const dialog = make('dialog', undefined, 'device-dialog');
  dialog.setAttribute('aria-labelledby', 'device-title');
  const heading = make('div'); heading.className = 'dialog-heading';
  const title = make('h2', '登录设备', 'device-title');
  const close = make('button', '关闭', 'device-close'); close.type = 'button'; close.className = 'secondary';
  heading.append(title, close);
  const hint = make('p', '撤销设备会立即终止其访问；桌面任务会继续运行。');
  const status = make('p', '', 'device-status'); status.setAttribute('role', 'status');
  const error = make('p', '', 'device-error'); error.setAttribute('role', 'alert');
  const toolbar = make('div'); toolbar.className = 'toolbar';
  const refresh = make('button', '刷新', 'device-refresh'); refresh.type = 'button'; refresh.className = 'secondary';
  const revokeAll = make('button', '撤销全部设备', 'device-revoke-all'); revokeAll.type = 'button'; revokeAll.className = 'secondary';
  toolbar.append(refresh, revokeAll);
  const devices = make('div', undefined, 'device-list');
  const audit = make('details', undefined, 'security-audit');
  const auditSummary = make('summary', '安全记录');
  const retention = make('p', '', 'security-audit-retention');
  const events = make('div', undefined, 'security-audit-list');
  audit.append(auditSummary, retention, events);
  dialog.append(heading, hint, status, error, toolbar, devices, audit);
  document.body.append(dialog);
  let busy = false, loaded = false;
  function controls() {
    for (const button of dialog.querySelectorAll('button')) button.disabled = busy && button !== close;
    revokeAll.disabled = busy || !loaded;
    dialog.setAttribute('aria-busy', String(busy));
  }
  async function perform(action) {
    if (busy) return;
    busy = true; error.textContent = ''; controls();
    try { await action(); }
    catch (failure) { error.textContent = failure.message || '操作失败，请刷新设备状态后再试。'; }
    finally { busy = false; controls(); }
  }
  function renderSessions(sessions) {
    const cards = sessions.map(session => {
      const card = make('article'); card.className = 'tool-record';
      const name = make('h3', `${session.device}${session.current ? '（当前设备）' : ''}`);
      const source = make('p', `来源：${session.source}`);
      const times = make('p', `登录：${date(session.createdAt)} · 最近访问：${date(session.lastSeen)}`);
      const expiry = make('p', `到期：${date(session.expiresAt)} · 闲置到期：${date(session.idleExpiresAt)}`);
      const revoke = make('button', session.current ? '撤销当前设备' : '撤销此设备');
      revoke.type = 'button'; revoke.className = 'secondary'; revoke.dataset.deviceId = session.id;
      revoke.onclick = () => {
        if (!window.confirm(session.current ? '撤销当前设备并重新登录？桌面任务会继续运行。' : `撤销 ${session.device} 的访问？桌面任务会继续运行。`)) return;
        perform(async () => {
          const result = await api('/api/sessions/revoke', { id: session.id });
          if (result.current) { location.replace('/login'); return; }
          await load();
        });
      };
      card.append(name, source, times, expiry, revoke);
      return card;
    });
    devices.replaceChildren(...cards);
    status.textContent = `${sessions.length} 个已登录设备`;
  }
  function renderAudit(data) {
    const persistence = data.persistence === 'enabled' ? '安全记录已保存' : data.persistence === 'unavailable' ? '安全记录暂时无法写入磁盘，本次仅保存在内存' : '安全记录仅保存在本次服务内存';
    retention.textContent = `${persistence}；最多保留 ${data.maxEvents} 条，展示最近 50 条。重复或过量事件已省略 ${data.suppressed} 条。记录不含密码、任务正文或指令参数。`;
    events.replaceChildren(...data.events.slice(0, 50).map(event => {
      const line = make('p', `${date(event.time)} · ${actions[event.action] || '安全操作'}：${results[event.result] || '未知'} · ${event.device} · ${event.source}`);
      return line;
    }));
    if (!data.events.length) events.append(make('p', '暂无安全记录'));
  }
  async function load() {
    status.textContent = '正在读取设备与安全记录…';
    const [list, audit] = await Promise.all([api('/api/sessions/list', {}), api('/api/security-audit/list', {})]);
    renderSessions(list.sessions); renderAudit(audit); loaded = true;
  }
  close.onclick = () => dialog.close();
  refresh.onclick = () => perform(load);
  revokeAll.onclick = () => {
    if (!window.confirm('撤销全部设备（包括当前设备）并重新登录？桌面任务会继续运行。')) return;
    perform(async () => { await api('/api/sessions/revoke-all', {}); location.replace('/login'); });
  };
  entry.addEventListener('click', () => {
    dialog.showModal();
    close.focus();
    perform(load);
  });
  return { open: () => { dialog.showModal(); close.focus(); return perform(load); } };
}
