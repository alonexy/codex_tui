import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const validMode = value => value === 'plan' || value === 'default';
const maxBytes = 16 * 1024 * 1024;

// Only paths from native thread responses are eligible. Browser requests contain IDs, never paths.
export function threadModes({ readContext = lastTurnContext } = {}) {
  const paths = new Map();
  return {
    register(result) {
      const thread = result?.thread;
      if (typeof thread?.id !== 'string' || !thread.id) return;
      if (paths.size >= 2000 && !paths.has(thread.id)) return;
      const path = typeof thread.path === 'string' && isAbsolute(thread.path) ? thread.path : paths.get(thread.id) ?? null;
      paths.set(thread.id, path);
    },
    async read(threadId, state) {
      if (!paths.has(threadId)) return null;
      const settings = state.threadSettings?.[threadId];
      if (settings && Object.hasOwn(settings, 'collaborationMode')) {
        const mode = settings.collaborationMode?.mode;
        return { threadId, collaborationMode: validMode(mode) ? { mode } : null, source: 'runtime' };
      }
      let context;
      try { if (paths.get(threadId)) context = await readContext(paths.get(threadId)); }
      catch { /* Missing, truncated or unreadable records never imply a default mode. */ }
      if (!context) return { threadId, collaborationMode: null, source: 'unavailable' };
      return {
        threadId, collaborationMode: { mode: context.mode }, turnId: context.turnId,
        source: context.turnId && state.active?.[threadId] === context.turnId ? 'current-turn' : 'last-turn',
      };
    },
  };
}

// Scan newest records first, with bounded I/O and allocation even for very large transcripts.
// Only turn_context metadata leaves this function; prompts and developer instructions do not.
export async function lastTurnContext(path, limit = maxBytes) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    let position = stat.size, consumed = 0, suffix = Buffer.alloc(0), dropPartial = false;
    const inspect = line => {
      if (!line.includes('turn_context')) return undefined;
      let record;
      try { record = JSON.parse(line); } catch { return undefined; }
      if (record?.type !== 'turn_context') return undefined;
      const value = record.payload;
      return validMode(value?.collaboration_mode?.mode)
        ? { mode: value.collaboration_mode.mode, turnId: typeof value.turn_id === 'string' ? value.turn_id : null }
        : null;
    };
    while (position > 0 && consumed < limit) {
      const length = Math.min(64 * 1024, position, limit - consumed);
      position -= length; consumed += length;
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await file.read(chunk, 0, length, position);
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), suffix]);
      let end = combined.length;
      for (let index = combined.length - 1; index >= 0; index--) {
        if (combined[index] !== 10) continue;
        if (!dropPartial && index + 1 < end) {
          const result = inspect(combined.subarray(index + 1, end).toString('utf8'));
          if (result !== undefined) return result;
        }
        dropPartial = false; end = index;
      }
      // A giant response item is irrelevant to mode. Skip it without growing memory unboundedly.
      if (end > 1024 * 1024) { suffix = Buffer.alloc(0); dropPartial = true; }
      else suffix = combined.subarray(0, end);
    }
    if (position === 0 && !dropPartial && suffix.length) return inspect(suffix.toString('utf8')) ?? null;
    return null;
  } finally { await file.close(); }
}
