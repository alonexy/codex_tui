import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function saveUpload(directory, value) {
  const match = typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw Error('请选择 PNG、JPEG 或 WebP 图片');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 8 * 1024 * 1024) throw Error('每张图片最多 8 MB');
  const valid = match[1] === 'png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
    : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw Error('图片内容与格式不匹配');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.${match[1]}`);
  await writeFile(path, data, { mode: 0o600, flag: 'wx' });
  return { type: 'localImage', path };
}
