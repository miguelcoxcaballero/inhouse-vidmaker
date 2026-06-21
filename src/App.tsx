import {
  ArrowLeft,
  ChevronRight,
  Download,
  Film,
  Folder,
  FolderInput,
  FolderPlus,
  Fullscreen,
  Home,
  Image as ImageIcon,
  Loader2,
  MoreVertical,
  Music,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Trash2,
  Type,
  Upload,
  User,
  Video
} from 'lucide-react';
import { ChangeEvent, CSSProperties, DragEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDriveClient } from './drive';
import { DRIVE_SYNC_DEBOUNCE_MS, PROJECT_APP_PROPERTY, PROJECT_FILE_NAME, PROJECT_FOLDER_PROPERTY } from './constants';
import { loadStoredState, persistStoredState } from './storage';
import type { AssetRecord, DriveClient, DriveFolder, DriveProjectFile, FolderPickerResult, ProjectRecord, SaveStatus, TimelineItem, TimelineTrack } from './types';
import {
  assetKindFromFile,
  clamp,
  createEmptyProject,
  defaultTransform,
  formatBytes,
  formatWhen,
  normalizeLoadedProject,
  nowIso,
  sanitizeProjectName,
  uid
} from './utils';

const drive = createDriveClient();

type DiffusionCore = typeof import('@diffusionstudio/core');

type BinEntry = {
  id: string;
  name: string;
  modifiedTime?: string;
  driveId?: string;
  projectId?: string;
};

type TimelineDragPreview = {
  source: 'asset' | 'clip';
  id: string;
  kind: TimelineItem['type'];
  start: number;
  duration: number;
  requestedTrackId: string;
  resolvedTrackId?: string;
  snapTime?: number;
};

