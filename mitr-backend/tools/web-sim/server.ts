import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const port = Number(process.env.WEB_SIM_PORT ?? 8787);
const indexPath = resolve(process.cwd(), 'tools/web-sim/index.html');
const assetsRoot = resolve(process.cwd(), 'tools/web-sim/assets');

const contentTypeFor = (path: string): string => {
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
  if (path.endsWith('.wav')) return 'audio/wav';
  if (path.endsWith('.webm')) return 'audio/webm';
  if (path.endsWith('.flac')) return 'audio/flac';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.md') || path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
};

const server = createServer(async (req, res) => {
  if (!req.url || req.url === '/' || req.url.startsWith('/index')) {
    try {
      const html = await readFile(indexPath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Failed to load simulator page: ${(error as Error).message}`);
      return;
    }
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url.startsWith('/assets/')) {
    try {
      const decoded = decodeURIComponent(req.url.slice('/assets/'.length));
      const normalized = decoded.replace(/^\/+/, '');
      const filePath = resolve(assetsRoot, normalized);
      if (!filePath.startsWith(assetsRoot)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const file = await readFile(filePath);
      res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'cache-control': 'public, max-age=3600' });
      res.end(file);
      return;
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Asset not found: ${(error as Error).message}`);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Mitr web simulator running at http://localhost:${port}`);
});
