import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.js';
import { aiStatus } from './nlfilter.js';

const PORT = Number(process.env.PORT || 4173);
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function serveStatic(url, res) {
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  serveStatic(url, res);
}).listen(PORT, () => {
  const ai = aiStatus();
  console.log(`CloudLabs ops dashboard on http://localhost:${PORT}`);
  console.log(`AI filter: ${ai.configured ? `model ${ai.model}` : 'no key set, using local rule parser'}`);
});
