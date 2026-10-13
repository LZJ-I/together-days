import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AdminError } from './admin-config.mjs';

const scrypt = promisify(scryptCallback);
const SESSION_MS = 8 * 60 * 60 * 1000;
const COOKIE = 'love_admin_session';
const sign = (secret, message) => createHmac('sha256', secret).update(message).digest('base64url');
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function settingsFrom(env) {
    const password = env.ADMIN_PASSWORD || '';
    const secret = env.ADMIN_SESSION_SECRET || '';
    const repository = env.GITHUB_REPOSITORY || '';
    const token = env.GITHUB_TOKEN || '';
    const branch = env.GITHUB_BRANCH || 'main';
    const issues = [];
    if (!password) issues.push('ADMIN_PASSWORD 未设置');
    else if (password.length < 12 || password.length > 512) issues.push('ADMIN_PASSWORD 需要为 12 至 512 个字符');
    if (!secret) issues.push('ADMIN_SESSION_SECRET 未设置');
    else if (secret.length < 32) issues.push('ADMIN_SESSION_SECRET 至少需要 32 个字符，请填写命令生成的字符串');
    if (!token.trim()) issues.push('GITHUB_TOKEN 未设置');
    if (!repository) issues.push('GITHUB_REPOSITORY 未设置');
    else if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        issues.push('GITHUB_REPOSITORY 格式应为 your-name/your-repository，不含网址或空格');
    }
    if (!/^[A-Za-z0-9_./-]{1,150}$/.test(branch) || branch.includes('..') || branch.includes('//')) {
        issues.push('GITHUB_BRANCH 格式不正确，请填写分支名，例如 main');
    }
    return { ready: issues.length === 0, issues, password, secret, repository, token, branch };
}

export async function passwordMatches(password, settings) {
    if (typeof password !== 'string' || password.length > 512) return false;
    const [actual, expected] = await Promise.all([
        scrypt(password, settings.secret, 32), scrypt(settings.password, settings.secret, 32)
    ]);
    return timingSafeEqual(actual, expected);
}

export function sessionCookie(token, secure, clear = false) {
    return `${COOKIE}=${clear ? '' : token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function createSession(settings, now) {
    const payload = Buffer.from(JSON.stringify({
        expiresAt: now + SESSION_MS,
        id: randomBytes(24).toString('base64url'),
        passwordVersion: sign(settings.secret, `password:${settings.password}`)
    })).toString('base64url');
    return `${payload}.${sign(settings.secret, payload)}`;
}

export function readSession(request, settings, now) {
    const token = (request.headers.get('cookie') || '').split(';').map((value) => value.trim())
        .find((value) => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!token || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !equal(parts[1], sign(settings.secret, parts[0]))) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + SESSION_MS
            || !payload.id || typeof payload.passwordVersion !== 'string'
            || !equal(payload.passwordVersion, sign(settings.secret, `password:${settings.password}`))) return null;
        return { token, csrf: sign(settings.secret, `csrf:${token}`) };
    } catch {
        return null;
    }
}

export function checkOrigin(request) {
    const origin = request.headers.get('origin');
    if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
        throw new AdminError(403, '请在当前网站的管理页操作');
    }
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        throw new AdminError(415, '请求需要使用 JSON 格式');
    }
}

export function checkCsrf(request, session) {
    const supplied = request.headers.get('x-csrf-token') || '';
    if (!equal(supplied, session.csrf)) throw new AdminError(403, '操作凭证已失效，请重新登录');
}

// This limit is local to a warm function instance; it is not a distributed limit.
export function createLoginLimiter() {
    const attempts = new Map();
    const windowMs = 15 * 60 * 1000;
    return (key, now) => {
        for (const [ip, entry] of attempts) if (entry.until <= now) attempts.delete(ip);
        if (attempts.size >= 2000 && !attempts.has(key)) throw new AdminError(429, '登录请求较多，请稍后再试');
        const entry = attempts.get(key) || { count: 0, until: now + windowMs };
        entry.count++;
        attempts.set(key, entry);
        if (entry.count > 5) throw new AdminError(429, '登录尝试过多，请 15 分钟后再试');
    };
}
