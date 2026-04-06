import { useEffect } from 'react';

function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (target.isContentEditable) return true;
    return false;
}

function useDialogHotkeys({
    open = true,
    onCancel,
    onConfirm,
    canConfirm = true,
    allowEnterInInputs = false,
}) {
    useEffect(() => {
        if (!open) return undefined;

        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                if (typeof onCancel === 'function') onCancel();
                return;
            }

            if (event.key !== 'Enter') return;
            if (event.defaultPrevented) return;
            if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
            if (!canConfirm || typeof onConfirm !== 'function') return;
            if (!allowEnterInInputs && isEditableTarget(event.target)) return;

            event.preventDefault();
            onConfirm();
        };

        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open, onCancel, onConfirm, canConfirm, allowEnterInInputs]);
}

export default useDialogHotkeys;
