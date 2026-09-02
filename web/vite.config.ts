import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the SPA runs on its own port and the API is proxied, so
    // cookies stay same-origin and the CSRF check behaves as it will in prod.
    proxy: { '/api': { target: 'http://127.0.0.1:4123', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
