// Static server for web/. If ROM_ZIP is set, also serves that file at /dev-rom.zip
// so the page can boot without the file picker during development.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.zip': 'application/zip', '.json': 'application/json', '.png': 'image/png' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/index.html';
  let file = join(root, normalize(path));
  if (path === '/dev-rom.zip') file = process.env.ROM_ZIP || '';
  else if (!file.startsWith(root)) file = '';
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`serving ${root} on http://localhost:${port}`));
