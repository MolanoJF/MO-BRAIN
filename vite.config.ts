import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { PRODUCT_NAME } from './src/control/lifecycle.ts';

/**
 * The console title is the product name constant, never a second literal in the
 * HTML. Vite cannot import a TS constant into index.html, so this substitutes
 * `%PRODUCT_NAME%` at build and serve time.
 */
function productNameHtml() {
  return {
    name: 'product-name-html',
    transformIndexHtml(html: string) {
      return html.replaceAll('%PRODUCT_NAME%', PRODUCT_NAME);
    },
  };
}

export default defineConfig({
  root: 'src/console',
  plugins: [react(), tailwind(), productNameHtml()],
  build: { outDir: '../../dist/console', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3150' } },
});
