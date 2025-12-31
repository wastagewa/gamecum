// Character Chatbot Game Logic
document.addEventListener('DOMContentLoaded', () => {
    const characterImage = document.getElementById('characterImage');
    const characterName = document.getElementById('characterName');
    const characterNameEdit = document.getElementById('characterNameEdit');
    const characterNameInput = document.getElementById('characterNameInput');
    const nameEditBtn = document.getElementById('nameEditBtn');
    const nameSaveBtn = document.getElementById('nameSaveBtn');
    const nameEditCancelBtn = document.getElementById('nameEditCancelBtn');
    const characterSelector = document.getElementById('characterSelector');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const contextInput = document.getElementById('contextInput');
    const sendBtn = document.getElementById('sendBtn');
    const clearChatBtn = document.getElementById('clearChatBtn');
    const backBtn = document.getElementById('backBtn');

    let currentCharacterId = 0;
    let currentCharacterFilename = '';
    let isLoading = false;

    // Initialize character selector
    function initializeCharacters() {
        characterSelector.innerHTML = '';
        CHATBOT_IMAGES.forEach((imageData, index) => {
            const thumb = document.createElement('img');
            thumb.src = imageData.url;
            thumb.alt = imageData.name;
            thumb.className = 'char-thumb';
            if (index === 0) thumb.classList.add('active');
            thumb.title = imageData.name;
            thumb.addEventListener('click', () => selectCharacter(index));
            characterSelector.appendChild(thumb);
        });
        selectCharacter(0);
    }

    // Select a character
    function selectCharacter(index) {
        currentCharacterId = index;
        const imageData = CHATBOT_IMAGES[index];
        currentCharacterFilename = imageData.filename;
        
        characterImage.src = imageData.url;
        characterName.textContent = imageData.name;
        characterNameInput.value = imageData.name;
        
        // Update active thumbnail
        document.querySelectorAll('.char-thumb').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === index);
        });

        // Clear chat when switching characters
        chatMessages.innerHTML = '';
        addMessage(`Hello! I'm ${imageData.name}. What would you like to talk about?`, 'bot');
        
        // Hide edit UI
        characterNameEdit.style.display = 'none';
        nameEditBtn.style.display = 'block';
    }

    // Add message to chat
    function addMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = text;
        
        messageDiv.appendChild(bubble);
        chatMessages.appendChild(messageDiv);
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Edit character name
    nameEditBtn.addEventListener('click', () => {
        nameEditBtn.style.display = 'none';
        characterNameEdit.style.display = 'flex';
        characterNameInput.focus();
        characterNameInput.select();
    });

    // Save character name
    async function saveCharacterName() {
        const newName = characterNameInput.value.trim();
        if (!newName) {
            characterNameInput.value = CHATBOT_IMAGES[currentCharacterId].name;
            return;
        }

        try {
            const response = await fetch('/api/chatbot/update-name', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    collection: CURRENT_COLLECTION,
                    filename: currentCharacterFilename,
                    name: newName
                })
            });

            const data = await response.json();
            if (response.ok && data.success) {
                CHATBOT_IMAGES[currentCharacterId].name = data.name;
                characterName.textContent = data.name;
                document.querySelectorAll('.char-thumb')[currentCharacterId].title = data.name;
                characterNameEdit.style.display = 'none';
                nameEditBtn.style.display = 'block';
                addMessage(`I'll now be known as ${data.name}!`, 'bot');
            } else {
                alert('Error saving name: ' + (data.error || 'Unknown error'));
            }
        } catch (error) {
            alert('Error: ' + error.message);
        }
    }

    nameSaveBtn.addEventListener('click', saveCharacterName);
    nameEditCancelBtn.addEventListener('click', () => {
        characterNameEdit.style.display = 'none';
        nameEditBtn.style.display = 'block';
    });

    characterNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveCharacterName();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            nameEditCancelBtn.click();
        }
    });

    // Send message
    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text || isLoading) return;

        // Add user message
        addMessage(text, 'user');
        chatInput.value = '';

        // Show loading
        isLoading = true;
        sendBtn.disabled = true;
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'loading';
        loadingDiv.innerHTML = '<div class="spinner"></div> Character is thinking...';
        chatMessages.appendChild(loadingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;

        try {
            const response = await fetch('/api/chatbot/message', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: text,
                    image_index: currentCharacterId,
                    collection: CURRENT_COLLECTION,
                    context: contextInput.value.trim()
                })
            });

            const data = await response.json();
            loadingDiv.remove();

            if (response.ok && data.success) {
                addMessage(data.reply, 'bot');
            } else {
                addMessage('Sorry, I couldn\'t respond. ' + (data.error || 'Please try again.'), 'bot');
            }
        } catch (error) {
            loadingDiv.remove();
            addMessage('Error: ' + error.message, 'bot');
        } finally {
            isLoading = false;
            sendBtn.disabled = false;
            chatInput.focus();
        }
    }

    // Event listeners for chat
    sendBtn.addEventListener('click', sendMessage);
    
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            if (e.shiftKey) {
                // Shift+Enter: add new line
                return; // Default behavior
            } else {
                // Enter: send message
                e.preventDefault();
                if (!isLoading) {
                    sendMessage();
                }
            }
        }
    });

    clearChatBtn.addEventListener('click', () => {
        chatMessages.innerHTML = '';
        addMessage('Chat cleared! Let\'s start fresh.', 'bot');
    });

    backBtn.addEventListener('click', () => {
        window.location.href = `/collection/${CURRENT_COLLECTION}`;
    });

    // Initialize
    initializeCharacters();
});
