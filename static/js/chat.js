/**
 * Chat Game
 * Pick an image, the AI analyses its tags to build a character description,
 * then you chat with that character via HuggingFace Serverless Inference API.
 */
'use strict';

document.addEventListener('DOMContentLoaded', async () => {
    const COLLECTION = CURRENT_COLLECTION || 'Real';

    // ── DOM ───────────────────────────────────────────────────────────────────
    const imgGrid          = document.getElementById('chatImgGrid');
    const imgCount         = document.getElementById('chatImgCount');
    const charImgEl        = document.getElementById('chatCharImg');
    const charImgWrap      = document.getElementById('chatCharImgWrap');
    const charPlaceholder  = document.getElementById('chatCharPlaceholder');
    const charNameInput    = document.getElementById('chatCharName');
    const charDescEl       = document.getElementById('chatCharDesc');
    const charTagsEl       = document.getElementById('chatCharTags');
    const topbarAvatar     = document.getElementById('chatTopbarAvatar');
    const topbarAvatarWrap = document.getElementById('chatTopbarAvatarWrap');
    const topbarIcon       = document.getElementById('chatTopbarIcon');
    const topbarNameEl     = document.getElementById('chatTopbarName');
    const topbarStatusEl   = document.getElementById('chatTopbarStatus');
    const messagesEl       = document.getElementById('chatMessages');
    const messagesWrap     = document.getElementById('chatMessagesWrap');
    const startHint        = document.getElementById('chatStartHint');
    const typingEl         = document.getElementById('chatTyping');
    const typingNameEl     = document.getElementById('chatTypingName');
    const chatInput        = document.getElementById('chatInput');
    const sendBtn          = document.getElementById('chatSendBtn');
    const clearBtn         = document.getElementById('chatClearBtn');
    const settingsBtn      = document.getElementById('chatSettingsBtn');
    const settingsDrawer   = document.getElementById('chatSettingsDrawer');
    const hfTokenInput     = document.getElementById('chatHfToken');
    const tokenSaveBtn     = document.getElementById('chatTokenSaveBtn');
    const modelSelect      = document.getElementById('chatModel');
    const tempSlider       = document.getElementById('chatTemp');
    const tempValEl        = document.getElementById('chatTempVal');
    const sidebarToggle    = document.getElementById('chatSidebarToggle');
    const sidebar          = document.getElementById('chatSidebar');

    // ── State ─────────────────────────────────────────────────────────────────
    const state = {
        selectedUrl:  null,
        filename:     null,
        systemPrompt: '',
        charName:     'Character',
        messages:     [],   // [{role, content}]
        busy:         false,
    };

    // ── Restore saved settings ────────────────────────────────────────────────
    const savedToken = localStorage.getItem('chat_hf_token');
    if (savedToken) hfTokenInput.value = savedToken;

    const savedModel = localStorage.getItem('chat_model');
    if (savedModel && modelSelect) {
        modelSelect.value = savedModel;
    }

    const savedTemp = localStorage.getItem('chat_temp');
    if (savedTemp && tempSlider) {
        tempSlider.value = savedTemp;
        if (tempValEl) tempValEl.textContent = savedTemp;
    }

    // ── Settings listeners ────────────────────────────────────────────────────
    tokenSaveBtn.addEventListener('click', () => {
        const tok = hfTokenInput.value.trim();
        if (tok) {
            localStorage.setItem('chat_hf_token', tok);
            showToast('Token saved!', 'success');
        } else {
            localStorage.removeItem('chat_hf_token');
            showToast('Token cleared.', 'info');
        }
    });

    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            localStorage.setItem('chat_model', modelSelect.value);
        });
    }

    if (tempSlider) {
        tempSlider.addEventListener('input', () => {
            const v = parseFloat(tempSlider.value).toFixed(2);
            if (tempValEl) tempValEl.textContent = v;
            localStorage.setItem('chat_temp', v);
        });
    }

    settingsBtn.addEventListener('click', () => {
        settingsDrawer.classList.toggle('open');
        settingsBtn.querySelector('i').classList.toggle('fa-cog');
        settingsBtn.querySelector('i').classList.toggle('fa-times');
    });

    if (sidebarToggle) {
        sidebarToggle.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    }

    // ── Load images ───────────────────────────────────────────────────────────
    async function loadImages() {
        try {
            const res  = await fetch(`/api/collections/${COLLECTION}/images`);
            const data = await res.json();
            if (data.success && data.images.length > 0) {
                renderGrid(data.images);
                if (imgCount) imgCount.textContent = `${data.images.length} images`;
            } else {
                imgGrid.innerHTML = '<p class="chat-no-images"><i class="fas fa-image"></i> No images in this collection.</p>';
            }
        } catch (e) {
            imgGrid.innerHTML = '<p class="chat-no-images">Failed to load images.</p>';
        }
    }

    function renderGrid(images) {
        imgGrid.innerHTML = '';
        images.forEach(img => {
            const tile = document.createElement('div');
            tile.className = 'chat-img-tile';
            tile.dataset.filename = img.filename;
            tile.dataset.url      = img.url;
            const imgEl = document.createElement('img');
            imgEl.src     = img.url;
            imgEl.alt     = '';
            imgEl.loading = 'lazy';
            tile.appendChild(imgEl);
            tile.addEventListener('click', () => selectCharacter(img));
            imgGrid.appendChild(tile);
        });
    }

    // ── Select & initialise character ─────────────────────────────────────────
    async function selectCharacter(img) {
        // Mark selected tile
        document.querySelectorAll('.chat-img-tile').forEach(t => t.classList.remove('selected'));
        const tile = imgGrid.querySelector(`[data-filename="${img.filename}"]`);
        if (tile) tile.classList.add('selected');

        // Update character panel immediately with the image
        state.selectedUrl = img.url;
        state.filename    = img.filename;

        charImgEl.src = img.url;
        charImgEl.style.display = 'block';
        charPlaceholder.style.display = 'none';
        charDescEl.textContent = 'Analysing…';
        charTagsEl.innerHTML   = '';

        topbarAvatar.src = img.url;
        topbarAvatar.style.display = 'block';
        topbarIcon.style.display   = 'none';
        topbarStatusEl.textContent = 'Analysing character…';

        // Fetch character analysis from backend
        try {
            const res = await fetch('/api/chat/character', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: COLLECTION,
                    filename:   img.filename,
                    name:       charNameInput.value.trim() || 'Character',
                }),
            });
            const data = await res.json();

            if (!data.success) throw new Error(data.error || 'Failed to analyse');

            state.systemPrompt = data.systemPrompt;
            state.charName     = data.characterName;

            charDescEl.textContent  = data.description || '(no description)';
            topbarNameEl.textContent = state.charName;
            charNameInput.value      = state.charName;

            // Show tags as pills (max 10)
            charTagsEl.innerHTML = (data.tags || []).slice(0, 10)
                .map(t => `<span class="chat-char-tag-pill">${t}</span>`)
                .join('');

            // Reset conversation
            state.messages  = [];
            messagesEl.innerHTML = '';
            startHint.style.display = 'none';

            // Enable input
            chatInput.disabled = false;
            sendBtn.disabled   = false;
            chatInput.focus();

            topbarStatusEl.textContent = 'online';

            // Auto-greeting from character
            await requestGreeting();

        } catch (err) {
            charDescEl.textContent = '⚠ ' + err.message;
            topbarStatusEl.textContent = 'Error';
            showToast(err.message, 'error');
        }
    }

    // Rename triggers a system prompt rebuild
    charNameInput.addEventListener('change', async () => {
        if (!state.filename) return;
        const newName = charNameInput.value.trim() || 'Character';
        try {
            const res = await fetch('/api/chat/character', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    collection: COLLECTION,
                    filename:   state.filename,
                    name:       newName,
                }),
            });
            const data = await res.json();
            if (data.success) {
                state.systemPrompt  = data.systemPrompt;
                state.charName      = data.characterName;
                topbarNameEl.textContent = state.charName;
                showToast(`Character renamed to ${newName}`, 'success');
            }
        } catch {}
    });

    // ── Greeting ──────────────────────────────────────────────────────────────
    async function requestGreeting() {
        setTyping(true);
        try {
            const reply = await callChatApi([], true);
            addBubble('assistant', reply);
        } catch (err) {
            addBubble('assistant', `*smiles* Hello… ${err.message}`);
        } finally {
            setTyping(false);
        }
    }

    // ── Send message ──────────────────────────────────────────────────────────
    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text || state.busy || !state.systemPrompt) return;

        chatInput.value = '';
        autoResizeInput();

        const userMsg = { role: 'user', content: text };
        state.messages.push(userMsg);
        addBubble('user', text);

        state.busy = true;
        chatInput.disabled = true;
        sendBtn.disabled   = true;
        setTyping(true);

        try {
            const reply = await callChatApi(state.messages);
            state.messages.push({ role: 'assistant', content: reply });
            addBubble('assistant', reply);
        } catch (err) {
            addBubble('system', '⚠ ' + err.message);
        } finally {
            state.busy = false;
            chatInput.disabled = false;
            sendBtn.disabled   = false;
            setTyping(false);
            chatInput.focus();
        }
    }

    // ── Call backend → HF API ─────────────────────────────────────────────────
    async function callChatApi(messages, isIntro = false) {
        const hfToken = hfTokenInput.value.trim() || localStorage.getItem('chat_hf_token') || '';
        const model   = modelSelect ? modelSelect.value : 'mistralai/Mistral-7B-Instruct-v0.3';
        const temp    = tempSlider ? parseFloat(tempSlider.value) : 0.92;

        const res = await fetch('/api/chat/send', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages:     messages.slice(-20),   // last 20 for context window
                systemPrompt: state.systemPrompt,
                hfToken:      hfToken,
                model:        model,
                temperature:  temp,
                intro:        isIntro,
            }),
        });

        const data = await res.json();
        if (data.error) throw new Error(data.error);
        return data.reply;
    }

    // ── Render chat bubbles ───────────────────────────────────────────────────
    function addBubble(role, content) {
        const wrap = document.createElement('div');
        wrap.className = `chat-bubble-wrap chat-bubble-${role}`;

        if (role === 'assistant') {
            const avatar = document.createElement('div');
            avatar.className = 'chat-bubble-avatar';
            if (state.selectedUrl) {
                const img = document.createElement('img');
                img.src = state.selectedUrl;
                avatar.appendChild(img);
            } else {
                avatar.innerHTML = '<i class="fas fa-robot"></i>';
            }
            wrap.appendChild(avatar);
        }

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.innerHTML = formatMessage(content);
        wrap.appendChild(bubble);

        if (role === 'user') {
            const ts = document.createElement('span');
            ts.className = 'chat-bubble-ts';
            ts.textContent = now();
            wrap.appendChild(ts);
        }

        messagesEl.appendChild(wrap);
        scrollToBottom();

        // Animate in
        requestAnimationFrame(() => wrap.classList.add('visible'));
    }

    // Light markdown: **bold**, *italic*, line breaks
    function formatMessage(text) {
        return text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
    }

    function now() {
        return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function scrollToBottom() {
        messagesWrap.scrollTop = messagesWrap.scrollHeight;
    }

    // ── Typing indicator ──────────────────────────────────────────────────────
    function setTyping(show) {
        typingEl.style.display = show ? 'flex' : 'none';
        if (show) {
            if (typingNameEl) typingNameEl.textContent = `${state.charName} is typing…`;
            scrollToBottom();
        }
    }

    // ── Auto-resize textarea ──────────────────────────────────────────────────
    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
    }

    chatInput.addEventListener('input', autoResizeInput);

    chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    sendBtn.addEventListener('click', sendMessage);

    // ── Clear conversation ────────────────────────────────────────────────────
    clearBtn.addEventListener('click', () => {
        if (!confirm('Clear this conversation?')) return;
        state.messages   = [];
        messagesEl.innerHTML = '';
        if (state.systemPrompt) {
            startHint.style.display = 'none';
            requestGreeting();
        }
    });

    // ── Toast notifications ───────────────────────────────────────────────────
    function showToast(msg, type = 'info') {
        const t = document.createElement('div');
        t.className = `chat-toast chat-toast-${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 300);
        }, 3000);
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    await loadImages();
});
