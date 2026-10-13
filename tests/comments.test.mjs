import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCommentHandler } from '../server/comment-handler.mjs';
import { createAdminHandler } from '../server/admin-handler.mjs';
import { createSession, readSession, settingsFrom } from '../server/admin-auth.mjs';
import { MAX_COMMENTS, commentSettings, openComments, sealComments, visitorIdentity } from '../server/comment-crypto.mjs';
import { fakeGitHub, fixtureSites, fixtureStory, testEnv } from './fixtures/github.mjs';

const origin = 'https://love.example', timestamp = Date.parse('2026-10-13T05:32:00Z');
const env = { ...testEnv, COMMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), COMMENTS_BRANCH: 'comments-data' };
const input = { nickname: '小满', message: '祝你们永远相爱！🌷' };
function setup({ siteConfig = fixtureSites, documents = {} } = {}) {
    const github = fakeGitHub({ 'sites.json': siteConfig, 'data/alex-sam.json': fixtureStory });
    github.createBranch('comments-data', documents);
    const handle = createCommentHandler({ env, fetchImpl: github.fetch, now: () => timestamp });
    const settings = commentSettings(settingsFrom(env), env);
    async function request({ method = 'GET', site = 'alex-sam', ip = '192.0.2.1', cookie, csrf, data, headers = {}, before, raw } = {}) {
        const query = new URLSearchParams({ site }); if (before) query.set('before', before);
        return handle(new Request(`${origin}/api/comments?${query}`, {
            method, headers: { 'x-vercel-forwarded-for': ip, ...(cookie ? { Cookie: cookie } : {}),
                ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf || '' } : {}), ...headers },
            ...(method === 'POST' ? { body: raw ?? JSON.stringify(data ?? input) } : {})
        }));
    }
    async function visitor(options = {}) {
        const response = await request(options); assert.equal(response.status, 200);
        return { ...options, cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json() };
    }
    const adminHandle = createAdminHandler({ env, fetchImpl: github.fetch, now: () => timestamp });
    const adminToken = createSession(settingsFrom(env), timestamp);
    const adminCookie = `love_admin_session=${adminToken}`;
    const adminCsrf = readSession(new Request(origin, { headers: { Cookie: adminCookie } }), settingsFrom(env), timestamp).csrf;
    async function admin({ method = 'GET', site = 'alex-sam', data, auth = true, csrf = adminCsrf } = {}) {
        return adminHandle(new Request(`${origin}/api/admin?action=comments&site=${site}`, {
            method, headers: { ...(auth ? { Cookie: adminCookie } : {}),
                ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) },
            ...(method === 'POST' ? { body: JSON.stringify({ siteId: site, ...data }) } : {})
        }));
    }
    return { github, request, visitor, settings, admin };
}
const stored = (app, site = 'alex-sam') => openComments(JSON.parse(app.github.files('comments-data')[`comments/${site}.json`]), site, app.settings.commentsKey);
const mutations = (github) => github.calls.filter((call) => call.method !== 'GET');

test('comments use randomized authenticated encryption bound to the couple, with no plaintext in GitHub', () => {
    const key = Buffer.alloc(32, 7), document = { version: 1, comments: [input] };
    const a = sealComments(document, 'alex-sam', key), b = sealComments(document, 'alex-sam', key);
    assert.notEqual(a.ciphertext, b.ciphertext); assert.notEqual(a.iv, b.iv);
    assert.deepEqual(openComments(a, 'alex-sam', key), document);
    assert.ok(!JSON.stringify(a).includes(input.nickname)); assert.ok(!JSON.stringify(a).includes(input.message));
    assert.throws(() => openComments(a, 'robin-jamie', key), /无法解密/);
    assert.throws(() => openComments(a, 'alex-sam', Buffer.alloc(32, 8)), /无法解密/);
    assert.throws(() => openComments({ ...a, tag: Buffer.alloc(16).toString('base64url') }, 'alex-sam', key), /无法解密/);
});

