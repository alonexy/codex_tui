import { passkeyStatus, passkeyError, webauthn, cancelPasskey } from './passkey-client.js';

export function passkeySettings({ api, leave }) {
  const make = (tag, text, id) => { const node = document.createElement(tag); if (text) node.textContent = text; if (id) node.id = id; return node; };
  const entry = document.getElementById('manage-passkeys');
  const dialog = make('dialog', '', 'passkey-dialog'); dialog.setAttribute('aria-labelledby', 'passkey-title');
  const title = make('h2', '通行密钥（Face ID）', 'passkey-title');
  const hint = make('p', '系统会选择 Face ID、Touch ID 或设备密码验证，本站不接收人脸数据。退出登录会结束会话；已绑定密钥会保留，可在此删除。'); hint.className = 'small muted';
  const status = make('p', '', 'passkey-status'); status.setAttribute('role', 'status');
  const form = make('form', '', 'passkey-register'); form.method = 'post';
  const label = make('label', '再次输入访问密码以绑定'); label.htmlFor = 'passkey-password';
  const password = make('input', '', 'passkey-password'); password.type = 'password'; password.autocomplete = 'current-password'; password.maxLength = 1024;
  const bind = make('button', '绑定此设备', 'passkey-bind'); bind.type = 'submit'; bind.disabled = true;
  form.append(label, password, bind);
  const error = make('p', '', 'passkey-error'); error.className = 'error'; error.setAttribute('role', 'alert');
  const list = make('div', '', 'passkey-list');
  const toolbar = make('div'); toolbar.className = 'toolbar';
  const refresh = make('button', '刷新密钥列表', 'passkey-refresh'), close = make('button', '关闭', 'passkey-close');
  refresh.type = close.type = 'button'; refresh.className = close.className = 'secondary'; toolbar.append(refresh, close);
  dialog.append(title, hint, status, form, error, list, toolbar); document.body.append(dialog);
  let busy = false, available = false, epoch = 0;
  function controls() {
    password.disabled = !!busy || !available; bind.disabled = !!busy || !available;
    refresh.disabled = !!busy; close.disabled = busy === 'saving';
    for (const button of list.querySelectorAll('button')) button.disabled = !!busy;
    dialog.setAttribute('aria-busy', String(!!busy));
  }
  async function load() {
    const client = await passkeyStatus();
    available = client.enabled; status.textContent = client.enabled ? '每次登录均需系统验证。最多绑定 32 个密钥。' : client.reason;
    form.hidden = !available;
    const data = await api('/api/passkeys/list', {});
    list.replaceChildren(...data.credentials.map((credential, index) => {
      const card = make('article'); card.append(make('p', `通行密钥 ${index + 1} · ${new Date(credential.createdAt).toLocaleString()}`));
      const remove = make('button', '删除此密钥'); remove.type = 'button'; remove.className = 'danger';
      remove.onclick = async () => {
        if (busy || !confirm('删除这个通行密钥并撤销由它登录的会话？删除后仍可使用访问密码。')) return;
        busy = 'saving'; error.textContent = ''; controls();
        try { const result = await api('/api/passkeys/remove', { id: credential.id }); if (result.current) leave(); else await load(); }
        catch (reason) { error.textContent = reason.message; }
        finally { busy = false; controls(); }
      };
      card.append(remove); return card;
    }));
    if (!data.credentials.length && data.enabled) list.textContent = '尚未绑定通行密钥。';
    controls();
  }
  async function reload() { if (busy) return; busy = 'loading'; controls(); try { await load(); } catch (reason) { error.textContent = reason.message; } finally { busy = false; controls(); } }
  entry.onclick = () => { password.value = ''; error.textContent = ''; dialog.showModal(); reload(); };
  refresh.onclick = reload;
  close.onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (busy === 'saving') event.preventDefault(); });
  dialog.addEventListener('close', () => { epoch++; password.value = ''; if (busy === 'prompt') void cancelPasskey(); busy = false; });
  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !available || !password.value) return;
    const current = ++epoch, passwordValue = password.value; password.value = '';
    busy = 'prompt'; controls(); error.textContent = '';
    try {
      const client = await webauthn();
      if (current !== epoch) return;
      const result = await api('/api/passkeys/register/options', { password: passwordValue });
      if (current !== epoch) { await cancelPasskey(); return; }
      status.textContent = '请在系统提示中确认绑定…';
      const response = await client.startRegistration({ optionsJSON: result.options });
      if (current !== epoch) return;
      busy = 'saving'; controls(); status.textContent = '正在保存绑定，请稍候…';
      try { await api('/api/passkeys/register/verify', { response }); }
      catch (reason) { throw Error(`${passkeyError(reason)} 请刷新列表确认是否已绑定，勿直接重复绑定。`); }
      if (current !== epoch) return;
      await load(); status.textContent = '通行密钥已绑定。下次可在登录页使用。';
    } catch (reason) { if (current === epoch) error.textContent = passkeyError(reason); }
    finally { if (current === epoch) { password.value = ''; busy = false; controls(); } }
  };
}
