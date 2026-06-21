import type { AssetKind, ProjectRecord, TimelineTrack, TransformRecord } from './types';

export function uid(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatWhen(iso?: string): string {
  if (!iso) return 'Sin guardar';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'Modificado ahora';
  if (diff < 3_600_000) return `Modificado hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `Modificado hace ${Math.floor(diff / 3_600_000)} h`;
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(new Date(iso));
}

export function assetKindFromFile(file: File): AssetKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

export function defaultTransform(): TransformRecord {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 100
  };
}

export function createDefaultTracks(): TimelineTrack[] {
  return [
    { id: 'track_text', name: 'Texto', kind: 'text', locked: false, muted: false },
    { id: 'track_video_1', name: 'Video 1', kind: 'video', locked: false, muted: false },
    { id: 'track_audio_1', name: 'Audio 1', kind: 'audio', locked: false, muted: false }
  ];
}

export function createEmptyProject(name: string, parentId?: string): ProjectRecord {
  const createdAt = nowIso();
  return {
    id: uid('project'),
    name: sanitizeProjectName(name),
    folderId: parentId,
    createdAt,
    updatedAt: createdAt,
    duration: 12,
    width: 1920,
    height: 1080,
    fps: 30,
    assets: [],
    assetFolders: [],
    tracks: createDefaultTracks(),
    timeline: []
  };
}

export function sanitizeProjectName(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || 'nuevo video';
}

export function normalizeLoadedProject(raw: Partial<ProjectRecord>): ProjectRecord {
  const fallback = createEmptyProject(raw.name || 'nuevo video');
  return {
    ...fallback,
    ...raw,
    id: raw.id || fallback.id,
    name: sanitizeProjectName(raw.name || fallback.name),
    assets: Array.isArray(raw.assets) ? raw.assets : [],
    assetFolders: Array.isArray(raw.assetFolders) ? raw.assetFolders : [],
    tracks: Array.isArray(raw.tracks) && raw.tracks.length ? raw.tracks : createDefaultTracks(),
    timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
    duration: Number(raw.duration) || fallback.duration,
    width: Number(raw.width) || fallback.width,
    height: Number(raw.height) || fallback.height,
    fps: Number(raw.fps) || fallback.fps
  };
}
