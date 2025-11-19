// Manage Collections JavaScript
document.addEventListener('DOMContentLoaded', () => {
    const createBtn = document.getElementById('createCollectionBtn');
    const createModal = document.getElementById('createModal');
    const renameModal = document.getElementById('renameModal');
    const deleteModal = document.getElementById('deleteModal');
    
    const newCollectionInput = document.getElementById('newCollectionName');
    const createMessage = document.getElementById('createMessage');
    const confirmCreate = document.getElementById('confirmCreate');
    
    const renameOldNameInput = document.getElementById('renameOldName');
    const renameNewNameInput = document.getElementById('renameNewName');
    const renameMessage = document.getElementById('renameMessage');
    const confirmRename = document.getElementById('confirmRename');
    
    const deleteCollectionNameSpan = document.getElementById('deleteCollectionName');
    const deleteMessage = document.getElementById('deleteMessage');
    const confirmDelete = document.getElementById('confirmDelete');
    
    let currentCollection = '';

    // Show/hide modals
    function showModal(modal) {
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('show'), 10);
    }

    function hideModal(modal) {
        modal.classList.remove('show');
        setTimeout(() => modal.style.display = 'none', 300);
    }

    // Create collection
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            newCollectionInput.value = '';
            createMessage.textContent = '';
            showModal(createModal);
            newCollectionInput.focus();
        });
    }

    if (confirmCreate) {
        confirmCreate.addEventListener('click', async () => {
            const name = newCollectionInput.value.trim();
            if (!name) {
                createMessage.textContent = 'Please enter a collection name';
                createMessage.className = 'message error';
                return;
            }

            try {
                const res = await fetch('/api/collections/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name })
                });
                const data = await res.json();

                if (data.success) {
                    createMessage.textContent = 'Collection created successfully!';
                    createMessage.className = 'message success';
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    createMessage.textContent = data.error || 'Failed to create collection';
                    createMessage.className = 'message error';
                }
            } catch (err) {
                createMessage.textContent = 'Error creating collection';
                createMessage.className = 'message error';
            }
        });
    }

    // Rename collection
    document.querySelectorAll('.rename-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentCollection = btn.dataset.collection;
            renameOldNameInput.value = currentCollection;
            renameNewNameInput.value = '';
            renameMessage.textContent = '';
            showModal(renameModal);
            renameNewNameInput.focus();
        });
    });

    if (confirmRename) {
        confirmRename.addEventListener('click', async () => {
            const newName = renameNewNameInput.value.trim();
            if (!newName) {
                renameMessage.textContent = 'Please enter a new name';
                renameMessage.className = 'message error';
                return;
            }

            try {
                const res = await fetch('/api/collections/rename', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ old_name: currentCollection, new_name: newName })
                });
                const data = await res.json();

                if (data.success) {
                    renameMessage.textContent = 'Collection renamed successfully!';
                    renameMessage.className = 'message success';
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    renameMessage.textContent = data.error || 'Failed to rename collection';
                    renameMessage.className = 'message error';
                }
            } catch (err) {
                renameMessage.textContent = 'Error renaming collection';
                renameMessage.className = 'message error';
            }
        });
    }

    // Delete collection
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentCollection = btn.dataset.collection;
            deleteCollectionNameSpan.textContent = currentCollection;
            deleteMessage.textContent = '';
            showModal(deleteModal);
        });
    });

    if (confirmDelete) {
        confirmDelete.addEventListener('click', async () => {
            try {
                const res = await fetch('/api/collections/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: currentCollection })
                });
                const data = await res.json();

                if (data.success) {
                    deleteMessage.textContent = 'Collection deleted successfully!';
                    deleteMessage.className = 'message success';
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                } else {
                    deleteMessage.textContent = data.error || 'Failed to delete collection';
                    deleteMessage.className = 'message error';
                }
            } catch (err) {
                deleteMessage.textContent = 'Error deleting collection';
                deleteMessage.className = 'message error';
            }
        });
    }

    // Close buttons
    document.getElementById('closeCreate').addEventListener('click', () => hideModal(createModal));
    document.getElementById('closeRename').addEventListener('click', () => hideModal(renameModal));
    document.getElementById('closeDelete').addEventListener('click', () => hideModal(deleteModal));

    // Close on outside click
    [createModal, renameModal, deleteModal].forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideModal(modal);
            }
        });
    });

    // Enter key handlers
    newCollectionInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmCreate.click();
    });

    renameNewNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmRename.click();
    });
});
