import { defineConfig } from 'vite';
import path from 'node:path';

// Builds the renderer only; main/preload are compiled by tsc (tsconfig.main.json).
export default defineConfig({
  root: path.join(__dirname, 'src', 'renderer'),
  base: './',
  publicDir: 'public',
  build: {
    outDir: path.join(__dirname, 'out', 'renderer'),
    emptyOutDir: true,
    target: 'chrome120',
  },
});