function RoofLogo() {
  return (
    <svg viewBox="0 0 40 24" fill="none" aria-hidden="true">
      <path d="M4 22 L20 6 L36 22" stroke="#E07A3C" strokeWidth="4.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function statusCopy(status: SaveStatus) {
  if (status === 'saving') return 'Guardando...';
  if (status === 'uploading') return 'Subiendo...';
  if (status === 'saved') return 'Guardado';
  if (status === 'paused') return 'Pausado';
  if (status === 'error') return 'Error de guardado';
  if (status === 'local') return 'Guardado local';
  return 'Sin cambios';
}

function projectCardMeta(project: ProjectRecord) {
  const clips = project.timeline.length;
  const assets = project.assets.length;
  return `${formatWhen(project.updatedAt)} · ${clips} clips · ${assets} assets`;
}

function readAssetMetadata(kind: AssetRecord['kind'], objectUrl: string): Promise<Pick<AssetRecord, 'duration' | 'width' | 'height'>> {
  return new Promise((resolve) => {
    if (kind === 'image') {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({});
      image.src = objectUrl;
      return;
    }
    const media = document.createElement(kind === 'video' ? 'video' : 'audio');
    media.onloadedmetadata = () => resolve({
      duration: Number.isFinite(media.duration) ? media.duration : undefined,
      width: kind === 'video' ? (media as HTMLVideoElement).videoWidth : undefined,
      height: kind === 'video' ? (media as HTMLVideoElement).videoHeight : undefined
    });
    media.onerror = () => resolve({});
    media.src = objectUrl;
  });
}

function timelineItemsOverlap(start: number, duration: number, other: TimelineItem): boolean {
  const epsilon = 0.001;
  return start < other.start + other.duration - epsilon && start + duration > other.start + epsilon;
}

export function App() {
  const initial = useMemo(loadStoredState, []);
  const [projects, setProjects] = useState<ProjectRecord[]>(initial.projects);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(initial.activeProjectId);
  const [profile, setProfile] = useState(drive.profile);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [search, setSearch] = useState('');
  const [isFolderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerMode, setFolderPickerMode] = useState<'project' | 'folder'>('project');
  const [currentFolder, setCurrentFolder] = useState<DriveFolder>({ id: 'root', name: 'Mi unidad' });
  const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [trashTarget, setTrashTarget] = useState<ProjectRecord | null>(null);
  const [isBinOpen, setBinOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [isDragging, setDragging] = useState(false);
  const [focusedClipId, setFocusedClipId] = useState<string | undefined>();
  const syncTimerRef = useRef<number | null>(null);
  const syncPromiseRef = useRef<Promise<void> | null>(null);
  const syncQueuedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId),
    [activeProjectId, projects]
  );

  const visibleProjects = useMemo(() => {
    const term = search.trim().toLowerCase();
    const activeProjects = projects.filter((project) => !project.trashedAt);
    if (!term) return activeProjects;
    return activeProjects.filter((project) => project.name.toLowerCase().includes(term));
  }, [projects, search]);

  const homeFolders = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return driveFolders;
    return driveFolders.filter((folder) => folder.name.toLowerCase().includes(term));
  }, [driveFolders, search]);

  const loadDriveFolders = useCallback(async (folderId = currentFolder.id) => {
    if (!drive.accessToken) {
      setDriveFolders([]);
      return;
    }
    setFoldersLoading(true);
    try {
      const folders = await drive.listFolders(folderId);
      setDriveFolders(folders);
    } catch (error) {
      setDriveFolders([]);
      setToast(error instanceof Error ? error.message : 'No se pudieron cargar carpetas de Drive.');
    } finally {
      setFoldersLoading(false);
    }
  }, [currentFolder.id]);

  const updateProjects = useCallback((updater: (projects: ProjectRecord[]) => ProjectRecord[]) => {
    setProjects((current) => {
      const next = updater(current).map((project) => normalizeLoadedProject(project));
      persistStoredState(next, activeProjectId);
      setSaveStatus('local');
      return next;
    });
  }, [activeProjectId]);

  const patchActiveProject = useCallback((updater: (project: ProjectRecord) => ProjectRecord) => {
    setProjects((current) => {
      const next = current.map((project) => {
        if (project.id !== activeProjectId) return project;
        return normalizeLoadedProject({ ...updater(project), updatedAt: nowIso() });
      });
      persistStoredState(next, activeProjectId);
      setSaveStatus('local');
      return next;
    });
  }, [activeProjectId]);

  const runDriveSync = useCallback(async (project: ProjectRecord) => {
    if (!drive.accessToken || !project.folderId) {
      setSaveStatus('saved');
      return;
    }
    if (syncPromiseRef.current) {
      syncQueuedRef.current = true;
      return;
    }
    setSaveStatus('saving');
    const payload = {
      ...project,
      assets: project.assets.map((asset) => ({ ...asset, objectUrl: undefined }))
    };
    syncPromiseRef.current = (async () => {
      if (project.projectFileId) {
        await drive.patchJson(project.projectFileId, payload, { [PROJECT_APP_PROPERTY]: '1' });
      } else {
        const file = await drive.uploadJson(PROJECT_FILE_NAME, payload, project.folderId!, { [PROJECT_APP_PROPERTY]: '1' });
        setProjects((current) => {
          const next = current.map((item) => item.id === project.id ? { ...item, projectFileId: file.id } : item);
          persistStoredState(next, activeProjectId);
          return next;
        });
      }
    })()
      .then(() => setSaveStatus('saved'))
      .catch((error) => {
        console.error(error);
        setSaveStatus('error');
        setToast(error instanceof Error ? error.message : 'No se pudo guardar en Drive.');
      })
      .finally(() => {
        syncPromiseRef.current = null;
        if (syncQueuedRef.current) {
          syncQueuedRef.current = false;
          const latest = projects.find((item) => item.id === project.id) || project;
          void runDriveSync(latest);
        }
      });
    await syncPromiseRef.current;
  }, [activeProjectId, projects]);

  useEffect(() => {
    persistStoredState(projects, activeProjectId);
  }, [projects, activeProjectId]);

  useEffect(() => {
    if (!activeProject) return;
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    syncTimerRef.current = window.setTimeout(() => {
      void runDriveSync(activeProject);
    }, DRIVE_SYNC_DEBOUNCE_MS);
    return () => {
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    };
  }, [activeProject, runDriveSync]);

  useEffect(() => {
    if (!profile) return;
    void refreshDriveProjects();
    void loadDriveFolders(currentFolder.id);
  }, []);

  async function signIn() {
    try {
      setSaveStatus('paused');
      const nextProfile = await drive.signIn();
      setProfile(nextProfile);
      setSaveStatus('saved');
      await Promise.all([refreshDriveProjects(), loadDriveFolders('root')]);
    } catch (error) {
      setSaveStatus('error');
      setToast(error instanceof Error ? error.message : 'No se pudo iniciar sesion.');
    }
  }

  function signOut() {
    drive.signOut();
    setProfile(null);
    setActiveProjectId(undefined);
    setCurrentFolder({ id: 'root', name: 'Mi unidad' });
    setDriveFolders([]);
    setSaveStatus('local');
  }

  async function refreshDriveProjects() {
    if (!drive.accessToken) return;
    try {
      setSaveStatus('saving');
      const files = await drive.listProjects();
      const loaded = await Promise.all(files.map(async (file) => {
        const project = normalizeLoadedProject(await drive.downloadJson<ProjectRecord>(file.id));
        const assets = await Promise.all(project.assets.map(async (asset) => {
          if (!asset.driveFileId) return asset;
          try {
            const blob = await drive.downloadFile(asset.driveFileId);
            const objectUrl = URL.createObjectURL(blob);
            const metadata = asset.width || asset.height || asset.duration ? {} : await readAssetMetadata(asset.kind, objectUrl);
            return { ...asset, ...metadata, objectUrl, uploadState: 'uploaded' as const };
          } catch {
            return { ...asset, uploadState: 'error' as const };
          }
        }));
        return { ...project, assets, projectFileId: file.id, trashedAt: undefined, updatedAt: project.updatedAt || file.modifiedTime || nowIso() };
      }));
      setProjects((current) => {
        const byId = new Map(current.map((project) => [project.id, project]));
        loaded.forEach((project) => byId.set(project.id, project));
        const next = Array.from(byId.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        persistStoredState(next, activeProjectId);
        return next;
      });
      setSaveStatus('saved');
    } catch (error) {
      setSaveStatus('error');
      setToast(error instanceof Error ? error.message : 'No se pudieron cargar proyectos.');
    }
  }

  async function createProject(result: FolderPickerResult) {
    const project = createEmptyProject(result.projectName, result.parentId);
    try {
      if (drive.accessToken) {
        setSaveStatus('saving');
        const folder = await drive.createFolder(project.name, result.parentId, { [PROJECT_FOLDER_PROPERTY]: '1' });
        const [assets, renders, thumbs] = await Promise.all([
          drive.createFolder('assets', folder.id),
          drive.createFolder('renders', folder.id),
          drive.createFolder('thumbs', folder.id)
        ]);
        const enriched = {
          ...project,
          folderId: folder.id,
          assetsFolderId: assets.id,
          rendersFolderId: renders.id,
          thumbsFolderId: thumbs.id
        };
        const file = await drive.uploadJson(PROJECT_FILE_NAME, enriched, folder.id, { [PROJECT_APP_PROPERTY]: '1' });
        enriched.projectFileId = file.id;
        setProjects((current) => {
          const next = [enriched, ...current];
          persistStoredState(next, enriched.id);
          return next;
        });
        setActiveProjectId(enriched.id);
        setSaveStatus('saved');
      } else {
        setProjects((current) => {
          const next = [project, ...current];
          persistStoredState(next, project.id);
          return next;
        });
        setActiveProjectId(project.id);
        setSaveStatus('local');
      }
    } catch (error) {
      setSaveStatus('error');
      setToast(error instanceof Error ? error.message : 'No se pudo crear el proyecto.');
    }
  }

  function duplicateProject(project: ProjectRecord) {
    const duplicate = normalizeLoadedProject({
      ...project,
      id: uid('project'),
      name: `${project.name} copia`,
      projectFileId: undefined,
      folderId: undefined,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    updateProjects((current) => [duplicate, ...current]);
  }

  async function moveProjectToTrash(project: ProjectRecord) {
    setTrashTarget(null);
    try {
      setSaveStatus('saving');
      if (project.folderId && drive.accessToken) {
        await drive.trashFile(project.folderId);
      }
      setProjects((current) => {
        const next = current.map((item) => item.id === project.id ? { ...item, trashedAt: nowIso() } : item);
        persistStoredState(next, activeProjectId === project.id ? undefined : activeProjectId);
        return next;
      });
      if (activeProjectId === project.id) setActiveProjectId(undefined);
      setSaveStatus('saved');
      setToast('Moved to bin');
    } catch (error) {
      setSaveStatus('error');
      setToast(error instanceof Error ? error.message : 'No se pudo mover el proyecto a la papelera.');
    }
  }

  async function restoreProject(entry: BinEntry) {
    try {
      setSaveStatus('saving');
      if (entry.driveId && drive.accessToken) {
        await drive.restoreFile(entry.driveId);
      }
      setProjects((current) => {
        const next = current.map((project) => {
          const matchesProject = entry.projectId && project.id === entry.projectId;
          const matchesFolder = entry.driveId && project.folderId === entry.driveId;
          return matchesProject || matchesFolder ? { ...project, trashedAt: undefined } : project;
        });
        persistStoredState(next, activeProjectId);
        return next;
      });
      if (entry.driveId) await refreshDriveProjects();
      setSaveStatus('saved');
      setToast('Restored');
    } catch (error) {
      setSaveStatus('error');
      setToast(error instanceof Error ? error.message : 'No se pudo restaurar el proyecto.');
      throw error;
    }
  }

  async function addFiles(files: FileList | File[], destinationFolderId?: string) {
    if (!activeProject) {
      setToast('Crea o abre un proyecto antes de subir archivos.');
      return;
    }
    const accepted = Array.from(files).filter((file) => assetKindFromFile(file));
    if (!accepted.length) {
      setToast('Solo se aceptan video, audio e imagen.');
      return;
    }
    for (const file of accepted) {
      const kind = assetKindFromFile(file)!;
      const objectUrl = URL.createObjectURL(file);
      const asset: AssetRecord = {
        id: uid('asset'),
        folderId: destinationFolderId,
        name: file.name,
        mimeType: file.type,
        kind,
        size: file.size,
        objectUrl,
        uploadState: drive.accessToken && activeProject.assetsFolderId ? 'uploading' : 'local',
        createdAt: nowIso()
      };
      patchActiveProject((project) => ({
        ...project,
        assets: [asset, ...project.assets]
      }));
      void readAssetMetadata(kind, objectUrl).then((metadata) => {
        patchActiveProject((project) => ({
          ...project,
          assets: project.assets.map((entry) => entry.id === asset.id ? { ...entry, ...metadata } : entry)
        }));
      });
      const uploadFolderId = destinationFolderId || activeProject.assetsFolderId;
      if (drive.accessToken && uploadFolderId) {
        try {
          setSaveStatus('uploading');
          const uploaded = await drive.uploadFile(file, uploadFolderId);
          patchActiveProject((project) => ({
            ...project,
            assets: project.assets.map((entry) => entry.id === asset.id ? {
              ...entry,
              driveFileId: uploaded.id,
              uploadState: 'uploaded'
            } : entry)
          }));
          setSaveStatus('saved');
        } catch (error) {
          patchActiveProject((project) => ({
            ...project,
            assets: project.assets.map((entry) => entry.id === asset.id ? { ...entry, uploadState: 'error' } : entry)
          }));
          setSaveStatus('error');
          setToast(error instanceof Error ? error.message : 'No se pudo subir el archivo.');
        }
      }
    }
  }

  function placeAssetOnTimeline(assetId: string, start: number, requestedTrackId?: string) {
    const clipId = uid('clip');
    patchActiveProject((project) => {
      const asset = project.assets.find((item) => item.id === assetId && !item.trashedAt);
      if (!asset) return project;
      const trackKind = asset.kind === 'audio' ? 'audio' : 'video';
      const duration = asset.kind === 'image' ? 5 : clamp(asset.duration || 6, 0.2, 60 * 60);
      const safeStart = clamp(start, 0, Math.max(project.duration, start));
      let track = project.tracks.find((item) => item.id === requestedTrackId && item.kind === trackKind);
      const overlaps = (trackId: string) => project.timeline.some((clip) => clip.trackId === trackId && timelineItemsOverlap(safeStart, duration, clip));
      if (!track || overlaps(track.id)) track = project.tracks.find((item) => item.kind === trackKind && !overlaps(item.id));
      let tracks = project.tracks;
      if (!track) {
        const count = project.tracks.filter((item) => item.kind === trackKind).length + 1;
        track = { id: uid(`track_${trackKind}`), name: `${trackKind === 'video' ? 'Video' : 'Audio'} ${count}`, kind: trackKind, locked: false, muted: false };
        const firstVideo = tracks.findIndex((item) => item.kind === 'video');
        tracks = trackKind === 'video' && firstVideo >= 0
          ? [...tracks.slice(0, firstVideo), track, ...tracks.slice(firstVideo)]
          : [...tracks, track];
      }
      const clip: TimelineItem = {
        id: clipId,
        type: asset.kind,
        trackId: track.id,
        assetId: asset.id,
        start: safeStart,
        duration,
        transform: defaultTransform()
      };
      return { ...project, tracks, timeline: [...project.timeline, clip], duration: Math.max(project.duration, safeStart + duration) };
    });
    setFocusedClipId(clipId);
  }

  function moveTimelineClip(clipId: string, start: number, requestedTrackId: string) {
    patchActiveProject((project) => {
      const moving = project.timeline.find((clip) => clip.id === clipId);
      if (!moving) return project;
      const trackKind = moving.type === 'audio' ? 'audio' : moving.type === 'text' ? 'text' : 'video';
      const safeStart = Math.max(0, start);
      let track = project.tracks.find((item) => item.id === requestedTrackId && item.kind === trackKind);
      const overlaps = (trackId: string) => project.timeline.some((clip) => clip.id !== clipId && clip.trackId === trackId && timelineItemsOverlap(safeStart, moving.duration, clip));
      if (!track || overlaps(track.id)) track = project.tracks.find((item) => item.kind === trackKind && !overlaps(item.id));
      let tracks = project.tracks;
      if (!track) {
        const count = project.tracks.filter((item) => item.kind === trackKind).length + 1;
        track = { id: uid(`track_${trackKind}`), name: `${trackKind === 'text' ? 'Texto' : trackKind === 'video' ? 'Video' : 'Audio'} ${count}`, kind: trackKind, locked: false, muted: false };
        const firstVideo = tracks.findIndex((item) => item.kind === 'video');
        tracks = trackKind === 'video' && firstVideo >= 0
          ? [...tracks.slice(0, firstVideo), track, ...tracks.slice(firstVideo)]
          : [...tracks, track];
      }
      return {
        ...project,
        tracks,
        timeline: project.timeline.map((clip) => clip.id === clipId ? { ...clip, start: safeStart, trackId: track!.id } : clip),
        duration: Math.max(project.duration, safeStart + moving.duration)
      };
    });
    setFocusedClipId(clipId);
  }

  async function createAssetFolder(name: string, parentId?: string) {
    if (!activeProject?.assetsFolderId) return;
    const cleanName = name.trim();
    if (!cleanName) return;
    try {
      const folder = await drive.createFolder(cleanName, parentId || activeProject.assetsFolderId);
      patchActiveProject((project) => ({
        ...project,
        assetFolders: [...project.assetFolders, { id: folder.id, name: folder.name, parentId, createdAt: nowIso() }]
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'No se pudo crear la carpeta.');
    }
  }

  async function moveAsset(assetId: string, destinationFolderId?: string) {
    if (!activeProject?.assetsFolderId) return;
    const asset = activeProject.assets.find((item) => item.id === assetId);
    if (!asset) return;
    if (asset.folderId === destinationFolderId) return;
    try {
      if (asset.driveFileId) {
        await drive.moveFile(asset.driveFileId, destinationFolderId || activeProject.assetsFolderId, asset.folderId || activeProject.assetsFolderId);
      }
      patchActiveProject((project) => ({
        ...project,
        assets: project.assets.map((item) => item.id === assetId ? { ...item, folderId: destinationFolderId } : item)
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'No se pudo mover el asset.');
    }
  }

  async function trashAsset(assetId: string) {
    const asset = activeProject?.assets.find((item) => item.id === assetId);
    if (!asset) return;
    try {
      if (asset.driveFileId) await drive.trashFile(asset.driveFileId);
      patchActiveProject((project) => ({
        ...project,
        assets: project.assets.map((item) => item.id === assetId ? { ...item, trashedAt: nowIso() } : item),
        timeline: project.timeline.filter((clip) => clip.assetId !== assetId)
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'No se pudo mover el asset a la papelera.');
    }
  }

  async function restoreAsset(assetId: string) {
    const asset = activeProject?.assets.find((item) => item.id === assetId);
    if (!asset) return;
    try {
      if (asset.driveFileId) await drive.restoreFile(asset.driveFileId);
      patchActiveProject((project) => ({
        ...project,
        assets: project.assets.map((item) => item.id === assetId ? { ...item, trashedAt: undefined } : item)
      }));
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'No se pudo restaurar el asset.');
    }
  }

  function addTextClip() {
    if (!activeProject) return;
    const start = activeProject.timeline.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
    const clipId = uid('clip');
    patchActiveProject((project) => ({
      ...project,
      timeline: [
        ...project.timeline,
        {
          id: clipId,
          type: 'text',
          trackId: 'track_text',
          start,
          duration: 4,
          text: 'inhouse vidmaker',
          transform: defaultTransform()
        }
      ],
      duration: Math.max(project.duration, start + 4)
    }));
    setFocusedClipId(clipId);
  }

  function updateClip(clipId: string, patch: Partial<TimelineItem>) {
    patchActiveProject((project) => {
      const current = project.timeline.find((clip) => clip.id === clipId);
      if (!current) return project;
      let updated = { ...current, ...patch };
      if (patch.start !== undefined || patch.duration !== undefined) {
        const siblings = project.timeline.filter((clip) => clip.id !== clipId && clip.trackId === current.trackId);
        if (patch.start !== undefined && patch.duration === undefined) {
          const candidates = [Math.max(0, updated.start), ...siblings.flatMap((clip) => [clip.start + clip.duration, Math.max(0, clip.start - updated.duration)])];
          const validStarts = candidates.filter((start) => !siblings.some((clip) => timelineItemsOverlap(start, updated.duration, clip)));
          updated = { ...updated, start: validStarts.sort((a, b) => Math.abs(a - updated.start) - Math.abs(b - updated.start))[0] ?? current.start };
        } else {
          const proposedEnd = updated.start + updated.duration;
          const previousEnd = siblings.filter((clip) => clip.start < updated.start).reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
          const nextStart = siblings.filter((clip) => clip.start >= updated.start).reduce((start, clip) => Math.min(start, clip.start), Number.POSITIVE_INFINITY);
          const safeStart = Math.max(previousEnd, updated.start);
          const safeDuration = Math.max(0.2, Math.min(proposedEnd - safeStart, nextStart - safeStart));
          updated = { ...updated, start: safeStart, duration: Number.isFinite(safeDuration) ? safeDuration : updated.duration };
        }
        if (siblings.some((clip) => timelineItemsOverlap(updated.start, updated.duration, clip))) updated = current;
      }
      const timeline = project.timeline.map((clip) => clip.id === clipId ? updated : clip);
      return {
        ...project,
        timeline,
        duration: Math.max(project.duration, ...timeline.map((clip) => clip.start + clip.duration))
      };
    });
  }

  function splitAtPlayhead(time: number, selectedClipIds: string[]) {
    patchActiveProject((project) => {
      const frameDuration = 1 / Math.max(1, project.fps);
      const selected = new Set(selectedClipIds);
      const targetIds = selected.size
        ? selected
        : new Set(project.timeline.filter((clip) => time > clip.start + frameDuration && time < clip.start + clip.duration - frameDuration).map((clip) => clip.id));
      const timeline = project.timeline.flatMap((clip) => {
        if (!targetIds.has(clip.id) || time <= clip.start + frameDuration || time >= clip.start + clip.duration - frameDuration) return [clip];
        const firstDuration = Number((time - clip.start).toFixed(4));
        const secondDuration = Number((clip.duration - firstDuration).toFixed(4));
        return [
          { ...clip, duration: firstDuration },
          {
            ...clip,
            id: uid('clip'),
            start: time,
            duration: secondDuration,
            trimStart: (clip.trimStart || 0) + firstDuration
          }
        ];
      });
      return { ...project, timeline };
    });
  }

  function deleteClip(clipId: string) {
    patchActiveProject((project) => ({
      ...project,
      timeline: project.timeline.filter((clip) => clip.id !== clipId)
    }));
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(true);
  }

  async function exportVideo() {
    if (!activeProject) return;
    try {
      setToast('Preparando exportacion con Diffusion Studio...');
      const core: DiffusionCore = await import('@diffusionstudio/core');
      const composition = new core.Composition({
        width: activeProject.width,
        height: activeProject.height,
        background: '#000000'
      });
      const encoder = new core.Encoder(composition, {
        video: { fps: activeProject.fps, codec: 'avc', bitrate: 8e6, resolution: 1 },
        audio: { enabled: true, codec: 'aac', bitrate: 128e3 }
      });
      const renderName = `${activeProject.name.replace(/[^\w.-]+/g, '_') || 'inhouse_vidmaker'}.mp4`;
      await encoder.render(renderName);
      setToast('Exportacion iniciada.');
    } catch (error) {
      console.error(error);
      setToast('Exportacion no disponible en este navegador. Prueba Chrome/Edge con WebCodecs.');
    }
  }

  if (!profile) {
    return (
      <>
        <SignInGate saveStatus={saveStatus} onSignIn={signIn} />
        {toast ? <Toast text={toast} onDone={() => setToast('')} /> : null}
      </>
    );
  }

  if (activeProject) {
    return (
      <EditorView
        project={activeProject}
        profile={profile}
        saveStatus={saveStatus}
        isDragging={isDragging}
        focusedClipId={focusedClipId}
        onBack={() => setActiveProjectId(undefined)}
        onFiles={addFiles}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onPickFiles={() => fileInputRef.current?.click()}
        fileInputRef={fileInputRef}
        onAddText={addTextClip}
        onPlaceAsset={placeAssetOnTimeline}
        onMoveTimelineClip={moveTimelineClip}
        onCreateAssetFolder={createAssetFolder}
        onMoveAsset={moveAsset}
        onTrashAsset={trashAsset}
        onRestoreAsset={restoreAsset}
        onUpdateClip={updateClip}
        onSplitAtPlayhead={splitAtPlayhead}
        onDeleteClip={deleteClip}
        onExport={exportVideo}
      />
    );
  }

  return (
    <main
      id="drive-home"
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      className={isDragging ? 'dragging' : ''}
    >
      <DriveHome
        drive={drive}
        profile={profile}
        projects={visibleProjects}
        folders={homeFolders}
        search={search}
        currentFolder={currentFolder}
        foldersLoading={foldersLoading}
        onSearch={setSearch}
        onSignIn={signIn}
        onSignOut={signOut}
        onRefresh={() => {
          void refreshDriveProjects();
          void loadDriveFolders(currentFolder.id);
        }}
        onCreateProject={() => {
          setFolderPickerMode('project');
          setFolderPickerOpen(true);
        }}
        onOpenProject={setActiveProjectId}
        onDuplicateProject={duplicateProject}
        onDeleteProject={(project) => setTrashTarget(project)}
        onOpenBin={() => setBinOpen(true)}
        onSelectFolder={(folder) => {
          setCurrentFolder(folder);
          void loadDriveFolders(folder.id);
        }}
      />
      <input
        ref={fileInputRef}
        className="hidden"
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          if (event.target.files) void addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <FolderPicker
        open={isFolderPickerOpen}
        mode={folderPickerMode}
        drive={drive}
        onCancel={() => setFolderPickerOpen(false)}
        onConfirm={(result) => {
          setFolderPickerOpen(false);
          void createProject(result);
        }}
      />
      <TrashConfirmModal
        project={trashTarget}
        onCancel={() => setTrashTarget(null)}
        onConfirm={() => {
          if (trashTarget) void moveProjectToTrash(trashTarget);
        }}
      />
      <DriveBinModal
        open={isBinOpen}
        drive={drive}
        localProjects={projects.filter((project) => project.trashedAt)}
        onClose={() => setBinOpen(false)}
        onRestore={restoreProject}
      />
      {isDragging ? <div className="drop-hint"><Upload size={22} /> Suelta archivos para subirlos al proyecto abierto</div> : null}
      {toast ? <Toast text={toast} onDone={() => setToast('')} /> : null}
    </main>
  );
}

function DriveHome(props: {
  drive: DriveClient;
  profile: ReturnType<typeof createDriveClient>['profile'];
  projects: ProjectRecord[];
  folders: DriveFolder[];
  search: string;
  currentFolder: DriveFolder;
  foldersLoading: boolean;
  onSearch(value: string): void;
  onSignIn(): void;
  onSignOut(): void;
  onRefresh(): void;
  onCreateProject(): void;
  onOpenProject(id: string): void;
  onDuplicateProject(project: ProjectRecord): void;
  onDeleteProject(project: ProjectRecord): void;
  onOpenBin(): void;
  onSelectFolder(folder: DriveFolder): void;
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const recentProjects = props.projects.slice(0, 8);

  return (
    <>
      <div className="drive-topbar">
        <div className="drive-brand">
          <RoofLogo />
          <span className="brand-name">inhouse vidmaker</span>
        </div>
        <div className="drive-actions">
          <button className="btn btn-secondary btn-icon-square" title="Pantalla completa" onClick={() => document.documentElement.requestFullscreen?.()}>
            <Fullscreen size={18} />
          </button>
          <button className="btn btn-primary drive-new-project" onClick={props.onCreateProject}>
            <Plus size={16} /> <span>Nuevo proyecto</span>
          </button>
          <button className="btn btn-secondary btn-icon-square" title="Actualizar" onClick={props.onRefresh}>
            <RefreshCw size={17} />
          </button>
          {!props.profile ? (
            <button className="btn btn-primary" onClick={props.onSignIn}>Sign in</button>
          ) : (
            <div className="drive-profile">
              <button className="drive-profile-btn" aria-label="Account menu" onClick={() => setProfileOpen((value) => !value)}>
                {props.profile.picture ? <img className="drive-profile-avatar" src={props.profile.picture} alt="Profile" /> : <User size={20} />}
              </button>
              <div className={`drive-profile-menu ${profileOpen ? '' : 'hidden'}`} role="menu">
                <div className="drive-profile-meta">
                  {props.profile.picture ? <img className="drive-profile-avatar" src={props.profile.picture} alt="Profile" /> : <User size={20} />}
                  <div>
                    <div className="drive-profile-name">{props.profile.name}</div>
                    <div className="drive-profile-email">{props.profile.email}</div>
                  </div>
                </div>
                <div className="drive-profile-actions">
                  <button className="btn btn-secondary" onClick={props.onRefresh}>Refresh</button>
                  <button className="btn btn-secondary" onClick={props.onSignOut}>Sign out</button>
                </div>
                <div className="drive-profile-version">v0.1.0</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="drive-main">
        <div className="drive-toolbar">
          <button className="btn btn-secondary btn-icon-square" title="Bin" aria-label="Bin" onClick={props.onOpenBin}>
            <Trash2 size={18} />
          </button>
          <div className="drive-search-wrap">
            <Search size={17} />
            <input
              className="drive-search"
              value={props.search}
              onChange={(event) => props.onSearch(event.target.value)}
              placeholder="Buscar proyectos o carpetas..."
            />
          </div>
        </div>

        <div className="drive-breadcrumbs">
          <button className="drive-breadcrumb" onClick={() => props.onSelectFolder({ id: 'root', name: 'Mi unidad' })}>Mi unidad</button>
          <span>/</span>
          <button className="drive-breadcrumb active">{props.currentFolder.name}</button>
        </div>

        <section className="drive-section">
          <div className="drive-section-header">
            <div className="drive-section-title">Carpetas</div>
          </div>
          <div className="drive-folder-grid">
            {props.foldersLoading ? (
              <div className="drive-empty drive-grid-empty"><Loader2 className="spin" size={20} /> Cargando carpetas de Drive...</div>
            ) : props.folders.map((folder) => (
              <button className="drive-folder-card" key={folder.id} onClick={() => props.onSelectFolder(folder)}>
                <Folder className="drive-folder-icon" />
                <div className="drive-card-title">{folder.name}</div>
              </button>
            ))}
          </div>
          {!props.foldersLoading && !props.folders.length ? (
            <div className="drive-empty folder-empty">No hay carpetas en esta ubicacion.</div>
          ) : null}
        </section>

        <section className="drive-section">
          <div className="drive-section-header">
            <div className="drive-section-title">Recientes</div>
          </div>
          <div className="drive-recents">
            {recentProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                compact
                onOpen={() => props.onOpenProject(project.id)}
                onDuplicate={() => props.onDuplicateProject(project)}
                onDelete={() => props.onDeleteProject(project)}
              />
            ))}
          </div>
          {!recentProjects.length ? <div className="drive-empty">No hay proyectos recientes.</div> : null}
        </section>

        <section className="drive-section">
          <div className="drive-section-header">
            <div className="drive-section-title">Proyectos</div>
          </div>
          <div className="drive-file-grid">
            {props.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={() => props.onOpenProject(project.id)}
                onDuplicate={() => props.onDuplicateProject(project)}
                onDelete={() => props.onDeleteProject(project)}
              />
            ))}
          </div>
          {!props.projects.length ? (
            <div className="drive-empty">
              <Film size={30} />
              <span>No hay proyectos. Crea uno o inicia sesion para cargar Drive.</span>
            </div>
          ) : null}
        </section>
      </div>
    </>
  );
}

function SignInGate(props: {
  saveStatus: SaveStatus;
  onSignIn(): void;
}) {
  const signingIn = props.saveStatus === 'paused' || props.saveStatus === 'saving';

  return (
    <main className="signin-gate">
      <div className="signin-topbar">
        <div className="drive-brand">
          <RoofLogo />
          <span className="brand-name">inhouse vidmaker</span>
        </div>
      </div>
      <section className="signin-panel" aria-label="Sign in">
        <div className="signin-logo">
          <RoofLogo />
        </div>
        <h1>inhouse vidmaker</h1>
        <button className="google-signin-btn" onClick={props.onSignIn} disabled={signingIn}>
          {signingIn ? <Loader2 className="spin" size={18} /> : <User size={18} />}
          <span>{signingIn ? 'Conectando...' : 'Sign in with Google'}</span>
        </button>
      </section>
    </main>
  );
}

function ProjectCard(props: {
  project: ProjectRecord;
  compact?: boolean;
  onOpen(): void;
  onDuplicate(): void;
  onDelete(): void;
}) {
  const [open, setOpen] = useState(false);
  const firstAsset = props.project.assets.find((asset) => asset.kind === 'video' || asset.kind === 'image');
  return (
    <article className={`drive-card ${props.compact ? 'compact' : ''}`} onDoubleClick={props.onOpen}>
      <button className="drive-card-open" onClick={props.onOpen} aria-label={`Abrir ${props.project.name}`}>
        <div className="drive-card-preview">
          {firstAsset?.objectUrl && firstAsset.kind === 'image' ? (
            <img src={firstAsset.objectUrl} alt="" />
          ) : (
            <div className="video-preview-mark">
              <Video size={34} />
              <span>{Math.round(props.project.duration)}s</span>
            </div>
          )}
        </div>
        <div className="drive-card-title">{props.project.name}</div>
        <div className="drive-card-meta">{projectCardMeta(props.project)}</div>
      </button>
      <div className="drive-card-menu">
        <button className="drive-card-more" onClick={() => setOpen((value) => !value)} aria-label="Menu">
          <MoreVertical size={17} />
        </button>
        <div className={`drive-card-dropdown ${open ? '' : 'hidden'}`}>
          <button onClick={props.onOpen}><Home size={15} /> Abrir</button>
          <button onClick={props.onDuplicate}><Plus size={15} /> Duplicar</button>
          <button className="danger" onClick={props.onDelete}><Trash2 size={15} /> Move to bin</button>
        </div>
      </div>
    </article>
  );
}

function TrashConfirmModal(props: {
  project: ProjectRecord | null;
  onCancel(): void;
  onConfirm(): void;
}) {
  const sliderRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const positionRef = useRef(0);
  const maxRef = useRef(0);
  const dragOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const [position, setPositionState] = useState(0);
  const [dragging, setDraggingState] = useState(false);
  const [complete, setComplete] = useState(false);

  const updateMetrics = useCallback(() => {
    const slider = sliderRef.current;
    const handle = handleRef.current;
    if (!slider || !handle) return 0;
    const sliderRect = slider.getBoundingClientRect();
    const handleWidth = handle.getBoundingClientRect().width || 44;
    maxRef.current = Math.max(0, sliderRect.width - handleWidth - 8);
    return maxRef.current;
  }, []);

  const setPosition = useCallback((next: number) => {
    const max = updateMetrics();
    const clamped = Math.max(0, Math.min(next, max));
    positionRef.current = clamped;
    setPositionState(clamped);
  }, [updateMetrics]);

  useEffect(() => {
    positionRef.current = 0;
    draggingRef.current = false;
    setPositionState(0);
    setDraggingState(false);
    setComplete(false);
    if (props.project) requestAnimationFrame(updateMetrics);
  }, [props.project, updateMetrics]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const slider = sliderRef.current;
    const handle = handleRef.current;
    if (!slider || !handle) return;
    draggingRef.current = true;
    setDraggingState(true);
    setComplete(false);
    slider.setPointerCapture(event.pointerId);
    const sliderRect = slider.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    dragOffsetRef.current = Math.max(0, Math.min(event.clientX - handleRect.left, handleRect.width));
    setPosition(event.clientX - sliderRect.left - 4 - dragOffsetRef.current);
  }

  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current || !sliderRef.current) return;
    const sliderRect = sliderRef.current.getBoundingClientRect();
    setPosition(event.clientX - sliderRect.left - 4 - dragOffsetRef.current);
  }

  function endDrag() {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDraggingState(false);
    const max = updateMetrics();
    if (max > 0 && positionRef.current >= max * 0.9) {
      setComplete(true);
      setPosition(max);
      window.setTimeout(props.onConfirm, 120);
      return;
    }
    setPosition(0);
  }

  if (!props.project) return null;

  return (
    <div className="modal-overlay visible" onMouseDown={(event) => event.target === event.currentTarget && props.onCancel()}>
      <div className="modal modal-danger">
        <h2>Move to bin?</h2>
        <p>This will move <strong>{props.project.name}</strong> to your Drive bin.</p>
        <div
          ref={sliderRef}
          className={`confirm-slider ${dragging ? 'dragging' : ''} ${complete ? 'complete' : ''}`}
          aria-label="Slide to move to bin"
          onPointerDown={startDrag}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          <div className="confirm-slider-fill" style={{ width: position + 26 }} />
          <div className="confirm-slider-text">Slide to move to bin</div>
          <div ref={handleRef} className="confirm-slider-handle" style={{ transform: `translateX(${position}px)` }} aria-hidden="true">
            <ChevronRight size={18} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function DriveBinModal(props: {
  open: boolean;
  drive: DriveClient;
  localProjects: ProjectRecord[];
  onClose(): void;
  onRestore(entry: BinEntry): Promise<void>;
}) {
  const [remoteFiles, setRemoteFiles] = useState<DriveProjectFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string>();

  const refresh = useCallback(async () => {
    if (!props.drive.accessToken) return;
    setLoading(true);
    try {
      setRemoteFiles(await props.drive.listTrash());
    } catch {
      setRemoteFiles([]);
    } finally {
      setLoading(false);
    }
  }, [props.drive]);

  useEffect(() => {
    if (!props.open) return;
    setOpenMenuId(undefined);
    void refresh();
  }, [props.open, refresh]);

  const entries = useMemo(() => {
    const localByFolder = new Map(props.localProjects.filter((project) => project.folderId).map((project) => [project.folderId!, project]));
    const result: BinEntry[] = remoteFiles.map((file) => ({
      id: `drive-${file.id}`,
      driveId: file.id,
      projectId: localByFolder.get(file.id)?.id,
      name: file.name,
      modifiedTime: file.modifiedTime || file.createdTime
    }));
    const remoteIds = new Set(remoteFiles.map((file) => file.id));
    props.localProjects.forEach((project) => {
      if (project.folderId && remoteIds.has(project.folderId)) return;
      result.push({
        id: `local-${project.id}`,
        driveId: project.folderId,
        projectId: project.id,
        name: project.name,
        modifiedTime: project.trashedAt || project.updatedAt
      });
    });
    return result.sort((a, b) => String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')));
  }, [props.localProjects, remoteFiles]);

  if (!props.open) return null;

  return (
    <div className="modal-overlay visible" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <div className="modal bin-modal">
        <h2>Bin</h2>
        <p>Files currently in your Drive bin.</p>
        {loading ? (
          <div className="bin-loading"><Loader2 className="spin" size={18} /> Loading bin...</div>
        ) : null}
        <div className="bin-list">
          {!loading && entries.map((entry) => (
            <div className="bin-item" key={entry.id}>
              <Folder size={18} />
              <div className="bin-item-content">
                <div className="bin-item-name">{entry.name}</div>
                <div className="bin-item-meta">Modified {formatWhen(entry.modifiedTime || nowIso())}</div>
              </div>
              <div className="bin-item-menu">
                <button className="bin-item-more" aria-label="More actions" onClick={() => setOpenMenuId(openMenuId === entry.id ? undefined : entry.id)}>
                  <MoreVertical size={16} />
                </button>
                <div className={`bin-item-dropdown ${openMenuId === entry.id ? '' : 'hidden'}`}>
                  <button onClick={async () => {
                    setOpenMenuId(undefined);
                    await props.onRestore(entry);
                    await refresh();
                  }}>
                    <RotateCcw size={16} /> Restore
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {!loading && !entries.length ? <div className="drive-empty">Bin is empty.</div> : null}
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function FolderPicker(props: {
  open: boolean;
  mode: 'project' | 'folder';
  drive: DriveClient;
  onCancel(): void;
  onConfirm(result: FolderPickerResult): void;
}) {
  const [name, setName] = useState('nuevo video');
  const [stack, setStack] = useState<DriveFolder[]>([{ id: 'root', name: 'Mi unidad' }]);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const active = stack[stack.length - 1];

  useEffect(() => {
    if (!props.open) return;
    setName('nuevo video');
    setStack([{ id: 'root', name: 'Mi unidad' }]);
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    if (!props.drive.accessToken) {
      setFolders([]);
      return;
    }
    setLoading(true);
    props.drive.listFolders(active.id)
      .then(setFolders)
      .catch(() => setFolders([]))
      .finally(() => setLoading(false));
  }, [active.id, props.drive, props.open]);

  if (!props.open) return null;

  return (
    <div className="modal-overlay visible">
      <div className="modal">
        <h2>Nuevo proyecto</h2>
        <p>Elige donde ubicar la carpeta del proyecto.</p>
        <div className="folder-picker-meta">
          <div className="folder-picker-meta-label">Creando</div>
          <div className="folder-picker-meta-name">{sanitizeProjectName(name)}</div>
          <div className="folder-picker-meta-path">{stack.map((item) => item.name).join(' / ')}</div>
        </div>
        <div className="folder-picker">
          <div className="folder-picker-breadcrumbs">
            {stack.map((folder, index) => (
              <button
                key={folder.id}
                className={`folder-picker-breadcrumb ${index === stack.length - 1 ? 'active' : ''}`}
                onClick={() => setStack(stack.slice(0, index + 1))}
              >
                {folder.name}
              </button>
            ))}
          </div>
          <div className="folder-picker-list">
            {loading ? (
              <div className="folder-picker-item"><Loader2 className="spin" size={18} /> Cargando carpetas...</div>
            ) : folders.length ? folders.map((folder) => (
              <button className="folder-picker-item" key={folder.id} onClick={() => setStack([...stack, folder])}>
                <Folder size={18} />
                <span>{folder.name}</span>
              </button>
            )) : (
              <div className="drive-empty">No hay carpetas aqui.</div>
            )}
          </div>
        </div>
        <div className="modal-input">
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus spellCheck={false} />
          <span className="file-ext">carpeta</span>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={props.onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => props.onConfirm({ projectName: name, parentId: active.id })}>Create</button>
        </div>
      </div>
    </div>
  );
}

function EditorView(props: {
  project: ProjectRecord;
  profile: ReturnType<typeof createDriveClient>['profile'];
  saveStatus: SaveStatus;
  isDragging: boolean;
  focusedClipId?: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onBack(): void;
  onFiles(files: FileList | File[], destinationFolderId?: string): void;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(): void;
  onPickFiles(): void;
  onAddText(): void;
  onPlaceAsset(assetId: string, start: number, trackId?: string): void;
  onMoveTimelineClip(clipId: string, start: number, trackId: string): void;
  onCreateAssetFolder(name: string, parentId?: string): void;
  onMoveAsset(assetId: string, destinationFolderId?: string): void;
  onTrashAsset(assetId: string): void;
  onRestoreAsset(assetId: string): void;
  onUpdateClip(clipId: string, patch: Partial<TimelineItem>): void;
  onSplitAtPlayhead(time: number, selectedClipIds: string[]): void;
  onDeleteClip(clipId: string): void;
  onExport(): void;
}) {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | undefined>();
  const [assetFolderId, setAssetFolderId] = useState<string | undefined>();
  const [isCreatingAssetFolder, setCreatingAssetFolder] = useState(false);
  const [assetFolderName, setAssetFolderName] = useState('');
  const [movingAssetId, setMovingAssetId] = useState<string | undefined>();
  const [showAssetBin, setShowAssetBin] = useState(false);
  const [assetPanelWidth, setAssetPanelWidth] = useState(268);
  const [inspectorPanelWidth, setInspectorPanelWidth] = useState(286);
  const [timelineHeight, setTimelineHeight] = useState(212);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [timelineOffset, setTimelineOffset] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(1);
  const [timelineDragPreview, setTimelineDragPreview] = useState<TimelineDragPreview | null>(null);
  const [trimSnapTime, setTrimSnapTime] = useState<number | undefined>();
  const [timelineSelectionBox, setTimelineSelectionBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const appliedFocusRef = useRef<string | undefined>(undefined);
  const tracksRef = useRef<HTMLDivElement>(null);
  const timelineRulerRef = useRef<HTMLDivElement>(null);
  const timelinePanelRef = useRef<HTMLElement>(null);
  const panelResizeRef = useRef<{
    pointerId: number;
    type: 'assets' | 'inspector' | 'timeline';
    startX: number;
    startY: number;
    assetWidth: number;
    inspectorWidth: number;
    timelineHeight: number;
  } | null>(null);
  const timelineDragSourceRef = useRef<{
    source: 'asset' | 'clip';
    id: string;
    kind: TimelineItem['type'];
    duration: number;
    grabOffset: number;
  } | null>(null);
  const timelineDragPreviewRef = useRef<TimelineDragPreview | null>(null);
  const timelineSelectionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    tracksLeft: number;
    tracksTop: number;
    initialIds: string[];
  } | null>(null);
  const transformGestureRef = useRef<{
    mode: 'move' | 'scale';
    pointerId: number;
    clipId: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originScale: number;
    stageWidth: number;
    stageHeight: number;
  } | null>(null);
  const trimGestureRef = useRef<{
    pointerId: number;
    clipId: string;
    edge: 'start' | 'end';
    startX: number;
    pixelsPerSecond: number;
    originStart: number;
    originDuration: number;
    originTrimStart: number;
  } | null>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [timelineScrollbarWidth, setTimelineScrollbarWidth] = useState(0);
  const selectedClip = props.project.timeline.find((clip) => clip.id === selectedClipId);
  const activeVisualClips = props.project.timeline
    .filter((clip) => clip.start <= playhead && playhead < clip.start + clip.duration && (clip.type === 'video' || clip.type === 'image'))
    .sort((a, b) => props.project.tracks.findIndex((track) => track.id === b.trackId) - props.project.tracks.findIndex((track) => track.id === a.trackId));
  const activeAudioClip = props.project.timeline.find((clip) => clip.type === 'audio' && clip.start <= playhead && playhead < clip.start + clip.duration);
  const activeAudioAsset = activeAudioClip?.assetId ? props.project.assets.find((asset) => asset.id === activeAudioClip.assetId) : undefined;
  const timelineDisplayDuration = props.project.duration / Math.min(1, timelineZoom);
  const timelineContentWidth = timelineViewportWidth * Math.max(1, timelineZoom);
  const timelinePixelsPerSecond = timelineContentWidth / Math.max(1, timelineDisplayDuration);
  const timelineTickStep = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find((step) => step * timelinePixelsPerSecond >= 52) || 3600;
  const visibleSnapTime = timelineDragPreview?.snapTime ?? trimSnapTime;
  const selectClip = (clipId: string, additive = false) => {
    if (!additive) {
      setSelectedClipId(clipId);
      setSelectedClipIds([clipId]);
      return;
    }
    const next = selectedClipIds.includes(clipId)
      ? selectedClipIds.filter((id) => id !== clipId)
      : [...selectedClipIds, clipId];
    setSelectedClipIds(next);
    setSelectedClipId(next.includes(clipId) ? clipId : next[next.length - 1]);
  };
  const clearClipSelection = () => {
    setSelectedClipId(undefined);
    setSelectedClipIds([]);
  };
  const splittableClipIds = (selectedClipIds.length ? props.project.timeline.filter((clip) => selectedClipIds.includes(clip.id)) : props.project.timeline)
    .filter((clip) => playhead > clip.start + 1 / props.project.fps && playhead < clip.start + clip.duration - 1 / props.project.fps)
    .map((clip) => clip.id);

  useEffect(() => {
    if (!props.focusedClipId || appliedFocusRef.current === props.focusedClipId) return;
    const clip = props.project.timeline.find((item) => item.id === props.focusedClipId);
    if (!clip) return;
    appliedFocusRef.current = props.focusedClipId;
    setPlaying(false);
    selectClip(clip.id);
    setPlayhead(Math.min(props.project.duration, clip.start + 0.001));
  }, [props.focusedClipId, props.project.timeline, props.project.duration]);

  useEffect(() => {
    const validIds = selectedClipIds.filter((id) => props.project.timeline.some((clip) => clip.id === id));
    if (validIds.length !== selectedClipIds.length) {
      setSelectedClipIds(validIds);
      if (!selectedClipId || !validIds.includes(selectedClipId)) setSelectedClipId(validIds[validIds.length - 1]);
    }
  }, [props.project.timeline, selectedClipId, selectedClipIds]);

  useEffect(() => {
    const handleCutShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'b') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]') || !splittableClipIds.length) return;
      event.preventDefault();
      props.onSplitAtPlayhead(playhead, selectedClipIds);
    };
    window.addEventListener('keydown', handleCutShortcut);
    return () => window.removeEventListener('keydown', handleCutShortcut);
  }, [playhead, props, selectedClipIds, splittableClipIds.length]);

  useEffect(() => {
    activeVisualClips.forEach((clip) => {
      if (clip.type !== 'video') return;
      const video = videoRefs.current.get(clip.id);
      if (!video) return;
      const clipTime = Math.max(0, playhead - clip.start + (clip.trimStart || 0));
      if (!playing || Math.abs(video.currentTime - clipTime) > 0.25) video.currentTime = clipTime;
      if (playing) void video.play().catch(() => setPlaying(false));
      else video.pause();
    });
  }, [playhead, playing, activeVisualClips]);

  const seekFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextTime = (event.clientX - bounds.left + timelineOffset) / Math.max(0.001, timelinePixelsPerSecond);
    setPlaying(false);
    setPlayhead(clamp(nextTime, 0, props.project.duration));
  };

  const beginScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('.timeline-clip')) return;
    clearClipSelection();
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event);
  };

  const continueScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) seekFromPointer(event);
  };

  const beginTimelineSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('.timeline-clip')) return;
    const tracks = tracksRef.current;
    if (!tracks) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    if (!additive) clearClipSelection();
    seekFromPointer(event);
    const bounds = tracks.getBoundingClientRect();
    timelineSelectionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tracksLeft: bounds.left,
      tracksTop: bounds.top,
      initialIds: additive ? [...selectedClipIds] : []
    };
    setTimelineSelectionBox(null);
  };

  const updateTimelineSelection = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = timelineSelectionRef.current;
    const tracks = tracksRef.current;
    if (!gesture || !tracks || gesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (distance < 4) return;
    const leftClient = Math.min(gesture.startX, event.clientX);
    const rightClient = Math.max(gesture.startX, event.clientX);
    const topClient = Math.min(gesture.startY, event.clientY);
    const bottomClient = Math.max(gesture.startY, event.clientY);
    const intersectingIds = Array.from(tracks.querySelectorAll<HTMLElement>('[data-clip-id]'))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < rightClient && bounds.right > leftClient && bounds.top < bottomClient && bounds.bottom > topClient;
      })
      .map((element) => element.dataset.clipId!)
      .filter(Boolean);
    const nextIds = Array.from(new Set([...gesture.initialIds, ...intersectingIds]));
    setSelectedClipIds(nextIds);
    setSelectedClipId(nextIds[nextIds.length - 1]);
    setTimelineSelectionBox({
      left: leftClient - gesture.tracksLeft,
      top: topClient - gesture.tracksTop + tracks.scrollTop,
      width: rightClient - leftClient,
      height: bottomClient - topClient
    });
  };

  const endTimelineSelection = (event: ReactPointerEvent<HTMLElement>) => {
    if (timelineSelectionRef.current?.pointerId !== event.pointerId) return;
    timelineSelectionRef.current = null;
    setTimelineSelectionBox(null);
  };

  const focusAsset = (assetId: string) => {
    setSelectedAssetId(assetId);
  };

  const timelineTrackKind = (kind: TimelineItem['type']) => kind === 'audio' ? 'audio' : kind === 'text' ? 'text' : 'video';

  const resolveTimelineTrack = (kind: TimelineItem['type'], start: number, duration: number, requestedTrackId: string, excludeClipId?: string) => {
    const requiredKind = timelineTrackKind(kind);
    const isFree = (trackId: string) => !props.project.timeline.some((clip) => clip.id !== excludeClipId && clip.trackId === trackId && timelineItemsOverlap(start, duration, clip));
    const requested = props.project.tracks.find((track) => track.id === requestedTrackId && track.kind === requiredKind);
    if (requested && isFree(requested.id)) return requested.id;
    return props.project.tracks.find((track) => track.kind === requiredKind && isFree(track.id))?.id;
  };

  const timelineSnapCandidates = (excludeClipId?: string) => [
    0,
    playhead,
    ...props.project.timeline
      .filter((clip) => clip.id !== excludeClipId)
      .flatMap((clip) => [clip.start, clip.start + clip.duration])
  ];

  const snapTimelineStart = (rawStart: number, duration: number, excludeClipId?: string) => {
    const thresholdSeconds = clamp(10 / Math.max(0.001, timelinePixelsPerSecond), 1 / props.project.fps, 1.5);
    const candidates = timelineSnapCandidates(excludeClipId);
    let bestStart = Math.max(0, rawStart);
    let snapTime: number | undefined;
    let bestDistance = thresholdSeconds + Number.EPSILON;
    candidates.forEach((candidate) => {
      [candidate - rawStart, candidate - (rawStart + duration)].forEach((delta) => {
        const distance = Math.abs(delta);
        if (distance <= bestDistance && rawStart + delta >= 0) {
          bestDistance = distance;
          bestStart = rawStart + delta;
          snapTime = candidate;
        }
      });
    });
    if (snapTime === undefined) bestStart = Math.max(0, Math.round(rawStart * props.project.fps) / props.project.fps);
    return { start: bestStart, snapTime };
  };

  const updateTimelineDragPreview = (event: DragEvent<HTMLElement>, requestedTrackId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const source = timelineDragSourceRef.current;
    if (!source) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pointerTime = (event.clientX - bounds.left + timelineOffset) / Math.max(0.001, timelinePixelsPerSecond);
    const snapped = snapTimelineStart(pointerTime - source.grabOffset, source.duration, source.source === 'clip' ? source.id : undefined);
    const resolvedTrackId = requestedTrackId.startsWith('__new_')
      ? undefined
      : resolveTimelineTrack(source.kind, snapped.start, source.duration, requestedTrackId, source.source === 'clip' ? source.id : undefined);
    const nextPreview: TimelineDragPreview = {
      source: source.source,
      id: source.id,
      kind: source.kind,
      start: snapped.start,
      duration: source.duration,
      requestedTrackId,
      resolvedTrackId,
      snapTime: snapped.snapTime
    };
    timelineDragPreviewRef.current = nextPreview;
    setTimelineDragPreview(nextPreview);
  };

  const dropOnTrack = (event: DragEvent<HTMLElement>, trackId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const preview = timelineDragPreviewRef.current;
    if (!preview) return;
    const destinationTrackId = preview.resolvedTrackId || trackId;
    if (preview.source === 'asset') props.onPlaceAsset(preview.id, preview.start, destinationTrackId);
    else props.onMoveTimelineClip(preview.id, preview.start, destinationTrackId);
    timelineDragSourceRef.current = null;
    timelineDragPreviewRef.current = null;
    setTimelineDragPreview(null);
  };

  const beginTrim = (event: ReactPointerEvent<HTMLElement>, clip: TimelineItem, edge: 'start' | 'end') => {
    event.preventDefault();
    event.stopPropagation();
    const lane = event.currentTarget.closest('.track-lane');
    if (!(lane instanceof HTMLElement)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setTrimSnapTime(undefined);
    trimGestureRef.current = {
      pointerId: event.pointerId,
      clipId: clip.id,
      edge,
      startX: event.clientX,
      pixelsPerSecond: Math.max(0.001, timelinePixelsPerSecond),
      originStart: clip.start,
      originDuration: clip.duration,
      originTrimStart: clip.trimStart || 0
    };
  };

  const updateTrim = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = trimGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const delta = (event.clientX - gesture.startX) / gesture.pixelsPerSecond;
    const thresholdSeconds = clamp(10 / Math.max(0.001, gesture.pixelsPerSecond), 1 / props.project.fps, 1.5);
    const snapValue = (rawTime: number) => {
      const candidate = timelineSnapCandidates(gesture.clipId)
        .map((time) => ({ time, distance: Math.abs(time - rawTime) }))
        .filter((entry) => entry.distance <= thresholdSeconds)
        .sort((a, b) => a.distance - b.distance)[0];
      setTrimSnapTime(candidate?.time);
      return candidate?.time ?? rawTime;
    };
    if (gesture.edge === 'end') {
      const end = snapValue(gesture.originStart + gesture.originDuration + delta);
      props.onUpdateClip(gesture.clipId, { duration: Math.max(0.2, end - gesture.originStart) });
      return;
    }
    const start = snapValue(gesture.originStart + delta);
    const appliedDelta = clamp(start - gesture.originStart, -gesture.originStart, gesture.originDuration - 0.2);
    props.onUpdateClip(gesture.clipId, {
      start: gesture.originStart + appliedDelta,
      duration: gesture.originDuration - appliedDelta,
      trimStart: Math.max(0, gesture.originTrimStart + appliedDelta)
    });
  };

  const endTrim = (event: ReactPointerEvent<HTMLElement>) => {
    if (trimGestureRef.current?.pointerId === event.pointerId) {
      trimGestureRef.current = null;
      setTrimSnapTime(undefined);
    }
  };

  const currentAssetFolder = assetFolderId ? props.project.assetFolders.find((folder) => folder.id === assetFolderId) : undefined;
  const visibleAssetFolders = showAssetBin ? [] : props.project.assetFolders.filter((folder) => folder.parentId === assetFolderId);
  const visibleAssets = props.project.assets.filter((asset) => showAssetBin ? !!asset.trashedAt : !asset.trashedAt && asset.folderId === assetFolderId);
  const timelineTracksForRender: Array<TimelineTrack & { virtual?: boolean }> = [...props.project.tracks];
  if (timelineDragPreview && !timelineDragPreview.resolvedTrackId) {
    const kind = timelineTrackKind(timelineDragPreview.kind);
    const virtualTrack: TimelineTrack & { virtual: boolean } = {
      id: `__new_${kind}`,
      name: 'Nueva capa',
      kind,
      locked: false,
      muted: false,
      virtual: true
    };
    const firstMatchingTrack = timelineTracksForRender.findIndex((track) => track.kind === kind);
    if (kind === 'audio' || firstMatchingTrack < 0) timelineTracksForRender.push(virtualTrack);
    else timelineTracksForRender.splice(firstMatchingTrack, 0, virtualTrack);
  }

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const updateStageSize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = props.project.width / props.project.height;
      let width = bounds.width;
      let height = width / ratio;
      if (height > bounds.height) {
        height = bounds.height;
        width = height * ratio;
      }
      setStageSize({ width: Math.max(0, width), height: Math.max(0, height) });
    };
    const observer = new ResizeObserver(updateStageSize);
    observer.observe(canvas);
    updateStageSize();
    return () => observer.disconnect();
  }, [props.project.width, props.project.height]);

  useEffect(() => {
    const tracks = tracksRef.current;
    if (!tracks) return;
    const updateScrollbarWidth = () => setTimelineScrollbarWidth(Math.max(0, tracks.offsetWidth - tracks.clientWidth));
    const observer = new ResizeObserver(updateScrollbarWidth);
    observer.observe(tracks);
    updateScrollbarWidth();
    return () => observer.disconnect();
  }, [props.project.tracks.length]);

  useEffect(() => {
    const ruler = timelineRulerRef.current;
    if (!ruler) return;
    const updateWidth = () => setTimelineViewportWidth(Math.max(1, ruler.clientWidth));
    const observer = new ResizeObserver(updateWidth);
    observer.observe(ruler);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const maxOffset = Math.max(0, timelineContentWidth - timelineViewportWidth);
    setTimelineOffset((current) => clamp(current, 0, maxOffset));
  }, [timelineContentWidth, timelineViewportWidth]);

  const handleTimelineWheel = (event: WheelEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('.timeline-ruler, .tracks')) return;
    event.preventDefault();
    const horizontalGesture = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey;
    if (horizontalGesture && timelineZoom > 1) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      setTimelineOffset((current) => clamp(current + delta, 0, Math.max(0, timelineContentWidth - timelineViewportWidth)));
      return;
    }
    const bounds = timelineRulerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const cursorX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const timeAtCursor = (timelineOffset + cursorX) / Math.max(0.001, timelinePixelsPerSecond);
    const nextZoom = clamp(timelineZoom * Math.exp(-event.deltaY * 0.0015), 0.25, 8);
    const nextContentWidth = timelineViewportWidth * Math.max(1, nextZoom);
    const nextDisplayDuration = props.project.duration / Math.min(1, nextZoom);
    const nextPixelsPerSecond = nextContentWidth / Math.max(1, nextDisplayDuration);
    const nextMaxOffset = Math.max(0, nextContentWidth - timelineViewportWidth);
    setTimelineZoom(nextZoom);
    setTimelineOffset(clamp(timeAtCursor * nextPixelsPerSecond - cursorX, 0, nextMaxOffset));
  };

  useEffect(() => {
    const panel = timelinePanelRef.current;
    if (!panel) return;
    const onWheel = (event: WheelEvent) => handleTimelineWheel(event);
    panel.addEventListener('wheel', onWheel, { passive: false });
    return () => panel.removeEventListener('wheel', onWheel);
  }, [timelineContentWidth, timelineOffset, timelinePixelsPerSecond, timelineViewportWidth, timelineZoom, props.project.duration]);

  const beginPanelResize = (event: ReactPointerEvent<HTMLElement>, type: 'assets' | 'inspector' | 'timeline') => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panelResizeRef.current = {
      pointerId: event.pointerId,
      type,
      startX: event.clientX,
      startY: event.clientY,
      assetWidth: assetPanelWidth,
      inspectorWidth: inspectorPanelWidth,
      timelineHeight
    };
  };

  const updatePanelResize = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = panelResizeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const minimumPreviewWidth = 320;
    const maximumAssetWidth = Math.max(180, Math.min(440, window.innerWidth - inspectorPanelWidth - minimumPreviewWidth - 12));
    const maximumInspectorWidth = Math.max(220, Math.min(440, window.innerWidth - assetPanelWidth - minimumPreviewWidth - 12));
    const maximumTimelineHeight = Math.max(220, window.innerHeight - 56 - 220 - 6);
    if (gesture.type === 'assets') setAssetPanelWidth(clamp(gesture.assetWidth + event.clientX - gesture.startX, 180, maximumAssetWidth));
    if (gesture.type === 'inspector') setInspectorPanelWidth(clamp(gesture.inspectorWidth - event.clientX + gesture.startX, 220, maximumInspectorWidth));
    if (gesture.type === 'timeline') setTimelineHeight(clamp(gesture.timelineHeight - event.clientY + gesture.startY, 140, maximumTimelineHeight));
  };

  const endPanelResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (panelResizeRef.current?.pointerId === event.pointerId) panelResizeRef.current = null;
  };

  const beginTransform = (event: ReactPointerEvent<HTMLElement>, clip: TimelineItem, mode: 'move' | 'scale') => {
    if (clip.type === 'audio') return;
    event.preventDefault();
    event.stopPropagation();
    selectClip(clip.id, event.ctrlKey || event.metaKey || event.shiftKey);
    event.currentTarget.setPointerCapture(event.pointerId);
    transformGestureRef.current = {
      mode,
      pointerId: event.pointerId,
      clipId: clip.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: clip.transform.x,
      originY: clip.transform.y,
      originScale: clip.transform.scale,
      stageWidth: Math.max(1, stageSize.width),
      stageHeight: Math.max(1, stageSize.height)
    };
  };

  const updateTransformGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = transformGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.mode === 'move') {
      props.onUpdateClip(gesture.clipId, {
        transform: {
          ...(props.project.timeline.find((clip) => clip.id === gesture.clipId)?.transform || defaultTransform()),
          x: clamp(gesture.originX + ((event.clientX - gesture.startX) / gesture.stageWidth) * 100, -100, 100),
          y: clamp(gesture.originY + ((event.clientY - gesture.startY) / gesture.stageHeight) * 100, -100, 100)
        }
      });
      return;
    }
    const delta = ((event.clientX - gesture.startX) / gesture.stageWidth + (event.clientY - gesture.startY) / gesture.stageHeight) / 2;
    props.onUpdateClip(gesture.clipId, {
      transform: {
        ...(props.project.timeline.find((clip) => clip.id === gesture.clipId)?.transform || defaultTransform()),
        scale: clamp(gesture.originScale + delta * 3, 0.1, 5)
      }
    });
  };

  const endTransformGesture = (event: ReactPointerEvent<HTMLElement>) => {
    if (transformGestureRef.current?.pointerId === event.pointerId) transformGestureRef.current = null;
  };

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setPlayhead((current) => {
        const next = current + 0.1;
        if (next >= props.project.duration) {
          setPlaying(false);
          return 0;
        }
        return next;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, props.project.duration]);

  return (
    <main
      className={`editor-shell ${props.isDragging ? 'dragging' : ''}`}
      style={{
        '--asset-panel-width': `${assetPanelWidth}px`,
        '--inspector-panel-width': `${inspectorPanelWidth}px`,
        '--timeline-height': `${timelineHeight}px`
      } as CSSProperties}
      onDrop={(event) => {
        event.preventDefault();
        props.onDragLeave();
        if (event.dataTransfer.files.length) props.onFiles(event.dataTransfer.files, assetFolderId);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-inhouse-asset') || event.dataTransfer.types.includes('application/x-inhouse-clip')) {
          event.preventDefault();
          return;
        }
        props.onDragOver(event);
      }}
      onDragLeave={props.onDragLeave}
    >
      <header className="editor-topbar">
        <button className="logo-button" onClick={props.onBack}>
          <RoofLogo />
          <span className="brand-name">inhouse vidmaker</span>
          <span className="doc-title">{props.project.name}</span>
        </button>
        <div className="header-actions">
          <span className={`save-pill ${props.saveStatus}`}>{statusCopy(props.saveStatus)}</span>
          <button className="btn btn-secondary" onClick={props.onBack}><ArrowLeft size={16} /> Home</button>
          <button className="btn btn-primary" onClick={props.onExport}><Download size={16} /> Exportar</button>
          <button className="drive-profile-btn" title={props.profile?.email || 'Local'}>
            {props.profile?.picture ? <img className="drive-profile-avatar" src={props.profile.picture} alt="Profile" /> : <User size={19} />}
          </button>
        </div>
      </header>

      <section className="editor-grid">
        <aside className="asset-panel">
          <div className="panel-head">
            <div>
              <h2>{showAssetBin ? 'Papelera' : 'Assets'}</h2>
              <span className="panel-subtitle">{visibleAssets.length} archivos</span>
            </div>
            <div className="asset-panel-actions">
              {!showAssetBin ? <button className="btn btn-secondary btn-icon-square" title="Nueva carpeta" onClick={() => setCreatingAssetFolder(true)}><FolderPlus size={17} /></button> : null}
              <button className={`btn btn-secondary btn-icon-square ${showAssetBin ? 'active' : ''}`} title={showAssetBin ? 'Volver a assets' : 'Papelera'} onClick={() => { setShowAssetBin((value) => !value); setMovingAssetId(undefined); }}>
                {showAssetBin ? <ArrowLeft size={17} /> : <Trash2 size={17} />}
              </button>
            </div>
          </div>
          {!showAssetBin ? (
            <>
              <div className="asset-breadcrumbs">
                <button onClick={() => setAssetFolderId(undefined)}>Assets</button>
                {currentAssetFolder ? <><ChevronRight size={13} /><span>{currentAssetFolder.name}</span></> : null}
              </div>
              <button className="dropzone" onClick={props.onPickFiles}>
                <Upload size={22} />
                <span>Arrastra archivos o haz clic</span>
              </button>
            </>
          ) : null}
          {isCreatingAssetFolder && !showAssetBin ? (
            <form className="asset-inline-form" onSubmit={(event) => { event.preventDefault(); props.onCreateAssetFolder(assetFolderName, assetFolderId); setAssetFolderName(''); setCreatingAssetFolder(false); }}>
              <input autoFocus value={assetFolderName} placeholder="Nombre de carpeta" onChange={(event) => setAssetFolderName(event.target.value)} />
              <button className="btn btn-primary" type="submit">Crear</button>
              <button className="btn btn-secondary btn-icon-square" type="button" onClick={() => setCreatingAssetFolder(false)}>×</button>
            </form>
          ) : null}
          <div className="asset-list">
            {visibleAssetFolders.map((folder) => (
              <button className="asset-folder-row" key={folder.id} onClick={() => setAssetFolderId(folder.id)}>
                <Folder size={19} /><strong>{folder.name}</strong><ChevronRight size={16} />
              </button>
            ))}
            {visibleAssets.map((asset) => (
              <div className={`asset-row ${selectedAssetId === asset.id ? 'selected' : ''}`} key={asset.id}>
                <button
                  className="asset-open-button"
                  draggable={!showAssetBin}
                  onDragStart={(event) => {
                    const duration = asset.kind === 'image' ? 5 : clamp(asset.duration || 6, 0.2, 60 * 60);
                    timelineDragSourceRef.current = { source: 'asset', id: asset.id, kind: asset.kind, duration, grabOffset: 0 };
                    event.dataTransfer.setData('application/x-inhouse-asset', asset.id);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragEnd={() => { timelineDragSourceRef.current = null; timelineDragPreviewRef.current = null; setTimelineDragPreview(null); }}
                  onClick={() => focusAsset(asset.id)}
                  onDoubleClick={() => props.onPlaceAsset(asset.id, playhead)}
                  title="Arrastra a la timeline o haz doble clic"
                >
                  {asset.kind === 'video' ? <Video size={18} /> : asset.kind === 'audio' ? <Music size={18} /> : <ImageIcon size={18} />}
                  <span className="asset-copy"><strong>{asset.name}</strong><span>{formatBytes(asset.size)} - {asset.uploadState}</span></span>
                </button>
                <div className="asset-row-actions">
                  {showAssetBin ? (
                    <button title="Restaurar" onClick={() => props.onRestoreAsset(asset.id)}><RotateCcw size={15} /></button>
                  ) : (
                    <>
                      <button title="Mover" onClick={() => setMovingAssetId(movingAssetId === asset.id ? undefined : asset.id)}><FolderInput size={15} /></button>
                      <button title="Mover a la papelera" onClick={() => props.onTrashAsset(asset.id)}><Trash2 size={15} /></button>
                    </>
                  )}
                </div>
                {movingAssetId === asset.id ? (
                  <div className="asset-move-menu">
                    <strong>Mover a</strong>
                    <button onClick={() => { props.onMoveAsset(asset.id, undefined); setMovingAssetId(undefined); }}><Folder size={15} /> Assets</button>
                    {props.project.assetFolders.map((folder) => <button key={folder.id} onClick={() => { props.onMoveAsset(asset.id, folder.id); setMovingAssetId(undefined); }}><Folder size={15} /> {folder.name}</button>)}
                  </div>
                ) : null}
              </div>
            ))}
            {!visibleAssets.length && !visibleAssetFolders.length ? <div className="panel-empty">{showAssetBin ? 'La papelera esta vacia.' : 'Esta carpeta esta vacia.'}</div> : null}
          </div>
        </aside>

        <div
          className="panel-resizer vertical"
          role="separator"
          aria-label="Cambiar ancho de assets"
          aria-orientation="vertical"
          onDoubleClick={() => setAssetPanelWidth(268)}
          onPointerDown={(event) => beginPanelResize(event, 'assets')}
          onPointerMove={updatePanelResize}
          onPointerUp={endPanelResize}
          onPointerCancel={endPanelResize}
        />

        <section className="preview-panel">
          <div className="preview-canvas" ref={previewCanvasRef}>
            <div className="preview-hud">
              <div>
                <strong>{props.project.name}</strong>
                <span>{props.project.width}x{props.project.height} - {props.project.fps}fps</span>
              </div>
              <span>{playhead.toFixed(1)}s</span>
            </div>
            <div
              className="preview-stage"
              style={{ width: stageSize.width, height: stageSize.height }}
              onPointerMove={updateTransformGesture}
              onPointerUp={endTransformGesture}
              onPointerCancel={endTransformGesture}
            >
              {activeVisualClips.map((clip) => {
                const asset = clip.assetId ? props.project.assets.find((item) => item.id === clip.assetId) : undefined;
                if (!asset?.objectUrl) return null;
                const projectRatio = props.project.width / props.project.height;
                const assetRatio = asset.width && asset.height ? asset.width / asset.height : projectRatio;
                const mediaWidth = assetRatio >= projectRatio ? 100 : (assetRatio / projectRatio) * 100;
                const mediaHeight = assetRatio >= projectRatio ? (projectRatio / assetRatio) * 100 : 100;
                const trackIndex = props.project.tracks.findIndex((track) => track.id === clip.trackId);
                return (
                  <div
                    key={clip.id}
                    className={`preview-media-layer ${asset.kind} ${selectedClipIds.includes(clip.id) ? 'selected' : ''}`}
                    style={{
                      width: `${mediaWidth}%`,
                      height: `${mediaHeight}%`,
                      left: `${50 + clip.transform.x}%`,
                      top: `${50 + clip.transform.y}%`,
                      zIndex: props.project.tracks.length - trackIndex,
                      transform: `translate(-50%, -50%) scale(${clip.transform.scale}) rotate(${clip.transform.rotation}deg)`,
                      opacity: clip.transform.opacity / 100
                    }}
                    onPointerDown={(event) => beginTransform(event, clip, 'move')}
                  >
                    {asset.kind === 'video' ? (
                      <video ref={(node) => { if (node) videoRefs.current.set(clip.id, node); else videoRefs.current.delete(clip.id); }} src={asset.objectUrl} muted playsInline controls={false} draggable={false} />
                    ) : (
                      <img src={asset.objectUrl} alt="" draggable={false} />
                    )}
                    {selectedClipId === clip.id ? (
                      <button
                        className="transform-handle"
                        aria-label="Cambiar tamano"
                        title="Arrastra para cambiar el tamano"
                        onPointerDown={(event) => beginTransform(event, clip, 'scale')}
                      />
                    ) : null}
                  </div>
                );
              })}
              {!activeVisualClips.length && activeAudioAsset?.objectUrl ? (
                <div className="audio-preview"><Music size={52} /> {activeAudioAsset.name}</div>
              ) : !activeVisualClips.length ? (
                <div className="empty-preview">
                  <Film size={54} />
                  <span>Arrastra clips a la linea de tiempo</span>
                </div>
              ) : null}
              {props.project.timeline
                .filter((clip) => clip.type === 'text' && clip.start <= playhead && clip.start + clip.duration >= playhead)
                .map((clip) => (
                  <div
                    className={`preview-text-layer ${selectedClipIds.includes(clip.id) ? 'selected' : ''}`}
                    key={clip.id}
                    style={{
                      left: `${50 + clip.transform.x}%`,
                      top: `${50 + clip.transform.y}%`,
                      transform: `translate(-50%, -50%) scale(${clip.transform.scale}) rotate(${clip.transform.rotation}deg)`,
                      opacity: clip.transform.opacity / 100
                    }}
                    onPointerDown={(event) => beginTransform(event, clip, 'move')}
                  >
                    <span>{clip.text}</span>
                    {selectedClipId === clip.id ? <button className="transform-handle" aria-label="Cambiar tamano" onPointerDown={(event) => beginTransform(event, clip, 'scale')} /> : null}
                  </div>
                ))}
            </div>
          </div>
          <div className="transport">
            <button className="btn btn-secondary btn-icon-square" onClick={() => setPlaying((value) => !value)}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <input
              type="range"
              min={0}
              max={props.project.duration}
              step={0.1}
              value={playhead}
              onChange={(event) => setPlayhead(Number(event.target.value))}
            />
            <span className="transport-time">{playhead.toFixed(1)}s / {props.project.duration.toFixed(1)}s</span>
          </div>
        </section>

        <div
          className="panel-resizer vertical"
          role="separator"
          aria-label="Cambiar ancho del inspector"
          aria-orientation="vertical"
          onDoubleClick={() => setInspectorPanelWidth(286)}
          onPointerDown={(event) => beginPanelResize(event, 'inspector')}
          onPointerMove={updatePanelResize}
          onPointerUp={endPanelResize}
          onPointerCancel={endPanelResize}
        />

        <aside className="inspector-panel">
          <div className="panel-head">
            <div>
              <h2>Inspector</h2>
              <span className="panel-subtitle">{selectedClip ? selectedClip.type : 'sin seleccion'}</span>
            </div>
          </div>
          {selectedClip ? (
            <div className="inspector-fields">
              <div className="clip-summary">
                <strong>{selectedClip.type === 'text' ? (selectedClip.text || 'Texto') : selectedClip.type}</strong>
                <span>{selectedClip.start.toFixed(1)}s - {(selectedClip.start + selectedClip.duration).toFixed(1)}s</span>
              </div>
              <label>Inicio <input type="number" value={selectedClip.start} min={0} step={0.1} onChange={(event) => props.onUpdateClip(selectedClip.id, { start: Number(event.target.value) })} /></label>
              <label>Duracion <input type="number" value={selectedClip.duration} min={0.2} step={0.1} onChange={(event) => props.onUpdateClip(selectedClip.id, { duration: Number(event.target.value) })} /></label>
              {selectedClip.type === 'text' ? (
                <label>Texto <textarea value={selectedClip.text || ''} onChange={(event) => props.onUpdateClip(selectedClip.id, { text: event.target.value })} /></label>
              ) : null}
              {selectedClip.type !== 'audio' ? (
                <>
                  <div className="transform-field-row">
                    <label>Posicion X <input type="number" value={Math.round(selectedClip.transform.x * 10) / 10} min={-100} max={100} step={1} onChange={(event) => props.onUpdateClip(selectedClip.id, { transform: { ...selectedClip.transform, x: clamp(Number(event.target.value), -100, 100) } })} /></label>
                    <label>Posicion Y <input type="number" value={Math.round(selectedClip.transform.y * 10) / 10} min={-100} max={100} step={1} onChange={(event) => props.onUpdateClip(selectedClip.id, { transform: { ...selectedClip.transform, y: clamp(Number(event.target.value), -100, 100) } })} /></label>
                  </div>
                  <label>Escala <input type="range" min={10} max={500} value={selectedClip.transform.scale * 100} onChange={(event) => props.onUpdateClip(selectedClip.id, { transform: { ...selectedClip.transform, scale: Number(event.target.value) / 100 } })} /><span className="field-value">{Math.round(selectedClip.transform.scale * 100)}%</span></label>
                  <label>Rotacion <input type="number" min={-180} max={180} step={1} value={selectedClip.transform.rotation} onChange={(event) => props.onUpdateClip(selectedClip.id, { transform: { ...selectedClip.transform, rotation: clamp(Number(event.target.value), -180, 180) } })} /></label>
                </>
              ) : null}
              <label>Opacidad <input type="range" min={0} max={100} value={selectedClip.transform.opacity} onChange={(event) => props.onUpdateClip(selectedClip.id, { transform: { ...selectedClip.transform, opacity: Number(event.target.value) } })} /></label>
              <div className="inspector-actions">
                {selectedClip.type !== 'audio' ? <button className="btn btn-secondary btn-icon-square" title="Restablecer transformacion" onClick={() => props.onUpdateClip(selectedClip.id, { transform: defaultTransform() })}><RotateCcw size={15} /></button> : null}
                <button className="btn btn-secondary" disabled={!splittableClipIds.length} onClick={() => props.onSplitAtPlayhead(playhead, selectedClipIds)}><Scissors size={15} /> Dividir</button>
                <button className="btn btn-secondary danger" onClick={() => props.onDeleteClip(selectedClip.id)}><Trash2 size={15} /> Borrar</button>
              </div>
            </div>
          ) : (
            <div className="panel-empty">Selecciona un clip.</div>
          )}
        </aside>
      </section>

      <div
        className="panel-resizer horizontal"
        role="separator"
        aria-label="Cambiar altura de la timeline"
        aria-orientation="horizontal"
        onDoubleClick={() => setTimelineHeight(212)}
        onPointerDown={(event) => beginPanelResize(event, 'timeline')}
        onPointerMove={updatePanelResize}
        onPointerUp={endPanelResize}
        onPointerCancel={endPanelResize}
      />

      <section className="timeline-panel" ref={timelinePanelRef}>
        <div className="timeline-toolbar">
          <div className="timeline-actions">
            <button className="btn btn-secondary" onClick={props.onAddText}><Type size={16} /> Texto</button>
            <button className="btn btn-secondary" onClick={props.onPickFiles}><Upload size={16} /> Importar</button>
          </div>
          <div className="timeline-meta">{props.project.timeline.length} clips - {props.project.duration.toFixed(1)}s - {Math.round(timelineZoom * 100)}%</div>
        </div>
        <div
          className="timeline-ruler timeline-scrub-area"
          ref={timelineRulerRef}
          style={{ marginRight: timelineScrollbarWidth }}
          onPointerDown={beginScrub}
          onPointerMove={continueScrub}
        >
          <div className="timeline-ruler-content" style={{ width: timelineContentWidth, transform: `translateX(${-timelineOffset}px)` }}>
            {Array.from({ length: Math.ceil(timelineDisplayDuration / timelineTickStep) + 1 }).map((_, index) => {
              const tick = index * timelineTickStep;
              return <span key={tick} style={{ left: `${(tick / Math.max(1, timelineDisplayDuration)) * 100}%` }}>{tick}s</span>;
            })}
            <div className="playhead" style={{ left: `${(playhead / Math.max(1, timelineDisplayDuration)) * 100}%` }}>
              <button
                className={`playhead-cut-button ${splittableClipIds.length ? '' : 'disabled'}`}
                title={selectedClipIds.length ? 'Cortar seleccion (Ctrl+B)' : 'Cortar todas las capas (Ctrl+B)'}
                aria-label="Cortar en el playhead"
                aria-disabled={!splittableClipIds.length}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  if (splittableClipIds.length) props.onSplitAtPlayhead(playhead, selectedClipIds);
                }}
              >
                <Scissors size={12} />
              </button>
            </div>
            {visibleSnapTime !== undefined ? <div className="timeline-snap-guide ruler" style={{ left: `${(visibleSnapTime / Math.max(1, timelineDisplayDuration)) * 100}%` }} /> : null}
          </div>
        </div>
        <div className="tracks" ref={tracksRef}>
          {timelineTracksForRender.map((track) => (
            <div className={`track-row ${track.virtual ? 'virtual' : ''}`} key={track.id}>
              <div className="track-label">{track.name}</div>
              <div
                className="track-lane timeline-scrub-area"
                onPointerDown={beginTimelineSelection}
                onPointerMove={updateTimelineSelection}
                onPointerUp={endTimelineSelection}
                onPointerCancel={endTimelineSelection}
                onDragOver={(event) => {
                  event.dataTransfer.dropEffect = event.dataTransfer.types.includes('application/x-inhouse-asset') ? 'copy' : 'move';
                  updateTimelineDragPreview(event, track.id);
                }}
                onDrop={(event) => dropOnTrack(event, track.id)}
              >
                <div className="track-lane-content" style={{ width: timelineContentWidth, transform: `translateX(${-timelineOffset}px)` }}>
                  {props.project.timeline.filter((clip) => clip.trackId === track.id).map((clip) => {
                    const asset = clip.assetId ? props.project.assets.find((item) => item.id === clip.assetId) : undefined;
                    const left = (clip.start / Math.max(1, timelineDisplayDuration)) * 100;
                    const width = (clip.duration / Math.max(1, timelineDisplayDuration)) * 100;
                    return (
                      <div
                      key={clip.id}
                      data-clip-id={clip.id}
                        className={`timeline-clip ${clip.type} ${selectedClipIds.includes(clip.id) ? 'selected' : ''} ${timelineDragPreview?.source === 'clip' && timelineDragPreview.id === clip.id ? 'dragging-source' : ''}`}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(event) => {
                          event.stopPropagation();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          timelineDragSourceRef.current = {
                            source: 'clip',
                            id: clip.id,
                            kind: clip.type,
                            duration: clip.duration,
                            grabOffset: clamp((event.clientX - bounds.left) / Math.max(0.001, timelinePixelsPerSecond), 0, clip.duration)
                          };
                          if (!selectedClipIds.includes(clip.id)) selectClip(clip.id);
                          event.dataTransfer.setData('application/x-inhouse-clip', clip.id);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onDragEnd={() => { timelineDragSourceRef.current = null; timelineDragPreviewRef.current = null; setTimelineDragPreview(null); }}
                        onClick={(event) => selectClip(clip.id, event.ctrlKey || event.metaKey || event.shiftKey)}
                      >
                        <button className="clip-trim-handle start" aria-label="Ajustar inicio" onPointerDown={(event) => beginTrim(event, clip, 'start')} onPointerMove={updateTrim} onPointerUp={endTrim} onPointerCancel={endTrim} />
                        <span>{clip.type === 'text' ? (clip.text || 'Texto') : (asset?.name || clip.type)}</span>
                        <button className="clip-trim-handle end" aria-label="Ajustar final" onPointerDown={(event) => beginTrim(event, clip, 'end')} onPointerMove={updateTrim} onPointerUp={endTrim} onPointerCancel={endTrim} />
                      </div>
                    );
                  })}
                  {timelineDragPreview && ((timelineDragPreview.resolvedTrackId === track.id) || (track.virtual && !timelineDragPreview.resolvedTrackId)) ? (
                    <div
                      className={`timeline-drop-preview ${timelineDragPreview.kind}`}
                      style={{
                        left: `${(timelineDragPreview.start / Math.max(1, timelineDisplayDuration)) * 100}%`,
                        width: `${(timelineDragPreview.duration / Math.max(1, timelineDisplayDuration)) * 100}%`
                      }}
                    />
                  ) : null}
                  <div className="track-playhead" style={{ left: `${(playhead / Math.max(1, timelineDisplayDuration)) * 100}%` }} />
                  {visibleSnapTime !== undefined ? <div className="timeline-snap-guide" style={{ left: `${(visibleSnapTime / Math.max(1, timelineDisplayDuration)) * 100}%` }} /> : null}
                </div>
              </div>
            </div>
          ))}
          {timelineSelectionBox ? <div className="timeline-selection-box" style={timelineSelectionBox} /> : null}
        </div>
      </section>

      <input
        ref={props.fileInputRef}
        className="hidden"
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={(event) => {
          if (event.target.files) void props.onFiles(event.target.files, assetFolderId);
          event.target.value = '';
        }}
      />
      {props.isDragging ? <div className="drop-hint"><Upload size={22} /> Suelta para subir a assets</div> : null}
    </main>
  );
}

function Toast(props: { text: string; onDone(): void }) {
  useEffect(() => {
    const timer = window.setTimeout(props.onDone, 4200);
    return () => window.clearTimeout(timer);
  }, [props.onDone]);
  return <div className="toast">{props.text}</div>;
}
