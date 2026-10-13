import { randomUUID } from 'node:crypto';
import { AdminError, checkSiteId, commentsEnabled, siteEntry } from './admin-config.mjs';
import { GitHubStore } from './github-store.mjs';
import { MAX_COMMENTS, openComments, sealComments } from './comment-crypto.mjs';

export function publicComment({ id, nickname, message, createdAt }) {
    return { id, nickname, message, createdAt };
}

export function blockedBy(comments, identity) {
    const blocked = comments.filter((record) => !record.releasedAt);
    if (blocked.some((record) => record.deviceHash === identity.deviceHash)) return 'device';
    if (blocked.some((record) => record.ipHash === identity.ipHash)) return 'ip';
    return null;
}

export function validateComment(raw) {
    const clean = (value, label, limit) => {
        if (typeof value !== 'string') throw new AdminError(400, `请填写${label}`);
        const result = value.replace(/\r\n?/g, '\n').trim().normalize('NFC');
        if (!result || [...result].length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)) {
            throw new AdminError(400, `${label}请填写 1 至 ${limit} 个字`);
        }
        return result;
    };
    if (raw.website) throw new AdminError(400, '留言暂时无法提交，请刷新后再试');
    const nickname = clean(raw.nickname == null || (typeof raw.nickname === 'string' && !raw.nickname.trim()) ? '访客' : raw.nickname, '昵称', 24).replace(/\s+/g, ' ');
    return { nickname, message: clean(raw.message, '留言', 300) };
}

export class CommentStore {
    constructor(settings, fetchImpl = fetch) {
        this.settings = settings;
        this.pages = new GitHubStore(settings, fetchImpl);
        this.data = new GitHubStore({ ...settings, branch: settings.commentsBranch }, fetchImpl);
    }

    async page(siteId, requireEnabled = true) {
        checkSiteId(siteId);
        const revision = await this.pages.head();
        const sites = await this.pages.readFile('sites.json', revision);
        const page = siteEntry(sites, siteId);
        if (requireEnabled && !commentsEnabled(page, siteId)) throw new AdminError(404, '这个页面暂未开放留言');
        return page;
    }

    async snapshot(siteId) {
        const revision = await this.data.head();
        const envelope = await this.data.readFile(`comments/${siteId}.json`, revision, true);
        return { revision, document: openComments(envelope, siteId, this.settings.commentsKey) };
    }

    async list(siteId, { identity, admin = false, before } = {}) {
        await this.page(siteId, !admin);
        const { revision, document } = await this.snapshot(siteId);
        const records = [...document.comments].reverse();
        if (admin) return { revision, comments: records.map((record) => ({ ...publicComment(record), deletedAt: record.deletedAt, releasedAt: record.releasedAt })), total: records.length };
        const visible = records.filter((record) => !record.deletedAt);
        let offset = 0;
        if (before) {
            const index = visible.findIndex((record) => record.id === before);
            if (index < 0) throw new AdminError(400, '留言列表已更新，请重新读取');
            offset = index + 1;
        }
        const page = visible.slice(offset, offset + 20);
        const reason = identity ? blockedBy(document.comments, identity) : null;
        return { comments: page.map(publicComment), total: visible.length,
            next: offset + page.length < visible.length ? page.at(-1).id : null, canPost: !reason, reason };
    }

    async mutate(siteId, change, message) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const { revision, document } = await this.snapshot(siteId);
            const result = change(document);
            if (result.changed === false) return { ...result, revision };
            try {
                const saved = await this.data.writeFiles(revision, [{ path: `comments/${siteId}.json`, data: sealComments(document, siteId, this.settings.commentsKey) }], message);
                return { ...result, revision: saved.revision };
            } catch (error) { if (error.status !== 409) throw error; }
        }
        throw new AdminError(503, '现在留言较多，请稍后再试；已填写的内容仍保留');
    }

    async add(siteId, input, identity, now) {
        const value = validateComment(input);
        await this.page(siteId);
        const record = { id: randomUUID(), ...value, createdAt: new Date(now).toISOString(), deletedAt: null, releasedAt: null, ...identity };
        return this.mutate(siteId, (document) => {
            const reason = blockedBy(document.comments, identity);
            if (reason) throw new AdminError(409, reason === 'device' ? '你已经在这里留下过祝福啦，谢谢你的心意。' : '这个网络已经留下过祝福啦，谢谢你的心意。');
            if (document.comments.length >= MAX_COMMENTS) throw new AdminError(409, '这里的祝福已经装满了，谢谢你的心意。');
            document.comments.push(record);
            return { comment: publicComment(record), changed: true };
        }, `Add encrypted comment to ${siteId}`);
    }

    async moderate(siteId, input, now) {
        if (!['delete', 'release'].includes(input.operation) || typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id)) throw new AdminError(400, '请选择有效的评论操作');
        await this.page(siteId, false);
        return this.mutate(siteId, (document) => {
            const record = document.comments.find((comment) => comment.id === input.id);
            if (!record) throw new AdminError(404, '没有找到这条评论，请重新读取');
            const field = input.operation === 'delete' ? 'deletedAt' : 'releasedAt';
            if (record[field]) return { changed: false };
            record[field] = new Date(now).toISOString();
            return { changed: true };
        }, `${input.operation === 'delete' ? 'Delete' : 'Release'} encrypted comment in ${siteId}`);
    }
}
