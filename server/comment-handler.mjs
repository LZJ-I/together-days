import { AdminError, checkSiteId } from './admin-config.mjs';
import { checkOrigin, settingsFrom } from './admin-auth.mjs';
import { checkVisitorCsrf, commentSettings, createVisitor, visitorCsrf, visitorFrom, visitorIdentity } from './comment-crypto.mjs';
import { CommentStore } from './comment-store.mjs';
import { json, readBody } from './http.mjs';

export function createCommentHandler({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
    return async (request) => {
        try {
            if (!['GET', 'POST'].includes(request.method)) return json({ error: '不支持这种请求方式' }, 405, { Allow: 'GET, POST' });
            const base = settingsFrom(env);
            if (!base.ready) throw new AdminError(503, '留言暂时还没有开放，请稍后再来');
            const settings = commentSettings(base, env);
            const url = new URL(request.url);
            const siteId = checkSiteId(url.searchParams.get('site'));
            const visitor = visitorFrom(request, settings);
            const store = new CommentStore(settings, fetchImpl);
            if (request.method === 'GET') {
                const created = visitor ? null : createVisitor(settings, url.protocol === 'https:');
                const id = visitor || created.id;
                const identity = visitorIdentity(request, settings, id, siteId);
                const result = await store.list(siteId, { identity, before: url.searchParams.get('before') });
                return json({ ...result, csrf: visitorCsrf(settings, id, siteId) }, 200, created ? { 'Set-Cookie': created.cookie } : {});
            }
            checkOrigin(request);
            checkVisitorCsrf(request, settings, visitor, siteId);
            const identity = visitorIdentity(request, settings, visitor, siteId);
            const input = await readBody(request, 8192);
            const result = await store.add(siteId, input, identity, now());
            return json({ comment: result.comment }, 201);
        } catch (error) {
            const status = error instanceof AdminError ? error.status : 500;
            return json({ error: status === 500 ? '留言暂时无法完成，请稍后再试' : error.message }, status);
        }
    };
}
