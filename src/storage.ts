import { STORAGE_KEY } from './constants';
import type { ProjectRecord, StoredState } from './types';
import { normalizeLoadedProject, nowIso } from './utils';

export function loadStoredState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, savedAt: nowIso(), projects: [] };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      version: 1,
      savedAt: parsed.savedAt || nowIso(),
      activeProjectId: parsed.activeProjectId,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.map((project) => normalizeLoadedProject(project))
        : []
    };
  } catch {
    return { version: 1, savedAt: nowIso(), projects: [] };
  }
}

export function persistStoredState(projects: ProjectRecord[], activeProjectId?: string) {
  const payload: StoredState = {
    version: 1,
    savedAt: nowIso(),
    activeProjectId,
    projects: projects.map((project) => ({
      ...project,
      assets: project.assets.map((asset) => ({ ...asset, objectUrl: undefined }))
    }))
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}
