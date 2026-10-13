import { AdminError } from './admin-config.mjs';

export function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status, headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff', Vary: 'Cookie', ...extra
        }
    });
}

export async function readBody(request, limit = 256000) {
    if (Number(request.headers.get('content-length')) > limit) throw new AdminError(413, '请求内容过大，请减少内容后再试');
    const reader = request.body?.getReader();
    if (!reader) throw new AdminError(400, '请求内容不能为空');
    const chunks = [];
    let length = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) { await reader.cancel(); throw new AdminError(413, '请求内容过大，请减少内容后再试'); }
        chunks.push(Buffer.from(value));
    }
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        return body;
    } catch { throw new AdminError(400, '请求内容需要是有效的 JSON 对象'); }
}
