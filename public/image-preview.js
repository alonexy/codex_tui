// One modal and one temporary history entry, shared by all conversation images.
export function imagePreview({ changed = () => {} } = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'image-dialog';
  dialog.setAttribute('aria-label', '图片预览');
  const toolbar = document.createElement('div'); toolbar.className = 'image-preview-toolbar';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '返回会话'; close.autofocus = true;
  const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'secondary'; zoom.textContent = '查看原尺寸';
  zoom.setAttribute('aria-pressed', 'false');
  const status = document.createElement('p'); status.className = 'image-preview-status'; status.setAttribute('role', 'status');
  const stage = document.createElement('div'); stage.className = 'image-preview-stage'; stage.tabIndex = 0; stage.setAttribute('aria-label', '图片，可滚动查看原尺寸');
  toolbar.append(close, zoom); dialog.append(toolbar, status, stage); document.body.append(dialog);
  const key = 'codexImagePreview';
  let active = false, closing = false, saved, current, image, token, sequence = 0;

  function finish() {
    if (!active || !dialog.open) return;
    image.onload = null; image.onerror = null;
    image?.remove();
    document.body.classList.remove('image-preview-open');
    document.body.style.removeProperty('--image-preview-top');
    document.body.style.removeProperty('--image-preview-left');
    window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
    // Keep navigation restoration manual through popstate and expose "closed"
    // only once the unlocked document and its saved reading position are ready.
    requestAnimationFrame(() => {
      dialog.close();
      saved.focus?.isConnected && saved.focus.focus({ preventScroll: true });
      window.scrollTo({ left: saved.x, top: saved.y, behavior: 'instant' });
      history.scrollRestoration = saved.restoration;
      active = false; closing = false; changed(false);
      if (current && history.state?.[key] === token) show(current.source, current.description, current.trigger, false);
    });
  }

  function requestClose() {
    if (!active || closing) return;
    closing = true;
    if (history.state?.[key] === token) history.back();
    else finish();
  }

  function show(source, description, trigger, push = true) {
    if (active) return;
    saved = { x: window.scrollX, y: window.scrollY, focus: trigger, restoration: history.scrollRestoration };
    current = { source, description, trigger };
    active = true; closing = false; changed(true);
    history.scrollRestoration = 'manual';
    if (push) {
      token = `${Date.now()}-${++sequence}`;
      history.pushState({ ...history.state, [key]: token }, '');
    }
    document.body.style.setProperty('--image-preview-top', `${-saved.y}px`);
    document.body.style.setProperty('--image-preview-left', `${-saved.x}px`);
    document.body.classList.add('image-preview-open');
    stage.classList.remove('original-size'); stage.scrollTop = 0; stage.scrollLeft = 0;
    zoom.textContent = '查看原尺寸'; zoom.setAttribute('aria-pressed', 'false'); zoom.disabled = true;
    status.textContent = '正在加载图片…';
    image = document.createElement('img'); image.alt = description; image.referrerPolicy = 'no-referrer';
    image.onload = () => { status.textContent = '可切换原尺寸，滑动查看细节'; zoom.disabled = false; };
    image.onerror = () => { status.textContent = '图片已失效或暂时无法读取，可返回会话'; zoom.disabled = true; };
    image.src = source; stage.replaceChildren(image);
    dialog.showModal();
  }

  close.addEventListener('click', requestClose);
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  zoom.addEventListener('click', () => {
    const original = stage.classList.toggle('original-size');
    zoom.textContent = original ? '适应屏幕' : '查看原尺寸';
    zoom.setAttribute('aria-pressed', String(original));
    stage.scrollTop = 0; stage.scrollLeft = 0;
  });
  window.addEventListener('popstate', () => {
    if (active && history.state?.[key] !== token) finish();
    else if (!active && current && history.state?.[key] === token) show(current.source, current.description, current.trigger, false);
  });
  return { open: show, get active() { return active; } };
}
