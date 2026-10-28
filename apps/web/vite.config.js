import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server: same-origin /api proxy so the UI always talks to the API over
// one origin (施工 MD §13.1 / §15). Port 3012 mirrors the compose web binding.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // batch-constants pulls in node:crypto (createHash) which the browser build
      // cannot resolve; map it to a WebCrypto shim (see crypto-browser-shim.js).
      { find: /^node:crypto$/, replacement: new URL('./src/lib/crypto-browser-shim.js', import.meta.url).pathname },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 3012,
    strictPort: true,
    proxy: {
      '/api': {
        // Dev-host override for local API (e.g. host-process API on a custom port).
        target: process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000',
        changeOrigin: false,
        ws: true, // device-stream WS (/api/device-streams/:id/ws) upgrade passthrough
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
