import { AdminError, applySiteSettings, checkHostConflicts, checkSiteId, commentsEnabled, emptyStory, siteEntry, validateSite, validateStory } from './admin-config.mjs';

export class GitHubStore {
    constructor(settings, fetchImpl = fetch) {
        this.settings = settings;
        this.fetch = fetchImpl;
        this.base = `https://api.github.com/repos/${settings.repository}`;
        this.refPath = `heads/${settings.branch.split('/').map(encodeURIComponent).join('/')}`;
    }

    async api(path, { method = 'GET', body, allowMissing = false, updatingRef = false } = {}) {
        let response;
        try {
            response = await this.fetch(`${this.base}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.settings.token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'Content-Type': 'application/json',
                    'User-Agent': 'love-timer-admin'
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                cache: 'no-store', signal: AbortSignal.timeout(10000)
            });
        } catch {
            throw new AdminError(502, '暂时无法连接 GitHub，请稍后重试');
        }
        if (allowMissing && response.status === 404) return null;
        if (updatingRef && [409, 422].includes(response.status)) {
            throw new AdminError(409, '仓库已有新修改，请重新读取后再保存；当前填写的内容仍保留在页面中');
        }
        if (!response.ok) throw new AdminError(502, '仓库操作失败，请检查 GitHub 令牌、仓库名称及目标分支权限');
        return response.json();
    }

    async head() {
        const ref = await this.api(`/git/ref/${this.refPath}`);
        return ref.object.sha;
    }

    async readFile(path, revision, allowMissing = false) {
        const file = await this.api(`/contents/${path}?ref=${encodeURIComponent(revision)}`, { allowMissing });
        if (file === null) return null;
        if (file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > 1000000) {
            throw new AdminError(422, '仓库中的配置文件格式或大小不符合要求');
        }
        try {
            return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
        } catch {
            throw new AdminError(422, '仓库中的配置文件不是有效的 JSON');
        }
    }

    async read(siteId) {
        const revision = await this.head();
        const sites = await this.readFile('sites.json', revision);
        const selectedId = siteId || sites.defaultSite;
        const entry = siteEntry(sites, selectedId);
        const raw = await this.readFile(`data/${selectedId}.json`, revision, true);
        if (raw === null && entry.relationshipData) throw new AdminError(422, '当前已开启展示，但仓库中缺少对应的数据文件');
        const data = validateStory(raw || emptyStory());
        return {
            revision, siteId: selectedId, enabled: !!entry.relationshipData, data,
            site: { ...entry, commentsEnabled: commentsEnabled(entry, selectedId) }, defaultSite: sites.defaultSite,
            sites: Object.entries(sites.sites).map(([id, site]) => ({
                id, name1: site.name1, name2: site.name2, enabled: !!site.relationshipData
            }))
        };
    }

    async save(input) {
        const siteId = checkSiteId(input.siteId);
        const data = validateStory(input.data);
        if (typeof input.enabled !== 'boolean') throw new AdminError(400, '请选择是否显示异地与见面记录');
        if (typeof input.revision !== 'string' || !/^[a-f0-9]{40}$/.test(input.revision)) throw new AdminError(400, '请先读取仓库中的最新配置');
        const revision = await this.head();
        if (revision !== input.revision) throw new AdminError(409, '仓库已有新修改，请重新读取后再保存；当前填写的内容仍保留在页面中');
        const [sites, parent] = await Promise.all([
            this.readFile('sites.json', revision), this.api(`/git/commits/${revision}`)
        ]);
        const updatedSites = applySiteSettings(sites, siteId, input.enabled);
        if (input.site !== undefined) {
            const metadata = validateSite(input.site);
            checkHostConflicts(sites, siteId, metadata);
            updatedSites.sites[siteId] = { ...updatedSites.sites[siteId], ...metadata };
        }
        return this.writeFiles(revision, [
            { path: 'sites.json', data: updatedSites }, { path: `data/${siteId}.json`, data }
        ], `Update ${siteId} relationship records`, parent);
    }

    async writeFiles(revision, files, message, parent) {
        parent ||= await this.api(`/git/commits/${revision}`);
        const tree = await this.api('/git/trees', {
            method: 'POST', body: {
                base_tree: parent.tree.sha,
                tree: files.map(({ path, data }) => ({ path, mode: '100644', type: 'blob',
                    ...(data === null ? { sha: null } : { content: `${JSON.stringify(data, null, 2)}\n` }) }))
            }
        });
        if (tree.sha === parent.tree.sha) return { changed: false, revision };
        const commit = await this.api('/git/commits', {
            method: 'POST', body: { message, tree: tree.sha, parents: [revision] }
        });
        await this.api(`/git/refs/${this.refPath}`, {
            method: 'PATCH', body: { sha: commit.sha, force: false }, updatingRef: true
        });
        return {
            changed: true, revision: commit.sha,
            commitUrl: `https://github.com/${this.settings.repository}/commit/${commit.sha}`
        };
    }

    async currentRevision(expected) {
        if (typeof expected !== 'string' || !/^[a-f0-9]{40}$/.test(expected)) throw new AdminError(400, '请先读取仓库中的最新配置');
        const revision = await this.head();
        if (revision !== expected) throw new AdminError(409, '仓库已有新修改，请重新读取后再操作；当前填写的内容仍保留在页面中');
        return revision;
    }

    async createSite(input) {
        const siteId = checkSiteId(input.siteId);
        const entry = validateSite(input.site);
        if (typeof input.enabled !== 'boolean') throw new AdminError(400, '请选择是否显示异地与见面记录');
        const data = validateStory(input.data || emptyStory());
        const revision = await this.currentRevision(input.revision);
        const sites = await this.readFile('sites.json', revision);
        if (Object.hasOwn(sites.sites, siteId) || Object.hasOwn(sites.archivedSites || {}, siteId)) {
            throw new AdminError(409, '这个页面标识已被使用，请换一个新的标识');
        }
        checkHostConflicts(sites, siteId, entry);
        if (input.enabled) entry.relationshipData = `./data/${siteId}.json`;
        sites.sites[siteId] = entry;
        const result = await this.writeFiles(revision, [
            { path: 'sites.json', data: sites }, { path: `data/${siteId}.json`, data }
        ], `Create ${siteId} couple page`);
        return { ...result, siteId };
    }

    async deleteSite(input, now = Date.now()) {
        const siteId = checkSiteId(input.siteId);
        const revision = await this.currentRevision(input.revision);
        const sites = await this.readFile('sites.json', revision);
        const entry = siteEntry(sites, siteId);
        if (Object.keys(sites.sites).length <= 1) throw new AdminError(400, '至少需要保留一个情侣页面');
        if (sites.defaultSite === siteId) {
            if (!input.replacementDefault || input.replacementDefault === siteId) throw new AdminError(400, '删除默认页面前，请选择新的默认页面');
            siteEntry(sites, input.replacementDefault);
            sites.defaultSite = input.replacementDefault;
        }
        const data = await this.readFile(`data/${siteId}.json`, revision, true);
        const deletedAt = new Date(now).toISOString();
        sites.archivedSites ||= {};
        sites.archivedSites[siteId] = { hosts: entry.hosts || [], deletedAt };
        delete sites.sites[siteId];
        const files = [
            { path: 'sites.json', data: sites },
            { path: `archive/${siteId}.json`, data: { site: entry, data, deletedAt } }
        ];
        if (data !== null) files.push({ path: `data/${siteId}.json`, data: null });
        const result = await this.writeFiles(revision, files, `Archive ${siteId} couple page`);
        return { ...result, siteId: sites.defaultSite };
    }
}
