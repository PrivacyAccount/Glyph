import { useEffect } from 'react';

function isTextInputLike(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

export default function useSelectionHotkeys({ enabled = true, onSelectAll, onClearSelection }) {
    useEffect(() => {
        if (!enabled) return undefined;

        const onKeyDown = (e) => {
            if (e.defaultPrevented) return;
            if (isTextInputLike(e.target)) return;

            const key = String(e.key || '').toLowerCase();
            const selectAllChord = (e.ctrlKey || e.metaKey) && !e.altKey && key === 'a';

            if (selectAllChord) {
                e.preventDefault();
                if (typeof onSelectAll === 'function') onSelectAll();
                return;
            }

            if (key === 'escape') {
                if (typeof onClearSelection === 'function') onClearSelection();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [enabled, onSelectAll, onClearSelection]);
}

