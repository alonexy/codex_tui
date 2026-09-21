// Mermaid is loaded only when a complete diagram enters the reading viewport.
const MAX_SOURCE = 16000;
const cache = new Map();
let renderer, serial = 0, queue = Promise.resolve();
let visibility;
const waiting = new WeakMap();

function observe(block, load) {
  if (!visibility) {
    visibility = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting && waiting.has(entry.target)) {
        const start = waiting.get(entry.target); waiting.delete(entry.target);
        visibility.unobserve(entry.target); start();
      }
    }, { rootMargin: '240px' });
    new MutationObserver(records => {
      for (const record of records) for (const node of [...record.removedNodes, ...record.addedNodes]) {
        if (node.nodeType !== 1) continue;
        const blocks = [...node.querySelectorAll('.mermaid-block')];
        if (node.matches('.mermaid-block')) blocks.push(node);
        for (const item of blocks) {
          if (!item.isConnected) visibility.unobserve(item);
          else if (waiting.has(item)) visibility.observe(item);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  waiting.set(block, load); visibility.observe(block);
}

export function fencedBlock(lines, index) {
  const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
  if (!opening) return null;
  const fence = opening[1], language = opening[2].trim().toLowerCase();
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
  let end = index + 1;
  while (end < lines.length && !closing.test(lines[end])) end++;
  return { language, closed: end < lines.length, end, source: lines.slice(index + 1, end).join('\n') + (end > index + 1 ? '\n' : '') };
}

function frame() {
  if (renderer) return renderer;
  const iframe = document.createElement('iframe');
  iframe.className = 'mermaid-renderer'; iframe.title = '图形渲染器';
  iframe.setAttribute('sandbox', 'allow-scripts'); iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  const state = { iframe, pending: null };
  state.ready = new Promise((resolve, reject) => {
    state.rejectReady = reject;
    state.timer = setTimeout(() => reset(state, new Error('图形资源加载超时')), 15000);
    state.receive = event => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (data?.type === 'mermaid-ready') { clearTimeout(state.timer); resolve(); }
      if (data?.type !== 'mermaid-result' || !state.pending || data.id !== state.pending.id) return;
      const pending = state.pending; state.pending = null; clearTimeout(pending.timer);
      if (typeof data.svg !== 'string' || data.svg.length > 2000000 || !data.svg.startsWith('<svg')) pending.reject(new Error('图形无法渲染'));
      else pending.resolve('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.svg));
    };
    window.addEventListener('message', state.receive);
    iframe.onerror = () => reset(state, new Error('图形资源暂不可用'));
  });
  renderer = state; iframe.src = '/mermaid-renderer'; document.body.append(iframe);
  return state;
}

function reset(state, error) {
  clearTimeout(state.timer); clearTimeout(state.pending?.timer);
  state.rejectReady(error); state.pending?.reject(error);
  window.removeEventListener('message', state.receive); state.iframe.remove();
  if (renderer === state) renderer = null;
}

function diagram(source) {
  if (cache.has(source)) return cache.get(source);
  const result = queue.catch(() => {}).then(async () => {
    const state = frame(); await state.ready;
    return new Promise((resolve, reject) => {
      const id = ++serial;
      state.pending = { id, resolve, reject, timer: setTimeout(() => reset(state, new Error('图形渲染超时')), 12000) };
      state.iframe.contentWindow.postMessage({ type: 'mermaid-render', id, source }, '*');
    });
  });
  queue = result; cache.set(source, result);
  result.catch(() => { if (cache.get(source) === result) cache.delete(source); });
  while (cache.size > 24) cache.delete(cache.keys().next().value);
  return result;
}

function button(text, action) {
  const node = document.createElement('button'); node.type = 'button';
  node.className = 'secondary'; node.textContent = text; node.onclick = action; return node;
}

export function mermaidBlock(source) {
  const block = document.createElement('section'); block.className = 'mermaid-block';
  block.mermaidSource = source;
  const toolbar = document.createElement('div'); toolbar.className = 'mermaid-toolbar';
  const label = document.createElement('span'); label.textContent = 'Mermaid';
  const code = document.createElement('pre'); code.textContent = source; code.tabIndex = 0;
  const status = document.createElement('p'); status.className = 'muted small'; status.setAttribute('role', 'status');
  const preview = button('', () => openDiagram(preview.querySelector('img').src));
  preview.className = 'mermaid-preview'; preview.setAttribute('aria-label', '放大图形'); preview.hidden = true;
  let sourceVisible = false, complete = false;
  const toggle = button('查看源码', () => { sourceVisible = !sourceVisible; show(); });
  const copy = button('复制源码', async () => {
    try { await navigator.clipboard.writeText(source); copy.textContent = '已复制'; }
    catch { sourceVisible = true; show(); copy.textContent = '请长按源码复制'; }
  });
  const retry = button('重试图形', () => load()); retry.hidden = true;
  function show() {
    code.hidden = complete && !sourceVisible; preview.hidden = !complete || sourceVisible;
    toggle.textContent = sourceVisible ? '查看图形' : '查看源码'; toggle.hidden = !complete;
  }
  async function load() {
    retry.hidden = true; status.hidden = false; status.textContent = '正在生成图形…';
    try {
      const url = await diagram(source);
      const img = document.createElement('img'); img.alt = 'Mermaid 图形，点击放大浏览'; img.src = url;
      await img.decode(); preview.replaceChildren(img);
      complete = true; status.textContent = '点击图形放大 · 支持缩放和平移'; show();
    } catch {
      cache.delete(source);
      status.textContent = '图形暂不可用，源码已保留。可重试或复制源码。'; retry.hidden = false; show();
    }
  }
  toolbar.append(label, toggle, copy, retry); block.append(toolbar, preview, status, code); show();
  if (source.length > MAX_SOURCE || /^\s*---(?:\r?\n|$)/.test(source) || /%%\s*\{/.test(source)) {
    status.textContent = source.length > MAX_SOURCE ? '图形过大，请复制源码查看。' : '此图包含自定义配置，已保留源码供查看。';
  } else {
    status.textContent = '图形将在滚动到这里时加载';
    observe(block, load);
  }
  return block;
}

function openDiagram(url) {
  const dialog = document.createElement('dialog'); dialog.className = 'mermaid-dialog';
  dialog.setAttribute('aria-label', '图形查看器');
  const toolbar = document.createElement('div'); toolbar.className = 'mermaid-toolbar';
  const title = document.createElement('strong'); title.textContent = '图形';
  const scale = document.createElement('output'); scale.setAttribute('aria-live', 'polite');
  const viewport = document.createElement('div'); viewport.className = 'mermaid-viewport'; viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', '拖动或双指缩放图形，也可使用缩放按钮');
  const canvas = document.createElement('div'); canvas.className = 'mermaid-canvas';
  const img = document.createElement('img'); img.src = url; img.alt = '放大后的 Mermaid 图形'; img.draggable = false;
  canvas.append(img); viewport.append(canvas);
  let zoom = 1, fitWidth = 1, fitHeight = 1;
  function resize(next, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
    next = Math.max(1, Math.min(12, next));
    const ratio = next / zoom, x = (viewport.scrollLeft + anchorX) * ratio - anchorX, y = (viewport.scrollTop + anchorY) * ratio - anchorY;
    zoom = next; img.style.width = `${fitWidth * zoom}px`; img.style.height = `${fitHeight * zoom}px`;
    viewport.scrollLeft = x; viewport.scrollTop = y; scale.value = `${Math.round(zoom * 100)}%`;
  }
  function fit() {
    const ratio = Math.min((viewport.clientWidth - 24) / img.naturalWidth, (viewport.clientHeight - 24) / img.naturalHeight, 1);
    fitWidth = img.naturalWidth * ratio; fitHeight = img.naturalHeight * ratio;
    resize(1); viewport.scrollLeft = viewport.scrollTop = 0;
  }
  toolbar.append(title, button('−', () => resize(zoom / 1.5)), scale, button('＋', () => resize(zoom * 1.5)), button('适配', fit), button('关闭', () => dialog.close()));
  toolbar.children[1].setAttribute('aria-label', '缩小图形'); toolbar.children[3].setAttribute('aria-label', '放大图形');
  const hint = document.createElement('p'); hint.className = 'muted small'; hint.textContent = '拖动平移 · 双指缩放 · 双击放大';
  dialog.append(toolbar, hint, viewport); document.body.append(dialog); dialog.showModal();
  img.decode().then(fit).catch(() => dialog.close());
  const pointers = new Map();
  viewport.onpointerdown = event => { pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); viewport.setPointerCapture(event.pointerId); };
  viewport.onpointermove = event => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    const before = [...pointers.values()]; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) { viewport.scrollLeft -= event.clientX - previous.x; viewport.scrollTop -= event.clientY - previous.y; }
    else if (pointers.size === 2) {
      const after = [...pointers.values()], distance = points => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const bounds = viewport.getBoundingClientRect(), oldDistance = distance(before);
      if (oldDistance > 0) resize(zoom * distance(after) / oldDistance, (after[0].x + after[1].x) / 2 - bounds.left, (after[0].y + after[1].y) / 2 - bounds.top);
    }
  };
  viewport.onpointerup = viewport.onpointercancel = event => pointers.delete(event.pointerId);
  viewport.ondblclick = () => resize(zoom === 1 ? 2 : 1);
  viewport.addEventListener('wheel', event => { if (event.ctrlKey) { event.preventDefault(); resize(zoom * Math.exp(-event.deltaY / 300)); } }, { passive: false });
  dialog.addEventListener('close', () => { window.removeEventListener('resize', fit); dialog.remove(); });
  window.addEventListener('resize', fit);
}
