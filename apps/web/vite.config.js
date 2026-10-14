import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server: same-origin /api proxy so the UI always talks to the API over
// one origin (施工 MD §13.1 / §15). Port 3012 mirrors the compose web binding.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 3012,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
