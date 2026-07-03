// Manage AI Quote Prompt JavaScript
document.addEventListener('DOMContentLoaded', () => {
    const templateInput = document.getElementById('promptTemplateInput');
    const charCount     = document.getElementById('promptCharCount');
    const message       = document.getElementById('promptMessage');
    const saveBtn       = document.getElementById('savePromptBtn');
    const resetBtn      = document.getElementById('resetPromptBtn');

    let defaultTemplate = '';

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
                updateCharCount();
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

    loadTemplate();
});
