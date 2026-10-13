import { createHash } from 'node:crypto';

export const testEnv = {
    ADMIN_PASSWORD: 'test-only-password-2026',
    ADMIN_SESSION_SECRET: 'test-only-session-secret-32-characters-long',
    GITHUB_TOKEN: 'test-only-token', GITHUB_REPOSITORY: 'testing/together-days', GITHUB_BRANCH: 'main'
};

export const fixtureSites = {
    defaultSite: 'alex-sam', sites: {
        'alex-sam': { name1: 'Alex', name2: 'Sam', commentsEnabled: true, startDate: '2025-01-01T00:00:00+08:00', hosts: ['alex-sam.example.com'], relationshipData: './data/alex-sam.json' },
        'robin-jamie': { name1: 'Robin', name2: 'Jamie', startDate: '2025-02-01T00:00:00+08:00', hosts: ['robin-jamie.example.com'] },
        'casey-jordan': { name1: 'Casey', name2: 'Jordan', startDate: '2025-03-01T00:00:00+08:00', hosts: ['casey-jordan.example.com'] }
    }
};

export const fixtureStory = {
    timeZone: 'Asia/Shanghai', locations: { person1: '上海', person2: '杭州' }, distanceKm: 180,
    longDistancePeriods: [{ startAt: '2026-05-01T09:00:00+08:00', endAt: null }], meetings: []
};

const digest = (data) => createHash('sha1').update(JSON.stringify(data)).digest('hex');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A small GitHub Git API fake: each commit has an immutable file snapshot.
// No credentials or network calls are used by tests.
export function fakeGitHub(seed = { 'sites.json': fixtureSites, 'data/alex-sam.json': fixtureStory }) {
    const initialFiles = Object.fromEntries(Object.entries(seed).map(([path, data]) => [path, `${JSON.stringify(data, null, 2)}\n`]));
    const initialTree = digest(initialFiles);
    const heads = new Map([['main', '1'.repeat(40)]]);
    const trees = new Map([[initialTree, initialFiles]]);
    const commits = new Map([['1'.repeat(40), { tree: { sha: initialTree }, parents: [] }]]);
    const calls = [];
    let conflictOnUpdate = null;
    const fake = {
        calls,
        get revision() { return heads.get('main'); },
        revisionFor(branch) { return heads.get(branch); },
        files(branch = 'main') { return { ...trees.get(commits.get(heads.get(branch)).tree.sha) }; },
        createBranch(branch, seed = {}) {
            const files = Object.fromEntries(Object.entries(seed).map(([path, data]) => [path, `${JSON.stringify(data, null, 2)}\n`]));
            const tree = digest(files), sha = digest([branch, tree]);
            trees.set(tree, files); commits.set(sha, { tree: { sha: tree }, parents: [] }); heads.set(branch, sha);
        },
        advance(branch = 'main') {
            const head = heads.get(branch);
            const next = digest([head, 'external change']);
            commits.set(next, { tree: commits.get(head).tree, parents: [head] });
            heads.set(branch, next);
        },
        raceNextUpdate(branch = 'main') { conflictOnUpdate = branch; },
        async fetch(input, options = {}) {
            const url = new URL(input);
            const path = url.pathname.replace('/repos/testing/together-days', '');
            const method = options.method || 'GET';
            const body = options.body ? JSON.parse(options.body) : undefined;
            calls.push({ path, method, body });
            if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
                const head = heads.get(decodeURIComponent(path.slice('/git/ref/heads/'.length)));
                return head ? json({ object: { sha: head } }) : json({}, 404);
            }
            if (method === 'GET' && path.startsWith('/contents/')) {
                const revision = url.searchParams.get('ref');
                const commit = commits.get(revision);
                const content = commit && trees.get(commit.tree.sha)[decodeURIComponent(path.slice('/contents/'.length))];
                return content === undefined ? json({ message: 'Not found' }, 404)
                    : json({ encoding: 'base64', content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content) });
            }
            if (method === 'GET' && path.startsWith('/git/commits/')) {
                const commit = commits.get(path.slice('/git/commits/'.length));
                return commit ? json(commit) : json({}, 404);
            }
            if (method === 'POST' && path === '/git/trees') {
                const files = { ...trees.get(body.base_tree) };
                for (const entry of body.tree) {
                    if (entry.sha === null) delete files[entry.path];
                    else files[entry.path] = entry.content;
                }
                const sha = digest(files);
                trees.set(sha, files);
                return json({ sha });
            }
            if (method === 'POST' && path === '/git/commits') {
                const sha = digest(body);
                commits.set(sha, { tree: { sha: body.tree }, parents: body.parents });
                return json({ sha });
            }
            if (method === 'PATCH' && path.startsWith('/git/refs/heads/')) {
                const branch = decodeURIComponent(path.slice('/git/refs/heads/'.length));
                if (conflictOnUpdate === branch) { conflictOnUpdate = null; fake.advance(branch); }
                const head = heads.get(branch);
                if (body.force || !commits.get(body.sha)?.parents.includes(head)) return json({ message: 'Not a fast forward' }, 422);
                heads.set(branch, body.sha);
                return json({ object: { sha: body.sha } });
            }
            throw new Error(`Unexpected fake GitHub request: ${method} ${path}`);
        }
    };
    return fake;
}
