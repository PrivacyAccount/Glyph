import { useEffect, useState } from 'react';

const SETTINGS_KEY = 'glyph_settings';
const SETTINGS_CHANGED_EVENT = 'glyph-settings-changed';

function readThumbnailHeatmapEnabled() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY) || '{}';
        const parsed = JSON.parse(raw);
        if (typeof parsed?.showThumbnailHeatmap === 'boolean') {
            return parsed.showThumbnailHeatmap;
        }
        return true;
    } catch {
        return true;
    }
}

export default function useThumbnailHeatmapMode() {
    const [enabled, setEnabled] = useState(readThumbnailHeatmapEnabled);

    useEffect(() => {
        const refresh = () => setEnabled(readThumbnailHeatmapEnabled());
        window.addEventListener('storage', refresh);
        window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
        return () => {
            window.removeEventListener('storage', refresh);
            window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
        };
    }, []);

    return enabled;
}
