import { defineConfig } from 'vite';

export default defineConfig({
  // Set base to repo name for GitHub Pages (https://<user>.github.io/<repo>/)
  base: '/piano-interval-filter/',
  root: '.',
  build: {
    outDir: 'dist',
  },
  server: {
    host: true,
  },
});
