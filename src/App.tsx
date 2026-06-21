import {
  ArrowLeft,
  ChevronRight,
  Download,
  Film,
  Folder,
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
import { ChangeEvent, DragEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createDriveClient } from './drive';
import { DRIVE_SYNC_DEBOUNCE_MS, PROJECT_APP_PROPERTY, PROJECT_FILE_NAME, PROJECT_FOLDER_PROPERTY } from './constants';
import { loadStoredState, persistStoredState } from './storage';
import type { AssetRecord, DriveClient, DriveFolder, DriveProjectFile, FolderPickerResult, ProjectRecord, SaveStatus, TimelineItem } from './types';
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
        return { ...project, projectFileId: file.id, trashedAt: undefined, updatedAt: project.updatedAt || file.modifiedTime || nowIso() };
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

  async function addFiles(files: FileList | File[]) {
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
      const asset: AssetRecord = {
        id: uid('asset'),
        name: file.name,
        mimeType: file.type,
        kind,
        size: file.size,
        objectUrl: URL.createObjectURL(file),
        uploadState: drive.accessToken && activeProject.assetsFolderId ? 'uploading' : 'local',
        createdAt: nowIso()
      };
      const item: TimelineItem = {
        id: uid('clip'),
        type: kind,
        trackId: kind === 'audio' ? 'track_audio_1' : 'track_video_1',
        assetId: asset.id,
        start: activeProject.timeline.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0),
        duration: kind === 'image' ? 5 : 6,
        transform: defaultTransform()
      };
      patchActiveProject((project) => ({
        ...project,
        assets: [asset, ...project.assets],
        timeline: [...project.timeline, item],
        duration: Math.max(project.duration, item.start + item.duration)
      }));
      if (drive.accessToken && activeProject.assetsFolderId) {
        try {
          setSaveStatus('uploading');
          const uploaded = await drive.uploadFile(file, activeProject.assetsFolderId);
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

  function addTextClip() {
    if (!activeProject) return;
    const start = activeProject.timeline.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
    patchActiveProject((project) => ({
      ...project,
      timeline: [
        ...project.timeline,
        {
          id: uid('clip'),
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
  }

  function updateClip(clipId: string, patch: Partial<TimelineItem>) {
    patchActiveProject((project) => ({
      ...project,
      timeline: project.timeline.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip)
    }));
  }

  function splitClip(clipId: string) {
    if (!activeProject) return;
    const clip = activeProject.timeline.find((item) => item.id === clipId);
    if (!clip || clip.duration <= 1) return;
    const firstDuration = Number((clip.duration / 2).toFixed(2));
    const secondDuration = Number((clip.duration - firstDuration).toFixed(2));
    patchActiveProject((project) => ({
      ...project,
      timeline: project.timeline.flatMap((item) => {
        if (item.id !== clipId) return [item];
        return [
          { ...item, duration: firstDuration },
          {
            ...item,
            id: uid('clip'),
            start: item.start + firstDuration,
            duration: secondDuration,
            trimStart: (item.trimStart || 0) + firstDuration
          }
        ];
      })
    }));
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
        onBack={() => setActiveProjectId(undefined)}
        onFiles={addFiles}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onPickFiles={() => fileInputRef.current?.click()}
        fileInputRef={fileInputRef}
        onAddText={addTextClip}
        onUpdateClip={updateClip}
        onSplitClip={splitClip}
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
        <p>Inicia sesion con Google para abrir tus proyectos, carpetas y archivos desde Drive.</p>
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
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onBack(): void;
  onFiles(files: FileList | File[]): void;
  onDrop(event: DragEvent<HTMLElement>): void;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(): void;
  onPickFiles(): void;
  onAddText(): void;
  onUpdateClip(clipId: string, patch: Partial<TimelineItem>): void;
  onSplitClip(clipId: string): void;
  onDeleteClip(clipId: string): void;
  onExport(): void;
}) {
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const previewCanvasRef = useRef<HTMLDivElement>(null);
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
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const selectedClip = props.project.timeline.find((clip) => clip.id === selectedClipId);
  const activeClip = props.project.timeline
    .filter((clip) => clip.start <= playhead && clip.start + clip.duration >= playhead)
    .sort((a, b) => (a.type === 'text' ? 1 : 0) - (b.type === 'text' ? 1 : 0))[0];
  const activeAsset = activeClip?.assetId ? props.project.assets.find((asset) => asset.id === activeClip.assetId) : undefined;

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

  const beginTransform = (event: ReactPointerEvent<HTMLElement>, mode: 'move' | 'scale') => {
    if (!activeClip || activeClip.type === 'audio') return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(activeClip.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    transformGestureRef.current = {
      mode,
      pointerId: event.pointerId,
      clipId: activeClip.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: activeClip.transform.x,
      originY: activeClip.transform.y,
      originScale: activeClip.transform.scale,
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
      onDrop={props.onDrop}
      onDragOver={props.onDragOver}
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
              <h2>Assets</h2>
              <span className="panel-subtitle">{props.project.assets.length} archivos</span>
            </div>
            <button className="btn btn-secondary btn-icon-square" onClick={props.onPickFiles}><Upload size={17} /></button>
          </div>
          <button className="dropzone" onClick={props.onPickFiles}>
            <Upload size={22} />
            <span>Arrastra archivos o haz clic</span>
          </button>
          <div className="asset-list">
            {props.project.assets.map((asset) => (
              <div className="asset-row" key={asset.id}>
                {asset.kind === 'video' ? <Video size={18} /> : asset.kind === 'audio' ? <Music size={18} /> : <ImageIcon size={18} />}
                <div>
                  <strong>{asset.name}</strong>
                  <span>{formatBytes(asset.size)} - {asset.uploadState}</span>
                </div>
                <span className={`asset-kind-pill ${asset.kind}`}>{asset.kind}</span>
              </div>
            ))}
            {!props.project.assets.length ? <div className="panel-empty">Sin assets todavia.</div> : null}
          </div>
        </aside>

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
              {activeAsset?.objectUrl && (activeAsset.kind === 'video' || activeAsset.kind === 'image') && activeClip ? (
                <div
                  className={`preview-media-layer ${selectedClipId === activeClip.id ? 'selected' : ''}`}
                  style={{
                    left: `${50 + activeClip.transform.x}%`,
                    top: `${50 + activeClip.transform.y}%`,
                    transform: `translate(-50%, -50%) scale(${activeClip.transform.scale}) rotate(${activeClip.transform.rotation}deg)`,
                    opacity: activeClip.transform.opacity / 100
                  }}
                  onPointerDown={(event) => beginTransform(event, 'move')}
                >
                  {activeAsset.kind === 'video' ? (
                    <video src={activeAsset.objectUrl} muted autoPlay={playing} controls={false} draggable={false} />
                  ) : (
                    <img src={activeAsset.objectUrl} alt="" draggable={false} />
                  )}
                  {selectedClipId === activeClip.id ? (
                    <button
                      className="transform-handle"
                      aria-label="Cambiar tamano"
                      title="Arrastra para cambiar el tamano"
                      onPointerDown={(event) => beginTransform(event, 'scale')}
                    />
                  ) : null}
                </div>
              ) : activeAsset?.objectUrl && activeAsset.kind === 'audio' ? (
                <div className="audio-preview"><Music size={52} /> {activeAsset.name}</div>
              ) : (
                <div className="empty-preview">
                  <Film size={54} />
                  <span>Arrastra clips a la linea de tiempo</span>
                </div>
              )}
              {props.project.timeline
                .filter((clip) => clip.type === 'text' && clip.start <= playhead && clip.start + clip.duration >= playhead)
                .map((clip) => <div className="preview-text" key={clip.id}>{clip.text}</div>)}
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
                <button className="btn btn-secondary" onClick={() => props.onSplitClip(selectedClip.id)}><Scissors size={15} /> Dividir</button>
                <button className="btn btn-secondary danger" onClick={() => props.onDeleteClip(selectedClip.id)}><Trash2 size={15} /> Borrar</button>
              </div>
            </div>
          ) : (
            <div className="panel-empty">Selecciona un clip.</div>
          )}
        </aside>
      </section>

      <section className="timeline-panel">
        <div className="timeline-toolbar">
          <div className="timeline-actions">
            <button className="btn btn-secondary" onClick={props.onAddText}><Type size={16} /> Texto</button>
            <button className="btn btn-secondary" onClick={props.onPickFiles}><Upload size={16} /> Importar</button>
          </div>
          <div className="timeline-meta">{props.project.timeline.length} clips - {props.project.duration.toFixed(1)}s</div>
        </div>
        <div className="timeline-ruler">
          {Array.from({ length: Math.ceil(props.project.duration) + 1 }).map((_, index) => <span key={index}>{index}s</span>)}
          <div className="playhead" style={{ left: `${(playhead / Math.max(1, props.project.duration)) * 100}%` }} />
        </div>
        <div className="tracks">
          {props.project.tracks.map((track) => (
            <div className="track-row" key={track.id}>
              <div className="track-label">{track.name}</div>
              <div className="track-lane">
                {props.project.timeline.filter((clip) => clip.trackId === track.id).map((clip) => {
                  const asset = clip.assetId ? props.project.assets.find((item) => item.id === clip.assetId) : undefined;
                  const left = (clip.start / Math.max(1, props.project.duration)) * 100;
                  const width = (clip.duration / Math.max(1, props.project.duration)) * 100;
                  return (
                    <button
                      key={clip.id}
                      className={`timeline-clip ${clip.type} ${selectedClipId === clip.id ? 'selected' : ''}`}
                      style={{ left: `${left}%`, width: `${clamp(width, 4, 100)}%` }}
                      onClick={() => setSelectedClipId(clip.id)}
                    >
                      {clip.type === 'text' ? (clip.text || 'Texto') : (asset?.name || clip.type)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <input
        ref={props.fileInputRef}
        className="hidden"
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        onChange={(event) => {
          if (event.target.files) void props.onFiles(event.target.files);
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
