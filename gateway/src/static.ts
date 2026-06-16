// Minimal static-file serving for the built React login app (login-app/dist).
// Assets live under the '/__login/' base; index.html is the SPA entry served
// for any unauthenticated navigation.

import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

export interface LoginStatic {
  hasBuild: boolean;
  distDir: string;
  asset(req: IncomingMessage, res: ServerResponse, pathname: string): void;
  index(res: ServerResponse): void;
}

// Config injected into the served index.html as window.__HERMES_GATE__, so the
// login app reads chain id + WalletConnect project at runtime (not baked at build).
export interface LoginRuntime {
  chainId: number;
  wcProjectId: string;
}

export function makeLoginStatic(distDir: string, runtime: LoginRuntime): LoginStatic {
  const resolvedDist = path.resolve(distDir);
  const indexPath = path.join(resolvedDist, 'index.html');
  const hasBuild = fs.existsSync(indexPath);
  // Classic (non-module) inline <script> -> runs before the deferred app bundle.
  // Escape '<' so a stray '</script>' in a value can't break out of the tag.
  const injectTag = `<script>window.__HERMES_GATE__=${JSON.stringify(runtime).replace(
    /</g,
    '\\u003c',
  )};</script>`;

  return {
    hasBuild,
    distDir: resolvedDist,

    // Serve /__login/<rel> from the dist directory (with traversal guard).
    asset(_req, res, pathname) {
      const rel = pathname.replace(/^\/__login\//, '');
      const file = path.resolve(resolvedDist, rel);
      if (file !== resolvedDist && !file.startsWith(resolvedDist + path.sep)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          // Vite emits content-hashed asset filenames -> safe to cache hard.
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(buf);
      });
    },

    // Serve the SPA entry (no-store so a new build is picked up immediately),
    // with the runtime config injected into <head>.
    index(res) {
      fs.readFile(indexPath, (err, buf) => {
        if (err) {
          res.writeHead(500);
          res.end('login app not built');
          return;
        }
        const html = buf.toString('utf8');
        const withCfg = html.includes('</head>')
          ? html.replace('</head>', injectTag + '</head>')
          : injectTag + html;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(withCfg);
      });
    },
  };
}