test('missing or unsafe comment configuration fails closed without revealing secrets or writing to GitHub', async () => {
    for (const override of [{ COMMENT_ENCRYPTION_KEY: '' }, { COMMENT_ENCRYPTION_KEY: 'x'.repeat(32) }, { COMMENTS_BRANCH: 'main' }, { COMMENTS_BRANCH: '../unsafe' }]) {
        const handle = createCommentHandler({ env: { ...env, ...override }, fetchImpl() { throw new Error('Must not connect'); } });
        const response = await handle(new Request(`${origin}/api/comments?site=alex-sam`));
        assert.equal(response.status, 503);
        const text = await response.text();
        for (const secret of [env.COMMENT_ENCRYPTION_KEY, env.ADMIN_SESSION_SECRET, env.ADMIN_PASSWORD, env.GITHUB_TOKEN]) assert.ok(!text.includes(secret));
    }
});

test('public reads issue signed HttpOnly credentials and expose only display fields', async () => {
    const app = setup();
    const response = await app.request();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private, no-store/);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api/comments']) assert.ok(response.headers.get('set-cookie').includes(attr));
    const data = await response.json(); assert.equal(data.canPost, true); assert.ok(data.csrf); assert.deepEqual(data.comments, []);
    const visitor = await app.visitor();
    const posted = await app.request({ ...visitor, method: 'POST' }); assert.equal(posted.status, 201);
    const list = await (await app.request({ cookie: visitor.cookie })).json();
    assert.deepEqual(Object.keys(list.comments[0]).sort(), ['createdAt', 'id', 'message', 'nickname']);
    assert.equal(list.canPost, false); assert.equal(list.reason, 'device');
    const text = JSON.stringify(list);
    for (const hidden of ['deviceHash', 'ipHash', '192.0.2.1', 'ciphertext', env.COMMENT_ENCRYPTION_KEY]) assert.ok(!text.includes(hidden));
});

test('a comment changes only the data branch, encrypting content and deduplication markers', async () => {
    const app = setup(), main = app.github.files(), revision = app.github.revision;
    const visitor = await app.visitor();
    assert.equal((await app.request({ ...visitor, method: 'POST' })).status, 201);
    assert.equal(app.github.revision, revision); assert.deepEqual(app.github.files(), main);
    const document = stored(app); assert.equal(document.comments[0].message, input.message);
    assert.equal(document.comments[0].deviceHash.length, 43); assert.equal(document.comments[0].ipHash.length, 43);
    const saved = JSON.stringify(app.github.files('comments-data'));
    for (const value of [input.nickname, input.message, '192.0.2.1', document.comments[0].ipHash, env.COMMENT_ENCRYPTION_KEY]) assert.ok(!saved.includes(value));
    const updates = app.github.calls.filter((call) => call.method === 'PATCH');
    assert.equal(updates.length, 1); assert.equal(updates[0].path, '/git/refs/heads/comments-data'); assert.equal(updates[0].body.force, false);
});

test('either the same browser or the same IP blocks another comment, independently per couple', async () => {
    const sites = structuredClone(fixtureSites); sites.sites['robin-jamie'].commentsEnabled = true;
    const app = setup({ siteConfig: sites });
    const first = await app.visitor(); assert.equal((await app.request({ ...first, method: 'POST' })).status, 201);
    assert.equal((await app.request({ ...first, method: 'POST', ip: '192.0.2.2' })).status, 409);
    const sameIp = await app.visitor(); assert.equal(sameIp.canPost, false); assert.equal(sameIp.reason, 'ip');
    assert.equal((await app.request({ ...sameIp, method: 'POST' })).status, 409);
    const fresh = await app.visitor({ ip: '192.0.2.3' }); assert.equal((await app.request({ ...fresh, method: 'POST' })).status, 201);
    const other = await app.request({ cookie: first.cookie, site: 'robin-jamie' }); const otherData = await other.json(); assert.equal(otherData.canPost, true);
    assert.equal((await app.request({ cookie: first.cookie, csrf: otherData.csrf, site: 'robin-jamie', method: 'POST' })).status, 201);
    assert.equal(stored(app).comments.length, 2); assert.equal(stored(app, 'robin-jamie').comments.length, 1);
});

