import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminHandler } from '../server/admin-handler.mjs';
import { createSession, sessionCookie, settingsFrom } from '../server/admin-auth.mjs';
import { fakeGitHub, fixtureSites, fixtureStory, testEnv } from './fixtures/github.mjs';

const origin = 'https://love.example';
const currentTime = Date.parse('2026-10-12T10:00:00Z');

function setup({ seed, env = { ...testEnv } } = {}) {
    const github = fakeGitHub(seed);
    let now = currentTime;
    const handle = createAdminHandler({ env, fetchImpl: github.fetch, now: () => now });
    const token = createSession(settingsFrom(env), now);
    const cookie = sessionCookie(token, true).split(';')[0];
    async function request(action, { method = 'GET', data, headers = {}, auth = false, raw } = {}) {
        return handle(new Request(`${origin}/api/admin?action=${action}`, {
            method, headers: {
                ...(auth ? { Cookie: cookie } : {}),
                ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...headers
            }, ...(method === 'POST' ? { body: raw ?? JSON.stringify(data ?? {}) } : {})
        }));
    }
    async function csrf() { return (await (await request('session', { auth: true })).json()).csrf; }
    async function save(data, extra = {}) {
        return request('config', { method: 'POST', auth: true, data, headers: { 'X-CSRF-Token': await csrf(), ...extra } });
    }
    return { github, request, csrf, save, env, cookie, setNow(value) { now = value; } };
}

test('unconfigured backend stays closed and does not claim a working login', async () => {
    const handle = createAdminHandler({ env: {}, fetchImpl: () => { throw new Error('Must not connect'); } });
    const response = await handle(new Request(`${origin}/api/admin`));
    assert.deepEqual(await response.json(), {
        configured: false, authenticated: false,
        configurationIssues: ['ADMIN_PASSWORD 未设置', 'ADMIN_SESSION_SECRET 未设置', 'GITHUB_TOKEN 未设置', 'GITHUB_REPOSITORY 未设置']
    });
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.equal((await handle(new Request(`${origin}/api/admin?action=config`))).status, 503);
});

test('configuration diagnostics identify invalid fields without exposing credential values', async () => {
    for (const [field, value] of [
        ['ADMIN_PASSWORD', 'short-pass'],
        ['ADMIN_PASSWORD', 'x'.repeat(513)],
        ['ADMIN_SESSION_SECRET', 'short-secret'],
        ['GITHUB_TOKEN', '   '],
        ['GITHUB_REPOSITORY', 'https://github.com/testing/together-days'],
        ['GITHUB_BRANCH', 'bad..branch']
    ]) {
        const env = { ...testEnv, [field]: value };
        const handle = createAdminHandler({ env, fetchImpl: () => { throw new Error('Must not connect'); } });
        const response = await handle(new Request(`${origin}/api/admin`));
        const body = await response.json();
        assert.equal(body.configured, false, field);
        assert.equal(body.authenticated, false, field);
        assert.equal(body.configurationIssues.length, 1, field);
        assert.ok(body.configurationIssues[0].startsWith(field), field);
        const serialized = JSON.stringify(body);
        for (const credential of [env.ADMIN_PASSWORD, env.ADMIN_SESSION_SECRET, env.GITHUB_TOKEN]) {
            assert.ok(!serialized.includes(credential), field);
        }
        assert.equal((await handle(new Request(`${origin}/api/admin?action=config`))).status, 503, field);
    }
    const env = { ...testEnv, ADMIN_PASSWORD: 'x'.repeat(12), ADMIN_SESSION_SECRET: 's'.repeat(32) };
    delete env.GITHUB_BRANCH;
    const handle = createAdminHandler({ env });
    assert.deepEqual(await (await handle(new Request(`${origin}/api/admin`))).json(), { configured: true, authenticated: false });
});

test('anonymous readers and writers cannot access repository operations', async () => {
    const app = setup();
    assert.equal((await app.request('config')).status, 401);
    assert.equal((await app.request('config', { method: 'POST', data: {} })).status, 401);
    assert.equal(app.github.calls.length, 0);
});

