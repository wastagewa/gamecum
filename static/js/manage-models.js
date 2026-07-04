// Manage Models JavaScript
document.addEventListener('DOMContentLoaded', () => {
    const createBtn = document.getElementById('createModelBtn');
    const createModal = document.getElementById('createModelModal');
    const renameModal = document.getElementById('renameModelModal');
    const deleteModal = document.getElementById('deleteModelModal');

    const newModelInput = document.getElementById('newModelName');
    const newModelGenderInput = document.getElementById('newModelGender');
    const createMessage = document.getElementById('createModelMessage');
    const confirmCreate = document.getElementById('confirmCreateModel');

    const renameOldNameInput = document.getElementById('renameModelOldName');
    const renameNewNameInput = document.getElementById('renameModelNewName');
    const renameMessage = document.getElementById('renameModelMessage');
    const confirmRename = document.getElementById('confirmRenameModel');

    const deleteModelNameSpan = document.getElementById('deleteModelName');
    const deleteMessage = document.getElementById('deleteModelMessage');
    const confirmDelete = document.getElementById('confirmDeleteModel');

    const modelSearchInput = document.getElementById('modelSearchInput');
    const modelsTableBody = document.getElementById('modelsTableBody');
    const emptyModelsMsg = document.getElementById('emptyModelsMsg');

    let currentModelId = null;

    function showModal(modal) {
        if (!modal) return;
        modal.style.display = 'flex';
        modal.classList.add('show');
        modal.offsetHeight;
        document.body.style.overflow = 'hidden';
    }

    function hideModal(modal) {
        if (!modal) return;
        modal.classList.remove('show');
        setTimeout(() => {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }, 300);
    }

    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => hideModal(btn.closest('.modal')));
    });

    if (createBtn) {
        createBtn.addEventListener('click', () => {
            newModelInput.value = '';
            if (newModelGenderInput) newModelGenderInput.value = 'unspecified';
            createMessage.textContent = '';
            showModal(createModal);
            newModelInput.focus();
        });
    }

    if (confirmCreate) {
        confirmCreate.addEventListener('click', async () => {
            const name = newModelInput.value.trim();
            const gender = newModelGenderInput ? newModelGenderInput.value : 'unspecified';
            if (!name) {
                createMessage.textContent = 'Please enter a model name';
                createMessage.className = 'message error';
                return;
            }
            try {
                const res = await fetch('/api/models', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, gender })
                });
                const data = await res.json();
                if (data.success) {
                    createMessage.textContent = 'Model added successfully!';
                    createMessage.className = 'message success';
                    setTimeout(() => window.location.reload(), 800);
                } else {
                    createMessage.textContent = data.error || 'Failed to add model';
                    createMessage.className = 'message error';
                }
            } catch (err) {
                createMessage.textContent = 'Error adding model';
                createMessage.className = 'message error';
            }
        });
    }

    if (newModelInput) {
        newModelInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') confirmCreate.click();
        });
    }

    function wireRowActions() {
        document.querySelectorAll('.model-rename-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                currentModelId = btn.dataset.id;
                renameOldNameInput.value = btn.dataset.name;
                renameNewNameInput.value = btn.dataset.name;
                renameMessage.textContent = '';
                showModal(renameModal);
                renameNewNameInput.focus();
                renameNewNameInput.select();
            });
        });

        document.querySelectorAll('.model-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                currentModelId = btn.dataset.id;
                deleteModelNameSpan.textContent = btn.dataset.name;
                deleteMessage.textContent = '';
                showModal(deleteModal);
            });
        });

        document.querySelectorAll('.model-gender-select').forEach(select => {
            select.addEventListener('change', async () => {
                const statusEl = select.nextElementSibling;
                const gender = select.value;
                select.disabled = true;
                try {
                    const res = await fetch(`/api/models/${select.dataset.id}/gender`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ gender })
                    });
                    const data = await res.json();
                    if (statusEl) {
                        statusEl.textContent = data.success ? 'Saved' : (data.error || 'Failed to save');
                        statusEl.className = 'model-gender-status' + (data.success ? '' : ' error');
                        setTimeout(() => { statusEl.textContent = ''; }, 2000);
                    }
                } catch (err) {
                    if (statusEl) {
                        statusEl.textContent = 'Error saving';
                        statusEl.className = 'model-gender-status error';
                    }
                } finally {
                    select.disabled = false;
                }
            });
        });
    }
    wireRowActions();

    if (confirmRename) {
        confirmRename.addEventListener('click', async () => {
            const newName = renameNewNameInput.value.trim();
            if (!newName) {
                renameMessage.textContent = 'Please enter a new name';
                renameMessage.className = 'message error';
                return;
            }
            try {
                const res = await fetch(`/api/models/${currentModelId}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: newName })
                });
                const data = await res.json();
                if (data.success) {
                    renameMessage.textContent = 'Model renamed successfully!';
                    renameMessage.className = 'message success';
                    setTimeout(() => window.location.reload(), 800);
                } else {
                    renameMessage.textContent = data.error || 'Failed to rename model';
                    renameMessage.className = 'message error';
                }
            } catch (err) {
                renameMessage.textContent = 'Error renaming model';
                renameMessage.className = 'message error';
            }
        });
    }

    if (confirmDelete) {
        confirmDelete.addEventListener('click', async () => {
            try {
                const res = await fetch(`/api/models/${currentModelId}/delete`, { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    deleteMessage.textContent = 'Model deleted successfully!';
                    deleteMessage.className = 'message success';
                    setTimeout(() => window.location.reload(), 800);
                } else {
                    deleteMessage.textContent = data.error || 'Failed to delete model';
                    deleteMessage.className = 'message error';
                }
            } catch (err) {
                deleteMessage.textContent = 'Error deleting model';
                deleteMessage.className = 'message error';
            }
        });
    }

    const emptyModelsText = document.getElementById('emptyModelsText');
    if (modelSearchInput) {
        modelSearchInput.addEventListener('input', () => {
            const term = modelSearchInput.value.trim().toLowerCase();
            let visibleCount = 0;
            document.querySelectorAll('#modelsTableBody tr').forEach(row => {
                const match = row.dataset.modelName.toLowerCase().includes(term);
                row.style.display = match ? '' : 'none';
                if (match) visibleCount++;
            });
            if (emptyModelsMsg && emptyModelsText) {
                emptyModelsMsg.style.display = (visibleCount === 0) ? '' : 'none';
                emptyModelsText.textContent = (visibleCount === 0 && term)
                    ? `No models match "${modelSearchInput.value.trim()}"`
                    : 'No models yet. Add one to start tagging images by subject/person name.';
            }
        });
    }
});
