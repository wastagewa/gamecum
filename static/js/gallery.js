// gallery.js - Gallery image viewer and upload handler
document.addEventListener('DOMContentLoaded', () => {
    // Initialize animations
    if (window.AOS) {
        AOS.init({ duration: 800, easing: 'ease-out', once: true });
    }

    const fileUpload = document.getElementById('file-upload');
    const gallery = document.getElementById('gallery');
    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImage');
    const closeBtn = document.querySelector('.close-modal');
    const modalOverlay = document.querySelector('.modal-overlay');
    const loading = document.getElementById('loading');
    
    // Hide loading spinner immediately on page load
    if (loading) {
        loading.style.display = 'none';
        loading.classList.add('hidden');
        loading.classList.remove('visible');
    }
    
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
    
        let currentImageIndex = 0;
        let allImages = [];

        function imageQuoteUrl(imageUrl) {
            try {
                const path = new URL(imageUrl, window.location.origin).pathname;
                const parts = path.split('/').filter(Boolean);
                const idx = parts.indexOf('uploads');
                if (idx !== -1 && parts.length > idx + 2) {
                    const col = parts[idx + 1];
                    const fn  = parts[idx + 2];
                    return `/get-quote?collection=${encodeURIComponent(col)}&filename=${encodeURIComponent(fn)}`;
                }
            } catch (e) {}
            return '/get-quote';
        }

        // ── AI-generated quotes (tags/body_parts/model-name aware) ──────────────
        // The server can't reach huggingface.co directly (see chat.js's
        // callChatApi comment), so generation happens here in the browser: fetch
        // the prompt + a token from the server, call HF directly, then POST the
        // result back so the server can cache it for next time.

        let cachedHfToken = null;                    // fetched once per page load, reused across calls
        const aiQuoteGenerationInFlight = new Set();  // "collection/filename" keys currently generating — avoids duplicate concurrent HF calls for the same image

        function imageQuoteParams(imageUrl) {
            try {
                const path = new URL(imageUrl, window.location.origin).pathname;
                const parts = path.split('/').filter(Boolean);
                if (parts.length >= 2) {
                    return { collection: parts[parts.length - 2], filename: parts[parts.length - 1] };
                }
            } catch (e) {}
            return { collection: '', filename: '' };
        }

        async function fetchCachedAiQuote(collection, filename) {
            if (!collection || !filename) return null;
            try {
                const res = await fetch(`/api/images/${encodeURIComponent(collection)}/${encodeURIComponent(filename)}/ai-quote`);
                const data = await res.json();
                return (data.success && data.cached) ? data.quote : null;
            } catch (e) {
                return null;
            }
        }

        async function generateAndSaveAiQuote(collection, filename) {
            if (!collection || !filename) throw new Error('Missing collection/filename');

            const promptRes  = await fetch(`/api/images/${encodeURIComponent(collection)}/${encodeURIComponent(filename)}/ai-quote-prompt`);
            const promptData = await promptRes.json();
            if (!promptRes.ok || !promptData.success) {
                throw new Error(promptData.error || 'Not enough data to generate a quote for this image');
            }

            if (!cachedHfToken) {
                const tokenRes  = await fetch('/api/quote-chat-token');
                const tokenData = await tokenRes.json();
                cachedHfToken   = tokenData.token || null;
            }

            const quote = await callHuggingFaceChat({
                token:        cachedHfToken,
                model:        promptData.model,
                systemPrompt: promptData.system_prompt,
                userMessage:  promptData.user_message,
                maxTokens:    promptData.max_tokens,
                apiBase:      promptData.api_base,
            });

            // Cache it server-side so the next viewer (and the next slideshow pass) gets it
            // instantly. Best-effort: if the save fails, still return the quote we already
            // paid to generate rather than throwing it away.
            try {
                await fetch(`/api/images/${encodeURIComponent(collection)}/${encodeURIComponent(filename)}/ai-quote`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ quote }),
                });
            } catch (e) {
                console.error('Failed to cache AI quote (showing it anyway):', e);
            }

            return quote;
        }

        // Non-blocking: if a cached AI quote already exists, swap it in immediately
        // (only if `isStillCurrent()` says the viewer hasn't moved on to a different
        // image in the meantime). If nothing is cached yet and `allowBackgroundGeneration`
        // is true, generate + cache one quietly so the NEXT view of this image is instant —
        // deduped per image so the same image never generates twice concurrently.
        // `onQuoteReady(hasAiQuote)` (optional) fires once we know whether an AI quote
        // is showing, so callers can update a "Generate" vs "Regenerate" button state.
        function refreshAiQuoteForElement(imageUrl, quoteElement, wrapInQuotes, isStillCurrent, allowBackgroundGeneration, onQuoteReady) {
            const { collection, filename } = imageQuoteParams(imageUrl);
            if (!collection || !filename || !quoteElement) {
                if (onQuoteReady) onQuoteReady(false);
                return;
            }
            const key = `${collection}/${filename}`;

            fetchCachedAiQuote(collection, filename).then(cached => {
                if (!isStillCurrent()) return;
                if (cached) {
                    quoteElement.textContent = wrapInQuotes ? `"${cached}"` : cached;
                    if (onQuoteReady) onQuoteReady(true);
                    return;
                }
                if (onQuoteReady) onQuoteReady(false);
                if (allowBackgroundGeneration && !aiQuoteGenerationInFlight.has(key)) {
                    aiQuoteGenerationInFlight.add(key);
                    generateAndSaveAiQuote(collection, filename)
                        .then(quote => {
                            if (isStillCurrent()) {
                                quoteElement.textContent = wrapInQuotes ? `"${quote}"` : quote;
                                if (onQuoteReady) onQuoteReady(true);
                            }
                        })
                        .catch(() => { /* static quote already showing — ignore */ })
                        .finally(() => aiQuoteGenerationInFlight.delete(key));
                }
            });
        }

        function updateQuoteGenButtonState(btn, hasAiQuote) {
            if (!btn) return;
            btn.classList.toggle('is-regenerate', hasAiQuote);
            btn.title = hasAiQuote ? 'Regenerate quote' : 'Generate AI quote';
            btn.setAttribute('aria-label', btn.title);
        }

        function updateNavigationButtons() {
            if (prevBtn && nextBtn) {
                prevBtn.style.display = currentImageIndex > 0 ? 'flex' : 'none';
                nextBtn.style.display = currentImageIndex < allImages.length - 1 ? 'flex' : 'none';
            }
        }

        async function showPreviousImage() {
            if (currentImageIndex > 0) {
                currentImageIndex--;
                await updateModalImage();
            }
        }

        async function showNextImage() {
            if (currentImageIndex < allImages.length - 1) {
                currentImageIndex++;
                await updateModalImage();
            }
        }

        async function updateModalImage() {
            if (modalImg && allImages[currentImageIndex]) {
                const imgSrc = allImages[currentImageIndex];
                modalImg.src = imgSrc;
                updateNavigationButtons();

                // Get a tag-matched quote for this image
                const quoteElement = document.getElementById('modalQuote');
                const modalRegenBtn = document.getElementById('modalQuoteRegenBtn');
                try {
                    const quoteResponse = await fetch(imageQuoteUrl(imgSrc));
                    const quoteData = await quoteResponse.json();
                    if (quoteData.quote && quoteElement) {
                        quoteElement.textContent = quoteData.quote;
                    }
                } catch (err) {
                    console.error('Error fetching quote:', err);
                }
                updateQuoteGenButtonState(modalRegenBtn, false);
                refreshAiQuoteForElement(
                    imgSrc, quoteElement, false,
                    () => allImages[currentImageIndex] === imgSrc,
                    true,
                    hasAi => updateQuoteGenButtonState(modalRegenBtn, hasAi)
                );
            }
        }

        // Set up navigation button event listeners
        if (prevBtn) {
            prevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showPreviousImage();
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showNextImage();
            });
        }

        // Add keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (modal.style.display === 'flex') {
                if (e.key === 'ArrowLeft') {
                    showPreviousImage();
                } else if (e.key === 'ArrowRight') {
                    showNextImage();
                } else if (e.key === 'Escape') {
                    closeModal();
                }
            }
        });
    async function openModal(imageUrl, clickedIndex = 0) {
        try {
            if (!modal || !modalImg) return;

            // Set current image index and list of images
            currentImageIndex = typeof clickedIndex === 'number' ? clickedIndex : 0;
            allImages = Array.from(document.querySelectorAll('.gallery-image')).map(img => img.src);
            updateNavigationButtons();

            // Fetch a tag-matched quote for this image
            const quoteElement = document.getElementById('modalQuote');
            const modalRegenBtn = document.getElementById('modalQuoteRegenBtn');
            try {
                const quoteResponse = await fetch(imageQuoteUrl(imageUrl));
                const quoteData = await quoteResponse.json();
                if (quoteData && quoteData.quote && quoteElement) {
                    quoteElement.textContent = quoteData.quote;
                }
            } catch (err) {
                console.error('Error fetching quote:', err);
            }
            updateQuoteGenButtonState(modalRegenBtn, false);
            refreshAiQuoteForElement(
                imageUrl, quoteElement, false,
                () => allImages[currentImageIndex] === imageUrl,
                true,
                hasAi => updateQuoteGenButtonState(modalRegenBtn, hasAi)
            );

            modal.style.display = 'flex';
            modalImg.src = imageUrl;

            // Force reflow for animation
            void modal.offsetHeight;

            requestAnimationFrame(() => {
                modal.classList.add('show-modal');
            });

            document.body.style.overflow = 'hidden';
            updateNavigationButtons();
        } catch (err) { console.error('openModal error', err); }
    }

    function closeModal() {
        try {
            if (!modal) return;
            modal.classList.remove('show-modal');
            document.body.style.overflow = '';
            setTimeout(() => {
                if (modal) modal.style.display = 'none';
                if (modalImg) modalImg.src = '';
            }, 350);
        } catch (err) { console.error('closeModal error', err); }
    }

    if (gallery) {
        // Single click handler on gallery container
        gallery.addEventListener('click', async (e) => {
            // If delete button (or its child) was clicked, handle deletion
            const deleteBtn = e.target.closest('.item-delete');
            if (deleteBtn) {
                e.preventDefault();
                e.stopPropagation();
                const filename = deleteBtn.dataset.filename;
                if (!filename) return;
                if (!confirm('Are you sure you want to delete this image?')) return;
                try {
                    const collectionPath = (window.CURRENT_COLLECTION && window.CURRENT_COLLECTION.length) ? `/${encodeURIComponent(window.CURRENT_COLLECTION)}` : '';
                    const res = await fetch(`/delete-image${collectionPath}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (data && data.success) {
                        // remove gallery item from DOM
                        const galleryItem = deleteBtn.closest('.gallery-item');
                        if (galleryItem) galleryItem.remove();
                    } else {
                        alert(data.error || 'Failed to delete image');
                    }
                } catch (err) {
                    console.error('Error deleting image:', err);
                    alert('Error deleting image');
                }
                return;
            }

            // If slideshow button (or its child) was clicked, start slideshow from that image
            const slideshowBtn = e.target.closest('.item-slideshow');
            if (slideshowBtn) {
                e.preventDefault();
                e.stopPropagation();
                const galleryItem = slideshowBtn.closest('.gallery-item');
                if (galleryItem) {
                    const img = galleryItem.querySelector('.gallery-image');
                    if (img) {
                        const allImages = Array.from(document.querySelectorAll('.gallery-image'));
                        const startIndex = allImages.indexOf(img);
                        openSlideshow(startIndex);
                    }
                }
                return;
            }

            // Otherwise open clicked image (either the img or an img inside the clicked element)
            const img = e.target.matches('img') ? e.target : e.target.querySelector && e.target.querySelector('img');
            if (!img) return;

            e.preventDefault();
            const allImages = Array.from(document.querySelectorAll('.gallery-image'));
            const clickedIndex = allImages.indexOf(img);
            openModal(img.src, clickedIndex);
        });

        // Make images clickable
        const images = document.querySelectorAll('.gallery-image');
        images.forEach((img, index) => {
            img.style.cursor = 'pointer';
        });
    }

    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });
    if (modalOverlay) modalOverlay.addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && modal.classList.contains('show-modal')) closeModal(); });

    async function handleFileUpload(event) {
        const files = event.target.files; if (!files || files.length === 0) return;
        for (let file of files) {
            if (!file.type || !file.type.startsWith('image/')) { alert('Please upload image files only.'); continue; }
            const formData = new FormData(); formData.append('file', file);
                try {
                showLoading();
                const res = await fetch(`/upload${window.CURRENT_COLLECTION ? '/' + encodeURIComponent(window.CURRENT_COLLECTION) : ''}`, { method: 'POST', body: formData });
                const data = await res.json();
                if (data && data.success) addImageToGallery(data.url, data.tags || []); else alert(data.error || 'Upload failed');
            } catch (err) { console.error('upload error', err); alert('Error uploading image'); } finally { hideLoading(); }
        }
        event.target.value = '';
    }

    if (fileUpload) fileUpload.addEventListener('change', handleFileUpload);

    function addImageToGallery(imageUrl, tags = []) {
        if (!gallery) return;
        const div = document.createElement('div');
        div.className = 'gallery-item';
        div.setAttribute('data-aos','fade-up');

        // delete button overlay
        const filename = imageUrl.split('/').pop();
        div.setAttribute('data-filename', filename);
        
        const delBtn = document.createElement('button');
        delBtn.className = 'item-delete';
        delBtn.setAttribute('data-filename', filename);
        delBtn.innerHTML = '<i class="fas fa-trash"></i>';

        // slideshow button overlay
        const slideshowBtn = document.createElement('button');
        slideshowBtn.className = 'item-slideshow';
        slideshowBtn.setAttribute('data-filename', filename);
        slideshowBtn.innerHTML = '<i class="fas fa-play-circle"></i>';

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Gallery Image';
        img.className = 'gallery-image';

        div.appendChild(delBtn);
        div.appendChild(slideshowBtn);
        div.appendChild(img);
        
        // Add tags if available
        if (tags && tags.length > 0) {
            const tagsDiv = document.createElement('div');
            tagsDiv.className = 'image-tags';
            tags.slice(0, 4).forEach(tag => {
                const badge = document.createElement('span');
                badge.className = 'tag-badge';
                badge.textContent = tag;
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                });
                tagsDiv.appendChild(badge);
            });
            div.appendChild(tagsDiv);
        }
        
        gallery.appendChild(div);

        if (window.AOS && AOS.refresh) AOS.refresh();
    }

    function showLoading() { 
        if (loading) {
            loading.style.display = 'flex'; 
            loading.classList.add('visible');
            loading.classList.remove('hidden');
        }
    }
    function hideLoading() { 
        if (loading) {
            loading.style.display = 'none';
            loading.classList.remove('visible');
            loading.classList.add('hidden');
        }
    }

    document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    document.addEventListener('drop', (e) => { 
        e.preventDefault(); 
        e.stopPropagation();
        const files = e.dataTransfer.files; 
        if (!fileUpload) return; 
        fileUpload.files = files; 
        fileUpload.dispatchEvent(new Event('change'));
    });

    // ========== FULLSCREEN SLIDESHOW ==========
    const startSlideshowBtn = document.getElementById('startSlideshow');
    const slideshowOverlay = document.getElementById('slideshowOverlay');
    const slideshowClose = document.getElementById('slideshowClose');
    const slideshowImage = document.getElementById('slideshowImage');
    const slideshowQuote = document.getElementById('slideshowQuote');
    const slideshowCounter = document.getElementById('slideshowCounter');
    const slideshowPrev = document.getElementById('slideshowPrev');
    const slideshowNext = document.getElementById('slideshowNext');
    const slideshowPlayPause = document.getElementById('slideshowPlayPause');
    const slideshowFullscreen = document.getElementById('slideshowFullscreen');
    const slideshowSpeed = document.getElementById('slideshowSpeed');

    let slideshowIndex = 0;
    let slideshowTimer = null;
    let slideshowPlaying = true;
    
    // Load saved slideshow speed from localStorage, default to 4000ms
    let slideshowInterval = parseInt(localStorage.getItem('imgur.slideshowSpeed') || '4000', 10);
    
    // Set the speed selector to the saved value
    if (slideshowSpeed) {
        slideshowSpeed.value = slideshowInterval.toString();
    }

    async function fetchRandomQuote(collection, filename) {
        try {
            // Fetch tag-based quote with flexible matching
            let url = `/get-quote?_=${Date.now()}`;
            if (collection && filename) {
                url += `&collection=${encodeURIComponent(collection)}&filename=${encodeURIComponent(filename)}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            return {
                quote: data.quote || "Life is beautiful, enjoy every moment.",
                matchedTag: data.matched_tag || null
            };
        } catch (err) {
            console.error('Error fetching quote:', err);
            const quotes = [
                "Life is beautiful, enjoy every moment.",
                "Every picture tells a story.",
                "Capture the moments that matter.",
                "Beauty is everywhere, you just have to look.",
                "Memories are timeless treasures of the heart."
            ];
            return {
                quote: quotes[Math.floor(Math.random() * quotes.length)],
                matchedTag: null
            };
        }
    }

    async function updateSlideshowImage() {
        if (!allImages || allImages.length === 0) return;
        const imgSrc = allImages[slideshowIndex];
        if (slideshowImage) {
            slideshowImage.src = imgSrc;
        }
        if (slideshowCounter) {
            slideshowCounter.textContent = `${slideshowIndex + 1} / ${allImages.length}`;
        }
        const slideshowQuoteErrorEl = document.getElementById('slideshowQuoteError');
        if (slideshowQuoteErrorEl) slideshowQuoteErrorEl.style.display = 'none';

        // Extract collection and filename from image URL for quote matching
        const { collection, filename } = imageQuoteParams(imgSrc);

        // Fetch and display tags for the current image first
        await updateSlideshowTags(imgSrc);

        // Then fetch and display the tag-based static quote with highlighting — awaited so
        // it can never land after (and stomp) the AI-quote check that follows it.
        const result = await fetchRandomQuote(collection, filename);
        if (slideshowQuote) {
            slideshowQuote.textContent = `"${result.quote}"`;
        }
        if (result.matchedTag && result.matchedTag !== 'default') {
            highlightMatchedTag(result.matchedTag);
        }

        // Slideshow autoplay can advance every couple of seconds — much faster than an
        // LLM round-trip — so it only ever shows an already-cached AI quote (never kicks
        // off a new background generation) to avoid piling up concurrent HF calls for
        // images the viewer has already scrolled past. Use the "Generate AI Quote" button for that.
        updateQuoteGenButtonState(slideshowQuoteRegenBtn, false);
        refreshAiQuoteForElement(
            imgSrc, slideshowQuote, true,
            () => allImages[slideshowIndex] === imgSrc,
            false,
            hasAi => updateQuoteGenButtonState(slideshowQuoteRegenBtn, hasAi)
        );
    }
    
    async function updateSlideshowTags(imgSrc) {
        const tagsPanel = document.getElementById('slideshowTagsContent');
        if (!tagsPanel) return;

        const { collection, filename } = imageQuoteParams(imgSrc);
        try {
            tagsPanel.innerHTML = '<p class="tags-loading"><i class="fas fa-spinner fa-spin"></i> Loading details...</p>';

            const response = await fetch(`/api/tags/${collection}/${filename}`);
            const data = await response.json();

            if (!data.success) {
                tagsPanel.innerHTML = '<p class="tags-empty">No details available</p>';
                return;
            }

            const sections = [];
            if (data.models && data.models.length > 0) {
                sections.push(`
                    <div class="info-section">
                        <span class="info-section-label"><i class="fas fa-user"></i> Model</span>
                        ${data.models.map((name, i) => `<span class="info-badge badge-model" style="animation-delay:${i * 0.03}s">${escapeHtml(name)}</span>`).join('')}
                    </div>
                `);
            }
            if (data.body_parts && data.body_parts.length > 0) {
                sections.push(`
                    <div class="info-section">
                        <span class="info-section-label"><i class="fas fa-child-reaching"></i> Details</span>
                        ${data.body_parts.map((bp, i) => `<span class="info-badge badge-bodypart" style="animation-delay:${i * 0.03}s">${escapeHtml(bp.label)}</span>`).join('')}
                    </div>
                `);
            }
            if (data.tags && data.tags.length > 0) {
                sections.push(`
                    <div class="info-section">
                        <span class="info-section-label"><i class="fas fa-tags"></i> Tags</span>
                        ${data.tags.map((tag, i) => `<span class="info-badge badge-tag slideshow-tag-badge" data-tag="${escapeHtml(tag)}" style="animation-delay:${i * 0.03}s">${escapeHtml(tag)}</span>`).join('')}
                    </div>
                `);
            }

            tagsPanel.innerHTML = sections.length ? sections.join('') : '<p class="tags-empty">No tags, details, or model set for this image yet</p>';
        } catch (error) {
            console.error('Error fetching image details:', error);
            tagsPanel.innerHTML = '<p class="tags-error">Unable to load details</p>';
        }
    }
    
    function highlightMatchedTag(matchedKey) {
        const tagsPanel = document.getElementById('slideshowTagsContent');
        if (!tagsPanel) return;
        
        // Remove any existing highlights
        const badges = tagsPanel.querySelectorAll('.slideshow-tag-badge');
        badges.forEach(badge => {
            badge.classList.remove('tag-matched');
        });
        
        // Normalize the matched key for comparison
        const normalizedKey = matchedKey.replace(/_/g, ' ').replace(/-/g, ' ').toLowerCase().trim();
        
        // Find and highlight matching tag(s) using flexible matching
        badges.forEach(badge => {
            const tagText = badge.getAttribute('data-tag') || badge.textContent;
            const normalizedTag = tagText.replace(/_/g, ' ').replace(/-/g, ' ').toLowerCase().trim();
            
            // Check for match (exact, contains, or is contained)
            if (normalizedTag === normalizedKey || 
                normalizedTag.includes(normalizedKey) || 
                normalizedKey.includes(normalizedTag)) {
                badge.classList.add('tag-matched');
            }
        });
    }

    function startSlideshowAutoplay() {
        if (slideshowTimer) clearInterval(slideshowTimer);
        slideshowTimer = setInterval(async () => {
            if (slideshowPlaying) {
                slideshowIndex = (slideshowIndex + 1) % allImages.length;
                await updateSlideshowImage();
            }
        }, slideshowInterval);
    }

    function stopSlideshowAutoplay() {
        if (slideshowTimer) {
            clearInterval(slideshowTimer);
            slideshowTimer = null;
        }
    }

    function toggleSlideshowPlayPause() {
        slideshowPlaying = !slideshowPlaying;
        if (slideshowPlayPause) {
            const icon = slideshowPlayPause.querySelector('i');
            if (slideshowPlaying) {
                icon.className = 'fas fa-pause';
                slideshowPlayPause.classList.add('playing');
                startSlideshowAutoplay();
            } else {
                icon.className = 'fas fa-play';
                slideshowPlayPause.classList.remove('playing');
                stopSlideshowAutoplay();
            }
        }
    }

    async function openSlideshow(startIndex = 0) {
        // Populate allImages from gallery
        allImages = Array.from(document.querySelectorAll('.gallery-image')).map(img => img.src);
        
        if (!allImages || allImages.length === 0) {
            alert('No images to display in slideshow.');
            return;
        }
        // Set starting index, default to 0 if not provided or invalid
        slideshowIndex = (startIndex >= 0 && startIndex < allImages.length) ? startIndex : 0;
        slideshowPlaying = true;
        if (slideshowOverlay) {
            slideshowOverlay.classList.add('active');
            await updateSlideshowImage();
            startSlideshowAutoplay();
            // Update play/pause button state
            if (slideshowPlayPause) {
                const icon = slideshowPlayPause.querySelector('i');
                icon.className = 'fas fa-pause';
                slideshowPlayPause.classList.add('playing');
            }
            // Hide navbar during slideshow
            const navbar = document.querySelector('.navbar');
            if (navbar) navbar.style.display = 'none';
        }
    }

    function closeSlideshow() {
        if (slideshowOverlay) {
            slideshowOverlay.classList.remove('active');
            stopSlideshowAutoplay();
        }
        // Restore navbar when slideshow closes
        const navbar = document.querySelector('.navbar');
        if (navbar) navbar.style.display = '';
        // Exit fullscreen if active
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    }

    function toggleSlideshowFullscreen() {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
            // Enter fullscreen
            const elem = slideshowOverlay;
            if (elem.requestFullscreen) {
                elem.requestFullscreen();
            } else if (elem.webkitRequestFullscreen) {
                elem.webkitRequestFullscreen();
            }
            if (slideshowFullscreen) {
                const icon = slideshowFullscreen.querySelector('i');
                icon.className = 'fas fa-compress';
            }
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
            if (slideshowFullscreen) {
                const icon = slideshowFullscreen.querySelector('i');
                icon.className = 'fas fa-expand';
            }
        }
    }

    async function slideshowPrevImage() {
        if (allImages.length === 0) return;
        slideshowIndex = (slideshowIndex - 1 + allImages.length) % allImages.length;
        await updateSlideshowImage();
    }

    async function slideshowNextImage() {
        if (allImages.length === 0) return;
        slideshowIndex = (slideshowIndex + 1) % allImages.length;
        await updateSlideshowImage();
    }

    // Event listeners
    if (startSlideshowBtn) {
        startSlideshowBtn.addEventListener('click', openSlideshow);
    }

    if (slideshowClose) {
        slideshowClose.addEventListener('click', closeSlideshow);
    }

    if (slideshowPrev) {
        slideshowPrev.addEventListener('click', slideshowPrevImage);
    }

    if (slideshowNext) {
        slideshowNext.addEventListener('click', slideshowNextImage);
    }

    if (slideshowPlayPause) {
        slideshowPlayPause.addEventListener('click', toggleSlideshowPlayPause);
    }

    if (slideshowFullscreen) {
        slideshowFullscreen.addEventListener('click', toggleSlideshowFullscreen);
    }

    async function handleRegenerateQuoteClick(btn, imgSrc, quoteEl, wrapInQuotes, isStillCurrent, errorEl) {
        if (!btn || !imgSrc) return;
        const { collection, filename } = imageQuoteParams(imgSrc);
        btn.disabled = true;
        btn.classList.add('spinning');
        if (errorEl) errorEl.style.display = 'none';
        try {
            const quote = await generateAndSaveAiQuote(collection, filename);
            if (isStillCurrent() && quoteEl) {
                quoteEl.textContent = wrapInQuotes ? `"${quote}"` : quote;
                updateQuoteGenButtonState(btn, true);
            }
        } catch (err) {
            console.error('Error regenerating quote:', err);
            if (errorEl && isStillCurrent()) {
                errorEl.textContent = err.message;
                errorEl.style.display = 'block';
            }
        } finally {
            btn.disabled = false;
            btn.classList.remove('spinning');
        }
    }

    const modalQuoteRegenBtn = document.getElementById('modalQuoteRegenBtn');
    if (modalQuoteRegenBtn) {
        modalQuoteRegenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const imgSrc = allImages[currentImageIndex];
            handleRegenerateQuoteClick(
                modalQuoteRegenBtn,
                imgSrc,
                document.getElementById('modalQuote'),
                false,
                () => allImages[currentImageIndex] === imgSrc
            );
        });
    }

    const slideshowQuoteRegenBtn = document.getElementById('slideshowQuoteRegenBtn');
    const slideshowQuoteError    = document.getElementById('slideshowQuoteError');
    if (slideshowQuoteRegenBtn) {
        slideshowQuoteRegenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const imgSrc = allImages[slideshowIndex];
            handleRegenerateQuoteClick(
                slideshowQuoteRegenBtn,
                imgSrc,
                slideshowQuote,
                true,
                () => allImages[slideshowIndex] === imgSrc,
                slideshowQuoteError
            );
        });
    }

    const infoPanelToggle = document.getElementById('infoPanelToggle');
    const slideshowInfoPanel = document.getElementById('slideshowInfoPanel');
    if (infoPanelToggle && slideshowInfoPanel) {
        infoPanelToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const collapsed = slideshowInfoPanel.classList.toggle('collapsed');
            infoPanelToggle.setAttribute('aria-expanded', String(!collapsed));
        });
    }

    if (slideshowSpeed) {
        slideshowSpeed.addEventListener('change', (e) => {
            slideshowInterval = parseInt(e.target.value, 10);
            // Save the selected speed to localStorage
            localStorage.setItem('imgur.slideshowSpeed', slideshowInterval.toString());
            if (slideshowPlaying) {
                stopSlideshowAutoplay();
                startSlideshowAutoplay();
            }
        });
    }

    // Keyboard controls for slideshow
    document.addEventListener('keydown', (e) => {
        if (!slideshowOverlay || !slideshowOverlay.classList.contains('active')) return;
        
        switch(e.key) {
            case 'Escape':
                closeSlideshow();
                break;
            case 'ArrowLeft':
                slideshowPrevImage();
                break;
            case 'ArrowRight':
                slideshowNextImage();
                break;
            case ' ':
                e.preventDefault();
                toggleSlideshowPlayPause();
                break;
            case 'f':
            case 'F':
                toggleSlideshowFullscreen();
                break;
        }
    });

    // Handle fullscreen change
    document.addEventListener('fullscreenchange', () => {
        if (slideshowFullscreen) {
            const icon = slideshowFullscreen.querySelector('i');
            if (document.fullscreenElement) {
                icon.className = 'fas fa-compress';
            } else {
                icon.className = 'fas fa-expand';
            }
        }
    });

    document.addEventListener('webkitfullscreenchange', () => {
        if (slideshowFullscreen) {
            const icon = slideshowFullscreen.querySelector('i');
            if (document.webkitFullscreenElement) {
                icon.className = 'fas fa-compress';
            } else {
                icon.className = 'fas fa-expand';
            }
        }
    });

    // Tag filtering functionality
    const tagFilterButtons = document.querySelectorAll('.tag-filter-btn');
    const clearTagFilter = document.getElementById('clearTagFilter');
    const tagSearchInput = document.getElementById('tagSearchInput');
    const selectedTagsContainer = document.getElementById('selectedTagsContainer');
    const selectedTagsList = document.getElementById('selectedTagsList');
    const noTagsFound = document.getElementById('noTagsFound');
    
    let selectedTags = new Set(); // Multi-select tags

    // Filter gallery items based on selected tags
    function applyTagFilter() {
        const galleryItems = document.querySelectorAll('.gallery-item');
        
        let matchCount = 0;
        galleryItems.forEach((item, index) => {
            if (selectedTags.size === 0) {
                // No filter - show all
                item.classList.remove('hidden');
                item.classList.remove('aos-animate');
                matchCount++;
            } else {
                // Check if item has ANY of the selected tags
                // Get ALL tags (including hidden ones from data attribute)
                const imageTagsDiv = item.querySelector('.image-tags');
                let itemTags = [];
                
                if (imageTagsDiv && imageTagsDiv.dataset.allTags) {
                    // Use all tags from data attribute
                    itemTags = imageTagsDiv.dataset.allTags.split(',').map(t => t.trim()).filter(t => t);
                } else {
                    // Fallback to visible tags only
                    const tagBadges = item.querySelectorAll('.tag-badge');
                    itemTags = Array.from(tagBadges).map(badge => badge.textContent.trim()).filter(t => !t.startsWith('+'));
                }
                
                const hasMatchingTag = itemTags.some(tag => selectedTags.has(tag));
                
                if (hasMatchingTag) {
                    item.classList.remove('hidden');
                    // Remove AOS animation classes to show immediately
                    item.classList.add('aos-animate');
                    item.style.opacity = '1';
                    item.style.transform = 'none';
                    matchCount++;
                } else {
                    item.classList.add('hidden');
                }
            }
        });
        
        // Update UI
        updateSelectedTagsDisplay();
        
        // Show/hide clear button
        if (clearTagFilter) {
            clearTagFilter.style.display = selectedTags.size > 0 ? 'inline-block' : 'none';
        }
    }

    // Update the selected tags display
    function updateSelectedTagsDisplay() {
        if (!selectedTagsContainer || !selectedTagsList) return;

        if (selectedTags.size === 0) {
            selectedTagsContainer.style.display = 'none';
        } else {
            selectedTagsContainer.style.display = 'block';
            selectedTagsList.innerHTML = '';
            
            selectedTags.forEach(tag => {
                const tagChip = document.createElement('span');
                tagChip.className = 'selected-tag-chip';
                tagChip.innerHTML = `
                    <i class="fas fa-tag"></i> ${tag}
                    <button class="remove-tag-btn" data-tag="${tag}" aria-label="Remove ${tag}">
                        <i class="fas fa-times"></i>
                    </button>
                `;
                selectedTagsList.appendChild(tagChip);
            });

            // Add click handlers to remove buttons
            document.querySelectorAll('.remove-tag-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tag = btn.dataset.tag;
                    toggleTag(tag);
                });
            });
        }

        // Update tag button states
        tagFilterButtons.forEach(btn => {
            const tag = btn.dataset.tag;
            if (selectedTags.has(tag)) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    // Toggle tag selection
    function toggleTag(tag) {
        console.log('toggleTag called with:', tag, 'Type:', typeof tag);
        if (selectedTags.has(tag)) {
            selectedTags.delete(tag);
            console.log('Removed tag');
        } else {
            selectedTags.add(tag);
            console.log('Added tag');
        }
        console.log('Calling applyTagFilter...');
        applyTagFilter();
    }

    // Search/filter tag buttons
    function searchTags(query) {
        const lowerQuery = query.toLowerCase().trim();
        let visibleCount = 0;

        tagFilterButtons.forEach(btn => {
            const tag = btn.dataset.tag;
            if (tag && tag.toLowerCase().includes(lowerQuery)) {
                btn.style.display = 'inline-flex';
                visibleCount++;
            } else {
                btn.style.display = 'none';
            }
        });

        if (noTagsFound) {
            noTagsFound.style.display = visibleCount === 0 && query !== '' ? 'block' : 'none';
        }
    }

    // Tag button click handler
    tagFilterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tag = btn.dataset.tag;
            console.log('Tag clicked:', tag, 'Selected tags before:', Array.from(selectedTags));
            toggleTag(tag);
            console.log('Selected tags after:', Array.from(selectedTags));
        });
    });

    // Search input handler
    if (tagSearchInput) {
        tagSearchInput.addEventListener('input', (e) => {
            searchTags(e.target.value);
        });

        // Clear search on escape
        tagSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                tagSearchInput.value = '';
                searchTags('');
            }
        });
    }

    // Clear all filters
    if (clearTagFilter) {
        clearTagFilter.addEventListener('click', () => {
            selectedTags.clear();
            if (tagSearchInput) {
                tagSearchInput.value = '';
                searchTags('');
            }
            applyTagFilter();
        });
    }
});