import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    allowedHosts: ['127.0.0.1'],
    fs: { strict: true },
    cors: false,
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 800 },
});
