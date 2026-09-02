/**
 * Serves exports/apk over the LAN so a phone can fetch the build.
 *
 * A plain static server is not quite enough: Android decides what to do with a download
 * partly from Content-Type, and the default for .apk is either nothing or text/plain, which
 * makes some browsers try to display it. This sends the real APK type and a
 * Content-Disposition, so the file lands in Downloads instead of the renderer.
 *
 *   node tools/serve-apk.mjs [port]
 */
import { createServer } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve, dirname, extname, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'exports/apk');
const PORT = Number(process.argv[2] ?? 8099);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.apk': 'application/vnd.android.package-archive',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    // normalize + prefix check: this serves one directory and must not be talked out of it.
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    const ext = extname(file);
    const headers = {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': String(info.size),
      'cache-control': 'no-store',
    };
    if (ext === '.apk') {
      // The REQUESTED name, not a hardcoded one: with two variants on offer a fixed
      // filename saves the release build under the debug build's name.
      headers['content-disposition'] = `attachment; filename="${basename(file)}"`;
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  console.log(`  serving exports/apk on port ${PORT}`);
  for (const a of addrs) console.log(`    http://${a}:${PORT}/`);
});
