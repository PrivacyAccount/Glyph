import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import AppDropdown from './AppDropdown';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function PlaylistPickerDialog({ title, videos = [], onCancel, onApplied }) {
    const { t } = useI18n();
    const [playlists, setPlaylists] = useState([]);
    const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
    const [newPlaylistName, setNewPlaylistName] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const videoPaths = useMemo(() => {
        return [...new Set((Array.isArray(videos) ? videos : [])
            .map(v => v?.filePath || v?.path || '')
            .map(v => String(v || '').trim())
            .filter(Boolean))];
    }, [videos]);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        fetch('/api/playlists')
            .then(res => res.json())
            .then(data => {
                if (cancelled) return;
                const items = Array.isArray(data) ? data : [];
                setPlaylists(items);
                if (items.length > 0) setSelectedPlaylistId(items[0].id);
            })
            .catch(() => {
                if (!cancelled) setPlaylists([]);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const canSubmit = videoPaths.length > 0 && (!!selectedPlaylistId || newPlaylistName.trim().length > 0) && !saving;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSaving(true);
        try {
            const body = {
                videoPaths,
                playlistId: selectedPlaylistId || undefined,
                playlistName: selectedPlaylistId ? undefined : newPlaylistName.trim(),
            };
            const res = await fetch('/api/playlists/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }
            const data = await res.json().catch(() => ({}));
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new Event('playlists-changed'));
            }
            if (typeof onApplied === 'function') {
                onApplied(data);
            }
        } finally {
            setSaving(false);
        }
    };

    useDialogHotkeys({
        open: true,
        onCancel,
        onConfirm: handleSubmit,
        canConfirm: canSubmit,
        allowEnterInInputs: true,
    });

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal playlist-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{title || t('addToPlaylist', 'Zur Playlist hinzuf�gen')}</h2>
                    <button className="modal-close" onClick={onCancel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="modal-body">
                    <div className="playlist-dialog-hint">{videoPaths.length} {t('selected', 'ausgew�hlt')}</div>

                    <div className="playlist-dialog-section">
                        <div className="playlist-dialog-label">{t('existingPlaylists', 'Vorhandene Playlists')}</div>
                        {loading ? (
                            <div className="playlist-dialog-empty">{t('loadingLoad', 'Lade...')}</div>
                        ) : playlists.length === 0 ? (
                            <div className="playlist-dialog-empty">{t('noPlaylistsYet', 'Noch keine Playlists')}</div>
                        ) : (
                            <div className="playlist-dialog-select-row">
                                <AppDropdown
                                    className="playlist-dialog-select"
                                    value={selectedPlaylistId}
                                    options={[
                                        { value: '', label: t('createPlaylist', 'Neue Playlist erstellen') },
                                        ...playlists.map((pl) => ({ value: pl.id, label: `${pl.name} (${pl.itemCount || 0})` })),
                                    ]}
                                    onChange={(val) => {
                                        setSelectedPlaylistId(val);
                                        setNewPlaylistName('');
                                    }}
                                />
                            </div>
                        )}
                    </div>

                    <div className="playlist-dialog-section">
                        <div className="playlist-dialog-label">{t('createPlaylist', 'Neue Playlist erstellen')}</div>
                        <div className="playlist-dialog-input-row">
                            <input
                                type="text"
                                value={newPlaylistName}
                                disabled={!!selectedPlaylistId}
                                onChange={(e) => {
                                    setNewPlaylistName(e.target.value);
                                    if (e.target.value.trim()) setSelectedPlaylistId('');
                                }}
                                placeholder={t('playlistNamePlaceholder', 'Playlist-Name')}
                            />
                        </div>
                    </div>
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>{t('cancel', 'Abbrechen')}</button>
                    <button className="btn btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
                        {saving ? t('saving', 'Speichere...') : t('addToPlaylist', 'Zur Playlist hinzuf�gen')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default PlaylistPickerDialog;


