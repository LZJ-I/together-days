import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { GitHubStore } from '../server/github-store.mjs';
import { createAdminHandler } from '../server/admin-handler.mjs';
import { createSession, readSession, settingsFrom } from '../server/admin-auth.mjs';
import { fakeGitHub, fixtureSites, fixtureStory, testEnv } from './fixtures/github.mjs';

const metadata = { name1: '小明', name2: '小红', startDate: '2026-10-13T14:32:00+08:00', motto: '一起慢慢走', hosts: [], commentsEnabled: true };
function setup() { const github = fakeGitHub(); return { github, store: new GitHubStore(settingsFrom(testEnv), github.fetch) }; }

test('creating a couple atomically registers the page and empty records without changing existing couples', async () => {
    const { github, store } = setup(), before = github.files();
    const result = await store.createSite({ siteId: 'xiaoming-xiaohong', revision: github.revision, site: metadata, enabled: true });
    assert.equal(result.changed, true); assert.equal(result.siteId, 'xiaoming-xiaohong');
    const sites = JSON.parse(github.files()['sites.json']);
    for (const [id, entry] of Object.entries(fixtureSites.sites)) assert.deepEqual(sites.sites[id], entry);
    assert.equal(github.files()['data/alex-sam.json'], before['data/alex-sam.json']);
    assert.equal(sites.sites['xiaoming-xiaohong'].relationshipData, './data/xiaoming-xiaohong.json');
    const loaded = await store.read('xiaoming-xiaohong'); assert.equal(loaded.site.name1, '小明'); assert.equal(loaded.site.commentsEnabled, true); assert.deepEqual(loaded.data.meetings, []);
});

test('metadata edits preserve minute records and other couples, and reject duplicate domains', async () => {
    const { github, store } = setup();
    const data = { ...fixtureStory, meetings: [{ startDate: '2026-10-13T14:32+08:00' }] };
    const site = { ...metadata, name1: 'Alex', name2: 'Sam', hosts: ['WWW.NEW.EXAMPLE.'] };
    const result = await store.save({ siteId: 'alex-sam', revision: github.revision, enabled: true, data, site });
    assert.equal(result.changed, true);
    const sites = JSON.parse(github.files()['sites.json']); assert.deepEqual(sites.sites['alex-sam'].hosts, ['new.example']);
    assert.deepEqual(sites.sites['robin-jamie'], fixtureSites.sites['robin-jamie']); assert.deepEqual(JSON.parse(github.files()['data/alex-sam.json']).meetings, data.meetings);
    await assert.rejects(store.createSite({ siteId: 'new-couple', revision: github.revision, enabled: false, site: { ...metadata, hosts: ['new.example'] } }), { status: 409 });
});

test('invalid names, times, domains, IDs and stale revisions cannot create pages', async () => {
    const { github, store } = setup();
    for (const override of [
        { siteId: '../bad' }, { siteId: 'alex-sam' }, { site: { ...metadata, name1: '' } },
        { site: { ...metadata, startDate: '2026-02-30T12:30:00' } }, { site: { ...metadata, startDate: '2026-10-13T24:30:00' } },
        { site: { ...metadata, hosts: ['https://love.example'] } }, { site: { ...metadata, hosts: ['love.example/path'] } },
        { site: { ...metadata, hosts: ['alex-sam.example.com'] } }, { revision: '0'.repeat(40) }
    ]) await assert.rejects(store.createSite({ siteId: 'new-couple', revision: github.revision, site: metadata, enabled: false, ...override }));
    assert.equal(github.calls.some((call) => call.method !== 'GET'), false);
});

