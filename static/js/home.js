// home.js - handle creating new collections on the home page
document.addEventListener('DOMContentLoaded', () => {
    const formBtn = document.getElementById('createCollectionBtn');
    const nameInput = document.getElementById('newCollectionName');
    const msg = document.getElementById('createMsg');
    const list = document.getElementById('collectionsList');

    function setMsg(text, isError = true) {
        if (!msg) return;
        msg.textContent = text;
        msg.style.color = isError ? '#c0392b' : '#16a085';
    }

    function createCard(name) {
        const wrap = document.createElement('div');
        wrap.className = 'collection-card';
        wrap.style.background = 'var(--surface-color)';
        wrap.style.padding = '14px';
        wrap.style.borderRadius = '14px';
        wrap.style.boxShadow = '0 8px 24px var(--shadow-color)';
        wrap.style.minWidth = '180px';
        wrap.style.border = '1px solid rgba(255,255,255,0.08)';
        wrap.innerHTML = `
            <div style="font-weight:700;color:var(--text-color);">${name}</div>
            <div style="color:var(--muted-text);margin-top:6px;">Images: <strong style="color:var(--text-color);">0</strong></div>
            <div style="color:var(--muted-text);margin-top:4px;">Best: <em>—</em><br><small style="opacity:0;">by —</small></div>
            <div style="margin-top:8px;display:flex;gap:8px;">
                <a class="custom-upload-btn" href="/collection/${encodeURIComponent(name)}">View</a>
                <a class="custom-upload-btn" href="/collection/${encodeURIComponent(name)}/game">Play</a>
            </div>`;
        return wrap;
    }

    if (formBtn && nameInput) {
        formBtn.addEventListener('click', async () => {
            const raw = nameInput.value.trim();
            if (!raw) return setMsg('Collection name required');
            if (!/^[A-Za-z0-9_-]+$/.test(raw)) return setMsg('Invalid characters. Use A-Za-z0-9_- only');
            try {
                formBtn.disabled = true;
                setMsg('Creating...', false);
                const res = await fetch('/create-collection', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: raw })
                });
                const data = await res.json();
                if (data && data.success) {
                    setMsg('Collection created', false);
                    nameInput.value = '';
                    if (list) list.appendChild(createCard(data.name));
                } else {
                    setMsg(data.error || 'Failed to create collection');
                }
            } catch (err) {
                console.error('create collection error', err);
                setMsg('Error creating collection');
            } finally { formBtn.disabled = false; }
        });
    }
});
