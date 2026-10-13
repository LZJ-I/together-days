import { AdminError } from './admin-config.mjs';
import { checkCsrf, checkOrigin, createLoginLimiter, createSession, passwordMatches, readSession, sessionCookie, settingsFrom } from './admin-auth.mjs';
import { GitHubStore } from './github-store.mjs';
import { commentSettings } from './comment-crypto.mjs';
import { CommentStore } from './comment-store.mjs';
import { json, readBody } from './http.mjs';

export function createAdminHandler({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
    const limitLogin = createLoginLimiter();
    return async (request) => {
        const settings = settingsFrom(env);
        const url = new URL(request.url);
        const action = url.searchParams.get('action') || 'session';
        const secure = url.protocol === 'https:';
        try {
            if (!['GET', 'POST'].includes(request.method)) return json({ error: '不支持这种请求方式' }, 405, { Allow: 'GET, POST' });
            if (!settings.ready) {
                if (request.method === 'GET' && action === 'session') {
                    return json({ configured: false, authenticated: false, configurationIssues: settings.issues });
                }
                throw new AdminError(503, '后台尚未配置，请先在 Vercel 添加后台环境变量并重新部署');
            }
            const session = readSession(request, settings, now());
            if (request.method === 'GET' && action === 'session') {
                return json({ configured: true, authenticated: !!session, ...(session ? { csrf: session.csrf } : {}) });
            }
            if (request.method === 'POST') checkOrigin(request);
            if (request.method === 'POST' && action === 'login') {
                const ip = request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
                limitLogin(ip, now());
                const body = await readBody(request);
                if (!await passwordMatches(body.password, settings)) throw new AdminError(401, '管理密码不正确');
                const token = createSession(settings, now());
                const authenticated = readSession(new Request(url, { headers: { Cookie: `love_admin_session=${token}` } }), settings, now());
                return json({ authenticated: true, csrf: authenticated.csrf }, 200, { 'Set-Cookie': sessionCookie(token, secure) });
            }
            if (!session) throw new AdminError(401, '登录已过期，请重新输入管理密码');
            if (request.method === 'POST') checkCsrf(request, session);
            if (request.method === 'POST' && action === 'logout') {
                return json({ authenticated: false }, 200, { 'Set-Cookie': sessionCookie('', secure, true) });
            }
            const store = new GitHubStore(settings, fetchImpl);
            if (request.method === 'GET' && action === 'config') return json(await store.read(url.searchParams.get('site') || undefined));
            if (request.method === 'POST' && action === 'config') return json(await store.save(await readBody(request)));
            if (request.method === 'POST' && action === 'create-site') return json(await store.createSite(await readBody(request)));
            if (request.method === 'POST' && action === 'delete-site') return json(await store.deleteSite(await readBody(request), now()));
            if (action === 'comments') {
                const comments = new CommentStore(commentSettings(settings, env), fetchImpl);
                if (request.method === 'GET') return json(await comments.list(url.searchParams.get('site'), { admin: true }));
                const input = await readBody(request, 8192);
                return json(await comments.moderate(input.siteId, input, now()));
            }
            return json({ error: '没有找到这个操作' }, 404);
        } catch (error) {
            const status = error instanceof AdminError ? error.status : 500;
            return json({ error: status === 500 ? '后台暂时无法完成操作，请稍后再试' : error.message }, status,
                status === 429 ? { 'Retry-After': '900' } : {});
        }
    };
}
