// Manage AI Quote Prompt JavaScript
document.addEventListener('DOMContentLoaded', () => {
    const templateInput = document.getElementById('promptTemplateInput');
    const charCount     = document.getElementById('promptCharCount');
    const message       = document.getElementById('promptMessage');
    const saveBtn       = document.getElementById('savePromptBtn');
    const resetBtn      = document.getElementById('resetPromptBtn');
    const testGenBtn    = document.getElementById('testGenBtn');
    const testGenResult = document.getElementById('testGenResult');
    const testGenModelName = document.getElementById('testGenModelName');

    let defaultTemplate = '';
    let savedTemplate   = '';
    let currentModel    = '';

    testGenBtn.disabled = true;  // re-enabled once loadTemplate() resolves below

    function updateCharCount() {
        const len = templateInput.value.length;
        charCount.textContent = len;
        charCount.parentElement.classList.toggle('over-limit', len > 4000);
    }

    function showMessage(text, isError) {
        message.textContent = text;
        message.className = 'message ' + (isError ? 'error' : 'success');
    }

    async function loadTemplate() {
        try {
            const res = await fetch('/api/settings/ai-quote-prompt');
            const data = await res.json();
            if (data.success) {
                templateInput.value = data.template;
                defaultTemplate = data.default;
                savedTemplate   = data.template;
                currentModel    = data.model;
                testGenModelName.textContent = currentModel;
                updateCharCount();
                testGenBtn.disabled = false;
            } else {
                showMessage(data.error || 'Failed to load prompt', true);
            }
        } catch (err) {
            showMessage('Error loading prompt', true);
        }
    }

    templateInput.addEventListener('input', updateCharCount);

    saveBtn.addEventListener('click', async () => {
        const template = templateInput.value.trim();
        if (!template) {
            showMessage('Template cannot be empty', true);
            return;
        }
        if (!template.includes('{name_instruction}')) {
            showMessage('Template must include the {name_instruction} placeholder', true);
            return;
        }
        saveBtn.disabled = true;
        try {
            const res = await fetch('/api/settings/ai-quote-prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template }),
            });
            const data = await res.json();
            if (data.success) {
                savedTemplate = data.template;
                showMessage('Prompt saved — new quotes will use this from now on.', false);
            } else {
                showMessage(data.error || 'Failed to save prompt', true);
            }
        } catch (err) {
            showMessage('Error saving prompt', true);
        } finally {
            saveBtn.disabled = false;
        }
    });

    resetBtn.addEventListener('click', () => {
        if (!defaultTemplate) return;
        templateInput.value = defaultTemplate;
        updateCharCount();
        showMessage('Reset in the editor — click Save to apply.', false);
    });

    function showTestResult(text, isError) {
        testGenResult.style.display = 'block';
        testGenResult.textContent = text;
        testGenResult.className = 'test-gen-result ' + (isError ? 'error' : 'success');
    }

    testGenBtn.addEventListener('click', async () => {
        testGenBtn.disabled = true;
        showTestResult('Generating…', false);
        try {
            const tokenRes  = await fetch('/api/chat/token');
            const tokenData = await tokenRes.json();
            if (!tokenData.token) {
                throw new Error('HuggingFace token not configured on the server (HF_TOKEN is empty).');
            }

            const nameInstruction = 'Address her directly by name ("Test Model") in the quote.';
            const systemPrompt = savedTemplate.replace('{name_instruction}', nameInstruction);
            const userMessage =
                'Write the caption for a photo with these details:\n' +
                'Tags: outdoor, smiling\nBody details: chest (nude)\nFeatured model: Test Model';

            const quote = await callHuggingFaceChat({
                token:        tokenData.token,
                model:        currentModel,
                systemPrompt,
                userMessage,
            });
            showTestResult('✓ Success — the model generated:\n\n"' + quote + '"', false);
        } catch (err) {
            showTestResult('✗ ' + err.message, true);
        } finally {
            testGenBtn.disabled = false;
        }
    });

    loadTemplate();
});
