export type SaveStatus = 'idle' | 'local' | 'saving' | 'uploading' | 'saved' | 'paused' | 'error';

export type AssetKind = 'video' | 'audio' | 'image';

export type TimelineItemType = AssetKind | 'text';

export interface DriveProfile {
  name: string;
  email: string;
  picture: string;
}

export interface DriveFolder {
  id: string;
  name: string;
}

export interface DriveProjectFile {
  id: string;
  name: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  thumbnailLink?: string;
  mimeType?: string;
}

export interface AssetRecord {
  id: string;
  driveFileId?: string;
  folderId?: string;
  trashedAt?: string;
  name: string;
  mimeType: string;
  kind: AssetKind;
  size: number;
  duration?: number;
  width?: number;
  height?: number;
  thumbnailDataUrl?: string;
  objectUrl?: string;
  uploadState: 'local' | 'uploading' | 'uploaded' | 'error';
  createdAt: string;
}

export interface AssetFolderRecord {
  id: string;
  name: string;
  parentId?: string;
  createdAt: string;
}

export interface TransformRecord {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  flipX: boolean;
  flipY: boolean;
  fit: 'contain' | 'cover';
}

export interface TextStyleRecord {
  fontFamily: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  backgroundColor: string;
  backgroundOpacity: number;
  animation: 'none' | 'fade' | 'slide-up' | 'typewriter';
}

export interface TransitionRecord {
  type: 'none' | 'fade' | 'dissolve' | 'slide';
  duration: number;
}

export interface TimelineItem {
  id: string;
  type: TimelineItemType;
  trackId: string;
  assetId?: string;
  start: number;
  duration: number;
  trimStart?: number;
  trimEnd?: number;
  text?: string;
  transform: TransformRecord;
  textStyle?: TextStyleRecord;
  transition?: TransitionRecord;
  playbackRate?: number;
  reverse?: boolean;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'text';
  locked: boolean;
  muted: boolean;
  hidden: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  folderId?: string;
  projectFileId?: string;
  assetsFolderId?: string;
  rendersFolderId?: string;
  thumbsFolderId?: string;
  trashedAt?: string;
  createdAt: string;
  updatedAt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  assets: AssetRecord[];
  assetFolders: AssetFolderRecord[];
  tracks: TimelineTrack[];
  timeline: TimelineItem[];
}

export interface StoredState {
  version: 1;
  savedAt: string;
  activeProjectId?: string;
  projects: ProjectRecord[];
}

export interface FolderPickerResult {
  projectName: string;
  parentId: string;
}

export interface DriveClient {
  isConfigured: boolean;
  accessToken: string;
  profile: DriveProfile | null;
  signIn(): Promise<DriveProfile>;
  signOut(): void;
  listFolders(parentId?: string): Promise<DriveFolder[]>;
  createFolder(name: string, parentId?: string, appProperties?: Record<string, string>): Promise<DriveFolder>;
  listProjects(): Promise<DriveProjectFile[]>;
  listTrash(): Promise<DriveProjectFile[]>;
  trashFile(fileId: string): Promise<void>;
  restoreFile(fileId: string): Promise<void>;
  downloadJson<T>(fileId: string): Promise<T>;
  downloadFile(fileId: string): Promise<Blob>;
  downloadThumbnail(fileId: string): Promise<Blob | undefined>;
  moveFile(fileId: string, destinationFolderId: string, previousFolderId: string): Promise<void>;
  uploadJson(name: string, data: unknown, parentId: string, appProperties?: Record<string, string>): Promise<DriveProjectFile>;
  patchJson(fileId: string, data: unknown, appProperties?: Record<string, string>): Promise<DriveProjectFile>;
  uploadFile(file: File, parentId: string, onProgress?: (progress: number) => void): Promise<DriveProjectFile>;
}
