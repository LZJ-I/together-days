const $ = (id) => document.getElementById(id);
const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function createCommentAdmin({ api, currentSite, setBusy }) {
    let records = [], sequence = 0;
    function notice(message = '') { $('admin-comments-notice').textContent = message; $('admin-comments-notice').hidden = !message; }
    function render() {
        const active = records.filter((record) => !record.deletedAt).length;
        $('admin-comments-summary').textContent = `${active} 条正在展示 · ${records.length - active} 条已删除`;
        $('admin-comment-count').textContent = active || '';
        const filter = $('comments-filter').value;
        const visible = records.filter((record) => filter === 'all' || (filter === 'deleted' ? !!record.deletedAt : !record.deletedAt));
        $('admin-comments-list').replaceChildren();
        $('admin-comments-empty').hidden = visible.length !== 0;
        $('admin-comments-empty').textContent = filter === 'deleted' ? '没有已删除的评论。' : '这里还没有评论，慢慢等一份祝福。';
        for (const record of visible) {
            const item = document.createElement('article'); item.className = `admin-comment${record.deletedAt ? ' is-deleted' : ''}`; item.dataset.id = record.id;
            const meta = document.createElement('div'); meta.className = 'admin-comment-meta';
            const name = document.createElement('h3'); name.textContent = record.nickname;
            const time = document.createElement('time'); time.dateTime = record.createdAt; time.textContent = formatter.format(new Date(record.createdAt)).replaceAll('/', '.');
            const badge = document.createElement('span'); badge.className = 'admin-comment-badge'; badge.textContent = record.deletedAt ? '已删除' : '正在展示';
            meta.append(name, time, badge);
            const message = document.createElement('p'); message.className = 'admin-comment-message'; message.textContent = record.message;
            const actions = document.createElement('div'); actions.className = 'admin-comment-actions';
            if (!record.deletedAt) {
                const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary small danger-text'; remove.textContent = '删除评论';
                remove.addEventListener('click', () => moderate(record, 'delete')); actions.append(remove);
            }
            if (!record.releasedAt) {
                const release = document.createElement('button'); release.type = 'button'; release.className = 'button ghost small'; release.textContent = '允许再次留言';
                release.addEventListener('click', () => moderate(record, 'release')); actions.append(release);
            } else {
                const released = document.createElement('span'); released.className = 'admin-comment-badge'; released.textContent = '已解除本条留言限制'; actions.append(released);
            }
            item.append(meta, message, actions); $('admin-comments-list').append(item);
        }
    }
    async function load() {
        const site = currentSite(); if (!site) return;
        const requestSequence = ++sequence;
        $('reload-comments').disabled = true; $('admin-comments-empty').hidden = true;
        $('admin-comments-summary').textContent = '正在读取评论…'; notice();
        try {
            const result = await api('comments', { site });
            if (requestSequence !== sequence || site !== currentSite()) return;
            records = result.comments; render();
        } catch (error) {
            if (requestSequence !== sequence || site !== currentSite()) return;
            $('admin-comments-summary').textContent = '评论暂时无法读取';
            $('admin-comments-list').replaceChildren();
            notice(error.message);
        } finally { if (requestSequence === sequence) $('reload-comments').disabled = false; }
    }
    async function moderate(record, operation) {
        const prompt = operation === 'delete' ? `删除「${record.nickname}」的这条评论？主页将不再展示，仍保留一次留言限制。` : `允许「${record.nickname}」使用这条评论对应的浏览器或网络再次留言？`;
        if (!confirm(prompt)) return;
        const siteId = currentSite();
        setBusy(true); notice();
        for (const button of $('admin-comments-list').querySelectorAll('button')) button.disabled = true;
        try {
            await api('comments', { method: 'POST', data: { siteId, id: record.id, operation } });
            await load();
        } catch (error) { notice(error.message); }
        finally { setBusy(false); for (const button of $('admin-comments-list').querySelectorAll('button')) button.disabled = false; }
    }
    $('reload-comments').addEventListener('click', load);
    $('comments-filter').addEventListener('change', render);
    return { load, invalidate() { sequence++; records = []; $('admin-comment-count').textContent = ''; $('admin-comments-list').replaceChildren(); } };
}
