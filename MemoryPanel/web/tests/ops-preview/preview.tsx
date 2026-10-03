import React from 'react';
import { createRoot } from 'react-dom/client';
import { installMockApi } from '../baren-preview/mock-api';
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
const networkFetch = window.fetch.bind(window);
installMockApi();
const fixtureFetch = window.fetch;
if (new URLSearchParams(location.search).get('scenario') === 'empty') {
  const session = JSON.parse(localStorage.getItem('tdai-panel.session') || '{}');
  session.userKey = 'synthetic-empty-user';
  session.user = { ...session.user, user_id: 'empty-user' };
  localStorage.setItem('tdai-panel.session', JSON.stringify(session));
}
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/v1/coordinator/')) {
    return networkFetch(input, init);
  }
  if (url.origin === location.origin && url.pathname.startsWith('/api/v1/ops/')) {
    const scenario = new URLSearchParams(location.search).get('scenario');
    if (scenario === 'error')
      return Promise.resolve(
        Response.json(
          { error: 'Synthetic Ops error. No real mailbox is connected.' },
          { status: 503 },
        ),
      );
    if (scenario === 'loading') return new Promise(() => {});
    return networkFetch(input, init);
  }
  return fixtureFetch(input, init);
};
// Interception and synthetic identity are installed before App imports stores,
// routing, auth or capabilities. Production entrypoints never import this file.
await import('../../src/i18n');
const { default: App } = await import('../../src/App');
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
