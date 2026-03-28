import { ui } from './state.js';

export function toFileSrc(filePath) {
    if (!filePath) return '';
    return encodeURI(`file:///${filePath.replace(/\\/g, '/')}`);
}

export function getDisplayPath(item) {
    return item.convertedPath || item.thumbnailPath || item.path;
}

export function getFullSizePath(item) {
    return item.convertedPath || item.path;
}

export function formatDate(timestamp) {
    if (timestamp == null || !Number.isFinite(Number(timestamp))) return '';
    return new Date(timestamp).toLocaleString();
}

export function nodeCountLabel(cluster) {
    const items = cluster.items || [];
    const videos = items.filter((item) => item.type === 'video').length;
    const images = items.length - videos;
    if (videos > 0 && images > 0) return `${items.length} items (${images} photos, ${videos} videos)`;
    if (videos > 0) return `${videos} video${videos > 1 ? 's' : ''}`;
    return `${images} photo${images > 1 ? 's' : ''}`;
}

let _hintTimer = 0;
export function showIndexingHint(message) {
    if (!ui.indexingHint) return;
    clearTimeout(_hintTimer);
    ui.indexingHint.textContent = message;
    ui.indexingHint.classList.remove('hidden');
    _hintTimer = setTimeout(() => {
        ui.indexingHint.classList.add('hidden');
    }, 4000);
}

export function renderEmptyState(message) {
    if (!ui.gallery || !ui.connections) return;
    ui.gallery.innerHTML = '';
    ui.connections.innerHTML = '';
    
    // Reset gallery positioning and styles
    ui.gallery.style.transform = 'none';
    ui.gallery.style.left = '0';
    ui.gallery.style.top = '0';
    ui.gallery.style.width = '100%';
    ui.gallery.style.height = '100%';
    ui.gallery.style.position = 'relative'; // Ensure it fills workspace properly
    
    const wrapper = document.createElement('div');
    wrapper.className = 'empty-state-view';
    
    // Add a nice icon (camera with slash)
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="1" y1="1" x2="23" y2="23"></line>
        <path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34"></path>
        <circle cx="12" cy="13" r="3"></circle>
    </svg>`;
    
    const title = document.createElement('h2');
    title.innerText = 'No memories found';
    
    const text = document.createElement('p');
    text.innerText = message;
    
    wrapper.appendChild(icon);
    wrapper.appendChild(title);
    wrapper.appendChild(text);
    
    ui.gallery.appendChild(wrapper);
}
