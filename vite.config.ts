import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = `http://127.0.0.1:${process.env.VA_PORT ?? 4317}`;

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': target,
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
});
