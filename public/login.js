const form = document.getElementById('login');
const password = document.getElementById('password');
const button = document.getElementById('login-submit');
const error = document.getElementById('login-error');
const toggle = document.getElementById('show-password');
try { sessionStorage.removeItem('codex-token'); } catch { /* Storage access is not required for login. */ }
if (location.search || location.hash) history.replaceState(null, '', '/login');
toggle.onclick = () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.textContent = show ? '隐藏' : '显示';
  toggle.setAttribute('aria-pressed', String(show));
};
form.onsubmit = async event => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在验证…';
  error.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '登录失败');
    password.value = '';
    location.replace('/');
  } catch (reason) {
    error.textContent = reason.name === 'TimeoutError' ? '连接超时，请检查网络后再试。' : reason.message;
    password.focus();
  } finally {
    button.disabled = false;
    button.textContent = '验证并进入';
  }
};
error.textContent = '';
button.disabled = false;
