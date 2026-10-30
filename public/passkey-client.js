export async function passkeyStatus() {
  const response = await fetch('/api/passkeys/status', { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw Error('通行密钥暂不可用，可继续使用密码。');
  const status = await response.json();
  if (!status.enabled) return status;
  if (!window.isSecureContext || !window.PublicKeyCredential || !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.())) return { enabled: false, reason: '此浏览器或设备不支持系统通行密钥验证，请使用密码。' };
  if (location.hostname !== status.rpID && !location.hostname.endsWith('.' + status.rpID)) return { enabled: false, reason: '当前域名不支持已配置的通行密钥，请使用密码。' };
  return status;
}

export async function requestPasskey(path, data = {}) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error ?? '通行密钥请求失败'), { status: response.status });
  return result;
}
export const passkeyError = error => ['NotAllowedError', 'AbortError'].includes(error.name)
  ? '系统验证已取消或超时，可重试或使用密码。' : error.name === 'InvalidStateError' ? '此设备可能已绑定通行密钥，请刷新列表核对。'
    : error.name === 'TimeoutError' ? '连接超时，请先核对绑定列表再重试。' : error.message || '验证失败，请使用密码。';

let library;
export function webauthn() { return library ??= import('./vendor/webauthn-browser.js'); }
export async function cancelPasskey() {
  try { (await library)?.WebAuthnAbortService.cancelCeremony(); } catch { /* Optional bundle may be unavailable. */ }
  try { await requestPasskey('/api/passkeys/cancel'); } catch { /* Server challenges also expire after two minutes. */ }
}

export function passkeyLogin({ onPasswordSubmit }) {
  const button = document.getElementById('passkey-login-button'), cancel = document.getElementById('passkey-login-cancel');
  const hint = document.getElementById('passkey-login-hint'), error = document.getElementById('passkey-login-error');
  let available = false, busy = false, epoch = 0;
  function controls() { button.disabled = busy || !available; cancel.hidden = !busy; button.textContent = busy ? '请完成系统验证…' : '使用通行密钥（Face ID）'; }
  const stop = () => { if (!busy) return; epoch++; busy = false; controls(); void cancelPasskey(); };
  onPasswordSubmit(stop);
  cancel.onclick = () => { stop(); error.textContent = '已取消，可继续输入访问密码。'; document.getElementById('password').focus(); };
  button.onclick = async () => {
    if (busy || !available) return;
    const current = ++epoch; busy = true; error.textContent = ''; controls();
    try {
      const client = await webauthn();
      if (current !== epoch) return;
      const { options } = await requestPasskey('/api/passkeys/authenticate/options');
      if (current !== epoch) { await cancelPasskey(); return; }
      const response = await client.startAuthentication({ optionsJSON: options });
      if (current !== epoch) return;
      await requestPasskey('/api/passkeys/authenticate/verify', { response });
      if (current === epoch) location.replace('/');
    } catch (reason) { if (current === epoch) error.textContent = passkeyError(reason); }
    finally { if (current === epoch) { busy = false; controls(); } }
  };
  window.addEventListener('pagehide', () => { epoch++; busy = false; controls(); (library ? library.then(value => value.WebAuthnAbortService.cancelCeremony()) : Promise.resolve()).catch(() => {}); });
  passkeyStatus().then(status => {
    available = status.enabled; hint.textContent = status.enabled ? '系统可能使用 Face ID、Touch ID 或设备密码验证；首次使用请先用密码登录并绑定。' : status.reason; controls();
  }).catch(reason => { hint.textContent = reason.message; controls(); });
}
