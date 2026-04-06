import { useEffect, useState } from 'react';

const SETTINGS_KEY = 'glyph_settings';
const SETTINGS_CHANGED_EVENT = 'glyph-settings-changed';

function readHoverPreviewEnabled() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY) || '{}';
        const parsed = JSON.parse(raw);
        if (typeof parsed?.hoverPreviewEnabled === 'boolean') return parsed.hoverPreviewEnabled;
        return false;
    } catch {
        return false;
    }
}

export default function useHoverPreviewEnabled() {
    const [enabled, setEnabled] = useState(readHoverPreviewEnabled);

    useEffect(() => {
        const refresh = (event) => {
            const value = event?.detail?.hoverPreviewEnabled;
            if (typeof value === 'boolean') {
                setEnabled(value);
                return;
            }
            setEnabled(readHoverPreviewEnabled());
        };
        window.addEventListener('storage', refresh);
        window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
        return () => {
            window.removeEventListener('storage', refresh);
            window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh);
        };
    }, []);

    return enabled;
}
