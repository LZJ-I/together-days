import { distanceDuration, meetingDayCount, normalizeStory, todayInZone } from '../assets/relationship-data.mjs?v=3';
import { createCommentAdmin } from './comments.mjs?v=1';

const { DateTime } = window.luxon;
const $ = (id) => document.getElementById(id);
const state = { csrf: '', snapshot: null, dirty: false, busy: false, configured: false, tab: 'records' };

function notice(message = '', success = false) {
    $('notice').textContent = message;
    $('notice').hidden = !message;
    $('notice').classList.toggle('is-success', success);
}

function showLogin(message = '') {
    $('loading-panel').hidden = true;
    $('workspace').hidden = true;
    $('login-panel').hidden = false;
    $('login-form').hidden = !state.configured;
    $('setup-note').hidden = state.configured;
    $('retry-button').hidden = state.configured;
    $('login-title').textContent = state.configured ? '欢迎回来' : '后台待配置';
    $('login-description').textContent = state.configured ? '输入管理密码，继续记录你们的故事。' : '完成一次配置，就可以在这里维护你们的记录。';
    if (message) notice(message);
    if (state.configured) $('password').focus();
}

async function api(action, { method = 'GET', data, site } = {}) {
    const query = new URLSearchParams({ action });
    if (site) query.set('site', site);
    let response;
    try {
        response = await fetch(`/api/admin?${query}`, {
            method, credentials: 'same-origin', cache: 'no-store',
            headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf } : {},
            ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
            signal: AbortSignal.timeout(60000)
        });
    } catch {
        throw new Error('暂时无法连接后台，请检查网络后重试；已填写的内容仍保留在页面中。');
    }
    let result;
    try { result = await response.json(); } catch { throw new Error('管理接口暂时不可用，请通过 Vercel 或本地开发服务器访问。'); }
    if (!response.ok) {
        if (response.status === 401 && action !== 'login') showLogin('登录已过期，请重新登录后继续保存，当前填写的内容仍然保留。');
        const error = new Error(result.error || '操作暂时没有完成，请重试');
        error.status = response.status;
        throw error;
    }
    return result;
}

function controls() {
    $('editor-fields').disabled = state.busy;
    $('site-select').disabled = state.busy;
    $('save-button').disabled = state.busy || !state.dirty;
    $('reload-button').disabled = state.busy;
    $('export-button').disabled = state.busy;
    $('logout-button').disabled = state.busy;
    $('create-site-button').disabled = state.busy || !state.snapshot;
    $('delete-site-button').disabled = state.busy || !state.snapshot || state.snapshot.sites.length <= 1;
    $('records-tab').disabled = state.busy;
    $('comments-tab').disabled = state.busy;
    $('save-button').textContent = state.busy ? '正在处理…' : '保存修改';
    $('save-state').textContent = state.busy ? '正在连接仓库，请稍候' : state.dirty ? '有尚未保存的修改' : '已读取最新配置';
    $('save-state').classList.toggle('is-dirty', state.dirty);
}

function localTime(instant, zone, minutesOnly = false) {
    return instant ? DateTime.fromISO(instant, { zone }).toFormat(minutesOnly ? "yyyy-LL-dd'T'HH:mm" : "yyyy-LL-dd'T'HH:mm:ss") : '';
}

function instant(value, zone, label = '异地') {
    const parsed = DateTime.fromISO(value, { zone });
    const expected = value.length === 16 ? `${value}:00` : value;
    if (!parsed.isValid || parsed.toFormat("yyyy-LL-dd'T'HH:mm:ss") !== expected) throw new Error(`${label}时间或时区无效，请检查开始和结束时间`);
    return parsed.toISO({ suppressMilliseconds: true });
}

function meetingTime(input, zone) {
    // Keep date-only historical records and their original precision unless edited.
    if (input.dataset.originalValue && input.value === input.dataset.originalDisplay && zone === input.dataset.originalZone) {
        return input.dataset.originalValue;
    }
    return instant(input.value, zone, '见面');
}

function collect() {
    const timeZone = $('time-zone').value.trim();
    const result = {
        timeZone,
        locations: { person1: $('location1').value.trim(), person2: $('location2').value.trim() },
        distanceKm: $('distance-km').value === '' ? null : Number($('distance-km').value),
        longDistancePeriods: [...$('periods').children].map((row) => ({
            startAt: instant(row.querySelector('[data-field="startAt"]').value, timeZone),
            endAt: row.querySelector('[data-field="endAt"]').value ? instant(row.querySelector('[data-field="endAt"]').value, timeZone) : null
        })),
        meetings: [...$('meetings').children].map((row) => {
            const value = (field) => row.querySelector(`[data-field="${field}"]`).value;
            const time = (field) => meetingTime(row.querySelector(`[data-field="${field}"]`), timeZone);
            const record = { startDate: time('startDate') };
            if (value('endDate')) record.endDate = time('endDate');
            if (value('title').trim()) record.title = value('title').trim();
            return record;
        })
    };
    normalizeStory(result);
    return result;
}

