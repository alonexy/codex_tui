import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read only display metadata. The cache also contains internal model instructions.
export async function desktopModels({ path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'), now = Date.now } = {}) {
  let cache;
  try { cache = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw Error('模型目录不可用，请在桌面完成模型同步后重试。'); }
  if (!Array.isArray(cache?.models)) throw Error('模型目录格式不可用，请在桌面完成模型同步后重试。');
  const seen = new Set();
  const models = cache.models
    .filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug.trim())
    .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : Infinity) - (Number.isFinite(b.priority) ? b.priority : Infinity))
    .flatMap(model => {
      if (seen.has(model.slug)) return [];
      seen.add(model.slug);
      const efforts = new Set();
      const supportedReasoningEfforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []).flatMap(option => {
        if (typeof option?.effort !== 'string' || !option.effort.trim() || efforts.has(option.effort)) return [];
        efforts.add(option.effort);
        return [{ effort: option.effort, description: typeof option.description === 'string' ? option.description : '' }];
      });
      return [{
        id: model.slug,
        displayName: typeof model.display_name === 'string' && model.display_name ? model.display_name : model.slug,
        description: typeof model.description === 'string' ? model.description : '',
        defaultReasoningEffort: efforts.has(model.default_reasoning_level) ? model.default_reasoning_level : null,
        supportedReasoningEfforts,
      }];
    });
  const timestamp = typeof cache.fetched_at === 'string' ? Date.parse(cache.fetched_at) : NaN;
  const fetchedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  return { source: 'desktop-cache', fetchedAt, stale: !fetchedAt || now() - timestamp > 24 * 60 * 60 * 1000, models };
}
