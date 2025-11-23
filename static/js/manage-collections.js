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

    // Retag collection
    const retagModal = document.getElementById('retagModal');
    const retagCollectionNameSpan = document.getElementById('retagCollectionName');
    const retagImagesList = document.getElementById('retagImagesList');
    const retagMessage = document.getElementById('retagMessage');
    const retagAllBtn = document.getElementById('retagAll');
    const retagProgress = document.getElementById('retagProgress');
    const retagProgressBar = document.getElementById('retagProgressBar');
    const retagProgressText = document.getElementById('retagProgressText');

    document.querySelectorAll('.retag-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            currentCollection = btn.dataset.collection;
            retagCollectionNameSpan.textContent = currentCollection;
            retagMessage.textContent = '';
            retagImagesList.innerHTML = '<div class="loading">Loading images...</div>';
            showModal(retagModal);
            
            // Load images for this collection
            await loadCollectionImages(currentCollection);
        });
    });

    async function loadCollectionImages(collection) {
        try {
            const res = await fetch(`/api/collections/${collection}/images`);
            const data = await res.json();

            if (data.success) {
                displayImages(data.images, collection);
            } else {
                retagImagesList.innerHTML = '<div class="error">Failed to load images</div>';
            }
        } catch (err) {
            retagImagesList.innerHTML = '<div class="error">Error loading images</div>';
        }
    }

    function displayImages(images, collection) {
        if (images.length === 0) {
            retagImagesList.innerHTML = '<div class="empty-state">No images in this collection</div>';
            return;
        }

        retagImagesList.innerHTML = images.map(img => `
            <div class="retag-image-card" data-filename="${img.filename}">
                <img src="${img.url}" alt="${img.filename}">
                <div class="retag-image-info">
                    <div class="retag-image-filename">${img.filename}</div>
                    <div class="retag-tags-container">
                        <div class="retag-tags" data-filename="${img.filename}">
                            ${img.tags.map(tag => `
                                <span class="retag-tag">
                                    ${tag}
                                    <button class="remove-tag" data-tag="${tag}">×</button>
                                </span>
                            `).join('')}
                        </div>
                        <button class="btn-add-tag" data-filename="${img.filename}">
                            <i class="fas fa-plus"></i> Add Tag
                        </button>
                        <button class="btn-auto-tag" data-filename="${img.filename}">
                            <i class="fas fa-magic"></i> Auto-Tag
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        // Add event listeners for tag management
        attachTagEventListeners(collection);
    }

    function attachTagEventListeners(collection) {
        // Remove tag buttons
        document.querySelectorAll('.remove-tag').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const tagToRemove = e.target.dataset.tag;
                const tagsContainer = card.querySelector('.retag-tags');
                
                // Get current tags
                const currentTags = Array.from(tagsContainer.querySelectorAll('.retag-tag'))
                    .map(t => t.textContent.trim().replace('×', ''))
                    .filter(t => t !== tagToRemove);
                
                await updateImageTags(collection, filename, currentTags);
                await loadCollectionImages(currentCollection);
            });
        });

        // Add tag buttons
        document.querySelectorAll('.btn-add-tag').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const newTag = prompt('Enter new tag:');
                
                if (newTag && newTag.trim()) {
                    const tagsContainer = card.querySelector('.retag-tags');
                    const currentTags = Array.from(tagsContainer.querySelectorAll('.retag-tag'))
                        .map(t => t.textContent.trim().replace('×', ''));
                    
                    currentTags.push(newTag.trim());
                    await updateImageTags(collection, filename, currentTags);
                    await loadCollectionImages(currentCollection);
                }
            });
        });

        // Auto-tag buttons
        document.querySelectorAll('.btn-auto-tag').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Tagging...';
                
                try {
                    const res = await fetch(`/api/images/${collection}/${filename}/retag`, {
                        method: 'POST'
                    });
                    const data = await res.json();
                    
                    if (data.success) {
                        await loadCollectionImages(currentCollection);
                    } else {
                        alert('Failed to auto-tag image: ' + data.error);
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-magic"></i> Auto-Tag';
                    }
                } catch (err) {
                    alert('Error auto-tagging image');
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-magic"></i> Auto-Tag';
                }
            });
        });
    }

    async function updateImageTags(collection, filename, tags) {
        try {
            const res = await fetch(`/api/images/${collection}/${filename}/tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags })
            });
            return await res.json();
        } catch (err) {
            return { success: false, error: 'Network error' };
        }
    }

    // Auto-tag all images in collection
    if (retagAllBtn) {
        retagAllBtn.addEventListener('click', async () => {
            if (!confirm(`Auto-tag all images in ${currentCollection}? This will replace existing tags.`)) {
                return;
            }

            retagAllBtn.disabled = true;
            retagProgress.style.display = 'block';
            retagProgressText.textContent = 'Processing images...';
            retagProgressBar.style.width = '0%';

            try {
                const res = await fetch(`/api/collections/${currentCollection}/retag-all`, {
                    method: 'POST'
                });
                const data = await res.json();

                if (data.success) {
                    retagProgressBar.style.width = '100%';
                    retagProgressText.textContent = data.message;
                    retagMessage.textContent = `Successfully processed ${data.processed} images`;
                    retagMessage.className = 'message success';
                    
                    // Reload images
                    setTimeout(async () => {
                        await loadCollectionImages(currentCollection);
                        retagProgress.style.display = 'none';
                        retagAllBtn.disabled = false;
                    }, 1500);
                } else {
                    retagMessage.textContent = data.error || 'Failed to auto-tag images';
                    retagMessage.className = 'message error';
                    retagProgress.style.display = 'none';
                    retagAllBtn.disabled = false;
                }
            } catch (err) {
                retagMessage.textContent = 'Error processing images';
                retagMessage.className = 'message error';
                retagProgress.style.display = 'none';
                retagAllBtn.disabled = false;
            }
        });
    }

    // Close buttons
    document.getElementById('closeCreate').addEventListener('click', () => hideModal(createModal));
    document.getElementById('closeRename').addEventListener('click', () => hideModal(renameModal));
    document.getElementById('closeDelete').addEventListener('click', () => hideModal(deleteModal));
    document.getElementById('closeRetag').addEventListener('click', () => hideModal(retagModal));

    // Close on outside click
    [createModal, renameModal, deleteModal, retagModal].forEach(modal => {
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
