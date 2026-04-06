import React, { useState, useRef, useEffect } from 'react';
import { useI18n } from '../i18n';

function RenameDialog({ currentName, onConfirm, onCancel }) {
    const { t } = useI18n();
    const [value, setValue] = useState(currentName || '');
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, []);

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && value.trim()) onConfirm(value.trim());
        if (e.key === 'Escape') onCancel();
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal rename-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{t('renameTitle', 'Name aendern')}</h2>
                    <button className="modal-close" onClick={onCancel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>
                <div className="modal-body">
                    <input
                        ref={inputRef}
                        type="text"
                        className="rename-input"
                        value={value}
                        onChange={e => setValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('renamePlaceholder', 'Neuer Name...')}
                    />
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>{t('cancel', 'Abbrechen')}</button>
                    <button className="btn btn-primary" onClick={() => value.trim() && onConfirm(value.trim())} disabled={!value.trim()}>{t('saveLabel', 'Speichern')}</button>
                </div>
            </div>
        </div>
    );
}

export default RenameDialog;

