import {
  DRIVE_SCOPE,
  GOOGLE_CLIENT_ID,
  PROJECT_APP_PROPERTY,
  PROJECT_FILE_NAME,
  PROJECT_FOLDER_PROPERTY,
  TOKEN_STORAGE_KEY
} from './constants';
import type { DriveClient, DriveFolder, DriveProfile, DriveProjectFile } from './types';

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

type TokenClient = {
  callback?: (response: TokenResponse) => void;
  requestAccessToken(options?: { prompt?: string; login_hint?: string; scope?: string }): void;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }): TokenClient;
          revoke(token: string, done: () => void): void;
        };
      };
    };
  }
}

function escapeDriveQueryValue(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function waitForGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = window.setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        window.clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > 8000) {
        window.clearInterval(timer);
        reject(new Error('Google Identity no esta disponible.'));
      }
    }, 80);
  });
}

async function parseDriveResponse<T>(response: Response, fallbackMessage: string): Promise<T> {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message ? ` ${body.error.message}` : '';
    } catch {
      detail = '';
    }
    throw new Error(fallbackMessage + detail);
  }
  return response.json() as Promise<T>;
}

export function createDriveClient(): DriveClient {
  let tokenClient: TokenClient | null = null;
  let accessToken = '';
  let expiresAt = 0;
  let profile: DriveProfile | null = null;

  function restoreToken() {
    try {
      const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { accessToken?: string; expiresAt?: number; profile?: DriveProfile };
      if (parsed.accessToken && parsed.expiresAt && Date.now() < parsed.expiresAt - 60_000) {
        accessToken = parsed.accessToken;
        expiresAt = parsed.expiresAt;
        profile = parsed.profile || null;
      }
    } catch {
      accessToken = '';
      expiresAt = 0;
      profile = null;
    }
  }

  function persistToken() {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify({ accessToken, expiresAt, profile }));
    } catch {
      // local auth cache is optional
    }
  }

  async function ensureToken(interactive = false): Promise<string> {
    restoreToken();
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    await waitForGoogleIdentity();
    if (!tokenClient) {
      tokenClient = window.google!.accounts!.oauth2!.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: () => undefined
      });
    }
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Google Drive no respondio a tiempo.')), 60_000);
      tokenClient!.callback = (response) => {
        window.clearTimeout(timeout);
        if (response.error || !response.access_token) {
          reject(new Error(response.error || 'No se recibio access token.'));
          return;
        }
        accessToken = response.access_token;
        expiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
        persistToken();
        resolve(accessToken);
      };
      tokenClient!.requestAccessToken({
        prompt: interactive ? 'consent' : '',
        scope: DRIVE_SCOPE,
        login_hint: profile?.email
      });
    });
  }

  async function driveFetch(url: string, init: RequestInit = {}, message = 'Error en Google Drive.'): Promise<Response> {
    const token = await ensureToken(false);
    const headers = new Headers(init.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers }).then(async (response) => {
      if (response.status !== 401) return response;
      accessToken = '';
      expiresAt = 0;
      const retryToken = await ensureToken(true);
      headers.set('Authorization', `Bearer ${retryToken}`);
      const retry = await fetch(url, { ...init, headers });
      if (!retry.ok) await parseDriveResponse(retry, message);
      return retry;
    });
  }

  async function driveJson<T>(url: string, init: RequestInit = {}, message?: string): Promise<T> {
    return parseDriveResponse<T>(await driveFetch(url, init, message), message || 'Error en Google Drive.');
  }

  async function signIn(): Promise<DriveProfile> {
    await ensureToken(true);
    const data = await driveJson<{ user?: { displayName?: string; emailAddress?: string; photoLink?: string } }>(
      'https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress,photoLink)',
      {},
      'No se pudo leer el perfil de Drive.'
    );
    profile = {
      name: data.user?.displayName || 'inhouse',
      email: data.user?.emailAddress || '',
      picture: data.user?.photoLink || ''
    };
    persistToken();
    return profile;
  }

  function signOut() {
    const token = accessToken;
    accessToken = '';
    expiresAt = 0;
    profile = null;
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // ignore cache cleanup errors
    }
    if (token && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(token, () => undefined);
    }
  }

  async function listFolders(parentId = 'root'): Promise<DriveFolder[]> {
    const queryParts = [
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      parentId === 'root' ? "'root' in parents" : `'${escapeDriveQueryValue(parentId)}' in parents`
    ];
    const query = encodeURIComponent(queryParts.join(' and '));
    const fields = encodeURIComponent('files(id,name)');
    const data = await driveJson<{ files: DriveFolder[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=name&pageSize=100&fields=${fields}`,
      {},
      'No se pudieron listar carpetas.'
    );
    return data.files || [];
  }

  async function createFolder(
    name: string,
    parentId = 'root',
    appProperties?: Record<string, string>
  ): Promise<DriveFolder> {
    const body: Record<string, unknown> = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      appProperties
    };
    if (parentId && parentId !== 'root') body.parents = [parentId];
    return driveJson<DriveFolder>(
      'https://www.googleapis.com/drive/v3/files?fields=id,name',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      'No se pudo crear la carpeta.'
    );
  }

  async function listProjects(): Promise<DriveProjectFile[]> {
    const query = encodeURIComponent(
      `trashed=false and name='${PROJECT_FILE_NAME}' and appProperties has { key='${PROJECT_APP_PROPERTY}' and value='1' }`
    );
    const fields = encodeURIComponent('files(id,name,modifiedTime,parents,thumbnailLink)');
    const data = await driveJson<{ files: DriveProjectFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=modifiedTime desc&pageSize=50&fields=${fields}`,
      {},
      'No se pudieron cargar proyectos.'
    );
    return data.files || [];
  }

  async function listTrash(): Promise<DriveProjectFile[]> {
    const query = encodeURIComponent(
      `trashed=true and mimeType='application/vnd.google-apps.folder' and appProperties has { key='${PROJECT_FOLDER_PROPERTY}' and value='1' }`
    );
    const fields = encodeURIComponent('files(id,name,modifiedTime,createdTime,mimeType,parents)');
    const data = await driveJson<{ files: DriveProjectFile[] }>(
      `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=modifiedTime desc&pageSize=100&fields=${fields}`,
      {},
      'No se pudo cargar la papelera.'
    );
    return data.files || [];
  }

  async function setTrashed(fileId: string, trashed: boolean): Promise<void> {
    await driveJson<DriveProjectFile>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed })
      },
      trashed ? 'No se pudo mover el proyecto a la papelera.' : 'No se pudo restaurar el proyecto.'
    );
  }

  async function trashFile(fileId: string): Promise<void> {
    await setTrashed(fileId, true);
  }

  async function restoreFile(fileId: string): Promise<void> {
    await setTrashed(fileId, false);
  }

  async function downloadJson<T>(fileId: string): Promise<T> {
    const response = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {},
      'No se pudo descargar el proyecto.'
    );
    if (!response.ok) await parseDriveResponse(response, 'No se pudo descargar el proyecto.');
    return response.json() as Promise<T>;
  }

  async function downloadFile(fileId: string): Promise<Blob> {
    const response = await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      {},
      'No se pudo descargar el asset.'
    );
    if (!response.ok) await parseDriveResponse(response, 'No se pudo descargar el asset.');
    return response.blob();
  }

  async function downloadThumbnail(fileId: string): Promise<Blob | undefined> {
    const metadata = await driveJson<{ thumbnailLink?: string }>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=thumbnailLink`,
      {},
      'No se pudo leer la miniatura del asset.'
    );
    if (!metadata.thumbnailLink) return undefined;
    const response = await driveFetch(metadata.thumbnailLink, {}, 'No se pudo descargar la miniatura del asset.');
    if (!response.ok) return undefined;
    return response.blob();
  }

  async function moveFile(fileId: string, destinationFolderId: string, previousFolderId: string): Promise<void> {
    const params = new URLSearchParams({
      addParents: destinationFolderId,
      removeParents: previousFolderId,
      fields: 'id,parents'
    });
    await driveJson<DriveProjectFile>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { method: 'PATCH' },
      'No se pudo mover el asset.'
    );
  }

  function buildMultipart(metadata: unknown, content: string, mimeType = 'application/json') {
    const boundary = 'inhouse_vidmaker_' + Math.random().toString(36).slice(2);
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}; charset=UTF-8`,
      '',
      content,
      `--${boundary}--`,
      ''
    ].join('\r\n');
    return {
      body,
      contentType: `multipart/related; boundary=${boundary}`
    };
  }

  async function uploadJson(
    name: string,
    data: unknown,
    parentId: string,
    appProperties?: Record<string, string>
  ): Promise<DriveProjectFile> {
    const metadata = {
      name,
      mimeType: 'application/json',
      parents: parentId ? [parentId] : undefined,
      appProperties
    };
    const multipart = buildMultipart(metadata, JSON.stringify(data, null, 2));
    return driveJson<DriveProjectFile>(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime,parents',
      {
        method: 'POST',
        headers: { 'Content-Type': multipart.contentType },
        body: multipart.body
      },
      'No se pudo subir el proyecto.'
    );
  }

  async function patchJson(
    fileId: string,
    data: unknown,
    appProperties?: Record<string, string>
  ): Promise<DriveProjectFile> {
    const metadata = {
      name: PROJECT_FILE_NAME,
      mimeType: 'application/json',
      appProperties
    };
    const multipart = buildMultipart(metadata, JSON.stringify(data, null, 2));
    return driveJson<DriveProjectFile>(
      `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id,name,modifiedTime,parents`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': multipart.contentType },
        body: multipart.body
      },
      'No se pudo guardar el proyecto.'
    );
  }

  async function uploadFile(file: File, parentId: string, onProgress?: (progress: number) => void) {
    const metadata = {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      parents: parentId ? [parentId] : undefined
    };
    const init = await driveFetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,modifiedTime,thumbnailLink',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': file.type || 'application/octet-stream',
          'X-Upload-Content-Length': String(file.size)
        },
        body: JSON.stringify(metadata)
      },
      'No se pudo iniciar la subida.'
    );
    if (!init.ok) await parseDriveResponse(init, 'No se pudo iniciar la subida.');
    const uploadUrl = init.headers.get('Location');
    if (!uploadUrl) throw new Error('Google Drive no devolvio URL de subida.');
    onProgress?.(5);
    const response = await driveFetch(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'Content-Length': String(file.size)
        },
        body: file
      },
      'No se pudo subir el archivo.'
    );
    onProgress?.(100);
    return parseDriveResponse<DriveProjectFile>(response, 'No se pudo subir el archivo.');
  }

  restoreToken();

  return {
    isConfigured: !!GOOGLE_CLIENT_ID,
    get accessToken() {
      restoreToken();
      return accessToken;
    },
    get profile() {
      restoreToken();
      return profile;
    },
    signIn,
    signOut,
    listFolders,
    createFolder,
    listProjects,
    listTrash,
    trashFile,
    restoreFile,
    downloadJson,
    downloadFile,
    downloadThumbnail,
    moveFile,
    uploadJson,
    patchJson,
    uploadFile
  };
}
