import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Only images referenced by a task response get an opaque, authenticated URL.
// No endpoint accepts a filesystem path supplied by the browser.
export function taskImages() {
  const paths = new Map(), tokens = new Map();
  function register(thread) {
    const result = {};
    const add = path => {
      if (typeof path !== 'string' || !isAbsolute(path) || !/\.(png|jpe?g|gif|webp)$/i.test(path)) return;
      if (!paths.has(path)) {
        if (paths.size >= 2000) return;
        const token = randomUUID(); paths.set(path, token); tokens.set(token, path);
      }
      result[path] = `/api/images/${paths.get(path)}`;
    };
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.type === 'localImage') add(value.path);
      if (typeof value.text === 'string') {
        for (const match of value.text.matchAll(/(?:\]\(|path=\")((?:\/[^\n\r"<>]+?)\.(?:png|jpe?g|gif|webp))(?:\)|\")/gi)) add(match[1]);
      }
      for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
    };
    visit(thread);
    return result;
  }
  async function read(token) {
    const path = tokens.get(token);
    if (!path) return null;
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw Error('图片过大或不可读取');
      const data = await file.readFile();
      const type = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
        : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
        : /^GIF8[79]a$/.test(data.subarray(0,6).toString()) ? 'image/gif'
        : data.subarray(0,4).toString() === 'RIFF' && data.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
      if (!type) throw Error('不是支持的图片格式');
      return { data, type };
    } finally { await file.close(); }
  }
  return { register, read };
}
