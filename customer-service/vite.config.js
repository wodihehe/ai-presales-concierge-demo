import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3219, proxy: { '/api': 'http://127.0.0.1:3218' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