function collectSite() {
    return {
        name1: $('name1').value.trim(), name2: $('name2').value.trim(),
        startDate: meetingTime($('couple-start'), $('time-zone').value),
        motto: $('couple-motto').value.trim(), hosts: $('couple-hosts').value.split(/[\s,，]+/).filter(Boolean),
        commentsEnabled: $('comments-enabled').checked
    };
}

function updatePreview() {
    if (!state.snapshot) return;
    const name1 = $('name1').value.trim() || '第一个人', name2 = $('name2').value.trim() || '第二个人';
    $('location1-label').textContent = `${name1} 的地点`;
    $('location2-label').textContent = `${name2} 的地点`;
    $('preview-people').textContent = `${name1} / ${name2}`;
    $('periods-empty').hidden = $('periods').children.length > 0;
    $('meetings-empty').hidden = $('meetings').children.length > 0;
    const enabled = $('enabled').checked;
    $('site-badge').textContent = enabled ? '已开启展示' : '未开启展示';
    $('site-badge').classList.toggle('is-enabled', enabled);
    $('preview-state').textContent = enabled ? '保存后，这些记录会显示在当前情侣的主页。' : '当前未开启展示；保存后记录仍会保留。';
    $('preview-location1').textContent = $('location1').value.trim() || '地点待记录';
    $('preview-location2').textContent = $('location2').value.trim() || '地点待记录';
    $('preview-distance').textContent = $('distance-km').value === '' ? '♡' : `${$('distance-km').value} km`;
    try {
        const story = normalizeStory(collect());
        const today = todayInZone(story.timeZone);
        $('preview-distance-days').textContent = distanceDuration(story.periods)?.days ?? '—';
        $('preview-meeting-days').textContent = meetingDayCount(story.meetings, today);
        $('preview-count').textContent = `${story.meetings.length} 条见面记录 · 重叠日期自动去重`;
    } catch {
        $('preview-distance-days').textContent = '—';
        $('preview-meeting-days').textContent = '—';
        $('preview-count').textContent = '日期填写完整后，自动计算天数。';
    }
}

function markDirty() {
    state.dirty = true;
    $('save-result').hidden = true;
    controls();
    updatePreview();
}

function addRow(kind, record = {}, focus = false) {
    const row = $(`${kind}-template`).content.firstElementChild.cloneNode(true);
    const list = $(kind === 'period' ? 'periods' : 'meetings');
    for (const input of row.querySelectorAll('[data-field]')) {
        const field = input.dataset.field;
        const zone = $('time-zone').value;
        if (kind === 'meeting' && ['startDate', 'endDate'].includes(field)) {
            input.value = localTime(record[field], zone, true);
            input.dataset.originalValue = record[field] || '';
            input.dataset.originalDisplay = input.value;
            input.dataset.originalZone = zone;
        } else input.value = kind === 'period' ? localTime(record[field], zone) : record[field] || '';
    }
    row.querySelector('.remove-record').addEventListener('click', () => { row.remove(); markDirty(); });
    list.append(row);
    if (focus) { markDirty(); row.querySelector('input').focus(); }
}

function applySnapshot(snapshot) {
    state.snapshot = snapshot;
    state.dirty = false;
    $('site-select').replaceChildren(...snapshot.sites.map((site) => new Option(`${site.name1} / ${site.name2}`, site.id)));
    $('site-select').value = snapshot.siteId;
    const site = snapshot.sites.find((site) => site.id === snapshot.siteId);
    $('site-scope').textContent = `仅修改 ${site.name1} / ${site.name2} 的配置`;
    $('location1-label').textContent = `${site.name1} 的地点`;
    $('location2-label').textContent = `${site.name2} 的地点`;
    $('preview-people').textContent = `${site.name1} / ${site.name2}`;
    $('home-link').href = `../?site=${encodeURIComponent(snapshot.siteId)}`;
    $('enabled').checked = snapshot.enabled;
    $('name1').value = snapshot.site.name1;
    $('name2').value = snapshot.site.name2;
    $('couple-start').value = localTime(snapshot.site.startDate, snapshot.data.timeZone, true);
    $('couple-start').dataset.originalValue = snapshot.site.startDate;
    $('couple-start').dataset.originalDisplay = $('couple-start').value;
    $('couple-start').dataset.originalZone = snapshot.data.timeZone;
    $('couple-motto').value = snapshot.site.motto || '';
    $('couple-hosts').value = (snapshot.site.hosts || []).join('\n');
    $('comments-enabled').checked = snapshot.site.commentsEnabled;
    $('page-id-badge').textContent = snapshot.siteId;
    $('location1').value = snapshot.data.locations.person1;
    $('location2').value = snapshot.data.locations.person2;
    $('distance-km').value = snapshot.data.distanceKm ?? '';
    $('time-zone').value = snapshot.data.timeZone;
    $('periods').replaceChildren();
    $('meetings').replaceChildren();
    for (const period of snapshot.data.longDistancePeriods) addRow('period', period);
    for (const meeting of snapshot.data.meetings) addRow('meeting', meeting);
    $('save-result').hidden = true;
    const url = new URL(location.href);
    url.searchParams.set('site', snapshot.siteId);
    history.replaceState(null, '', url);
    document.title = `记录管理 · ${site.name1} / ${site.name2}`;
    $('loading-panel').hidden = true;
    $('login-panel').hidden = true;
    $('workspace').hidden = false;
    commentAdmin.invalidate();
    if (state.tab === 'comments') commentAdmin.load();
    updatePreview();
}

