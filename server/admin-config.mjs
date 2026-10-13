import { normalizeStory, parseDay } from '../assets/relationship-data.mjs';

export class AdminError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

export function checkSiteId(siteId) {
    if (typeof siteId !== 'string' || siteId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(siteId)) {
        throw new AdminError(400, '请选择有效的情侣配置');
    }
    return siteId;
}

export function emptyStory() {
    return { timeZone: 'Asia/Shanghai', locations: { person1: '', person2: '' }, distanceKm: null, longDistancePeriods: [], meetings: [] };
}

function text(value, label, limit, optional = false) {
    if (optional && value == null) return '';
    if (typeof value !== 'string' || value.length > limit) throw new AdminError(400, `${label}格式不正确，最多 ${limit} 个字符`);
    return value.trim();
}

export function validateStory(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdminError(400, '记录配置格式不正确');
    if (!Array.isArray(raw.meetings) || raw.meetings.length > 1000) throw new AdminError(400, '见面记录最多支持 1000 条');
    if (!Array.isArray(raw.longDistancePeriods) || raw.longDistancePeriods.length > 100) throw new AdminError(400, '异地阶段最多支持 100 条');
    const data = {
        timeZone: text(raw.timeZone, '时区', 60),
        locations: {
            person1: text(raw.locations?.person1, '第一个地点', 60, true),
            person2: text(raw.locations?.person2, '第二个地点', 60, true)
        },
        distanceKm: raw.distanceKm ?? null,
        longDistancePeriods: raw.longDistancePeriods.map((record) => ({
            startAt: text(record?.startAt, '异地开始时间', 40),
            endAt: record?.endAt ? text(record.endAt, '异地结束时间', 40) : null
        })),
        meetings: raw.meetings.map((record) => {
            const result = { startDate: text(record?.startDate, '见面开始日期时间', 40) };
            if (record?.endDate) result.endDate = text(record.endDate, '见面结束日期时间', 40);
            const title = text(record?.title, '见面备注', 200, true);
            if (title) result.title = title;
            return result;
        })
    };
    try {
        normalizeStory(data);
    } catch (error) {
        throw new AdminError(400, error.message);
    }
    return data;
}

export function siteEntry(sites, siteId) {
    checkSiteId(siteId);
    if (!sites?.sites || !Object.hasOwn(sites.sites, siteId)) throw new AdminError(404, '没有找到这对情侣的配置');
    const entry = sites.sites[siteId];
    if (entry.relationshipData && entry.relationshipData !== `./data/${siteId}.json`) {
        throw new AdminError(422, '该站点的数据路径需要先调整为 ./data/情侣标识.json');
    }
    return entry;
}

export function applySiteSettings(sites, siteId, enabled) {
    if (typeof enabled !== 'boolean') throw new AdminError(400, '请选择是否显示异地与见面记录');
    siteEntry(sites, siteId);
    const result = structuredClone(sites);
    if (enabled) result.sites[siteId].relationshipData = `./data/${siteId}.json`;
    else delete result.sites[siteId].relationshipData;
    return result;
}

export function commentsEnabled(site, siteId) {
    return site.commentsEnabled ?? false;
}

export function validateSite(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AdminError(400, '情侣页面配置格式不正确');
    const name1 = text(raw.name1, '第一个名字', 40);
    const name2 = text(raw.name2, '第二个名字', 40);
    if (!name1 || !name2) throw new AdminError(400, '请填写两个人的名字');
    const startDate = text(raw.startDate, '恋爱开始时间', 40);
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-]\d{2}:\d{2})?$/.exec(startDate);
    try {
        if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59 || !Number.isFinite(Date.parse(startDate))) throw new Error();
        parseDay(match[1]);
    } catch { throw new AdminError(400, '请填写有效的恋爱开始日期和时间'); }
    if (!Array.isArray(raw.hosts) || raw.hosts.length > 20) throw new AdminError(400, '域名最多支持 20 个');
    const hosts = [...new Set(raw.hosts.map((value) => {
        const host = text(value, '域名', 253).toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
        if (!host || !host.includes('.') || !host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) {
            throw new AdminError(400, '域名只填写主机名，例如 love.example.com，不要包含 https:// 或路径');
        }
        return host;
    }))];
    if (typeof raw.commentsEnabled !== 'boolean') throw new AdminError(400, '请选择是否开启评论');
    return { name1, name2, startDate, motto: text(raw.motto, '页面文案', 300, true), hosts, commentsEnabled: raw.commentsEnabled };
}

export function checkHostConflicts(sites, siteId, entry) {
    const wanted = new Set(entry.hosts);
    for (const [id, site] of Object.entries(sites.sites)) {
        if (id === siteId) continue;
        if ((site.hosts || []).some((host) => wanted.has(host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')))) {
            throw new AdminError(409, `域名已分配给 ${site.name1} / ${site.name2}，请先修改原页面的域名`);
        }
    }
}
