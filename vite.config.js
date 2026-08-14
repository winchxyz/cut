import { defineConfig } from 'vite';
import { writeFileSync, mkdirSync } from 'node:fs';

/**
 * Dev-only: accept a canvas capture and write it to tools/shots/.
 *
 * Lets the running scene be inspected as an image during development without
 * a screenshot tool attached to the window. Never present in a build.
 */
function captureEndpoint() {
  return {
    name: 'cut-capture',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const { name = 'shot', data } = JSON.parse(body);
            const b64 = String(data).replace(/^data:image\/\w+;base64,/, '');
            mkdirSync('tools/shots', { recursive: true });
            const file = `tools/shots/${name.replace(/[^a-z0-9_-]/gi, '')}.jpg`;
            writeFileSync(file, Buffer.from(b64, 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  // Relative, so the same build works from a domain root and from a project
  // subpath on GitHub Pages without the repository name being compiled in.
  base: './',
  plugins: [captureEndpoint()],
  server: {
    // Honour a PORT handed down by the environment; fall back to Vite's default.
    port: Number(process.env.PORT) || 5173,
    // Bind IPv4 explicitly. Resolving the name "localhost" can land on ::1
    // only, which leaves anything connecting over 127.0.0.1 unable to reach
    // the server at all.
    host: process.env.HOST || '127.0.0.1',
  },
  preview: {
    port: Number(process.env.PORT) || 4173,
  },
  build: {
    target: 'es2022',
    // three is the bulk of the bundle and changes far less often than game
    // code, so give it its own chunk for cache friendliness.
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
