// Local interactive preview. All repository reads/writes stay in memory.
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDevServer } from './dev-server.mjs';
import { createAdminHandler } from '../server/admin-handler.mjs';
import { createCommentHandler } from '../server/comment-handler.mjs';
import { commentSettings, sealComments } from '../server/comment-crypto.mjs';
import { settingsFrom } from '../server/admin-auth.mjs';
import { fakeGitHub, testEnv } from '../tests/fixtures/github.mjs';

const sites = JSON.parse(await readFile(new URL('../sites.json', import.meta.url)));
sites.sites[sites.defaultSite].commentsEnabled = true;
const seed = { 'sites.json': sites };
for (const id of Object.keys(sites.sites)) {
    try { seed[`data/${id}.json`] = JSON.parse(await readFile(new URL(`../data/${id}.json`, import.meta.url))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const github = fakeGitHub(seed);
const env = { ...testEnv, ADMIN_PASSWORD: 'preview-love-only', COMMENT_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), COMMENTS_BRANCH: 'comments-data' };
const settings = commentSettings(settingsFrom(env), env);
const now = Date.now();
const comments = [
    ['阿橙', '愿你们的每一次奔赴，都有好天气和好心情。\n180 公里，也挡不住认真相爱的人 ♡'],
    ['路过的朋友', '从今天到往后的每一天，都要一起慢慢走呀。'],
    ['小满', '把想念攒成下一次拥抱。祝你们早日结束异地，天天见面！🌷']
].map(([nickname, message], index) => ({ id: randomUUID(), nickname, message,
    createdAt: new Date(now - (3 - index) * 3600000).toISOString(), deletedAt: null, releasedAt: null,
    deviceHash: `demo-device-${index}`, ipHash: `demo-network-${index}` }));
github.createBranch('comments-data', { [`comments/${sites.defaultSite}.json`]: sealComments({ version: 1, comments }, sites.defaultSite, settings.commentsKey) });
const handle = createAdminHandler({ env, fetchImpl: github.fetch });
const handleComments = createCommentHandler({ env, fetchImpl: github.fetch });
const server = createDevServer({ handle, handleComments, publicFile(path) {
    if (path === '/sites.json' || path.startsWith('/data/')) return github.files()[path.slice(1)] ?? null;
} });
const port = Number(process.env.PORT || 8765);
server.listen(port, '127.0.0.1', () => console.log(`Preview: http://localhost:${port}/\nAdmin: http://localhost:${port}/admin/\nPreview-only password: preview-love-only\nAll changes are temporary and do not write to GitHub.`));