const commentAdmin = createCommentAdmin({ api, currentSite: () => state.snapshot?.siteId, setBusy(value) { state.busy = value; controls(); } });
function setTab(tab) {
    state.tab = tab;
    $('records-panel').hidden = tab !== 'records';
    $('admin-comments-panel').hidden = tab !== 'comments';
    for (const name of ['records', 'comments']) {
        $(`${name}-tab`).classList.toggle('is-active', tab === name);
        $(`${name}-tab`).setAttribute('aria-pressed', String(tab === name));
    }
    if (tab === 'comments') commentAdmin.load();
}
$('records-tab').addEventListener('click', () => setTab('records'));
$('comments-tab').addEventListener('click', () => setTab('comments'));

async function load(site) {
    state.busy = true;
    controls();
    notice();
    try { applySnapshot(await api('config', { site })); }
    catch (error) {
        if (state.snapshot) $('site-select').value = state.snapshot.siteId;
        notice(error.message);
        if (!state.snapshot && $('login-panel').hidden) showLogin();
        if (!state.snapshot) $('retry-button').hidden = false;
    } finally { state.busy = false; controls(); }
}

async function initialize() {
    $('retry-button').disabled = true;
    notice();
    try {
        const session = await api('session');
        state.configured = session.configured;
        state.csrf = session.csrf || '';
        if (session.authenticated) await load(new URLSearchParams(location.search).get('site'));
        else showLogin(!session.configured && session.configurationIssues?.length
            ? `请调整以下 Vercel 环境变量：${session.configurationIssues.join('；')}。保存后重新部署 Production。` : '');
    } catch (error) { state.configured = false; showLogin(error.message); }
    finally { $('retry-button').disabled = false; }
}

$('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    $('login-button').disabled = true;
    $('login-button').textContent = '正在登录…';
    notice();
    try {
        const session = await api('login', { method: 'POST', data: { password: $('password').value } });
        state.csrf = session.csrf;
        $('password').value = '';
        if (state.snapshot && state.dirty) {
            $('login-panel').hidden = true;
            $('workspace').hidden = false;
            notice('已重新登录，可以继续保存刚才的修改。', true);
        } else await load(new URLSearchParams(location.search).get('site'));
    } catch (error) { notice(error.message); }
    finally { $('login-button').disabled = false; $('login-button').textContent = '登录管理后台'; }
});

