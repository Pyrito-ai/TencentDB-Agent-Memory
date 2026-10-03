import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Only the local synthetic Ops/Coordinator backend is proxied. Other HTTP API requests fail
// closed even if a future component bypasses the browser fetch fixture.
const root = resolve(__dirname, '../..');
export default defineConfig({
  root,
  plugins: [
    react(),
    {
      name: 'ops-preview-network-boundary',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url || '/', 'http://localhost').pathname;
          if (/^\/api\/v1\/(ops|coordinator|fixture)\//.test(path)) return next();
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
            request.url = `/tests/ops-preview/index.html${search}`;
          }
          next();
        });
      },
    },
  ],
  resolve: { alias: { '@': resolve(root, 'src') } },
  server: {
    host: '127.0.0.1',
    port: 5195,
    strictPort: true,
    proxy: {
      '/api/v1/ops': 'http://127.0.0.1:8195',
      '/api/v1/coordinator': 'http://127.0.0.1:8195',
      '/api/v1/fixture': 'http://127.0.0.1:8195',
    },
    fs: { strict: true },
  },
});