test('deduplication survives function restarts and invalid browser cookies still meet the IP restriction', async () => {
    const app = setup(); const visitor = await app.visitor();
    await app.request({ ...visitor, method: 'POST' });
    const restarted = createCommentHandler({ env, fetchImpl: app.github.fetch });
    const response = await restarted(new Request(`${origin}/api/comments?site=alex-sam`, { headers: { Cookie: visitor.cookie, 'x-vercel-forwarded-for': '192.0.2.9' } }));
    assert.equal((await response.json()).reason, 'device');
    const invalid = await app.request({ cookie: `${visitor.cookie}tampered` }); assert.equal(invalid.status, 200);
    assert.ok(invalid.headers.get('set-cookie')); assert.equal((await invalid.json()).reason, 'ip');
});

test('origin, credentials, input limits and body validation reject invalid submissions before repository writes', async () => {
    const app = setup(); const visitor = await app.visitor();
    const cases = [
        { csrf: 'wrong' }, { cookie: '' }, { headers: { Origin: 'https://other.example' } },
        { headers: { Origin: '' } }, { headers: { 'Content-Type': 'text/plain' } },
        { headers: { 'Sec-Fetch-Site': 'cross-site' } }, { raw: '{' }, { raw: 'x'.repeat(8193) },
        { data: { ...input, message: '🌷'.repeat(301) } }, { data: { ...input, nickname: '名'.repeat(25) } },
        { data: { ...input, message: '  ' } }, { data: { ...input, website: 'https://spam.example' } },
        { data: { ...input, message: 'bad\u0000text' } }, { site: '../bad' }
    ];
    for (const value of cases) assert.ok((await app.request({ ...visitor, method: 'POST', ...value })).status >= 400, JSON.stringify(value));
    assert.equal(mutations(app.github).length, 0);
    assert.equal((await app.request({ method: 'DELETE' })).status, 405);
});

test('concurrent submissions from one IP permit one write, while distinct visitors preserve both comments', async () => {
    const app = setup(); const a = await app.visitor(), b = await app.visitor();
    const responses = await Promise.all([app.request({ ...a, method: 'POST' }), app.request({ ...b, method: 'POST' })]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]); assert.equal(stored(app).comments.length, 1);
    const c = await app.visitor({ ip: '192.0.2.2' }), d = await app.visitor({ ip: '192.0.2.3' });
    const distinct = await Promise.all([app.request({ ...c, method: 'POST' }), app.request({ ...d, method: 'POST' })]);
    assert.deepEqual(distinct.map((response) => response.status), [201, 201]); assert.equal(stored(app).comments.length, 3);
});

test('admin deletion removes public content but preserves the restriction until explicitly released', async () => {
    const app = setup(); const visitor = await app.visitor();
    const result = await (await app.request({ ...visitor, method: 'POST' })).json();
    const id = result.comment.id;
    assert.equal((await app.admin({ auth: false })).status, 401);
    assert.equal((await app.admin({ method: 'POST', csrf: '', data: { id, operation: 'delete' } })).status, 403);
    assert.equal((await app.admin({ method: 'POST', data: { id, operation: 'delete' } })).status, 200);
    const list = await (await app.request({ cookie: visitor.cookie })).json();
    assert.equal(list.total, 0); assert.equal(list.canPost, false); assert.equal(list.reason, 'device');
    assert.equal((await app.request({ ...visitor, method: 'POST' })).status, 409);
    const admin = await (await app.admin()).json();
    assert.equal(admin.comments[0].message, input.message); assert.equal(admin.comments[0].deletedAt, new Date(timestamp).toISOString());
    assert.ok(!JSON.stringify(admin).includes('deviceHash')); assert.ok(!JSON.stringify(admin).includes('ipHash'));
    assert.equal((await app.admin({ method: 'POST', data: { id, operation: 'release' } })).status, 200);
    assert.equal((await app.request({ ...visitor, method: 'POST' })).status, 201);
    assert.equal(stored(app).comments.length, 2);
    assert.equal((await app.admin({ method: 'POST', data: { id, operation: 'delete' } })).status, 200);
});

test('disabled or deleted couple pages close public reads and writes even with existing credentials', async () => {
    const app = setup(); const visitor = await app.visitor();
    assert.equal((await app.request({ site: 'robin-jamie' })).status, 404);
    assert.equal((await app.request({ ...visitor, method: 'POST', site: 'robin-jamie' })).status, 403);
    const sites = structuredClone(fixtureSites); sites.sites['alex-sam'].commentsEnabled = false;
    const disabled = setup({ siteConfig: sites });
    assert.equal((await disabled.request()).status, 404);
    assert.equal((await disabled.request({ ...visitor, method: 'POST' })).status, 404);
    assert.equal((await disabled.admin()).status, 200);
    delete sites.sites['alex-sam']; sites.defaultSite = 'robin-jamie';
    const deleted = setup({ siteConfig: sites });
    assert.equal((await deleted.request()).status, 404); assert.equal((await deleted.admin()).status, 404);
});

