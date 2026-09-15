import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/console',
  plugins: [react(), tailwind()],
  build: { outDir: '../../dist/console', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3150' } },
});
