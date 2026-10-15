import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), tailwind()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8788', '/mcp': 'http://127.0.0.1:8788', '/install': 'http://127.0.0.1:8788' },
  },
});