$('editor-form').addEventListener('input', markDirty);
$('editor-form').addEventListener('change', markDirty);
$('add-period').addEventListener('click', () => addRow('period', {}, true));
$('add-meeting').addEventListener('click', () => addRow('meeting', {}, true));
$('retry-button').addEventListener('click', initialize);
$('site-select').addEventListener('change', () => {
    if (state.dirty && !confirm('当前修改尚未保存。切换情侣会放弃这些修改，是否继续？')) {
        $('site-select').value = state.snapshot.siteId;
        return;
    }
    load($('site-select').value);
});
$('reload-button').addEventListener('click', () => {
    if (state.dirty && !confirm('重新读取会放弃当前尚未保存的修改，是否继续？可以先导出记录备份。')) return;
    load(state.snapshot.siteId);
});
$('logout-button').addEventListener('click', async () => {
    if (state.dirty && !confirm('当前修改尚未保存，确定退出登录吗？')) return;
    try {
        await api('logout', { method: 'POST', data: {} });
        state.csrf = '';
        state.snapshot = null;
        state.dirty = false;
        $('password').value = '';
        showLogin();
        notice('已退出登录。', true);
    } catch (error) { notice(error.message); }
});
$('export-button').addEventListener('click', () => {
    try {
        const data = collect();
        const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `${state.snapshot.siteId}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { notice(error.message); }
});
$('editor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.dirty || state.busy) return;
    let data, site;
    try { data = collect(); site = collectSite(); } catch (error) { notice(error.message); return; }
    state.busy = true;
    controls();
    notice();
    try {
        const result = await api('config', {
            method: 'POST', data: { siteId: state.snapshot.siteId, revision: state.snapshot.revision, enabled: $('enabled').checked, data, site }
        });
        const snapshot = { ...state.snapshot, revision: result.revision, data, site, enabled: $('enabled').checked,
            sites: state.snapshot.sites.map((value) => value.id === state.snapshot.siteId ? { ...value, name1: site.name1, name2: site.name2 } : value) };
        applySnapshot(snapshot);
        const message = result.changed ? '已保存。主页会在本次部署完成后更新，可稍后刷新查看。' : '记录与仓库一致，无需更新。';
        $('save-result').replaceChildren(document.createTextNode(message));
        if (result.commitUrl) {
            const link = document.createElement('a');
            link.textContent = '查看保存记录 ↗';
            link.href = result.commitUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            $('save-result').append(link);
        }
        $('save-result').hidden = false;
    } catch (error) { notice(error.message); }
    finally { state.busy = false; controls(); }
});

for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => {
    if (!state.busy) $(button.dataset.closeDialog).close();
});
for (const dialog of document.querySelectorAll('.site-dialog')) dialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });

$('create-site-button').addEventListener('click', () => {
    if (state.dirty && !confirm('创建后会切换到新的情侣页面，当前未保存的修改将被放弃。是否继续？')) return;
    $('create-site-form').reset(); $('create-site-notice').hidden = true;
    $('new-couple-start').value = DateTime.now().setZone('Asia/Shanghai').toFormat("yyyy-LL-dd'T'HH:mm");
    $('create-site-dialog').showModal();
});
$('create-site-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.busy) return;
    let site;
    try {
        site = { name1: $('new-name1').value.trim(), name2: $('new-name2').value.trim(),
            startDate: instant($('new-couple-start').value, 'Asia/Shanghai', '恋爱开始'), motto: $('new-couple-motto').value.trim(),
            hosts: $('new-couple-hosts').value.split(/[\s,，]+/).filter(Boolean), commentsEnabled: $('new-comments-enabled').checked };
    } catch (error) { $('create-site-notice').textContent = error.message; $('create-site-notice').hidden = false; return; }
    state.busy = true; controls(); $('create-site-fields').disabled = true; $('confirm-create-site').disabled = true; $('create-site-notice').hidden = true;
    try {
        const result = await api('create-site', { method: 'POST', data: { revision: state.snapshot.revision, siteId: $('new-site-id').value.trim(), site, enabled: $('new-relationship-enabled').checked } });
        $('create-site-dialog').close(); setTab('records');
        await load(result.siteId);
        notice('情侣页面已创建。部署完成后，可通过「查看主页」访问。', true);
    } catch (error) { $('create-site-notice').textContent = error.message; $('create-site-notice').hidden = false; }
    finally { state.busy = false; controls(); $('create-site-fields').disabled = false; $('confirm-create-site').disabled = false; }
});

$('delete-site-button').addEventListener('click', () => {
    $('delete-site-form').reset(); $('delete-site-notice').hidden = true;
    $('delete-site-description').textContent = `即将删除 ${state.snapshot.site.name1} / ${state.snapshot.site.name2}（${state.snapshot.siteId}）。`;
    $('delete-site-confirmation').placeholder = state.snapshot.siteId;
    const isDefault = state.snapshot.defaultSite === state.snapshot.siteId;
    $('replacement-default-field').hidden = !isDefault; $('replacement-default').required = isDefault;
    $('replacement-default').replaceChildren(...state.snapshot.sites.filter((site) => site.id !== state.snapshot.siteId).map((site) => new Option(`${site.name1} / ${site.name2}`, site.id)));
    $('delete-site-dialog').showModal();
});
$('delete-site-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (state.busy) return;
    if ($('delete-site-confirmation').value.trim() !== state.snapshot.siteId) {
        $('delete-site-notice').textContent = '页面标识不一致，请检查后再确认。'; $('delete-site-notice').hidden = false; return;
    }
    state.busy = true; controls(); $('delete-site-fields').disabled = true; $('confirm-delete-site').disabled = true; $('delete-site-notice').hidden = true;
    try {
        const result = await api('delete-site', { method: 'POST', data: { siteId: state.snapshot.siteId, revision: state.snapshot.revision, replacementDefault: $('replacement-default').value } });
        $('delete-site-dialog').close(); setTab('records'); await load(result.siteId);
        notice('页面已删除，记录已归档。部署完成后，对应主页将关闭。', true);
    } catch (error) { $('delete-site-notice').textContent = error.message; $('delete-site-notice').hidden = false; }
    finally { state.busy = false; controls(); $('delete-site-fields').disabled = false; $('confirm-delete-site').disabled = false; }
});

window.addEventListener('beforeunload', (event) => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
});

initialize();