test('login validates the password and issues a secure HttpOnly session without exposing secrets', async () => {
    const app = setup();
    assert.equal((await app.request('login', { method: 'POST', data: { password: 'wrong' } })).status, 401);
    const response = await app.request('login', { method: 'POST', data: { password: testEnv.ADMIN_PASSWORD } });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/admin']) assert.ok(cookie.includes(attribute));
    const text = await response.text();
    for (const secret of [testEnv.ADMIN_PASSWORD, testEnv.ADMIN_SESSION_SECRET, testEnv.GITHUB_TOKEN]) assert.ok(!text.includes(secret));
    const session = await app.request('session', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal((await session.json()).authenticated, true);
});

test('cross-origin, missing-origin and non-JSON login attempts are rejected', async () => {
    const app = setup();
    const data = { password: testEnv.ADMIN_PASSWORD };
    assert.equal((await app.request('login', { method: 'POST', data, headers: { Origin: 'https://another.example' } })).status, 403);
    assert.equal((await app.request('login', { method: 'POST', data, headers: { Origin: '' } })).status, 403);
    assert.equal((await app.request('login', { method: 'POST', data, headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('expired, tampered and password-rotated sessions cannot read configurations', async () => {
    const app = setup();
    const tampered = `${app.cookie.slice(0, -1)}!`;
    assert.equal((await app.request('config', { headers: { Cookie: tampered } })).status, 401);
    app.setNow(currentTime + 8 * 3600000);
    assert.equal((await app.request('config', { auth: true })).status, 401);
    app.setNow(currentTime);
    app.env.ADMIN_PASSWORD = 'a-new-test-only-password';
    assert.equal((await app.request('config', { auth: true })).status, 401);
});

test('authenticated changes require both a valid origin and the CSRF token', async () => {
    const app = setup();
    const data = { siteId: 'alex-sam', enabled: true, revision: app.github.revision, data: fixtureStory };
    assert.equal((await app.request('config', { method: 'POST', auth: true, data })).status, 403);
    assert.equal((await app.save(data, { Origin: 'https://another.example' })).status, 403);
    assert.equal(app.github.calls.length, 0);
});

test('a warm backend instance limits repeated login attempts', async () => {
    const app = setup();
    for (let i = 0; i < 5; i++) assert.equal((await app.request('login', { method: 'POST', data: { password: 'wrong' } })).status, 401);
    const limited = await app.request('login', { method: 'POST', data: { password: testEnv.ADMIN_PASSWORD } });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '900');
    app.setNow(currentTime + 15 * 60000);
    assert.equal((await app.request('login', { method: 'POST', data: { password: testEnv.ADMIN_PASSWORD } })).status, 200);
});

test('reading configurations keeps the default feature exclusive to Alex/Sam', async () => {
    const app = setup();
    const response = await app.request('config', { auth: true });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.siteId, 'alex-sam');
    assert.equal(result.enabled, true);
    assert.equal(result.data.distanceKm, 180);
    assert.deepEqual(result.sites.map(({ id, enabled }) => [id, enabled]), [['alex-sam', true], ['robin-jamie', false], ['casey-jordan', false]]);
    assert.equal(app.github.calls.every((call) => call.method === 'GET'), true);
});

test('enabling and disabling another couple atomically changes only that couple and preserves its records', async () => {
    const app = setup();
    const initial = app.github.files();
    const data = {
        ...fixtureStory, locations: { person1: '上海', person2: '郑州' }, distanceKm: 930,
        meetings: [{ startDate: '2026-10-01', endDate: '2026-10-07', title: '一起过国庆' }, { startDate: '2026-10-11', title: '一起吃晚饭' }]
    };
    const response = await app.save({ siteId: 'robin-jamie', enabled: true, revision: app.github.revision, data });
    const saved = await response.json();
    assert.equal(response.status, 200);
    assert.equal(saved.changed, true);
    const files = app.github.files();
    assert.equal(files['data/alex-sam.json'], initial['data/alex-sam.json']);
    const sites = JSON.parse(files['sites.json']);
    assert.deepEqual(sites.sites['alex-sam'], fixtureSites.sites['alex-sam']);
    assert.deepEqual(sites.sites['casey-jordan'], fixtureSites.sites['casey-jordan']);
    assert.equal(sites.sites['robin-jamie'].relationshipData, './data/robin-jamie.json');
    assert.deepEqual(JSON.parse(files['data/robin-jamie.json']), data);
    const tree = app.github.calls.find((call) => call.path === '/git/trees');
    assert.deepEqual(tree.body.tree.map((file) => file.path), ['sites.json', 'data/robin-jamie.json']);
    assert.equal(app.github.calls.filter((call) => call.method === 'PATCH').length, 1);
    assert.equal(app.github.calls.find((call) => call.method === 'PATCH').body.force, false);
    const disabled = await app.save({ siteId: 'robin-jamie', enabled: false, revision: app.github.revision, data });
    assert.equal(disabled.status, 200);
    assert.equal(JSON.parse(app.github.files()['sites.json']).sites['robin-jamie'].relationshipData, undefined);
    assert.equal(app.github.files()['data/robin-jamie.json'], files['data/robin-jamie.json']);
});

test('minute-precision and date-only meetings survive saving and reloading without losing precision', async () => {
    const app = setup();
    const meetings = [
        { startDate: '2026-02-02', endDate: '2026-02-04', title: '历史日期' },
        { startDate: '2026-10-11T23:30:00+08:00', endDate: '2026-10-12T00:15:00+08:00', title: '跨日见面' },
        { startDate: '2026-10-12T14:32+08:00' }
    ];
    const response = await app.save({ siteId: 'alex-sam', enabled: true, revision: app.github.revision, data: { ...fixtureStory, meetings } });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(app.github.files()['data/alex-sam.json']).meetings, meetings);
    const reloaded = await (await app.request('config', { auth: true })).json();
    assert.deepEqual(reloaded.data.meetings, meetings);
    const writes = app.github.calls.filter((call) => call.method !== 'GET').length;
    const invalid = await app.save({
        siteId: 'alex-sam', enabled: true, revision: app.github.revision,
        data: { ...fixtureStory, meetings: [{ startDate: '2026-10-12T14:32+08:00', endDate: '2026-10-12T14:31+08:00' }] }
    });
    assert.equal(invalid.status, 400);
    assert.equal(app.github.calls.filter((call) => call.method !== 'GET').length, writes);
});

test('stale versions and a concurrent branch update never overwrite the newer head', async () => {
    const app = setup();
    const revision = app.github.revision;
    app.github.advance();
    const stale = await app.save({ siteId: 'alex-sam', enabled: true, revision, data: fixtureStory });
    assert.equal(stale.status, 409);
    assert.equal(app.github.calls.some((call) => call.method === 'POST'), false);
    const before = app.github.files();
    app.github.raceNextUpdate();
    const raced = await app.save({ siteId: 'alex-sam', enabled: true, revision: app.github.revision, data: { ...fixtureStory, distanceKm: 1600 } });
    assert.equal(raced.status, 409);
    assert.deepEqual(app.github.files(), before);
});

test('invalid ranges, path traversal and unknown site IDs cannot create repository commits', async () => {
    const app = setup();
    const input = { siteId: 'alex-sam', enabled: true, revision: app.github.revision, data: fixtureStory };
    assert.equal((await app.save({ ...input, siteId: '../index.html' })).status, 400);
    assert.equal((await app.save({ ...input, siteId: 'missing-site' })).status, 404);
    assert.equal((await app.save({ ...input, data: { ...fixtureStory, distanceKm: -1 } })).status, 400);
    assert.equal((await app.save({ ...input, data: { ...fixtureStory, meetings: [{ startDate: '2026-10-07', endDate: '2026-10-01' }] } })).status, 400);
    assert.equal(app.github.calls.some((call) => call.method === 'POST' || call.method === 'PATCH'), false);
});

test('malformed and oversized request bodies fail before any repository operations', async () => {
    const app = setup();
    const headers = { 'X-CSRF-Token': await app.csrf() };
    assert.equal((await app.request('config', { method: 'POST', auth: true, raw: '{', headers })).status, 400);
    assert.equal((await app.request('config', { method: 'POST', auth: true, raw: 'x'.repeat(256001), headers })).status, 413);
    assert.equal(app.github.calls.length, 0);
});

test('logout clears the browser session and backend errors do not expose tokens', async () => {
    const app = setup();
    const logout = await app.request('logout', { method: 'POST', auth: true, headers: { 'X-CSRF-Token': await app.csrf() } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    const failed = createAdminHandler({ env: testEnv, fetchImpl: async () => new Response('denied', { status: 401 }), now: () => currentTime });
    const response = await failed(new Request(`${origin}/api/admin?action=config`, { headers: { Cookie: app.cookie } }));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(testEnv.GITHUB_TOKEN));
});
