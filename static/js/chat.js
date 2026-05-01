document.addEventListener('DOMContentLoaded', () => {
    const collectionSelect = document.getElementById('chatCollectionSelect');
    const imageGrid = document.getElementById('chatImageGrid');
    const preview = document.getElementById('chatPreview');
    const analyzeBtn = document.getElementById('chatAnalyzeBtn');
    const descriptionEl = document.getElementById('chatDescription');
    const statusEl = document.getElementById('chatStatus');
    const threadEl = document.getElementById('chatThread');
    const userInput = document.getElementById('chatUserInput');
    const sendBtn = document.getElementById('chatSendBtn');

    const state = {
        collections: {},
        selectedCollection: window.CURRENT_COLLECTION || 'Real',
        selectedImage: '',
        imageDescription: '',
        chatHistory: ''
    };

    function setStatus(text, isError = false) {
        statusEl.textContent = text;
        statusEl.style.color = isError ? '#ff6b81' : 'var(--muted-text)';
    }

    function setBusy(isBusy, text) {
        analyzeBtn.disabled = isBusy || !state.selectedImage;
        sendBtn.disabled = isBusy || !state.imageDescription;
        userInput.disabled = isBusy || !state.imageDescription;
        if (text !== undefined) {
            setStatus(text);
        }
    }

    function appendBubble(role, text) {
        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${role}`;
        bubble.textContent = text;
        threadEl.appendChild(bubble);
        threadEl.scrollTop = threadEl.scrollHeight;
    }

    function resetConversation() {
        state.imageDescription = '';
        state.chatHistory = '';
        descriptionEl.textContent = 'Analyze the selected image to generate a description.';
        threadEl.innerHTML = '';
        userInput.value = '';
        userInput.disabled = true;
        sendBtn.disabled = true;
    }

    function renderCollections() {
        collectionSelect.innerHTML = '';
        Object.keys(state.collections).sort().forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = `${name} (${state.collections[name].length})`;
            collectionSelect.appendChild(option);
        });

        if (!state.collections[state.selectedCollection]) {
            state.selectedCollection = Object.keys(state.collections)[0] || '';
        }
        collectionSelect.value = state.selectedCollection;
        renderImages();
    }

    function renderImages() {
        const images = state.collections[state.selectedCollection] || [];
        imageGrid.innerHTML = '';
        state.selectedImage = images[0] || '';

        images.forEach((imageUrl) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'chat-thumb';
            button.innerHTML = `<img src="${imageUrl}" alt="Collection image">`;
            button.addEventListener('click', () => selectImage(imageUrl, button));
            imageGrid.appendChild(button);
        });

        const first = imageGrid.querySelector('.chat-thumb');
        if (first && state.selectedImage) {
            first.classList.add('active');
        }
        updatePreview();
        resetConversation();
        setBusy(false, images.length ? '' : 'No images in this collection.');
    }

    function selectImage(imageUrl, button) {
        state.selectedImage = imageUrl;
        imageGrid.querySelectorAll('.chat-thumb').forEach((thumb) => thumb.classList.remove('active'));
        button.classList.add('active');
        updatePreview();
        resetConversation();
        setBusy(false, '');
    }

    function updatePreview() {
        if (!state.selectedImage) {
            preview.innerHTML = '';
            analyzeBtn.disabled = true;
            return;
        }
        preview.innerHTML = `<img src="${state.selectedImage}" alt="Selected image">`;
        analyzeBtn.disabled = false;
    }

    async function postJson(url, payload) {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
            throw new Error(data.error || 'Request failed');
        }
        return data;
    }

    async function generateInitialReply() {
        setBusy(true, 'Generating first chat response...');
        const data = await postJson('/api/chat/reply', {
            imageDescription: state.imageDescription,
            chatHistory: state.chatHistory
        });
        state.chatHistory += `\nAssistant: ${data.reply}`;
        appendBubble('assistant', data.reply);
        setBusy(false, '');
    }

    async function analyzeSelectedImage() {
        if (!state.selectedImage) return;

        try {
            resetConversation();
            setBusy(true, 'Analyzing image...');
            const data = await postJson('/api/chat/describe', {
                imageUrl: state.selectedImage
            });
            state.imageDescription = data.description;
            state.chatHistory = 'User: (looking at you)';
            descriptionEl.textContent = data.description;
            await generateInitialReply();
        } catch (err) {
            setBusy(false, '');
            setStatus(err.message, true);
        }
    }

    async function sendMessage() {
        const message = userInput.value.trim();
        if (!message || !state.imageDescription) return;

        appendBubble('user', message);
        state.chatHistory += `\nUser: ${message}`;
        userInput.value = '';

        try {
            setBusy(true, 'Generating reply...');
            const data = await postJson('/api/chat/reply', {
                imageDescription: state.imageDescription,
                chatHistory: state.chatHistory
            });
            state.chatHistory += `\nAssistant: ${data.reply}`;
            appendBubble('assistant', data.reply);
            setBusy(false, '');
        } catch (err) {
            setBusy(false, '');
            setStatus(err.message, true);
        }
    }

    async function loadCollections() {
        try {
            setStatus('Loading collections...');
            const response = await fetch('/api/collections');
            const data = await response.json();
            state.collections = data.collections || {};
            renderCollections();
            setStatus('');
        } catch (err) {
            setStatus('Failed to load collections.', true);
        }
    }

    collectionSelect.addEventListener('change', (event) => {
        state.selectedCollection = event.target.value;
        renderImages();
    });
    analyzeBtn.addEventListener('click', analyzeSelectedImage);
    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    loadCollections();
});
