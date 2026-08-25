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
    const testGenMaxTokens  = document.getElementById('testGenMaxTokens');
    const testGenApiBase    = document.getElementById('testGenApiBase');
    const sampleTagsInput      = document.getElementById('sampleTagsInput');
    const sampleBodyPartsInput = document.getElementById('sampleBodyPartsInput');
    const sampleModelInput     = document.getElementById('sampleModelInput');
    const sampleModelGenderInput = document.getElementById('sampleModelGenderInput');

    // Mirrors _BODY_PART_RATING_LABELS in app.py — keep in sync if that ever changes.
    const BODY_PART_RATING_LABELS = { h: 'hidden', c: 'covered', sn: 'semi-nude', n: 'nude' };

    // Mirrors _MODEL_GENDER_PRONOUNS / _MODEL_GENDER_NEUTRAL_PRONOUN in app.py.
    const MODEL_GENDER_PRONOUNS = { female: 'her', male: 'him' };
    const MODEL_GENDER_NEUTRAL_PRONOUN = 'them';

    function buildSampleUserMessage() {
        const tags = sampleTagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
        const bodyParts = sampleBodyPartsInput.value.split(',')
            .map(pair => pair.trim())
            .filter(Boolean)
            .map(pair => {
                const [part, rating] = pair.split(':').map(s => (s || '').trim());
                return { part, rating };
            })
            .filter(({ part, rating }) => part && BODY_PART_RATING_LABELS[rating]);
        const modelName = sampleModelInput.value.trim();
        const modelGender = sampleModelGenderInput ? sampleModelGenderInput.value : 'unspecified';

        const details = [];
        if (tags.length) details.push('Tags: ' + tags.join(', '));
        if (bodyParts.length) {
            details.push('Body details: ' + bodyParts.map(({ part, rating }) => `${part} (${BODY_PART_RATING_LABELS[rating]})`).join(', '));
        }
        if (modelName) {
            details.push('Featured model: ' + modelName);
            if (modelGender in MODEL_GENDER_PRONOUNS) details.push('Subject gender: ' + modelGender);
        }

        return {
            userMessage: 'Write the caption for a photo with these details:\n' + details.join('\n'),
            modelName,
            modelGender,
        };
    }

    let defaultTemplate = '';
    let savedTemplate   = '';
    let currentModel    = '';
    let currentMaxTokens = 500;
    let currentMaxChars = 500;
    let currentApiBase  = 'https://router.huggingface.co/v1/chat/completions';

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
                currentMaxTokens = data.maxTokens;
                currentMaxChars = data.maxChars || 500;
                currentApiBase  = data.apiBase;
                testGenModelName.textContent = currentModel;
                if (testGenMaxTokens) testGenMaxTokens.textContent = currentMaxTokens;
                if (testGenApiBase) testGenApiBase.textContent = currentApiBase;
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

        const { userMessage, modelName, modelGender } = buildSampleUserMessage();
        const pronoun = MODEL_GENDER_PRONOUNS[modelGender] || MODEL_GENDER_NEUTRAL_PRONOUN;
        const nameInstruction = modelName
            ? `Address ${pronoun} directly by name ("${modelName}") in the quote.`
            : "This image has no named model — keep the quote generic, don't invent a name.";
        const systemPrompt = savedTemplate.replace('{name_instruction}', nameInstruction);
        const promptBlock = 'SYSTEM PROMPT:\n' + systemPrompt + '\n\nUSER MESSAGE:\n' + userMessage;

        showTestResult(promptBlock + '\n\nGenerating…', false);
        try {
            const tokenRes  = await fetch('/api/quote-chat-token');
            const tokenData = await tokenRes.json();
            if (!tokenData.token) {
                throw new Error('Chat API token not configured on the server (set QUOTE_CHAT_API_TOKEN or HF_TOKEN).');
            }

            // Same path the real feature takes (cleanup, English-only retry, length
            // trim) so this preview shows what would actually be stored, not the
            // raw completion.
            const quote = await generateQuote({
                token:        tokenData.token,
                model:        currentModel,
                systemPrompt,
                userMessage,
                maxTokens:    currentMaxTokens,
                maxChars:     currentMaxChars,
                apiBase:      currentApiBase,
            });
            showTestResult(promptBlock + '\n\nGENERATED QUOTE:\n"' + quote + '"', false);
        } catch (err) {
            showTestResult(promptBlock + '\n\n✗ ' + err.message, true);
        } finally {
            testGenBtn.disabled = false;
        }
    });

    loadTemplate();
});
