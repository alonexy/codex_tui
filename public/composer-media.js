import { checkAttachment, formatBytes, maxAttachments, maxTotalBytes } from './attachment-policy.js';

function uploadId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function composerMedia({ getThread, busy, api, changed, error, uploaded = () => {} }) {
  const $ = id => document.getElementById(id);
  const drafts = new Map();
  const batches = new Map();
  let recognition, speechThread, reading = false;
  const items = () => drafts.get(getThread()) ?? [];
  function render() {
    if (recognition && speechThread !== getThread()) recognition.abort();
    $('attach-image').disabled = busy() || reading || !getThread();
    $('voice-input').disabled = busy() || !getThread();
    $('message').required = !items().length;
    $('image-previews').replaceChildren(...items().map(item => {
      const card = document.createElement('div'); card.className = 'upload-preview';
      if (item.kind === 'image') {
        const img = document.createElement('img'); img.src = item.data; img.alt = item.name; card.append(img);
      } else { card.classList.add('file-preview'); }
      const details = document.createElement('span'); details.className = 'upload-details';
      const name = document.createElement('span'); name.className = 'upload-name'; name.textContent = item.name;
      const state = document.createElement('span'); state.className = 'upload-state'; state.textContent = `${formatBytes(item.file.size)} · ${item.status ?? '待上传'}`;
      details.append(name, state); card.append(details);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
      remove.setAttribute('aria-label', `移除附件 ${item.name}`); remove.disabled = busy();
      remove.onclick = () => { drafts.set(getThread(), items().filter(other => other !== item)); render(); changed(); };
      card.append(remove); return card;
    }));
    $('image-previews').hidden = !items().length;
  }
  async function add(files) {
    if (busy() || reading || !getThread()) return;
    const id = getThread(), count = items().length, added = [];
    reading = true; render();
    try {
      if (count + files.length > maxAttachments) throw Error('每条消息最多 10 个附件');
      if ([...items().map(item => item.file), ...files].reduce((sum, file) => sum + file.size, 0) > maxTotalBytes) throw Error('每条消息附件合计最多 50 MiB');
      for (const file of files) {
        const kind = checkAttachment(file.name, file.size);
        const data = kind === 'image' ? await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(Error('图片读取失败')); reader.readAsDataURL(file);
        }) : null;
        added.push({ id: uploadId(), name: file.name, file, data, kind });
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
      const thread = getThread(), snapshot = [...items()];
      if (!snapshot.length) return [];
      if (!batches.has(thread)) batches.set(thread, uploadId());
      const batch = batches.get(thread);
      // Reconcile removed files without deleting bytes referenced by earlier history.
      await api('/api/attachment-batches', { batch, keep: snapshot.map(item => item.id) });
      const result = [];
      for (const item of snapshot) {
        if (!item.upload) {
          item.status = '上传中'; render();
          try {
            item.upload = await new Promise((resolve, reject) => {
              const request = new XMLHttpRequest();
              request.open('POST', `/api/attachments?batch=${batch}&id=${item.id}`);
              request.setRequestHeader('Content-Type', 'application/octet-stream');
              request.setRequestHeader('X-Attachment-Name', encodeURIComponent(item.name));
              request.timeout = 120000;
              request.upload.onprogress = event => { if (event.lengthComputable) { item.status = `上传中 ${Math.round(event.loaded / event.total * 100)}%`; render(); } };
              request.onload = () => {
                let value; try { value = JSON.parse(request.responseText); } catch { reject(Error('上传响应无效，请重试')); return; }
                if (request.status >= 200 && request.status < 300) resolve(value);
                else reject(Error(value.error ?? '上传失败，请重试'));
              };
              request.onerror = request.ontimeout = () => reject(Error('上传未确认，请重试；已完成的附件会复用'));
              request.send(item.file);
            });
            item.status = '已上传';
            uploaded(item.upload, item.data);
          } catch (error) { item.status = '上传失败 · 可重试'; render(); throw error; }
          render();
        }
        result.push(item.upload.input);
      }
      return result;
    },
    clear(snapshot) {
      const remaining = (drafts.get(snapshot.threadId) ?? []).filter(item => !snapshot.items.includes(item));
      if (remaining.length) drafts.set(snapshot.threadId, remaining);
      else { drafts.delete(snapshot.threadId); batches.delete(snapshot.threadId); }
      render();
    },
  };
}
