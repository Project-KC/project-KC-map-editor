import { defineConfig } from 'vite';
import { resolve } from 'path';

// Babylon.js fetches missing shader includes (*.fx) via HTTP as a fallback.
// Vite's SPA fallback returns index.html (200) for any unknown path, which
// Babylon then splices into the shader source → `<!DOCTYPE html>` triggers a
// `<` GLSL syntax error and all PBR materials fail to compile. Intercept
// shader-include requests with a real 404 so Babylon falls back to its
// bundled shader store instead of treating HTML as shader code.
const shaderFallback404 = {
  name: 'shader-fallback-404',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url = req.url || '';
      if (/\.(fx|glsl|vert|frag)(\?|$)/.test(url)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [shaderFallback404],
  resolve: {
    alias: {
      '@projectrs/shared': resolve(__dirname, '../shared'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:4000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:4000',
      },
      '/maps': {
        target: 'http://localhost:4000',
      },
      '/data': {
        target: 'http://localhost:4000',
      },
    },
  },
});
