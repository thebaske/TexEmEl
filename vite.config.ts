import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
  clearScreen: false,
  server: {
    port: 3100,
    strictPort: true,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
