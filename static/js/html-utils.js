// html-utils.js — shared HTML-escaping helper for content built from user/admin-entered
// strings (tags, model names, filenames) before it's inserted via innerHTML.
function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return String(text).replace(/[&<>"']/g, m => map[m]);
}
