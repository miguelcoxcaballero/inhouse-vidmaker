# inhouse vidmaker

Editor de video web con Home tipo Drive inspirado en `inhouse notes`, proyectos con autoguardado local/Drive y editor básico con assets, timeline, texto y exportación con Diffusion Studio.

## Ejecutar

```bash
npm install
npm run dev
```

Abre `http://localhost:5173`.

## Comprobar antes de subir

```bash
npm run check
npm run build
```

## Google Drive

La app usa Google Identity Services y Google Drive API. Para local ya hay un client ID de referencia en `.env.example`, pero para producción conviene crear tu propio OAuth Client ID de tipo Web en Google Cloud y autorizar:

- `http://localhost:5173`
- la URL final de GitHub Pages, por ejemplo `https://miguelcoxcaballero.github.io/inhouse-vidmaker`

Luego configura en GitHub:

- Repository variable: `VITE_GOOGLE_CLIENT_ID`

En local puedes copiar `.env.example` a `.env`.

## Subir a GitHub

```bash
git init
git add .
git commit -m "Initial inhouse vidmaker"
git branch -M main
git remote add origin https://github.com/miguelcoxcaballero/inhouse-vidmaker.git
git push -u origin main
```

El workflow `.github/workflows/deploy.yml` compila y publica `dist` en GitHub Pages cuando haces push a `main`.

## Incluye

- Home tipo Drive con topbar, cards, carpetas, perfil, búsqueda y modal de ubicación.
- Google Drive con OAuth, creación de carpeta de proyecto y `project.ihvideo.json`.
- Subida automática de assets al arrastrar archivos cuando el proyecto tiene carpeta Drive.
- Fallback local si no hay sesión de Google.
- Editor básico con biblioteca, preview, timeline, recorte por inspector, división, borrado, texto y exportación MP4.
