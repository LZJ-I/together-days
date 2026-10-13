const input = document.getElementById('generated-comment-key');
const generate = document.getElementById('generate-comment-key');
const copy = document.getElementById('copy-comment-key');
const status = document.getElementById('comment-key-status');
generate.addEventListener('click', () => {
    if (input.value && !confirm('这里只生成新密钥。已有评论时，请继续使用原来的密钥。是否重新生成？')) return;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    input.value = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    copy.disabled = false;
    status.textContent = '已在当前浏览器生成，请备份后填入 Vercel 的 COMMENT_ENCRYPTION_KEY。';
});
copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(input.value); status.textContent = '已复制，请备份后填入 Vercel。'; }
    catch { input.focus(); input.select(); status.textContent = '请复制选中的密钥，再填入 Vercel。'; }
});