test('deleting a couple archives its configuration and records, closes its routes and preserves other pages', async () => {
    const { github, store } = setup(), original = github.files();
    await store.deleteSite({ siteId: 'alex-sam', revision: github.revision, replacementDefault: 'casey-jordan' }, Date.parse('2026-10-13T05:32:00Z'));
    const files = github.files(), sites = JSON.parse(files['sites.json']), archive = JSON.parse(files['archive/alex-sam.json']);
    assert.equal(sites.defaultSite, 'casey-jordan'); assert.equal(sites.sites['alex-sam'], undefined); assert.equal(files['data/alex-sam.json'], undefined);
    assert.deepEqual(archive.data, fixtureStory); assert.deepEqual(archive.site, fixtureSites.sites['alex-sam']);
    assert.deepEqual(sites.sites['robin-jamie'], JSON.parse(original['sites.json']).sites['robin-jamie']);
    assert.deepEqual(sites.archivedSites['alex-sam'].hosts, ['alex-sam.example.com']);
    await assert.rejects(store.read('alex-sam'), { status: 404 });
    await assert.rejects(store.createSite({ siteId: 'alex-sam', revision: github.revision, enabled: false, site: metadata }), { status: 409 });
});

test('the last couple and an unreplaced default cannot be deleted, and races do not overwrite changes', async () => {
    const { github, store } = setup();
    await assert.rejects(store.deleteSite({ siteId: 'alex-sam', revision: github.revision }), { status: 400 });
    await store.deleteSite({ siteId: 'robin-jamie', revision: github.revision });
    await store.deleteSite({ siteId: 'casey-jordan', revision: github.revision });
    await assert.rejects(store.deleteSite({ siteId: 'alex-sam', revision: github.revision }), { status: 400 });
    github.raceNextUpdate(); const files = github.files();
    await assert.rejects(store.createSite({ siteId: 'new-couple', revision: github.revision, site: metadata, enabled: false }), { status: 409 });
    assert.deepEqual(github.files(), files);
});

test('admin page creation and deletion require login, same origin and the session CSRF token', async () => {
    const { github } = setup(); const origin = 'https://love.example';
    const settings = settingsFrom(testEnv), now = Date.now();
    const cookie = `love_admin_session=${createSession(settings, now)}`;
    const csrf = readSession(new Request(origin, { headers: { Cookie: cookie } }), settings, now).csrf;
    const handle = createAdminHandler({ env: testEnv, fetchImpl: github.fetch, now: () => now });
    const data = { siteId: 'new-couple', revision: github.revision, site: metadata, enabled: false };
    const request = (action, headers = {}) => handle(new Request(`${origin}/api/admin?action=${action}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) }));
    assert.equal((await request('create-site')).status, 401); assert.equal((await request('delete-site')).status, 401);
    assert.equal((await request('create-site', { Cookie: cookie })).status, 403);
    assert.equal((await request('create-site', { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://other.example' })).status, 403);
    assert.equal(github.calls.length, 0);
    assert.equal((await request('create-site', { Cookie: cookie, 'X-CSRF-Token': csrf })).status, 200);
});

test('frontend routing shows closed pages instead of falling back to another couple and ignores prototype names', async () => {
    const source = await readFile(new URL('../config.js', import.meta.url), 'utf8');
    const context = vm.createContext({ URLSearchParams }); vm.runInContext(source, context);
    const route = (host, query, sites, archived = {}) => context.resolveSiteId(host, query, sites, context.buildHostMap(sites), 'casey-jordan', archived);
    const sites = structuredClone(fixtureSites.sites); delete sites['alex-sam'];
    const archived = { 'alex-sam': { hosts: ['alex-sam.example.com'] } };
    assert.throws(() => route('example.com', '?site=alex-sam', sites, archived), /已关闭/);
    assert.throws(() => route('alex-sam.example.com', '', sites, archived), /已关闭/);
    assert.throws(() => route('alex-sam.example.com', '', sites, archived), /已关闭/);
    assert.throws(() => route('example.com', '?site=__proto__', sites), /不存在/);
    assert.equal(route('unrelated.example', '', sites), 'casey-jordan');
    assert.equal(route('robin-jamie.example.com', '', sites), 'robin-jamie');
});
