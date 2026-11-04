import { defineConfig } from 'vite';

export default defineConfig({
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