test('IPv6 equivalent spellings and IPv4 mapped IPv6 share a deduplication marker', () => {
    const settings = commentSettings(settingsFrom(env), env);
    const identity = (ip) => visitorIdentity(new Request(origin, { headers: { 'x-vercel-forwarded-for': ip } }), settings, 'visitor-id', 'alex-sam');
    assert.equal(identity('2001:db8::1').ipHash, identity('2001:0db8:0000:0000:0000:0000:0000:0001').ipHash);
    assert.equal(identity('192.0.2.1').ipHash, identity('::ffff:192.0.2.1').ipHash);
    assert.throws(() => identity(''), /无法确认/); assert.throws(() => identity('not-an-ip'), /无法确认/);
});

test('public pagination never includes deleted comments and rejects stale cursors', async () => {
    const settings = commentSettings(settingsFrom(env), env);
    const records = Array.from({ length: 45 }, (_, index) => ({ id: randomUUID(), ...input, createdAt: new Date(timestamp + index).toISOString(), deletedAt: index < 2 ? new Date(timestamp).toISOString() : null, releasedAt: null, deviceHash: `device-${index}`, ipHash: `ip-${index}` }));
    const app = setup({ documents: { 'comments/alex-sam.json': sealComments({ version: 1, comments: records }, 'alex-sam', settings.commentsKey) } });
    const first = await app.visitor(); assert.equal(first.total, 43); assert.equal(first.comments.length, 20);
    const second = await (await app.request({ cookie: first.cookie, before: first.next })).json(); assert.equal(second.comments.length, 20);
    const last = await (await app.request({ cookie: first.cookie, before: second.next })).json(); assert.equal(last.comments.length, 3); assert.equal(last.next, null);
    assert.equal(new Set([...first.comments, ...second.comments, ...last.comments].map((record) => record.id)).size, 43);
    assert.equal((await app.request({ before: 'not-a-valid-comment' })).status, 400);
});

test('wrong encryption keys cannot overwrite existing comments and conflicts retry from the latest data', async () => {
    const app = setup(); const visitor = await app.visitor();
    app.github.raceNextUpdate('comments-data');
    assert.equal((await app.request({ ...visitor, method: 'POST' })).status, 201); assert.equal(stored(app).comments.length, 1);
    const before = app.github.files('comments-data'), writes = mutations(app.github).length;
    const wrongKey = createCommentHandler({ env: { ...env, COMMENT_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64url') }, fetchImpl: app.github.fetch });
    const response = await wrongKey(new Request(`${origin}/api/comments?site=alex-sam`, { headers: { 'x-vercel-forwarded-for': '192.0.2.4' } }));
    assert.equal(response.status, 422); assert.equal(mutations(app.github).length, writes); assert.deepEqual(app.github.files('comments-data'), before);
});

test('storage stays below the GitHub JSON limit even at capacity with maximum length Unicode comments', async () => {
    const settings = commentSettings(settingsFrom(env), env);
    const records = Array.from({ length: MAX_COMMENTS }, () => ({ id: randomUUID(), nickname: '🌷'.repeat(24), message: '🌷'.repeat(300), createdAt: new Date(timestamp).toISOString(), deletedAt: new Date(timestamp).toISOString(), releasedAt: new Date(timestamp).toISOString(), deviceHash: 'd'.repeat(43), ipHash: 'i'.repeat(43) }));
    const envelope = sealComments({ version: 1, comments: records }, 'alex-sam', settings.commentsKey);
    assert.ok(Buffer.byteLength(JSON.stringify(envelope, null, 2)) < 1000000);
    const app = setup({ documents: { 'comments/alex-sam.json': envelope } });
    const visitor = await app.visitor();
    assert.equal((await app.request({ ...visitor, method: 'POST' })).status, 409); assert.equal(mutations(app.github).length, 0);
});
