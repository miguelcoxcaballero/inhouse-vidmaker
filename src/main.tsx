import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    const legacy = registrations.filter((registration) => registration.active?.scriptURL.endsWith('/coi-serviceworker.js'));
    if (!legacy.length) return;
    await Promise.all(legacy.map((registration) => registration.unregister()));
    if (navigator.serviceWorker.controller?.scriptURL.endsWith('/coi-serviceworker.js')) window.location.reload();
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
