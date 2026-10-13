// 只负责读 sites.json 并按域名选出一套配置。新增站点请改 sites.json，不要改这个文件。

function normalizeHost(host) {
    return String(host || "")
        .trim()
        .toLowerCase()
        .replace(/\.$/, "")
        .replace(/^www\./, "");
}

function buildHostMap(sites) {
    const hostToSite = {};
    Object.keys(sites).forEach((id) => {
        const hosts = sites[id].hosts || [];
        hosts.forEach((host) => {
            hostToSite[normalizeHost(host)] = id;
        });
    });
    return hostToSite;
}

function resolveSiteId(host, search, sites, hostToSite, defaultSite, archivedSites = {}) {
    const params = new URLSearchParams(search || "");
    const fromQuery = params.get("site");
    if (fromQuery && Object.hasOwn(sites, fromQuery)) {
        return fromQuery;
    }
    if (fromQuery) throw new Error('这个情侣页面已关闭或不存在。');

    const hostname = normalizeHost(host);
    if (Object.hasOwn(hostToSite, hostname)) {
        return hostToSite[hostname];
    }

    if (Object.values(archivedSites).some((site) => (site.hosts || []).some((value) => normalizeHost(value) === hostname))) {
        throw new Error('这个情侣页面已关闭。');
    }

    const subdomain = hostname.split(".")[0];
    if (Object.hasOwn(sites, subdomain)) {
        return subdomain;
    }
    if (Object.hasOwn(archivedSites, subdomain)) throw new Error('这个情侣页面已关闭。');

    return defaultSite && sites[defaultSite] ? defaultSite : Object.keys(sites)[0];
}

async function loadCoupleConfig() {
    const data = await (window.__sitesPromise || fetch("./sites.json").then((response) => {
        if (!response.ok) {
            throw new Error("无法加载 sites.json");
        }
        return response.json();
    }));
    const sites = data.sites || {};
    const hostToSite = buildHostMap(sites);
    const host = typeof location !== "undefined" ? location.hostname : "";
    const search = typeof location !== "undefined" ? location.search : "";
    const siteId = resolveSiteId(host, search, sites, hostToSite, data.defaultSite, data.archivedSites);
    return { ...sites[siteId], siteId };
}
