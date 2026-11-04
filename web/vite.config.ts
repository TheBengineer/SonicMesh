import { defineConfig } from 'vite';

// Cross-origin isolation lets the page use SharedArrayBuffer for mic audio. Without it the app falls back to
// postMessage. netlify.toml sets the same headers for the deployed site.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    // three.js alone is ~565 kB minified (140 kB gzipped); it now sits in its own cached chunk
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules[\\/]three[\\/]/.test(id)) return 'three';
        },
      },
    },
  },
});
