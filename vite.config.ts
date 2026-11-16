import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { defineConfig } from 'vite';

// "type": "module" — __dirname is undefined in native ESM, so derive it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// inject the package version at build time so the About modal can
// show exactly which build is running (no more guessing from a bug report
// whether the user is on a stale exe). Single source of truth: package.json.
const APP_VERSION = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version as string;

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1200,
    },
    // Expose the Tauri CLI's devUrl port to Vite's server.
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      host: '127.0.0.1',
    },
  };
});
