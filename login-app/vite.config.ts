import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base '/__login/' namespaces the built assets so they never collide with the
// Hermes dashboard's own /assets/ (which the gateway proxies only AFTER login).
export default defineConfig({
  base: '/__login/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
