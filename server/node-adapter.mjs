export async function respondWithHandler(req, res, handler) {
    const protocol = process.env.VERCEL || req.socket.encrypted ? 'https' : 'http';
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) headers.set(key, value.join(', '));
        else if (value !== undefined) headers.set(key, value);
    }
    try {
        let body;
        if (!['GET', 'HEAD'].includes(req.method)) {
            if (req.body !== undefined) body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            else {
                const chunks = [];
                let bytes = 0;
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > 256000) {
                        res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                        res.end(JSON.stringify({ error: '记录内容过大' }));
                        return;
                    }
                    chunks.push(chunk);
                }
                body = Buffer.concat(chunks);
            }
        }
        const request = new Request(new URL(req.url, `${protocol}://${req.headers.host}`), { method: req.method, headers, ...(body !== undefined ? { body } : {}) });
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: '请求格式不正确' }));
    }
}
