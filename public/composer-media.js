export function composerMedia({ getThread, busy, api, changed, error }) {
  const $ = id => document.getElementById(id);
  const drafts = new Map();
  let recognition, speechThread, reading = false;
  const items = () => drafts.get(getThread()) ?? [];
  function render() {
    if (recognition && speechThread !== getThread()) recognition.abort();
    $('attach-image').disabled = busy() || reading || !getThread();
    $('voice-input').disabled = busy() || !getThread();
    $('message').required = !items().length;
    $('image-previews').replaceChildren(...items().map(item => {
      const card = document.createElement('div'); card.className = 'upload-preview';
      const img = document.createElement('img'); img.src = item.data; img.alt = item.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `移除图片 ${item.name}`); remove.disabled = busy();
      remove.onclick = () => { drafts.set(getThread(), items().filter(other => other !== item)); render(); changed(); };
      card.append(img, remove); return card;
    }));
    $('image-previews').hidden = !items().length;
  }
  async function add(files) {
    if (busy() || reading || !getThread()) return;
    const id = getThread(), count = items().length, added = [];
    reading = true; render();
    try {
      if (count + files.length > 4) throw Error('每条消息最多 4 张图片');
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw Error('请选择 PNG、JPEG 或 WebP 图片');
        if (file.size > 8 * 1024 * 1024) throw Error('每张图片最多 8 MB');
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('图片读取失败')); reader.readAsDataURL(file);
        });
        added.push({ name: file.name || '截图', data });
      }
      // A late receipt may remove submitted images while this file is being read.
      drafts.set(id, [...(drafts.get(id) ?? []), ...added]);
    } catch (e) { error(e); }
    finally { reading = false; render(); changed(); }
  }
  $('attach-image').onclick = () => $('image-files').click();
  $('image-files').onchange = () => { add([...$('image-files').files]); $('image-files').value = ''; };
  $('message').addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
    if (files.length) { event.preventDefault(); add(files); }
  });
  $('voice-input').onclick = () => {
    if (recognition) { recognition.stop(); return; }
    if (!window.isSecureContext) {
      $('message').focus();
      error(Error('当前是 HTTP 页面，浏览器限制网页麦克风。请改用有效的 HTTPS 地址；现在可点击手机键盘的麦克风进行听写。'));
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) { error(Error('此浏览器不支持语音识别，可使用手机键盘的听写按钮。')); return; }
    const instance = new Recognition(); recognition = instance; speechThread = getThread();
    instance.lang = navigator.language || 'zh-CN'; instance.interimResults = true;
    const initial = $('message').value;
    $('voice-input').setAttribute('aria-pressed', 'true');
    $('voice-input').setAttribute('aria-label', '停止语音输入');
    $('media-status').textContent = '正在听…再次点击麦克风结束';
    instance.onresult = event => {
      if (speechThread !== getThread() || recognition !== instance) return;
      const text = Array.from(event.results, result => result[0].transcript).join('');
      $('message').value = initial + (initial && text ? '\n' : '') + text;
      $('message').dispatchEvent(new Event('input', { bubbles: true }));
    };
    instance.onerror = event => {
      const messages = {
        'not-allowed': '麦克风权限被拒绝，请检查 Chrome 网站权限和手机系统的麦克风权限。',
        'audio-capture': '无法使用麦克风，请检查系统权限或是否被其他应用占用。',
        'network': '无法连接浏览器的语音识别服务，可改用手机键盘听写。',
        'no-speech': '未检测到语音，请再试一次。',
        'service-not-allowed': '此浏览器未开放语音识别服务，可改用手机键盘听写。',
      };
      if (event.error !== 'aborted') error(Error(messages[event.error] ?? `语音识别未完成：${event.error}`));
    };
    instance.onend = () => {
      if (recognition !== instance) return;
      recognition = null; $('voice-input').setAttribute('aria-pressed', 'false'); $('voice-input').setAttribute('aria-label', '语音输入'); $('media-status').textContent = ''; changed();
    };
    try { instance.start(); } catch (e) { instance.onend(); error(e); }
  };
  window.addEventListener('pagehide', () => recognition?.abort());
  return {
    render, hasImages: () => !!items().length, reading: () => reading,
    capture: () => ({ threadId: getThread(), items: [...items()] }),
    async input() {
      recognition?.stop();
      const result = [];
      for (const item of items()) {
        item.upload ??= await api('/api/uploads', { image: item.data });
        result.push(item.upload);
      }
      return result;
    },
    clear(snapshot) {
      const remaining = (drafts.get(snapshot.threadId) ?? []).filter(item => !snapshot.items.includes(item));
      if (remaining.length) drafts.set(snapshot.threadId, remaining);
      else drafts.delete(snapshot.threadId);
      render();
    },
  };
}
