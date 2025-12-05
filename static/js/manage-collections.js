// Manage Collections JavaScript
document.addEventListener('DOMContentLoaded', () => {
    const createBtn = document.getElementById('createCollectionBtn');
    const createModal = document.getElementById('createModal');
    const renameModal = document.getElementById('renameModal');
    const deleteModal = document.getElementById('deleteModal');
    const retagModal = document.getElementById('retagModal');
    
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
    
    const retagCollectionNameSpan = document.getElementById('retagCollectionName');
    const retagImagesList = document.getElementById('retagImagesList');
    const retagMessage = document.getElementById('retagMessage');
    const retagAllBtn = document.getElementById('retagAllBtn');
    const retagProgress = document.getElementById('retagProgress');
    const retagProgressBar = document.getElementById('retagProgressBar');
    const retagProgressText = document.getElementById('retagProgressText');
    const closeRetagBtn = document.getElementById('closeRetagBtn');
    const closeRetagFooterBtn = document.getElementById('closeRetagFooterBtn');
    
    // Add Tags Modal elements
    const addTagsModal = document.getElementById('addTagsModal');
    const addTagsInput = document.getElementById('addTagsInput');
    const addTagsMessage = document.getElementById('addTagsMessage');
    const closeAddTagsBtn = document.getElementById('closeAddTagsBtn');
    const cancelAddTagsBtn = document.getElementById('cancelAddTagsBtn');
    const confirmAddTagsBtn = document.getElementById('confirmAddTagsBtn');
    
    let currentCollection = '';
    let currentImageForTags = { collection: '', filename: '', existingTags: [] };

    // Show/hide modals - REBUILT FROM SCRATCH
    function showModal(modal) {
        if (!modal) return;
        modal.style.display = 'flex';
        modal.classList.add('show');
        // Force reflow to trigger CSS transition
        modal.offsetHeight;
        // Ensure body doesn't scroll when modal is open
        document.body.style.overflow = 'hidden';
    }

    function hideModal(modal) {
        if (!modal) return;
        modal.classList.remove('show');
        setTimeout(() => {
            modal.style.display = 'none';
            // Restore body scroll
            document.body.style.overflow = '';
        }, 300);
    }
    
    // Retag modal - REBUILT FROM SCRATCH
    function openRetagModal(collectionName) {
        if (!retagModal) return;
        
        currentCollection = collectionName;
        retagCollectionNameSpan.textContent = collectionName;
        retagImagesList.innerHTML = '<div class="loading">Loading images...</div>';
        retagMessage.textContent = '';
        
        // Direct display change - no classes, no transitions
        retagModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
        
        // Load images
        loadCollectionImages(collectionName);
    }
    
    function closeRetagModal() {
        if (!retagModal) return;
        retagModal.style.display = 'none';
        document.body.style.overflow = '';
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
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
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
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
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

    // Retag button handler - REBUILT FROM SCRATCH
    document.querySelectorAll('.retag-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const collectionName = btn.dataset.collection;
            openRetagModal(collectionName);
        });
    });
    
    // Close retag modal handlers - REBUILT FROM SCRATCH
    if (closeRetagBtn) {
        closeRetagBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeRetagModal();
        });
    }
    
    if (closeRetagFooterBtn) {
        closeRetagFooterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeRetagModal();
        });
    }
    
    // Close on overlay click - REBUILT FROM SCRATCH
    if (retagModal) {
        retagModal.addEventListener('click', (e) => {
            if (e.target.classList.contains('retag-modal-overlay')) {
                closeRetagModal();
            }
        });
    }
    
    // Add Tags Modal functions
    function openAddTagsModal(collection, filename, existingTags) {
        if (!addTagsModal) return;
        
        currentImageForTags = { collection, filename, existingTags };
        addTagsInput.value = '';
        addTagsMessage.textContent = '';
        
        // Reset button state
        if (confirmAddTagsBtn) {
            confirmAddTagsBtn.disabled = false;
            confirmAddTagsBtn.innerHTML = '<i class="fas fa-plus"></i> Add Tags';
        }
        
        addTagsModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
        
        // Focus on input
        setTimeout(() => addTagsInput.focus(), 100);
    }
    
    function closeAddTagsModal() {
        if (!addTagsModal) return;
        addTagsModal.style.display = 'none';
        document.body.style.overflow = '';
        currentImageForTags = { collection: '', filename: '', existingTags: [] };
        
        // Reset button state
        if (confirmAddTagsBtn) {
            confirmAddTagsBtn.disabled = false;
            confirmAddTagsBtn.innerHTML = '<i class="fas fa-plus"></i> Add Tags';
        }
    }
    
    // Add Tags Modal event listeners
    if (closeAddTagsBtn) {
        closeAddTagsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeAddTagsModal();
        });
    }
    
    if (cancelAddTagsBtn) {
        cancelAddTagsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeAddTagsModal();
        });
    }
    
    if (confirmAddTagsBtn) {
        confirmAddTagsBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            const tagsInput = addTagsInput.value.trim();
            if (!tagsInput) {
                addTagsMessage.textContent = 'Please enter at least one tag';
                addTagsMessage.className = 'message error';
                return;
            }
            
            // Parse comma-separated tags
            const newTags = tagsInput.split(',')
                .map(tag => tag.trim())
                .filter(tag => tag.length > 0);
            
            if (newTags.length === 0) {
                addTagsMessage.textContent = 'Please enter valid tags';
                addTagsMessage.className = 'message error';
                return;
            }
            
            // Merge with existing tags (remove duplicates)
            const allTags = [...currentImageForTags.existingTags, ...newTags];
            const uniqueTags = [...new Set(allTags)];
            
            // Disable button while processing
            confirmAddTagsBtn.disabled = true;
            confirmAddTagsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
            
            const result = await updateImageTags(
                currentImageForTags.collection, 
                currentImageForTags.filename, 
                uniqueTags
            );
            
            if (result.success) {
                closeAddTagsModal();
                await loadCollectionImages(currentCollection);
            } else {
                addTagsMessage.textContent = 'Failed to add tags: ' + (result.error || 'Unknown error');
                addTagsMessage.className = 'message error';
                confirmAddTagsBtn.disabled = false;
                confirmAddTagsBtn.innerHTML = '<i class="fas fa-plus"></i> Add Tags';
            }
        });
    }
    
    // Close on overlay click
    if (addTagsModal) {
        addTagsModal.addEventListener('click', (e) => {
            if (e.target.classList.contains('retag-modal-overlay')) {
                closeAddTagsModal();
            }
        });
    }
    
    // Enter key to submit
    if (addTagsInput) {
        addTagsInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                confirmAddTagsBtn.click();
            }
        });
    }

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
                e.preventDefault();
                e.stopPropagation();
                
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const tagToRemove = btn.dataset.tag;
                const tagsContainer = card.querySelector('.retag-tags');
                
                // Get current tags from the remove-tag buttons (they have the actual tag text)
                const currentTags = Array.from(tagsContainer.querySelectorAll('.remove-tag'))
                    .map(b => b.dataset.tag)
                    .filter(tag => tag !== tagToRemove);
                
                const result = await updateImageTags(collection, filename, currentTags);
                if (result.success) {
                    await loadCollectionImages(currentCollection);
                }
            });
        });

        // Add tag buttons
        document.querySelectorAll('.btn-add-tag').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const tagsContainer = card.querySelector('.retag-tags');
                
                // Get current tags from the remove-tag buttons
                const currentTags = Array.from(tagsContainer.querySelectorAll('.remove-tag'))
                    .map(b => b.dataset.tag);
                
                // Open the add tags modal
                openAddTagsModal(collection, filename, currentTags);
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

    // Close buttons for other modals
    const closeCreate = document.getElementById('closeCreate');
    const closeRename = document.getElementById('closeRename');
    const closeDelete = document.getElementById('closeDelete');
    
    if (closeCreate) closeCreate.addEventListener('click', () => hideModal(createModal));
    if (closeRename) closeRename.addEventListener('click', () => hideModal(renameModal));
    if (closeDelete) closeDelete.addEventListener('click', () => hideModal(deleteModal));

    // Close on outside click for other modals
    [createModal, renameModal, deleteModal].forEach(modal => {
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    hideModal(modal);
                }
            });
        }
    });
    
    // Ensure all modals start closed
    [createModal, renameModal, deleteModal].forEach(modal => {
        if (modal) {
            modal.style.display = 'none';
            modal.classList.remove('show');
        }
    });
    
    // Retag modal starts closed
    if (retagModal) {
        retagModal.style.display = 'none';
    }

    // Enter key handlers
    newCollectionInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmCreate.click();
    });

    renameNewNameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') confirmRename.click();
    });
});
