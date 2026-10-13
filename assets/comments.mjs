export async function mountComments(couple) {
    const $ = (id) => document.getElementById(id);
    const state = { csrf: '', busy: false, next: null, canPost: false };
    const formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

    function notice(message = '') { $('comment-notice').textContent = message; $('comment-notice').hidden = !message; }
    function controls() {
        $('comment-fields').disabled = state.busy || !state.canPost;
        $('comments-refresh').disabled = state.busy;
        $('comments-more').disabled = state.busy;
        const length = [...$('comment-message').value].length;
        $('comment-character-count').textContent = `${length} / 300`;
        $('comment-character-count').classList.toggle('is-over-limit', length > 300);
        $('comment-submit').disabled = state.busy || !state.canPost || length > 300;
        $('comment-submit').textContent = state.busy ? '正在送达…' : '留下祝福 ↗';
    }
    function eligibility(canPost, reason, justPosted = false) {
        state.canPost = canPost;
        $('comment-form').hidden = !canPost;
        $('comment-thanks').hidden = canPost;
        $('comment-thanks-title').textContent = !justPosted && reason === 'ip' ? '这里已经收到一份祝福' : '你的祝福已送达';
        $('comment-thanks-note').textContent = !justPosted && reason === 'ip' ? '每个网络可以留下一次祝福。谢谢你的心意。' : '谢谢你，让这段故事多了一份温柔。';
    }
    function render(record, prepend = false) {
        if ([...$('comments-list').children].some((child) => child.dataset.id === record.id)) return;
        const item = document.createElement('article'); item.className = 'comment-item'; item.dataset.id = record.id;
        const avatar = document.createElement('span'); avatar.className = 'comment-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = [...record.nickname][0];
        const content = document.createElement('div'); content.className = 'comment-item-content';
        const meta = document.createElement('div'); meta.className = 'comment-item-meta';
        const name = document.createElement('h4'); name.textContent = record.nickname;
        const time = document.createElement('time'); time.dateTime = record.createdAt; time.textContent = formatter.format(new Date(record.createdAt)).replaceAll('/', '.');
        const message = document.createElement('p'); message.className = 'comment-item-message'; message.textContent = record.message;
        meta.append(name, time); content.append(meta, message); item.append(avatar, content);
        if (prepend) $('comments-list').prepend(item); else $('comments-list').append(item);
    }
    async function request({ method = 'GET', data, before } = {}) {
        const query = new URLSearchParams({ site: couple.siteId });
        if (before) query.set('before', before);
        const response = await fetch(`/api/comments?${query}`, {
            method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(60000),
            ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf }, body: JSON.stringify(data) } : {})
        });
        const result = await response.json();
        if (!response.ok) { const error = new Error(result.error); error.status = response.status; throw error; }
        return result;
    }
    async function load(more = false) {
        if (state.busy) return;
        state.busy = true; controls(); notice();
        try {
            const result = await request({ before: more ? state.next : null });
            state.csrf = result.csrf; state.next = result.next;
            if (!more) $('comments-list').replaceChildren();
            for (const comment of result.comments) render(comment);
            $('comment-total').textContent = result.total;
            $('comments-empty').hidden = result.total !== 0;
            $('comments-more').hidden = !state.next;
            eligibility(result.canPost, result.reason);
        } catch {
            notice('留言暂时没有加载成功，稍后再来看看吧。');
            if (!state.csrf) { $('comment-form').hidden = true; $('comment-thanks').hidden = true; }
        } finally { $('comments-loading').hidden = true; state.busy = false; controls(); }
    }

    $('comment-message').addEventListener('input', controls);
    $('comments-refresh').addEventListener('click', () => load());
    $('comments-more').addEventListener('click', () => load(true));
    $('comment-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (state.busy || !state.canPost) return;
        if ([...$('comment-message').value.trim()].length > 300) { notice('祝福最多填写 300 个字。'); return; }
        state.busy = true; controls(); notice();
        try {
            const result = await request({ method: 'POST', data: { nickname: $('comment-nickname').value, message: $('comment-message').value, website: $('comment-website').value } });
            render(result.comment, true);
            $('comment-total').textContent = Number($('comment-total').textContent) + 1;
            $('comments-empty').hidden = true;
            eligibility(false, 'device', true);
            $('comment-message').value = '';
        } catch (error) {
            notice([400, 409].includes(error.status) ? error.message : '祝福暂时没有送达，文字已为你保留，请稍后重试。');
            if (error.status === 409 && error.message.includes('祝福啦')) eligibility(false, error.message.includes('网络') ? 'ip' : 'device');
        } finally { state.busy = false; controls(); }
    });
    await load();
}
