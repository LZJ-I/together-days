import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { AdminError } from './admin-config.mjs';

const COOKIE = 'love_comment_visitor';
export const MAX_COMMENTS = 400;
const mac = (key, value) => createHmac('sha256', key).update(value).digest('base64url');
const same = (a, b) => {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
};

export function commentSettings(settings, env) {
    const raw = env.COMMENT_ENCRYPTION_KEY || '';
    const key = /^[A-Za-z0-9_-]{43}$/.test(raw) ? Buffer.from(raw, 'base64url') : null;
    if (!key || key.length !== 32 || key.toString('base64url') !== raw) {
        throw new AdminError(503, '评论尚未配置：请在 Vercel 添加 COMMENT_ENCRYPTION_KEY（32 字节的 base64url 随机密钥）并重新部署');
    }
    const branch = env.COMMENTS_BRANCH || 'comments-data';
    if (!/^[A-Za-z0-9_./-]{1,150}$/.test(branch) || branch.includes('..') || branch.includes('//') || branch === settings.branch) {
        throw new AdminError(503, 'COMMENTS_BRANCH 必须是独立的数据分支，例如 comments-data');
    }
    return { ...settings, commentsBranch: branch, commentsKey: key,
        visitorKey: createHmac('sha256', key).update('love-timer/visitor/v1').digest(),
        identityKey: createHmac('sha256', key).update('love-timer/identity/v1').digest() };
}

export function sealComments(data, siteId, key) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`love-timer/comments/v1/${siteId}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return { version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function openComments(envelope, siteId, key) {
    if (envelope === null) return { version: 1, comments: [] };
    try {
        if (envelope.version !== 1 || ![envelope.iv, envelope.tag, envelope.ciphertext].every((part) => typeof part === 'string' && /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
        const iv = Buffer.from(envelope.iv, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url');
        if (iv.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`love-timer/comments/v1/${siteId}`));
        decipher.setAuthTag(tag);
        const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
        if (data.version !== 1 || !Array.isArray(data.comments) || data.comments.length > MAX_COMMENTS) throw new Error();
        return data;
    } catch { throw new AdminError(422, '评论数据无法解密，请检查评论密钥是否与保存时一致；请勿直接替换原密钥'); }
}

export function visitorFrom(request, settings) {
    const token = (request.headers.get('cookie') || '').split(';').map((part) => part.trim())
        .find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    const match = typeof token === 'string' && /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
    return match && same(match[2], mac(settings.visitorKey, `visitor:${match[1]}`)) ? match[1] : null;
}

export function createVisitor(settings, secure) {
    const id = randomBytes(24).toString('base64url');
    const token = `${id}.${mac(settings.visitorKey, `visitor:${id}`)}`;
    return { id, cookie: `${COOKIE}=${token}; Path=/api/comments; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}` };
}

export function visitorCsrf(settings, id, siteId) {
    return mac(settings.visitorKey, `csrf:${siteId}:${id}`);
}

export function checkVisitorCsrf(request, settings, id, siteId) {
    if (!id || !same(request.headers.get('x-csrf-token') || '', visitorCsrf(settings, id, siteId))) {
        throw new AdminError(403, '留言凭证已过期，请刷新后再试；已填写的内容可以先复制保留');
    }
}

export function visitorIdentity(request, settings, id, siteId) {
    let ip = (request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (!isIP(ip)) throw new AdminError(503, '暂时无法确认留言来源，请稍后再试');
    if (isIP(ip) === 6) {
        ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
        if (ip.startsWith('::ffff:')) {
            const [first, last] = ip.slice(7).split(':').map((part) => Number.parseInt(part, 16));
            ip = `${first >> 8}.${first & 255}.${last >> 8}.${last & 255}`;
        }
    }
    return { deviceHash: mac(settings.identityKey, `device:${siteId}:${id}`), ipHash: mac(settings.identityKey, `ip:${siteId}:${ip}`) };
}
