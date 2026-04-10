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
    const existingTagsSection = document.getElementById('existingTagsSection');
    const existingTagsList = document.getElementById('existingTagsList');
    
    // Copy Tags Modal elements
    const copyTagsModal = document.getElementById('copyTagsModal');
    const copyTargetImageName = document.getElementById('copyTargetImageName');
    const copySourceImagesList = document.getElementById('copySourceImagesList');
    const selectedSourceTags = document.getElementById('selectedSourceTags');
    const selectedSourceTagsList = document.getElementById('selectedSourceTagsList');
    const copyTagsMessage = document.getElementById('copyTagsMessage');
    const closeCopyTagsBtn = document.getElementById('closeCopyTagsBtn');
    const cancelCopyTagsBtn = document.getElementById('cancelCopyTagsBtn');
    const confirmCopyTagsBtn = document.getElementById('confirmCopyTagsBtn');
    
    let currentCollection = '';
    let currentImageForTags = { collection: '', filename: '', existingTags: [] };
    let currentImageForCopy = { collection: '', filename: '', targetFilename: '', allImages: [] };
    let selectedSourceImageTags = [];

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
        
        // Display existing tags
        if (existingTags && existingTags.length > 0) {
            const section = document.getElementById('existingTagsSection');
            const list = document.getElementById('existingTagsList');
            
            if (section && list) {
                section.style.display = 'block';
                list.innerHTML = existingTags.map(tag => `
                    <span class="retag-tag" style="background: var(--primary-color); color: white; padding: 4px 10px; border-radius: 4px; font-size: 0.9rem;">
                        ${tag}
                    </span>
                `).join('');
            }
        } else {
            const section = document.getElementById('existingTagsSection');
            const list = document.getElementById('existingTagsList');
            if (section) section.style.display = 'none';
            if (list) list.innerHTML = '';
        }
        
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

    // Copy Tags Modal functions
    function openCopyTagsModal(collection, targetFilename, allImages) {
        if (!copyTagsModal) {
            return;
        }
        
        if (!allImages || !Array.isArray(allImages)) {
            return;
        }
        
        currentImageForCopy = { collection, targetFilename, allImages, sourceFilename: '' };
        copyTargetImageName.textContent = targetFilename;
        copyTagsMessage.textContent = '';
        selectedSourceImageTags = [];
        confirmCopyTagsBtn.disabled = true;
        confirmCopyTagsBtn.innerHTML = '<i class="fas fa-check"></i> Copy Selected Tags';
        
        // Reset tags display - don't clear yet, wait for selection
        if (selectedSourceTagsList) {
            selectedSourceTagsList.innerHTML = '';
        }
        if (selectedSourceTags) {
            selectedSourceTags.style.display = 'none';
        }
        
        // Display all images except the target
        const sourceImages = allImages.filter(img => img.filename !== targetFilename);
        
        copySourceImagesList.innerHTML = sourceImages
            .map(img => {
                const tagsJson = JSON.stringify(img.tags || []);
                return `
                <button class="copy-source-image-btn" data-filename="${img.filename}" data-tags='${tagsJson}'>
                    <img src="${img.url}" alt="${img.filename}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px;">
                    <div class="copy-source-image-label">${img.filename.substring(0, 15)}...</div>
                </button>
            `;
            }).join('');
        
        // Add click listeners to source images
        document.querySelectorAll('.copy-source-image-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Deselect previous button
                document.querySelectorAll('.copy-source-image-btn').forEach(b => {
                    b.classList.remove('selected');
                });
                
                // Select this button
                btn.classList.add('selected');
                
                const filename = btn.dataset.filename;
                const tagsStr = btn.dataset.tags;
                const tags = tagsStr ? JSON.parse(tagsStr) : [];
                
                currentImageForCopy.sourceFilename = filename;
                selectedSourceImageTags = tags;
                
                // Display selected tags - ensure container is shown
                if (selectedSourceTags) {
                    selectedSourceTags.style.display = 'block';
                    
                    // Scroll into view
                    setTimeout(() => {
                        selectedSourceTags.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 0);
                    
                    if (selectedSourceTagsList) {
                        if (tags && tags.length > 0) {
                            const tagHtml = tags.map(tag => `<span class="retag-tag" style="background: var(--primary-color); color: white; padding: 4px 10px; border-radius: 4px; font-size: 0.9rem;">${tag}</span>`).join('');
                            selectedSourceTagsList.innerHTML = tagHtml;
                        } else {
                            selectedSourceTagsList.innerHTML = '<span style="color: var(--text-secondary);">No tags to copy</span>';
                        }
                    }
                }
                
                // Enable copy button only if there are tags
                if (confirmCopyTagsBtn) {
                    confirmCopyTagsBtn.disabled = !tags || tags.length === 0;
                }
            });
        });
        
        copyTagsModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
    }
    
    function closeCopyTagsModal() {
        if (!copyTagsModal) return;
        copyTagsModal.style.display = 'none';
        document.body.style.overflow = '';
        currentImageForCopy = { collection: '', targetFilename: '', sourceFilename: '', allImages: [] };
        selectedSourceImageTags = [];
    }
    
    // Copy Tags Modal event listeners
    if (closeCopyTagsBtn) {
        closeCopyTagsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeCopyTagsModal();
        });
    }
    
    if (cancelCopyTagsBtn) {
        cancelCopyTagsBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeCopyTagsModal();
        });
    }
    
    if (confirmCopyTagsBtn) {
        confirmCopyTagsBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (!currentImageForCopy.sourceFilename || selectedSourceImageTags.length === 0) {
                copyTagsMessage.textContent = 'Please select a source image';
                copyTagsMessage.className = 'message error';
                return;
            }
            
            // Disable button while processing
            confirmCopyTagsBtn.disabled = true;
            confirmCopyTagsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Copying...';
            
            const apiUrl = `/api/images/${currentImageForCopy.collection}/${currentImageForCopy.sourceFilename}/copy-tags/${currentImageForCopy.targetFilename}`;
            
            try {
                const res = await fetch(apiUrl, {
                    method: 'POST'
                });
                const data = await res.json();
                
                if (data.success) {
                    copyTagsMessage.textContent = data.message;
                    copyTagsMessage.className = 'message success';
                    
                    setTimeout(async () => {
                        closeCopyTagsModal();
                        await loadCollectionImages(currentCollection);
                    }, 1000);
                } else {
                    copyTagsMessage.textContent = 'Failed to copy tags: ' + (data.error || 'Unknown error');
                    copyTagsMessage.className = 'message error';
                    confirmCopyTagsBtn.disabled = false;
                    confirmCopyTagsBtn.innerHTML = '<i class="fas fa-check"></i> Copy Selected Tags';
                }
            } catch (err) {
                copyTagsMessage.textContent = 'Error copying tags: ' + err.message;
                copyTagsMessage.className = 'message error';
                confirmCopyTagsBtn.disabled = false;
                confirmCopyTagsBtn.innerHTML = '<i class="fas fa-check"></i> Copy Selected Tags';
            }
        });
    }
    
    // Close on overlay click
    if (copyTagsModal) {
        copyTagsModal.addEventListener('click', (e) => {
            if (e.target.classList.contains('retag-modal-overlay')) {
                closeCopyTagsModal();
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

        // Images are already sorted by upload time from backend
        retagImagesList.innerHTML = images.map(img => {
            // Extract all body part prefixes as three consecutive letters
            const getAllBodyPartPrefixes = () => {
                const fieldMap = {
                    'boobs': ['Covered boobs', 'Semi Naked boobs', 'Naked boobs', 'Unseen boobs'],
                    'pussy': ['Covered pussy', 'Semi Naked pussy', 'Naked pussy', 'Unseen pussy'],
                    'butt': ['Covered butt', 'Semi Naked butt', 'Naked butt', 'Unseen butt']
                };
                
                const abbreviationMap = {
                    'Covered': 'c',
                    'Semi Naked': 's',
                    'Naked': 'n',
                    'Unseen': 'u'
                };
                
                const result = [];
                const fields = ['boobs', 'pussy', 'butt'];
                
                for (const fieldName of fields) {
                    const tags = fieldMap[fieldName] || [];
                    let found = false;
                    
                    // Check each tag in fieldMap to find which one is in img.tags
                    for (const tag of tags) {
                        if (img.tags.includes(tag)) {
                            // Extract prefix: everything before the last space
                            const parts = tag.split(' ');
                            const lastPart = parts[parts.length - 1];
                            const fullPrefix = tag.substring(0, tag.length - lastPart.length - 1);
                            result.push(abbreviationMap[fullPrefix] || '');
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        result.push('');
                    }
                }
                
                return result.join('');
            };

            return `
            <div class="retag-image-card" data-filename="${img.filename}" data-locked="${img.locked || false}">
                <img src="${img.url}" alt="${img.filename}">
                <div class="retag-image-info">
                    <div class="retag-image-filename">
                        ${img.filename}
                        ${img.locked ? '<span class="lock-badge" title="Tags locked"><i class="fas fa-lock"></i></span>' : ''}
                    </div>
                    <div class="retag-tags-container">
                        <div class="retag-tags" data-filename="${img.filename}">
                            ${img.tags.map(tag => `
                                <span class="retag-tag">
                                    ${tag}
                                    <button class="remove-tag" data-tag="${tag}">×</button>
                                </span>
                            `).join('')}
                        </div>
                        <div class="retag-body-parts">
                            <label>Body Parts (Boobs, Pussy, Butt):</label>
                            <input type="text" class="body-parts-combined-input" data-filename="${img.filename}" value="${getAllBodyPartPrefixes()}" placeholder="e.g., csn" maxlength="3">
                            <small style="display: block; margin-top: 4px; color: var(--text-secondary);">Format: 3 letters (c=Covered, s=Semi Naked, n=Naked, u=Unseen). e.g., "csn" for Covered boobs, Semi Naked pussy, Naked butt</small>
                        </div>
                        <div class="retag-button-group">
                            <button class="btn-add-tag" data-filename="${img.filename}">
                                <i class="fas fa-plus"></i> Add
                            </button>
                            <button class="btn-auto-tag" data-filename="${img.filename}">
                                <i class="fas fa-magic"></i> Auto-Tag
                            </button>
                            <button class="btn-copy-tags" data-filename="${img.filename}">
                                <i class="fas fa-copy"></i> Copy From
                            </button>
                            <button class="btn-lock-tag ${img.locked ? 'locked' : ''}" data-filename="${img.filename}" title="${img.locked ? 'Unlock tags' : 'Lock tags'}">
                                <i class="fas fa-${img.locked ? 'lock' : 'lock-open'}"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        }).join('');

        // Add event listeners for tag management
        attachTagEventListeners(collection, images);
    }

    function attachTagEventListeners(collection, allImages) {
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

        // Copy tags buttons
        document.querySelectorAll('.btn-copy-tags').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                
                // Open the copy tags modal
                openCopyTagsModal(collection, filename, allImages);
            });
        });

        // Body part input handlers (combined input with three consecutive letters)
        document.querySelectorAll('.body-parts-combined-input').forEach(input => {
            input.addEventListener('change', async (e) => {
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const inputValue = e.target.value.trim();
                
                // Get current tags
                const tagsContainer = card.querySelector('.retag-tags');
                const currentTags = Array.from(tagsContainer.querySelectorAll('.remove-tag'))
                    .map(b => b.dataset.tag);
                
                // Map abbreviations to full names
                const abbreviationMap = {
                    'c': 'Covered',
                    's': 'Semi Naked',
                    'n': 'Naked',
                    'u': 'Unseen'
                };
                
                // Remove any existing body part tags (all Covered/Semi Naked/Naked/Unseen + boobs/pussy/butt)
                const validPrefixes = ['Covered', 'Semi Naked', 'Naked', 'Unseen'];
                const bodyParts = ['boobs', 'pussy', 'butt'];
                let newTags = currentTags.filter(tag => {
                    // Keep tags that don't match any body part pattern
                    for (const validPrefix of validPrefixes) {
                        for (const bodyPart of bodyParts) {
                            if (tag === `${validPrefix} ${bodyPart}`) {
                                return false;
                            }
                        }
                    }
                    return true;
                });
                
                // Parse three consecutive letters
                if (inputValue) {
                    const fieldNames = ['boobs', 'pussy', 'butt'];
                    
                    // Add new tags for each body part (up to 3 letters)
                    for (let i = 0; i < Math.min(inputValue.length, 3); i++) {
                        const abbrev = inputValue[i].toLowerCase();
                        const fieldName = fieldNames[i];
                        
                        if (abbrev && abbreviationMap[abbrev]) {
                            const fullPrefix = abbreviationMap[abbrev];
                            newTags.push(`${fullPrefix} ${fieldName}`);
                        }
                    }
                }
                
                // Update tags
                const result = await updateImageTags(collection, filename, newTags);
                if (result.success) {
                    await loadCollectionImages(currentCollection);
                } else {
                    alert('Failed to update tags: ' + (result.error || 'Unknown error'));
                }
            });
        });

        // Lock/unlock tag buttons
        document.querySelectorAll('.btn-lock-tag').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const card = e.target.closest('.retag-image-card');
                const filename = card.dataset.filename;
                const isCurrentlyLocked = card.dataset.locked === 'true';
                
                try {
                    const endpoint = isCurrentlyLocked ? 'unlock' : 'lock';
                    const res = await fetch(`/api/images/${collection}/${filename}/${endpoint}`, {
                        method: 'POST'
                    });
                    const data = await res.json();
                    
                    if (data.success) {
                        await loadCollectionImages(currentCollection);
                    } else {
                        alert('Failed to ' + endpoint + ' image: ' + data.error);
                    }
                } catch (err) {
                    alert('Error ' + (isCurrentlyLocked ? 'unlocking' : 'locking') + ' image');
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
