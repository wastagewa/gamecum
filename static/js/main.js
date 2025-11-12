// Initialize AOS (Animate on Scroll)
AOS.init({
    duration: 800,
    easing: 'ease-out',
    once: true
});

document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const fileUpload = document.getElementById('file-upload');
    const gallery = document.getElementById('gallery');
    const modal = document.getElementById('imageModal');
    const modalImg = document.getElementById('modalImage');
    const closeModalBtn = document.querySelector('.close-modal');
    const modalOverlay = document.querySelector('.modal-overlay');
    const loading = document.getElementById('loading');

// Event Listeners
fileUpload.addEventListener('change', handleFileUpload);

// Initialize existing images
document.querySelectorAll('.gallery-item img').forEach(img => {
    img.addEventListener('click', (e) => {
        e.preventDefault();
        openModal(e.target.src);
    });
});

closeModalBtn.addEventListener('click', () => {
    modal.classList.remove('show-modal');
    setTimeout(() => {
        modal.style.display = 'none';
    }, 500); // Match the transition duration
});

window.addEventListener('click', (e) => {
    if (e.target === modal) {
        modal.classList.remove('show-modal');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 500); // Match the transition duration
    }
});

// Handle escape key
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'block') {
        modal.classList.remove('show-modal');
        setTimeout(() => {
            modal.style.display = 'none';
        }, 500);
    }
});

// Handle file upload
async function handleFileUpload(event) {
    const files = event.target.files;
    
    for (let file of files) {
        if (!file.type.startsWith('image/')) {
            alert('Please upload image files only.');
            continue;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            showLoading();
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();
            
            if (data.success) {
                addImageToGallery(data.url);
            } else {
                alert(data.error || 'Error uploading image');
            }
        } catch (error) {
            console.error('Error:', error);
            alert('Error uploading image');
        } finally {
            hideLoading();
        }
    }

    // Clear the file input
    event.target.value = '';
}

// Add new image to gallery
function addImageToGallery(imageUrl) {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    div.setAttribute('data-aos', 'fade-up');
    
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'Gallery Image';
    img.onclick = (e) => {
        e.preventDefault();
        openModal(imageUrl);
    };
    
    div.appendChild(img);
    gallery.appendChild(div);
    
    // Refresh AOS for new elements
    AOS.refresh();
}

// Open modal with clicked image
function openModal(imageUrl) {
    // Remove any existing event listeners
    modalImg.removeEventListener('mousemove', handleModalImageTilt);
    modalImg.removeEventListener('mouseleave', resetModalImageTilt);
    
    // Set initial display
    modal.style.display = 'block';
    modalImg.style.opacity = '0';
    modalImg.src = imageUrl;
    
    // Force reflow and add show class
    modal.offsetHeight;
    modal.classList.add('show-modal');
    
    // Fade in the image
    setTimeout(() => {
        modalImg.style.opacity = '1';
    }, 100);
    
    // Add tilt effect to modal image
    modalImg.addEventListener('mousemove', handleModalImageTilt);
    modalImg.addEventListener('mouseleave', resetModalImageTilt);
}

function handleModalImageTilt(e) {
    const box = e.currentTarget;
    const boxRect = box.getBoundingClientRect();
    const boxCenterX = boxRect.left + boxRect.width / 2;
    const boxCenterY = boxRect.top + boxRect.height / 2;
    const angleY = -(e.clientX - boxCenterX) / 50;
    const angleX = (e.clientY - boxCenterY) / 50;
    
    box.style.transform = `translate(-50%, -50%) rotateX(${angleX}deg) rotateY(${angleY}deg) scale(1.02)`;
}

function resetModalImageTilt(e) {
    e.currentTarget.style.transform = 'translate(-50%, -50%) rotateX(0) rotateY(0) scale(1)';
}

// Loading spinner functions
function showLoading() {
    loading.style.display = 'flex';
    loading.style.opacity = '0';
    // Force reflow
    loading.offsetHeight;
    loading.style.opacity = '1';
}

function hideLoading() {
    loading.style.display = 'none';
}

// Handle drag and drop
document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
});

document.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const files = e.dataTransfer.files;
    fileUpload.files = files;
    fileUpload.dispatchEvent(new Event('change'));
});
});