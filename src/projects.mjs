import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';

// Read only the desktop's project metadata; never modify its state or expose other settings.
export async function desktopProjects(path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), '.codex-global-state.json')) {
  const state = JSON.parse(await readFile(path, 'utf8'));
  const local = state['local-projects'];
  if (!local || typeof local !== 'object') throw Error('桌面项目配置不可用，请在桌面确认项目列表');
  const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const ids = [...new Set([...order, ...Object.keys(local)])];
  const serverIds = state['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${dirname(path)}`] ?? {};
  const projects = ids.flatMap(id => {
    const item = local[id];
    if (!item || typeof item.name !== 'string' || !Array.isArray(item.rootPaths)) return [];
    const roots = item.rootPaths.filter(path => typeof path === 'string' && isAbsolute(path));
    return roots.length ? [{ id, name: item.name, roots, ...(typeof serverIds[id] === 'string' ? { serverId: serverIds[id] } : {}) }] : [];
  });
  const known = new Set(projects.map(project => project.id));
  const assignments = {};
  for (const [id, assignment] of Object.entries(state['thread-project-assignments'] ?? {})) {
    if (assignment?.projectKind === 'local' && known.has(assignment.projectId)) assignments[id] = assignment.projectId;
  }
  for (const id of state['projectless-thread-ids'] ?? []) if (typeof id === 'string') assignments[id] = null;
  return { projects, assignments };
}
