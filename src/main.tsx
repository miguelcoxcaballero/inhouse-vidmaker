import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if ('serviceWorker' in navigator && import.meta.env.PROD && !window.crossOriginIsolated) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-serviceworker.js`).then(() => {
    if (navigator.serviceWorker.controller) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  }).catch((error) => console.warn('Export isolation could not be enabled.', error));
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
