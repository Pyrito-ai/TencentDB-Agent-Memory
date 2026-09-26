import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMockApi } from './mock-api';
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/tea-themeable.css';
import '../../src/index.css';
import '../../src/tea-override.css';
import '../../src/baren-theme.css';

if (!import.meta.env.DEV || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) {
  throw new Error('The synthetic Baren preview can only run on a local Vite development server.');
}
// Keep parallel role/login/scenario tabs independent. Fixture state is purposely
// document-local and resets on reload; production still uses native storage.
const fixtureStorage = new Map<string, string>();
const isolatedStorage: Storage = {
  get length() {
    return fixtureStorage.size;
  },
  clear: () => fixtureStorage.clear(),
  getItem: (key) => fixtureStorage.get(key) ?? null,
  key: (index) => Array.from(fixtureStorage.keys())[index] ?? null,
  removeItem: (key) => {
    fixtureStorage.delete(key);
  },
  setItem: (key, value) => {
    fixtureStorage.set(key, String(value));
  },
};
Object.defineProperty(window, 'localStorage', { value: isolatedStorage, configurable: true });
window.addEventListener('storage', (event) => event.stopImmediatePropagation(), true);
installMockApi();
// Interception and synthetic identity are installed before App imports stores,
// routing, auth or capabilities. Production entrypoints never import this file.
await import('../../src/i18n');
const { default: App } = await import('../../src/App');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
