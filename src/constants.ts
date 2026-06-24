export const GOOGLE_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_CLIENT_ID || '435784295430-cmug30o42f1vu4ijgor9sjb0ro4oo37o.apps.googleusercontent.com';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const STORAGE_KEY = 'inhouseVidmakerStateV1';
export const TOKEN_STORAGE_KEY = STORAGE_KEY + '::token';
export const PROJECT_FILE_NAME = 'project.ihvideo.json';
export const PREVIEWS_FILE_NAME = 'previews.ihvideo.json';
export const PROJECT_APP_PROPERTY = 'inhouseVidmakerProject';
export const PROJECT_FOLDER_PROPERTY = 'inhouseVidmakerFolder';
export const DRIVE_SYNC_DEBOUNCE_MS = 900;

export const INHOUSE_TOKENS = {
  cream: '#f5f5f0',
  surface: '#ffffff',
  ink: '#1a1a1a',
  orange: '#E07A3C'
};
