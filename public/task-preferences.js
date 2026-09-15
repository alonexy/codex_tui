const key = 'codex-task-preferences-v1';
const validText = value => typeof value === 'string' && value.length <= 4096;

function favoriteTask(task) {
  if (!task || !validText(task.id) || !task.id) return null;
  const result = { id: task.id };
  for (const field of ['name', 'preview', 'cwd', 'projectId']) if (validText(task[field])) result[field] = task[field];
  if (typeof task.updatedAt === 'number' || validText(task.updatedAt)) result.updatedAt = task.updatedAt;
  return result;
}

// Preferences stay local to this browser. Storage restrictions never block task use.
export function taskPreferences(storage) {
  let stored;
  try {
    storage ??= globalThis.localStorage;
    stored = JSON.parse(storage?.getItem(key) ?? 'null');
  } catch { /* Private browsing, disabled storage, or malformed preferences. */ }
  const entries = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : [];
  const expansion = new Map(entries(stored?.expansion).filter(([, value]) => typeof value === 'boolean'));
  const workspaces = new Map(entries(stored?.workspaces).filter(([, value]) => validText(value)));
  const favorites = new Map((Array.isArray(stored?.favorites) ? stored.favorites : []).map(favoriteTask).filter(Boolean).map(task => [task.id, task]));
  let lastProject = validText(stored?.lastProject) ? stored.lastProject : null;
  function save() {
    try {
      storage?.setItem(key, JSON.stringify({ expansion: Object.fromEntries(expansion), workspaces: Object.fromEntries(workspaces), favorites: [...favorites.values()], lastProject }));
    } catch { /* Keep the working in-memory preferences if storage is unavailable. */ }
  }
  return {
    expanded: id => expansion.get(id) ?? true,
    setExpanded(id, open) { expansion.set(id, open); save(); },
    workspace: id => workspaces.get(id),
    lastProject: () => lastProject,
    rememberWorkspace(id, cwd) {
      lastProject = id;
      if (validText(cwd) && cwd) workspaces.set(id, cwd);
      save();
    },
    isFavorite: id => favorites.has(id),
    favorites: () => [...favorites.values()].map(task => ({ ...task })),
    toggleFavorite(task) {
      const value = favoriteTask(task);
      if (!value) return false;
      if (favorites.has(value.id)) favorites.delete(value.id);
      else favorites.set(value.id, value);
      save();
      return favorites.has(value.id);
    },
    refreshFavorites(tasks) {
      let changed = false;
      for (const task of tasks) {
        if (!favorites.has(task.id)) continue;
        const value = favoriteTask(task);
        if (!value || JSON.stringify(value) === JSON.stringify(favorites.get(task.id))) continue;
        favorites.set(task.id, value); changed = true;
      }
      if (changed) save();
    },
  };
}
