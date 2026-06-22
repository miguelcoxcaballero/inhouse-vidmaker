# inhouse vidmaker

Editor de video web con Home tipo Drive inspirado en `inhouse notes`, proyectos con autoguardado en Google Drive y exportacion MP4 local.

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

La app usa Google Identity Services y Google Drive API. Para local hay un client ID de referencia en `.env.example`; para produccion se debe configurar un OAuth Client ID de tipo Web en Google Cloud y autorizar:

- `http://localhost:5173`
- `https://miguelcoxcaballero.github.io/inhouse-vidmaker`

La variable de repositorio `VITE_GOOGLE_CLIENT_ID` debe estar configurada en GitHub. En local se puede copiar `.env.example` a `.env`.

## Despliegue

El workflow `.github/workflows/deploy.yml` compila y publica `dist` en GitHub Pages con cada push a `main`.

## Incluye

- Acceso obligatorio con Google antes de abrir el Home.
- Home tipo Drive con topbar, cards, carpetas, perfil, busqueda y modal de ubicacion.
- Creacion de carpeta de proyecto y `project.ihvideo.json` en Drive.
- Subida automatica de assets, carga bajo demanda, cache y reintentos.
- Timeline multipista con snap, ripple, seleccion multiple, miniaturas, zoom y atajos.
- Crop, contain/cover, volteo, transformaciones, velocidad y reproduccion inversa.
- Pistas bloqueables, ocultables, silenciables, reordenables y renombrables.
- Transiciones basicas y editor de texto con estilos y animaciones.
- Preview responsive y exportacion MP4 que respeta la composicion del proyecto.
