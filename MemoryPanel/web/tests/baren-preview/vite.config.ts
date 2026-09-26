import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Separate dev server: no backend proxies, and HTTP API requests fail closed even
// if a future component bypasses the browser fetch fixture.
const root = resolve(__dirname, '../..');
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: 'baren-preview-network-boundary',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url || '/', 'http://localhost').pathname;
          if (/^\/(api|v3|health)(\/|$)/.test(path)) {
            response.statusCode = 501;
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify({ error: 'Synthetic preview: network API calls are disabled.' }),
            );
            return;
          }
          if (path === '/' || path === '/index.html') {
            const search = new URL(request.url || '/', 'http://localhost').search;
            request.url = `/tests/baren-preview/index.html${search}`;
          }
          next();
        });
      },
    },
  ],
  resolve: { alias: { '@': resolve(root, 'src') } },
  server: { host: '127.0.0.1', port: 5191, strictPort: true, proxy: {}, fs: { strict: true } },
});
