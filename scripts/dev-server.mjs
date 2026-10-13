import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminHandler } from '../server/admin-handler.mjs';
import { createCommentHandler } from '../server/comment-handler.mjs';
import { respondWithHandler } from '../server/node-adapter.mjs';
import vercelConfig from '../vercel.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.md': 'text/plain; charset=utf-8' };
const adminHeaders = Object.fromEntries(vercelConfig.headers.find((rule) => rule.source === '/admin/:path*').headers.map(({ key, value }) => [key, value]));

export function createDevServer({ handle = createAdminHandler(), handleComments = createCommentHandler(), publicFile } = {}) {
    return createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/api/admin') return respondWithHandler(req, res, handle);
        if (url.pathname === '/api/comments') {
            // The local server is directly bound to loopback; use the socket address here.
            req.headers['x-vercel-forwarded-for'] = req.socket.remoteAddress;
            return respondWithHandler(req, res, handleComments);
        }
        try {
            let path = decodeURIComponent(url.pathname);
            if (path.endsWith('/')) path += 'index.html';
            const allowed = ['/index.html', '/config.js', '/sites.json', '/README.md'].includes(path)
                || /^\/(?:admin|assets|data)\/[A-Za-z0-9_./-]+$/.test(path);
            const absolute = resolve(root, `.${path}`);
            if (!allowed || !absolute.startsWith(root) || path.split('/').includes('..') || !['GET', 'HEAD'].includes(req.method)) {
                res.writeHead(404); res.end('Not found'); return;
            }
            const override = publicFile ? await publicFile(path) : undefined;
            if (override === null) { res.writeHead(404); res.end('Not found'); return; }
            const content = override ?? await readFile(absolute);
            res.writeHead(200, { ...(path.startsWith('/admin/') ? adminHeaders : {}), 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
            res.end(req.method === 'HEAD' ? undefined : content);
        } catch { res.writeHead(404); res.end('Not found'); }
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.env.PORT || 8000);
    createDevServer().listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}\nAdmin: http://127.0.0.1:${port}/admin/`));
}
