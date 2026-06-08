import React, { useState } from 'react';
import { useI18n } from '../i18n';

function PlaylistManageDialog({ mode = 'rename', playlistName = '', onCancel, onConfirm }) {
    const { t } = useI18n();
    const [name, setName] = useState(playlistName);
    const [saving, setSaving] = useState(false);

    const isRename = mode === 'rename';
    const isDelete = mode === 'delete';

    const handleSubmit = async () => {
        if (saving) return;
        if (isRename && !name.trim()) return;
        setSaving(true);
        try {
            await onConfirm?.({ name: name.trim() });
        } finally {
            setSaving(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !saving) {
            e.preventDefault();
            handleSubmit();
        }
        if (e.key === 'Escape') {
            onCancel?.();
        }
    };

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
                <div className="modal-header">
                    <h2 className="modal-title">
                        {isRename ? t('renamePlaylist', 'Playlist umbenennen') : t('deletePlaylist', 'Playlist löschen')}
                    </h2>
                    <button className="modal-close" onClick={onCancel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="modal-body">
                    {isRename ? (
                        <div className="playlist-dialog-section">
                            <div className="playlist-dialog-label">{t('playlistName', 'Playlist-Name')}</div>
                            <input
                                type="text"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder={t('playlistNamePlaceholder', 'Playlist-Name')}
                                autoFocus
                            />
                        </div>
                    ) : (
                        <div className="playlist-dialog-hint">
                            {t('confirmDeletePlaylist', 'Möchten Sie die Playlist "{name}" wirklich löschen?').replace('{name}', playlistName)}
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>{t('cancel', 'Abbrechen')}</button>
                    <button
                        className={`btn ${isDelete ? 'btn-danger' : 'btn-primary'}`}
                        onClick={handleSubmit}
                        disabled={saving || (isRename && !name.trim())}
                    >
                        {saving
                            ? t('saving', 'Speichere...')
                            : isRename
                                ? t('rename', 'Umbenennen')
                                : t('delete', 'Löschen')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default PlaylistManageDialog;
