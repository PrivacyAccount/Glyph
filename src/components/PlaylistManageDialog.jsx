import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function PlaylistManageDialog({ mode = 'rename', playlistName = '', onCancel, onConfirm }) {
    const { t } = useI18n();
    const [name, setName] = useState(String(playlistName || ''));
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        setName(String(playlistName || ''));
    }, [playlistName]);

    const isRename = mode === 'rename';
    const title = isRename
        ? t('renamePlaylist', 'Playlist umbenennen')
        : t('deletePlaylist', 'Playlist löschen');

    const canSubmit = useMemo(() => {
        if (!isRename) return true;
        const next = String(name || '').trim();
        const current = String(playlistName || '').trim();
        return next.length > 0 && next !== current;
    }, [isRename, name, playlistName]);

    const handleSubmit = async () => {
        if (submitting || !canSubmit) return;
        setSubmitting(true);
        try {
            const payload = isRename ? { name: String(name || '').trim() } : {};
            await Promise.resolve(onConfirm?.(payload));
        } finally {
            setSubmitting(false);
        }
    };

    useDialogHotkeys({
        open: true,
        onCancel,
        onConfirm: handleSubmit,
        canConfirm: !submitting && canSubmit,
        allowEnterInInputs: true,
    });

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal playlist-manage-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{title}</h2>
                    <button className="modal-close" onClick={onCancel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="modal-body">
                    {isRename ? (
                        <div className="playlist-manage-field">
                            <div className="playlist-dialog-label">{t('playlistName', 'Playlist-Name')}</div>
                            <div className="playlist-dialog-input-row">
                                <input
                                    autoFocus
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    placeholder={t('playlistNamePlaceholder', 'Playlist-Name')}
                                />
                            </div>
                        </div>
                    ) : (
                        <div className="playlist-manage-warning">
                            {t('deletePlaylistConfirm', 'Playlist löschen?')}
                            <strong>{playlistName}</strong>
                        </div>
                    )}
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>{t('cancel', 'Abbrechen')}</button>
                    <button
                        className={`btn ${isRename ? 'btn-primary' : 'btn-danger'}`}
                        onClick={handleSubmit}
                        disabled={!canSubmit || submitting}
                    >
                        {isRename ? t('save', 'Speichern') : t('delete', 'Löschen')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default PlaylistManageDialog;

