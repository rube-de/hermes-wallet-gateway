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

export function makeLoginStatic(distDir: string): LoginStatic {
  const resolvedDist = path.resolve(distDir);
  const indexPath = path.join(resolvedDist, 'index.html');
  const hasBuild = fs.existsSync(indexPath);

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

    // Serve the SPA entry (no-store so a new build is picked up immediately).
    index(res) {
      fs.readFile(indexPath, (err, buf) => {
        if (err) {
          res.writeHead(500);
          res.end('login app not built');
          return;
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(buf);
      });
    },
  };
}
