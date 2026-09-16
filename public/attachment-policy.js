export const textExtensions = new Set('txt md markdown log csv json jsonl ndjson yaml yml toml xml html htm css scss less js mjs cjs jsx ts tsx py rb go rs java c h cc cpp hpp cs swift kt kts sh bash zsh sql r vue svelte ini cfg conf'.split(' '));
export const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'webp']);
export const officeExtensions = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
export const maxAttachments = 10, maxTotalBytes = 50 * 1024 * 1024;
export function attachmentKind(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  return imageExtensions.has(ext) ? 'image' : textExtensions.has(ext) || officeExtensions.has(ext) || ext === 'pdf' ? 'file' : null;
}
export function checkAttachment(name, size) {
  const kind = attachmentKind(name);
  if (!kind) throw Error('仅支持图片、文本/代码、PDF、Word、Excel 和 PPT 文件');
  if (!Number.isSafeInteger(size) || size <= 0 || size > (kind === 'image' ? 8 : 20) * 1024 * 1024) throw Error(kind === 'image' ? '每张图片最多 8 MiB，不能是空文件' : '每个文件最多 20 MiB，不能是空文件');
  return kind;
}
export function formatBytes(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1048576).toFixed(1)} MiB`; }
