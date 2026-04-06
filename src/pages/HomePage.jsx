import React, { useState, useEffect, useRef, useMemo } from 'react';
import { flushSync } from 'react-dom';
import PlaylistPickerDialog from '../components/PlaylistPickerDialog';
import VideoCard from '../components/VideoCard';
import TagDialog from '../components/TagDialog';
import PlaylistManageDialog from '../components/PlaylistManageDialog';
import PropertiesDialog from '../components/PropertiesDialog';
import ThumbnailTimestampDialog from '../components/ThumbnailTimestampDialog';
import { useI18n } from '../i18n';
import { clearWatchProgress, fetchContinueWatchingList, isContinueWatchingEnabled, restoreWatchProgress, watchProgressEvents } from '../services/watchProgress';
import useSelectionHotkeys from '../hooks/useSelectionHotkeys';

function HomePage({ libraries, playlists = [], onSelect, onPlay, onOpenPlaylists, onLibrariesReordered, onOpenFunscriptManager, onOpenPerformer }) {
    const { t } = useI18n();
    const [contextMenu, setContextMenu] = useState(null);
    const [toast, setToast] = useState(null);
    const [toastClosing, setToastClosing] = useState(false);
    const [tagDialog, setTagDialog] = useState(null);
    const [posterKeys, setPosterKeys] = useState({}); // force re-render after upload
    const [hiddenPosterLibraryIds, setHiddenPosterLibraryIds] = useState(() => new Set());
    const [recentAddedByLibrary, setRecentAddedByLibrary] = useState({});
    const [recentFadeState, setRecentFadeState] = useState({});
    const [playlistPreviewById, setPlaylistPreviewById] = useState({});
    const [playlistPreviewErrorById, setPlaylistPreviewErrorById] = useState({});
    const [playlistPosterById, setPlaylistPosterById] = useState({});
    const [continueWatchingItems, setContinueWatchingItems] = useState([]);
    const [continueWatchingEnabled, setContinueWatchingEnabledState] = useState(isContinueWatchingEnabled());
    const [selectedHomeVideoKeys, setSelectedHomeVideoKeys] = useState([]);
    const [continueDeleteDialog, setContinueDeleteDialog] = useState(null);
    const [batchHomeTagDialog, setBatchHomeTagDialog] = useState(null);
    const [playlistDialog, setPlaylistDialog] = useState(null);
    const [playlistManageDialog, setPlaylistManageDialog] = useState(null);
    const [propertiesVideo, setPropertiesVideo] = useState(null);
    const [thumbTimestampDialogVideo, setThumbTimestampDialogVideo] = useState(null);
    const [libraryOrderIds, setLibraryOrderIds] = useState([]);
    const [draggingLibraryId, setDraggingLibraryId] = useState('');
    const [playlistOrderIds, setPlaylistOrderIds] = useState([]);
    const [draggingHomePlaylistId, setDraggingHomePlaylistId] = useState('');
    const recentRowRefs = useRef({});
    const fadeExitTimersRef = useRef({});
    const libraryCardRefs = useRef(new Map());
    const libraryHoldTimerRef = useRef(null);
    const libraryDragStateRef = useRef(null);
    const libraryOrderIdsRef = useRef([]);
    const playlistCardRefs = useRef(new Map());
    const playlistHoldTimerRef = useRef(null);
    const playlistDragStateRef = useRef(null);
    const playlistOrderIdsRef = useRef([]);
    const toastTimerRef = useRef(null);
    const toastCloseTimerRef = useRef(null);
    const libraryFlipAnimationsRef = useRef(new Map());
    const suppressLibraryClickRef = useRef(false);
    const suppressPlaylistClickRef = useRef(false);
    const selectionAnchorRef = useRef('');
    const recentEnabledLibraries = useMemo(() => (Array.isArray(libraries) ? libraries.filter(lib => lib?.showRecentAdded !== false) : []), [libraries]);
    const continueTrackingLibraryIds = useMemo(() => (
        new Set((Array.isArray(libraries) ? libraries : [])
            .filter((lib) => lib?.trackContinueWatching !== false)
            .map((lib) => String(lib.id)))
    ), [libraries]);
    const orderedLibraries = useMemo(() => {
        const incoming = Array.isArray(libraries) ? libraries : [];
        const byId = new Map(incoming.map((lib) => [String(lib.id), lib]));
        const ordered = [];
        for (const id of libraryOrderIds) {
            const hit = byId.get(String(id));
            if (hit) ordered.push(hit);
        }
        for (const lib of incoming) {
            if (!ordered.some((entry) => String(entry.id) === String(lib.id))) ordered.push(lib);
        }
        return ordered;
    }, [libraries, libraryOrderIds]);
    const orderedPlaylists = useMemo(() => {
        const incoming = Array.isArray(playlists) ? playlists : [];
        const byId = new Map(incoming.map((pl) => [String(pl.id), pl]));
        const ordered = [];
        for (const id of playlistOrderIds) {
            const hit = byId.get(String(id));
            if (hit) ordered.push(hit);
        }
        for (const pl of incoming) {
            if (!ordered.some((entry) => String(entry.id) === String(pl.id))) ordered.push(pl);
        }
        return ordered;
    }, [playlists, playlistOrderIds]);
    const dismissToast = (delayMs = 0) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
        const run = () => {
            setToastClosing(true);
            toastCloseTimerRef.current = setTimeout(() => {
                setToast(null);
                setToastClosing(false);
            }, 220);
        };
        if (delayMs > 0) toastTimerRef.current = setTimeout(run, delayMs);
        else run();
    };

    const showToast = (msg, type = 'success', action = null) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
        setToastClosing(false);
        setToast({ message: msg, type, action });
        dismissToast(action ? 6000 : 3000);
    };

    useEffect(() => {
        const incomingIds = (Array.isArray(libraries) ? libraries : []).map((lib) => String(lib.id));
        setLibraryOrderIds((prev) => {
            const kept = (Array.isArray(prev) ? prev : []).filter((id) => incomingIds.includes(String(id)));
            const add = incomingIds.filter((id) => !kept.includes(String(id)));
            return [...kept, ...add];
        });
    }, [libraries]);

    useEffect(() => {
        const incomingIds = (Array.isArray(playlists) ? playlists : []).map((pl) => String(pl.id));
        setPlaylistOrderIds((prev) => {
            const kept = (Array.isArray(prev) ? prev : []).filter((id) => incomingIds.includes(String(id)));
            const add = incomingIds.filter((id) => !kept.includes(String(id)));
            return [...kept, ...add];
        });
    }, [playlists]);

    useEffect(() => {
        libraryOrderIdsRef.current = libraryOrderIds;
    }, [libraryOrderIds]);

    useEffect(() => {
        playlistOrderIdsRef.current = playlistOrderIds;
    }, [playlistOrderIds]);

    useEffect(() => {
        const refreshContinueWatching = () => {
            const enabled = isContinueWatchingEnabled();
            setContinueWatchingEnabledState(enabled);
            if (!enabled) {
                setContinueWatchingItems([]);
                return;
            }
            fetchContinueWatchingList(20, { allowedLibraryIds: continueTrackingLibraryIds })
                .then((items) => setContinueWatchingItems(Array.isArray(items) ? items : []))
                .catch(() => setContinueWatchingItems([]));
        };

        refreshContinueWatching();
        window.addEventListener(watchProgressEvents.changed, refreshContinueWatching);
        window.addEventListener(watchProgressEvents.settingsChanged, refreshContinueWatching);
        window.addEventListener('storage', refreshContinueWatching);
        return () => {
            window.removeEventListener(watchProgressEvents.changed, refreshContinueWatching);
            window.removeEventListener(watchProgressEvents.settingsChanged, refreshContinueWatching);
            window.removeEventListener('storage', refreshContinueWatching);
        };
    }, [continueTrackingLibraryIds]);
    useEffect(() => {
        try {
            const rawMap = localStorage.getItem('playlistPosterById');
            const parsed = rawMap ? JSON.parse(rawMap) : {};
            setPlaylistPosterById(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
            setPlaylistPosterById({});
        }
    }, []);

    const persistPlaylistPosterMap = (nextMap) => {
        setPlaylistPosterById(nextMap);
        try {
            localStorage.setItem('playlistPosterById', JSON.stringify(nextMap));
            window.dispatchEvent(new Event('playlist-posters-changed'));
        } catch { }
    };
    useEffect(() => {
        let cancelled = false;
        if (!Array.isArray(recentEnabledLibraries) || recentEnabledLibraries.length === 0) {
            setRecentAddedByLibrary({});
            return;
        }

        (async () => {
            const rows = await Promise.all(recentEnabledLibraries.map(async (lib) => {
                try {
                    const params = new URLSearchParams({ sort: 'date', limit: '10' });
                    const res = await fetch(`/api/libraries/${lib.id}/videos?${params.toString()}`);
                    if (!res.ok) return [lib.id, []];
                    const data = await res.json();
                    return [lib.id, Array.isArray(data) ? data : []];
                } catch {
                    return [lib.id, []];
                }
            }));
            if (!cancelled) {
                setRecentAddedByLibrary(Object.fromEntries(rows));
            }
        })();

        return () => { cancelled = true; };
    }, [recentEnabledLibraries]);

    useEffect(() => {
        let cancelled = false;
        if (!Array.isArray(playlists) || playlists.length === 0) {
            setPlaylistPreviewById({});
            setPlaylistPreviewErrorById({});
            return;
        }

        (async () => {
            const rows = await Promise.all((playlists || []).slice(0, 20).map(async (pl) => {
                try {
                    const res = await fetch(`/api/playlists/${pl.id}/videos`);
                    if (!res.ok) return [pl.id, null];
                    const data = await res.json();
                    const firstVideo = Array.isArray(data?.videos) && data.videos.length > 0 ? data.videos[0] : null;
                    return [pl.id, firstVideo];
                } catch {
                    return [pl.id, null];
                }
            }));
            if (!cancelled) {
                setPlaylistPreviewById(Object.fromEntries(rows));
                setPlaylistPreviewErrorById({});
            }
        })();

        return () => { cancelled = true; };
    }, [playlists]);

    const clearFadeExitTimer = (key, side) => {
        const timerKey = `${key}:${side}`;
        const timer = fadeExitTimersRef.current[timerKey];
        if (timer) {
            clearTimeout(timer);
            delete fadeExitTimersRef.current[timerKey];
        }
    };

    const setFadeStateAnimated = (key, left, right) => {
        setRecentFadeState(prev => {
            const current = prev[key] || {};
            return {
                ...prev,
                [key]: {
                    ...current,
                    left,
                    right,
                    leftFx: left ? true : !!current.leftFx,
                    rightFx: right ? true : !!current.rightFx,
                },
            };
        });

        if (left) {
            clearFadeExitTimer(key, 'left');
        } else {
            clearFadeExitTimer(key, 'left');
            fadeExitTimersRef.current[`${key}:left`] = setTimeout(() => {
                setRecentFadeState(prev => {
                    const current = prev[key] || {};
                    return { ...prev, [key]: { ...current, leftFx: false } };
                });
                delete fadeExitTimersRef.current[`${key}:left`];
            }, 240);
        }

        if (right) {
            clearFadeExitTimer(key, 'right');
        } else {
            clearFadeExitTimer(key, 'right');
            fadeExitTimersRef.current[`${key}:right`] = setTimeout(() => {
                setRecentFadeState(prev => {
                    const current = prev[key] || {};
                    return { ...prev, [key]: { ...current, rightFx: false } };
                });
                delete fadeExitTimersRef.current[`${key}:right`];
            }, 240);
        }
    };

    useEffect(() => {
        const updateAll = () => {
            const librariesRow = recentRowRefs.current.__libraries;
            if (librariesRow) {
                const max = Math.max(0, librariesRow.scrollWidth - librariesRow.clientWidth);
                const left = librariesRow.scrollLeft > 2;
                const right = librariesRow.scrollLeft < max - 2;
                setFadeStateAnimated('__libraries', left, right);
            }
            for (const lib of recentEnabledLibraries || []) {
                const row = recentRowRefs.current[lib.id];
                if (!row) continue;
                const max = Math.max(0, row.scrollWidth - row.clientWidth);
                const left = row.scrollLeft > 2;
                const right = row.scrollLeft < max - 2;
                setFadeStateAnimated(lib.id, left, right);
            }
            const playlistsRow = recentRowRefs.current.__playlists;
            if (playlistsRow) {
                const max = Math.max(0, playlistsRow.scrollWidth - playlistsRow.clientWidth);
                const left = playlistsRow.scrollLeft > 2;
                const right = playlistsRow.scrollLeft < max - 2;
                setFadeStateAnimated('__playlists', left, right);
            }
            const continueRow = recentRowRefs.current.__continue;
            if (continueRow) {
                const max = Math.max(0, continueRow.scrollWidth - continueRow.clientWidth);
                const left = continueRow.scrollLeft > 2;
                const right = continueRow.scrollLeft < max - 2;
                setFadeStateAnimated('__continue', left, right);
            }
        };

        const timer = setTimeout(updateAll, 30);
        window.addEventListener('resize', updateAll);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('resize', updateAll);
        };
    }, [recentEnabledLibraries, recentAddedByLibrary, playlists, playlistPreviewById, continueWatchingItems]);

    useEffect(() => () => {
        Object.values(fadeExitTimersRef.current).forEach(clearTimeout);
        fadeExitTimersRef.current = {};
        libraryFlipAnimationsRef.current.forEach((anim) => {
            try { anim.cancel(); } catch { }
        });
        libraryFlipAnimationsRef.current.clear();
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryHoldTimerRef.current = null;
        libraryDragStateRef.current = null;
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
        window.removeEventListener('mousemove', onLibraryMouseMove);
        window.removeEventListener('mouseup', onLibraryMouseUp);
        document.body.style.userSelect = '';
    }, []);

    const pickImage = () => {
        return new Promise(resolve => {
            if (window.electronAPI?.selectImage) {
                window.electronAPI.selectImage().then(r => resolve(r ? r.base64 : null)).catch(() => resolve(null));
                return;
            }
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/gif,image/webp';
            input.onchange = () => {
                const file = input.files[0];
                if (!file) return resolve(null);
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(file);
            };
            input.click();
        });
    };

    const handleUploadPoster = async (lib) => {
        const imageData = await pickImage();
        if (!imageData) return;
        try {
            const res = await fetch('/api/poster/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: lib.path, imageData }),
            });
            if (!res.ok) throw new Error(t('uploadFailed', 'Upload fehlgeschlagen'));
            setPosterKeys(prev => ({ ...prev, [lib.id]: Date.now() }));
            setHiddenPosterLibraryIds(prev => {
                const next = new Set(prev);
                next.delete(String(lib.id));
                return next;
            });
            showToast(t('posterUpdated', 'Poster aktualisiert!'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        }
    };

    const handleRemovePoster = async (lib) => {
        try {
            const res = await fetch('/api/poster/remove', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: lib.path }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('unknown', 'Unbekannt'));
            setHiddenPosterLibraryIds(prev => {
                const next = new Set(prev);
                next.add(String(lib.id));
                return next;
            });
            setPosterKeys(prev => ({ ...prev, [lib.id]: Date.now() }));
            showToast(t('thumbnailRemoved', 'Thumbnail entfernt'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err?.message || ''), 'error');
        }
    };

    const handleEditVideoTags = async (video, libId) => {
        const videoId = String(video?.id || '').trim();
        const videoPath = String(video?.filePath || video?.path || '').trim() || null;
        let latestTags = Array.isArray(video?.tags) ? video.tags : [];
        if (videoId) {
            try {
                const res = await fetch(`/api/tags/video/${encodeURIComponent(videoId)}`);
                const data = await res.json().catch(() => ({}));
                if (res.ok && Array.isArray(data?.tags)) latestTags = data.tags;
            } catch {
                // Keep local tags fallback when lookup fails.
            }
        }
        setTagDialog({
            videoId: videoId || video.id,
            videoPath,
            libId,
            title: `${t('editTags', 'Tags bearbeiten')}: ${video.title}`,
            tags: latestTags,
        });
    };

    const handleSaveVideoTags = async (tags) => {
        if (!tagDialog) return;
        try {
            const res = await fetch(`/api/tags/video/${tagDialog.videoId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags, videoPath: tagDialog.videoPath || null }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }

            setRecentAddedByLibrary(prev => {
                const next = { ...prev };
                Object.keys(next).forEach((libKey) => {
                    next[libKey] = (next[libKey] || []).map((v) => (
                        (v.id === tagDialog.videoId || (tagDialog.videoPath && v.filePath === tagDialog.videoPath))
                            ? { ...v, tags: Array.isArray(tags) ? tags : [] }
                            : v
                    ));
                });
                return next;
            });
            setContinueWatchingItems(prev => (
                (prev || []).map((entry) => (
                    (String(entry?.id || '') === String(tagDialog.videoId || '')
                        || (tagDialog.videoPath && entry?.filePath === tagDialog.videoPath))
                        ? { ...entry, tags: Array.isArray(tags) ? tags : [] }
                        : entry
                ))
            ));

            setTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const openPlaylistDialogForVideos = (videos, title) => {
        const normalized = Array.isArray(videos) ? videos.filter(v => !!(v?.filePath || v?.path)) : [];
        if (normalized.length === 0) return;
        setPlaylistDialog({
            title: title || `${t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}: ${normalized.length} ${t('videos', 'Videos')}`,
            videos: normalized,
        });
    };

    const handleApplyPlaylist = (data) => {
        const addedCount = Number(data?.addedCount || 0);
        const playlistName = data?.playlist?.name || t('playlists', 'Playlists');
        showToast(`${addedCount} ${t('addedToPlaylist', 'zur Playlist hinzugef\u00FCgt')}: ${playlistName}`);
        setPlaylistDialog(null);
    };

    const restoreContinueEntries = async (entries) => {
        const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
        if (!list.length) return;
        for (const entry of list) restoreWatchProgress(entry);
        const refreshed = await fetchContinueWatchingList(20, { allowedLibraryIds: continueTrackingLibraryIds }).catch(() => []);
        setContinueWatchingItems(Array.isArray(refreshed) ? refreshed : []);
        showToast(t('undone', 'Undone'), 'success');
    };

    const removeFromContinueWatching = (video) => {
        const id = String(video?.id || '').trim();
        if (!id) return;
        const removed = (continueWatchingItems || [])
            .filter((entry) => String(entry?.id || '').trim() === id)
            .map((entry) => ({ ...entry }));
        clearWatchProgress(id);
        setContinueWatchingItems(prev => prev.filter(item => String(item?.id || '') !== id));
        showToast(
            `${video?.title || t('video', 'Video')} ${t('removedSuffix', 'entfernt')}`,
            'success',
            { label: t('undo', 'Undo'), onClick: () => restoreContinueEntries(removed) }
        );
    };

    const clearContinueSelection = () => {
        setSelectedHomeVideoKeys((prev) => prev.filter((k) => !continueWatchingKeySet.has(k)));
    };

    const requestContinueDelete = () => {
        if (selectedContinueKeys.length > 0) {
            setContinueDeleteDialog({ mode: 'selected', count: selectedContinueKeys.length });
            return;
        }
        if (continueWatchingVideos.length > 0) {
            setContinueDeleteDialog({ mode: 'all', count: continueWatchingVideos.length });
        }
    };

    const confirmContinueDelete = () => {
        if (!continueDeleteDialog) return;
        if (continueDeleteDialog.mode === 'selected') {
            const selectedIds = selectedContinueVideos
                .map((v) => String(v?.id || '').trim())
                .filter(Boolean);
            const removedEntries = (continueWatchingItems || [])
                .filter((entry) => selectedIds.includes(String(entry?.id || '').trim()))
                .map((entry) => ({ ...entry }));
            const ids = new Set(
                selectedContinueVideos
                    .map((v) => String(v?.id || '').trim())
                    .filter(Boolean)
            );
            ids.forEach((id) => clearWatchProgress(id));
            setContinueWatchingItems((prev) => prev.filter((item) => !ids.has(String(item?.id || '').trim())));
            clearContinueSelection();
            showToast(
                `${ids.size} ${t('removedSuffix', 'entfernt')}`,
                'success',
                { label: t('undo', 'Undo'), onClick: () => restoreContinueEntries(removedEntries) }
            );
        } else {
            const removedEntries = (continueWatchingItems || []).map((v) => ({ ...v }));
            for (const entry of continueWatchingVideos) {
                const id = String(entry?.id || '').trim();
                if (id) clearWatchProgress(id);
            }
            setContinueWatchingItems([]);
            clearContinueSelection();
            showToast(
                t('cleared', 'Gelöscht'),
                'success',
                { label: t('undo', 'Undo'), onClick: () => restoreContinueEntries(removedEntries) }
            );
        }
        setContinueDeleteDialog(null);
    };

    const handleHomeVideoContextMenu = (e, video, source = null) => {
        e.preventDefault();
        e.stopPropagation();
        const items = [
            {
                label: t('play', 'Abspielen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
                onClick: () => {
                    const resumeFromSec = Number(video?._resumeFromSec || 0);
                    if (resumeFromSec > 0) onPlay(video, { resumeFromSec });
                    else onPlay(video);
                },
            },
            {
                label: t('select', 'Ausw\u00E4hlen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 11 12 14 20 6" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
                onClick: () => selectHomeVideoFromContextMenu(video),
            },
            {
                label: t('editTags', 'Tags bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                onClick: () => handleEditVideoTags(video),
            },
            {
                label: t('manageScript', 'Script verwalten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" /><rect x="2.5" y="4" width="19" height="16" rx="3" /></svg>,
                onClick: () => onOpenFunscriptManager?.({
                    videoId: video?.id,
                    libraryId: video?.libraryId || video?.library_id || null,
                    title: video?.title || video?.fileName || '',
                }),
            },
            {
                label: t('addToPlaylist', 'Zur Playlist hinzufügen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h10" /><path d="m17 15 3 3-3 3" /><path d="M20 18h-6" /></svg>,
                onClick: () => openPlaylistDialogForVideos([video], `${t('addToPlaylist', 'Zur Playlist hinzufügen')}: ${video.title}`),
            },
            {
                label: t('regenerateThumbnailShort', 'Regenerate thumbnail'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="14" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /><path d="M12 19v2" /><path d="M8 21h8" /></svg>,
                onClick: () => setThumbTimestampDialogVideo(video),
            },
            {
                label: t('properties', 'Eigenschaften'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>,
                onClick: () => setPropertiesVideo(video),
            },
        ];

        if (source === 'continue') {
            items.push({
                label: t('remove', 'Entfernen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
                onClick: () => removeFromContinueWatching(video),
            });
        }

        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items,
        });
    };

    const handleContextMenu = (e, lib) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                {
                    label: t('changePoster', 'Poster/Thumbnail \u00E4ndern'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                    onClick: () => handleUploadPoster(lib),
                },
                {
                    label: t('removeThumbnail', 'Thumbnail entfernen'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /></svg>,
                    onClick: () => handleRemovePoster(lib),
                },
            ],
        });
    };



    const handleUploadPlaylistPoster = async (playlist) => {
        if (!playlist?.id) return;
        const imageData = await pickImage();
        if (!imageData) return;
        const nextMap = { ...playlistPosterById, [playlist.id]: imageData };
        persistPlaylistPosterMap(nextMap);
        showToast(t('posterUpdated', 'Poster aktualisiert!'));
    };
    const renamePlaylist = (playlist) => {
        const currentName = String(playlist?.name || '').trim();
        if (!playlist?.id || !currentName) return;
        setPlaylistManageDialog({ mode: 'rename', playlist });
    };

    const deletePlaylist = (playlist) => {
        const name = String(playlist?.name || '').trim();
        if (!playlist?.id || !name) return;
        setPlaylistManageDialog({ mode: 'delete', playlist });
    };

    const handleConfirmPlaylistManage = async (payload = {}) => {
        const dialog = playlistManageDialog;
        const playlist = dialog?.playlist;
        if (!playlist?.id) return;

        try {
            if (dialog.mode === 'rename') {
                const nextName = String(payload?.name || '').trim();
                if (!nextName || nextName === String(playlist.name || '').trim()) {
                    setPlaylistManageDialog(null);
                    return;
                }
                const res = await fetch(`/api/playlists/${playlist.id}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nextName }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
                showToast(t('saved', 'Gespeichert'));
            } else {
                const res = await fetch(`/api/playlists/${playlist.id}`, { method: 'DELETE' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
                showToast(t('deleted', 'Gel\u00f6scht'));
            }

            setPlaylistManageDialog(null);
            window.dispatchEvent(new Event('playlists-changed'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handlePlaylistContextMenu = (e, playlist) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                {
                    label: t('changePoster', 'Change poster/thumbnail'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                    onClick: () => handleUploadPlaylistPoster(playlist),
                },
                {
                    label: t('rename', 'Rename'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>,
                    onClick: () => renamePlaylist(playlist),
                },
                {
                    label: t('delete', 'Delete'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>,
                    onClick: () => deletePlaylist(playlist),
                },
            ],
        });
    };
    const allKnownHomeTags = [
        ...new Set(
            Object.values(recentAddedByLibrary || {})
                .flatMap(arr => arr || [])
                .flatMap(v => (v.tags || []).map(tag => String(tag)))
        ),
    ].sort((a, b) => a.localeCompare(b));

    const homeVideoSelectionKey = (video) => video?.filePath || video?.path || video?.id;

    const homeVisibleVideos = useMemo(() => (
        [
            ...Object.values(recentAddedByLibrary || {})
                .flatMap(arr => (arr || []).slice(0, 10)),
            ...(continueWatchingItems || []).map((entry) => ({
                id: entry?.id,
                filePath: entry?.filePath || '',
                path: entry?.filePath || '',
                title: entry?.title || `${t('video', 'Video')} ${entry?.id || ''}`,
                libraryId: entry?.libraryId || entry?.library_id || '',
                libraryType: entry?.libraryType || entry?.library_type || '',
                tags: Array.isArray(entry?.tags) ? entry.tags : [],
                performers: Array.isArray(entry?.performers) ? entry.performers : [],
            })),
        ]
    ), [recentAddedByLibrary, continueWatchingItems, t]);

    const homeVisibleVideoKeys = useMemo(() => (
        [...new Set(homeVisibleVideos.map(homeVideoSelectionKey).filter(Boolean))]
    ), [homeVisibleVideos]);

    const selectedHomeVideos = useMemo(() => {
        const keySet = new Set(selectedHomeVideoKeys);
        const picked = [];
        const seen = new Set();
        for (const video of homeVisibleVideos) {
            const key = homeVideoSelectionKey(video);
            if (!key || !keySet.has(key) || seen.has(key)) continue;
            seen.add(key);
            picked.push(video);
        }
        return picked;
    }, [homeVisibleVideos, selectedHomeVideoKeys]);

    const updateRecentFadeForLib = (libId) => {
        const row = recentRowRefs.current[libId];
        if (!row) return;
        const max = Math.max(0, row.scrollWidth - row.clientWidth);
        const left = row.scrollLeft > 2;
        const right = row.scrollLeft < max - 2;
        setFadeStateAnimated(libId, left, right);
    };

    const scrollRecentRow = (libId, direction) => {
        const row = recentRowRefs.current[libId];
        if (!row) return;
        row.scrollBy({ left: direction * 520, behavior: 'smooth' });
        setTimeout(() => updateRecentFadeForLib(libId), 240);
    };
    const updateLibraryRowFade = () => {
        const row = recentRowRefs.current.__libraries;
        if (!row) return;
        const max = Math.max(0, row.scrollWidth - row.clientWidth);
        const left = row.scrollLeft > 2;
        const right = row.scrollLeft < max - 2;
        setFadeStateAnimated('__libraries', left, right);
    };

    const scrollLibraryRow = (direction) => {
        const row = recentRowRefs.current.__libraries;
        if (!row) return;
        row.scrollBy({ left: direction * 420, behavior: 'smooth' });
        setTimeout(() => updateLibraryRowFade(), 240);
    };

    const animateLibraryReorder = (nextOrderIds, activeDragId = '') => {
        const nextIds = Array.isArray(nextOrderIds) ? nextOrderIds.map((id) => String(id)) : [];
        if (!nextIds.length) return;
        const activeId = String(activeDragId || '');
        const dragState = libraryDragStateRef.current;

        const firstRects = new Map();
        for (const id of nextIds) {
            const el = libraryCardRefs.current.get(id);
            if (!el) continue;
            firstRects.set(id, el.getBoundingClientRect());
        }

        libraryOrderIdsRef.current = nextIds;
        flushSync(() => {
            setLibraryOrderIds(nextIds);
        });
        // Re-anchor dragged card to cursor against the new layout slot immediately after reorder.
        if (activeId && dragState && String(dragState.libId || '') === activeId) {
            const activeElAfter = libraryCardRefs.current.get(activeId);
            if (activeElAfter) {
                activeElAfter.style.pointerEvents = 'none';
                activeElAfter.style.zIndex = '40';
                activeElAfter.style.transition = 'none';
                activeElAfter.style.willChange = 'transform';
                activeElAfter.style.transformOrigin = `${Number(dragState.pointerOffsetX || 0)}px ${Number(dragState.pointerOffsetY || 0)}px`;
                dragState.dragEl = activeElAfter;
                reanchorDraggingElement(dragState, activeElAfter);
            }
        }

        const toAnimate = [];
        for (const id of nextIds) {
            if (id === String(activeDragId || '')) continue;
            const el = libraryCardRefs.current.get(id);
            const first = firstRects.get(id);
            if (!el || !first) continue;
            const last = el.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
            toAnimate.push({ el, dx, dy });
        }

        if (!toAnimate.length) return;

        for (const entry of toAnimate) {
            const { el, dx, dy } = entry;
            el.style.willChange = 'transform';
            el.style.transition = 'none';
            el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        }

        requestAnimationFrame(() => {
            for (const entry of toAnimate) {
                const { el } = entry;
                el.style.transition = 'transform 700ms cubic-bezier(0.16, 1, 0.3, 1)';
                el.style.transform = 'translate3d(0, 0, 0)';
                const cleanup = () => {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.willChange = '';
                    el.removeEventListener('transitionend', cleanup);
                };
                el.addEventListener('transitionend', cleanup);
                window.setTimeout(cleanup, 820);
            }
        });
    };

    const applyDraggingTransform = (state, el, clientX, clientY, immediate = false) => {
        if (!state || !el) return;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = Number(clientX || 0) - pointerOffsetX;
        const desiredTop = Number(clientY || 0) - pointerOffsetY;
        const targetTx = desiredLeft - Number(state.originLeft || 0);
        const rawTy = desiredTop - Number(state.originTop || 0);
        const maxVerticalDrag = 0;
        const targetTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, rawTy));
        const k = 1;
        const nextTx = Number(state.currentTx || 0) + (targetTx - Number(state.currentTx || 0)) * k;
        const nextTy = Number(state.currentTy || 0) + (targetTy - Number(state.currentTy || 0)) * k;
        const smoothDx = Math.abs(nextTx) < 0.2 ? 0 : nextTx;
        const smoothDy = Math.abs(nextTy) < 0.2 ? 0 : nextTy;
        const vx = Number(clientX || 0) - (state.lastX ?? Number(clientX || 0));
        const targetTilt = Math.max(-1.8, Math.min(1.8, vx * 0.08));
        const nextTilt = Number(state.currentTilt || 0) + (targetTilt - Number(state.currentTilt || 0)) * (immediate ? 1 : 0.5);
        const smoothTilt = Math.abs(nextTilt) < 0.05 ? 0 : nextTilt;
        el.style.transform = `translate3d(${smoothDx}px, ${smoothDy}px, 0) rotate(${smoothTilt}deg)`;
        state.currentTx = smoothDx;
        state.currentTy = smoothDy;
        state.currentTilt = smoothTilt;
        state.lastX = Number(clientX || 0);
    };

    const reanchorDraggingElement = (state, el) => {
        if (!state || !el) return;
        const pointerX = Number(state.pointerX || state.startX || 0);
        const pointerY = Number(state.pointerY || state.startY || 0);
        const prevTransition = el.style.transition;
        const prevTransform = el.style.transform;
        el.style.transition = 'none';
        el.style.transform = 'none';
        const rect = el.getBoundingClientRect();
        el.style.transform = prevTransform;
        el.style.transition = prevTransition;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = pointerX - pointerOffsetX;
        const desiredTop = pointerY - pointerOffsetY;
        state.originLeft = rect.left;
        state.originTop = rect.top;
        state.currentTx = desiredLeft - rect.left;
        const maxVerticalDrag = 0;
        state.currentTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, desiredTop - rect.top));
        state.currentTilt = Number(state.currentTilt || 0);
        el.style.transformOrigin = `${pointerOffsetX}px ${pointerOffsetY}px`;
        el.style.transform = `translate3d(${state.currentTx}px, ${state.currentTy}px, 0) rotate(${state.currentTilt}deg)`;
        applyDraggingTransform(state, el, pointerX, pointerY, true);
    };

    const persistLibraryOrder = async (orderedIds) => {
        try {
            const ids = Array.isArray(orderedIds) ? orderedIds.map((id) => String(id)) : [];
            if (!ids.length) return;
            const res = await fetch('/api/settings');
            if (!res.ok) return;
            const settings = await res.json();
            const existing = Array.isArray(settings?.libraries) ? settings.libraries : [];
            const byId = new Map(existing.map((lib) => [String(lib.id), lib]));
            const reordered = [];
            for (const id of ids) {
                const hit = byId.get(id);
                if (hit) reordered.push(hit);
            }
            for (const lib of existing) {
                if (!reordered.some((entry) => String(entry.id) === String(lib.id))) reordered.push(lib);
            }
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ libraries: reordered }),
            });
            if (typeof onLibrariesReordered === 'function') {
                await onLibrariesReordered();
            }
        } catch { }
    };

    const onLibraryMouseMove = (e) => {
        const state = libraryDragStateRef.current;
        if (!state) return;
        state.pointerX = e.clientX;
        state.pointerY = e.clientY;

        if (!state.dragging) {
            const dx = Math.abs(e.clientX - state.startX);
            const dy = Math.abs(e.clientY - state.startY);
            if (dx > 8 || dy > 8) {
                if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
                libraryHoldTimerRef.current = null;
                libraryDragStateRef.current = null;
                window.removeEventListener('mousemove', onLibraryMouseMove);
                window.removeEventListener('mouseup', onLibraryMouseUp);
            }
            return;
        }

        e.preventDefault();
        const draggingId = String(state.libId || '');
        if (!draggingId) return;

        const mappedEl = libraryCardRefs.current.get(draggingId);
        if (mappedEl && state.dragEl !== mappedEl) {
            if (state.dragEl) {
                state.dragEl.style.pointerEvents = '';
                state.dragEl.style.zIndex = '';
                state.dragEl.style.transition = '';
                state.dragEl.style.willChange = '';
                state.dragEl.style.transform = '';
                state.dragEl.style.transformOrigin = '';
            }
            state.dragEl = mappedEl;
            mappedEl.style.pointerEvents = 'none';
            mappedEl.style.zIndex = '40';
            mappedEl.style.transition = 'none';
            mappedEl.style.willChange = 'transform';
            mappedEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            reanchorDraggingElement(state, mappedEl);
        }

        const draggingEl = state.dragEl || mappedEl;
        if (draggingEl) {
            applyDraggingTransform(state, draggingEl, state.pointerX, state.pointerY);
        }

        const now = Date.now();
        if (now - Number(state.lastSwapTs || 0) < 180) return;
        const current = Array.isArray(libraryOrderIdsRef.current) ? [...libraryOrderIdsRef.current] : [];
        if (current.length < 2) return;
        if (!current.includes(draggingId)) return;

        const others = current.filter((id) => id !== draggingId);
        let insertIndex = others.length;
        for (let i = 0; i < others.length; i++) {
            const el = libraryCardRefs.current.get(String(others[i]));
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const mid = r.left + (r.width / 2);
            if (e.clientX < mid) {
                insertIndex = i;
                break;
            }
        }

        const next = [...others];
        next.splice(insertIndex, 0, draggingId);
        let changed = false;
        for (let i = 0; i < next.length; i++) {
            if (next[i] !== current[i]) { changed = true; break; }
        }
        if (!changed) return;

        const movedSinceSwap = Math.abs(e.clientX - Number(state.lastSwapX ?? state.startX ?? e.clientX));
        if (movedSinceSwap < 28) return;

        state.didSwap = true;
        state.lastSwapTs = now;
        state.lastSwapX = e.clientX;
        animateLibraryReorder(next, draggingId);
        const el = libraryCardRefs.current.get(String(state.libId || '')) || state.dragEl;
        if (el) {
            state.dragEl = el;
            el.style.pointerEvents = 'none';
            el.style.zIndex = '40';
            el.style.transition = 'none';
            el.style.willChange = 'transform';
            el.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
        }
    };

    const onLibraryMouseUp = () => {
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryHoldTimerRef.current = null;
        const state = libraryDragStateRef.current;
        libraryDragStateRef.current = null;
        window.removeEventListener('mousemove', onLibraryMouseMove);
        window.removeEventListener('mouseup', onLibraryMouseUp);
        document.body.style.userSelect = '';
        const dragId = String(state?.libId || '');
        const mappedEl = dragId ? libraryCardRefs.current.get(dragId) : null;
        if (state?.dragEl) {
            state.dragEl.style.pointerEvents = '';
            state.dragEl.style.zIndex = '';
            state.dragEl.style.transform = '';
            state.dragEl.style.transition = '';
            state.dragEl.style.willChange = '';
            state.dragEl.style.transformOrigin = '';
        }
        if (mappedEl && mappedEl !== state?.dragEl) {
            mappedEl.style.pointerEvents = '';
            mappedEl.style.zIndex = '';
            mappedEl.style.transform = '';
            mappedEl.style.transition = '';
            mappedEl.style.willChange = '';
            mappedEl.style.transformOrigin = '';
        }
        if (!state?.dragging) return;
        setDraggingLibraryId('');
        if (state.didSwap) {
            suppressLibraryClickRef.current = true;
            persistLibraryOrder(libraryOrderIdsRef.current);
        }
    };

    const cancelLibraryHoldIfPending = () => {
        const state = libraryDragStateRef.current;
        if (state?.dragging) return;
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryHoldTimerRef.current = null;
        libraryDragStateRef.current = null;
        document.body.style.userSelect = '';
    };

    const onLibraryMouseDown = (e, libId) => {
        if (e.button !== 0) return;
        suppressLibraryClickRef.current = false;
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryDragStateRef.current = {
            libId: String(libId || ''),
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            reordered: false,
            didSwap: false,
            lastSwapTs: 0,
            lastSwapX: e.clientX,
        };
        window.addEventListener('mouseup', cancelLibraryHoldIfPending, { once: true });
        libraryHoldTimerRef.current = setTimeout(() => {
            const state = libraryDragStateRef.current;
            if (!state || String(state.libId) !== String(libId)) return;
            state.dragging = true;
            state.lastX = state.startX;
            setDraggingLibraryId(String(libId));
            document.body.style.userSelect = 'none';
            const dragEl = libraryCardRefs.current.get(String(libId));
            if (dragEl) {
                const rect = dragEl.getBoundingClientRect();
                state.dragEl = dragEl;
                state.pointerOffsetX = state.startX - rect.left;
                state.pointerOffsetY = state.startY - rect.top;
                state.originLeft = rect.left;
                state.originTop = rect.top;
                state.currentTx = 0;
                state.currentTy = 0;
                dragEl.style.pointerEvents = 'none';
                dragEl.style.zIndex = '40';
                dragEl.style.transition = 'none';
                dragEl.style.willChange = 'transform';
                dragEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            }
            window.addEventListener('mousemove', onLibraryMouseMove);
            window.addEventListener('mouseup', onLibraryMouseUp);
        }, 280);
    };

    const onLibraryCardClick = (lib) => {
        if (suppressLibraryClickRef.current) {
            suppressLibraryClickRef.current = false;
            return;
        }
        onSelect(lib);
    };

    const openLibraryFromRecent = (lib) => {
        if (!lib) return;
        onSelect(lib, {
            initialSort: 'date',
            initialSeriesSort: 'date',
            initialVideoTab: 'all',
        });
    };

    const inferLibraryIdFromVideoPath = (videoPath) => {
        const full = String(videoPath || '').trim().toLowerCase();
        if (!full) return '';
        let best = '';
        let bestLen = -1;
        for (const lib of (Array.isArray(libraries) ? libraries : [])) {
            const root = String(lib?.path || '').trim().toLowerCase();
            if (!root) continue;
            if (full.startsWith(root) && root.length > bestLen) {
                best = String(lib?.id || '');
                bestLen = root.length;
            }
        }
        return best;
    };

    const openPerformerFromVideoCard = (video, performer, fallbackLibraryId = '') => {
        const directLibraryId = String(video?.libraryId || video?.library_id || fallbackLibraryId || '').trim();
        const inferredLibraryId = inferLibraryIdFromVideoPath(video?.filePath || video?.path || '');
        const libraryId = directLibraryId || inferredLibraryId;
        const performerId = String(performer?.id || '').trim();
        const performerName = String(performer?.name || '').trim();
        if (!libraryId || (!performerId && !performerName)) return;
        if (typeof onOpenPerformer === 'function') {
            onOpenPerformer({
                libraryId,
                performer: { id: performerId, name: performerName },
            });
            return;
        }
        const targetLibrary = (Array.isArray(libraries) ? libraries : []).find((lib) => String(lib?.id || '') === libraryId);
        if (!targetLibrary) return;
        onSelect(targetLibrary, {
            initialVideoTab: 'performers',
            initialPerformer: { id: performerId, name: performerName },
        });
    };
    const updateContinueWatchingFade = () => {
        const row = recentRowRefs.current.__continue;
        if (!row) return;
        const max = Math.max(0, row.scrollWidth - row.clientWidth);
        const left = row.scrollLeft > 2;
        const right = row.scrollLeft < max - 2;
        setFadeStateAnimated('__continue', left, right);
    };

    const scrollContinueWatchingRow = (direction) => {
        const row = recentRowRefs.current.__continue;
        if (!row) return;
        row.scrollBy({ left: direction * 420, behavior: 'smooth' });
        setTimeout(() => updateContinueWatchingFade(), 240);
    };

    const updatePlaylistFade = () => {
        const row = recentRowRefs.current.__playlists;
        if (!row) return;
        const max = Math.max(0, row.scrollWidth - row.clientWidth);
        const left = row.scrollLeft > 2;
        const right = row.scrollLeft < max - 2;
        setFadeStateAnimated('__playlists', left, right);
    };

    const scrollPlaylistsRow = (direction) => {
        const row = recentRowRefs.current.__playlists;
        if (!row) return;
        row.scrollBy({ left: direction * 420, behavior: 'smooth' });
        setTimeout(() => updatePlaylistFade(), 240);
    };

    const applyPlaylistDraggingTransform = (state, el, clientX, clientY, immediate = false) => {
        if (!state || !el) return;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = Number(clientX || 0) - pointerOffsetX;
        const desiredTop = Number(clientY || 0) - pointerOffsetY;
        const targetTx = desiredLeft - Number(state.originLeft || 0);
        const rawTy = desiredTop - Number(state.originTop || 0);
        const maxVerticalDrag = 0;
        const targetTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, rawTy));
        const k = immediate ? 1 : 1;
        const nextTx = Number(state.currentTx || 0) + (targetTx - Number(state.currentTx || 0)) * k;
        const nextTy = Number(state.currentTy || 0) + (targetTy - Number(state.currentTy || 0)) * k;
        const smoothDx = Math.abs(nextTx) < 0.2 ? 0 : nextTx;
        const smoothDy = Math.abs(nextTy) < 0.2 ? 0 : nextTy;
        const vx = Number(clientX || 0) - (state.lastX ?? Number(clientX || 0));
        const targetTilt = Math.max(-1.8, Math.min(1.8, vx * 0.08));
        const nextTilt = Number(state.currentTilt || 0) + (targetTilt - Number(state.currentTilt || 0)) * (immediate ? 1 : 0.5);
        const smoothTilt = Math.abs(nextTilt) < 0.05 ? 0 : nextTilt;
        el.style.transform = `translate3d(${smoothDx}px, ${smoothDy}px, 0) rotate(${smoothTilt}deg)`;
        state.currentTx = smoothDx;
        state.currentTy = smoothDy;
        state.currentTilt = smoothTilt;
        state.lastX = Number(clientX || 0);
    };

    const reanchorDraggingPlaylistElement = (state, el) => {
        if (!state || !el) return;
        const pointerX = Number(state.pointerX || state.startX || 0);
        const pointerY = Number(state.pointerY || state.startY || 0);
        const prevTransition = el.style.transition;
        const prevTransform = el.style.transform;
        el.style.transition = 'none';
        el.style.transform = 'none';
        const rect = el.getBoundingClientRect();
        el.style.transform = prevTransform;
        el.style.transition = prevTransition;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = pointerX - pointerOffsetX;
        const desiredTop = pointerY - pointerOffsetY;
        state.originLeft = rect.left;
        state.originTop = rect.top;
        state.currentTx = desiredLeft - rect.left;
        const maxVerticalDrag = 0;
        state.currentTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, desiredTop - rect.top));
        state.currentTilt = Number(state.currentTilt || 0);
        el.style.transformOrigin = `${pointerOffsetX}px ${pointerOffsetY}px`;
        el.style.transform = `translate3d(${state.currentTx}px, ${state.currentTy}px, 0) rotate(${state.currentTilt}deg)`;
        applyPlaylistDraggingTransform(state, el, pointerX, pointerY, true);
    };

    const animatePlaylistReorder = (nextOrderIds, activeDragId = '') => {
        const nextIds = Array.isArray(nextOrderIds) ? nextOrderIds.map((id) => String(id)) : [];
        if (!nextIds.length) return;
        const activeId = String(activeDragId || '');
        const dragState = playlistDragStateRef.current;

        const firstRects = new Map();
        for (const id of nextIds) {
            const el = playlistCardRefs.current.get(id);
            if (!el) continue;
            firstRects.set(id, el.getBoundingClientRect());
        }

        playlistOrderIdsRef.current = nextIds;
        flushSync(() => {
            setPlaylistOrderIds(nextIds);
        });

        if (activeId && dragState && String(dragState.playlistId || '') === activeId) {
            const activeElAfter = playlistCardRefs.current.get(activeId);
            if (activeElAfter) {
                activeElAfter.style.pointerEvents = 'none';
                activeElAfter.style.zIndex = '40';
                activeElAfter.style.transition = 'none';
                activeElAfter.style.willChange = 'transform';
                activeElAfter.style.transformOrigin = `${Number(dragState.pointerOffsetX || 0)}px ${Number(dragState.pointerOffsetY || 0)}px`;
                dragState.dragEl = activeElAfter;
                reanchorDraggingPlaylistElement(dragState, activeElAfter);
            }
        }

        const toAnimate = [];
        for (const id of nextIds) {
            if (id === activeId) continue;
            const el = playlistCardRefs.current.get(id);
            const first = firstRects.get(id);
            if (!el || !first) continue;
            const last = el.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
            toAnimate.push({ el, dx, dy });
        }

        if (!toAnimate.length) return;

        for (const entry of toAnimate) {
            const { el, dx, dy } = entry;
            el.style.willChange = 'transform';
            el.style.transition = 'none';
            el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        }

        requestAnimationFrame(() => {
            for (const entry of toAnimate) {
                const { el } = entry;
                el.style.transition = 'transform 700ms cubic-bezier(0.16, 1, 0.3, 1)';
                el.style.transform = 'translate3d(0, 0, 0)';
                const cleanup = () => {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.willChange = '';
                    el.removeEventListener('transitionend', cleanup);
                };
                el.addEventListener('transitionend', cleanup);
                window.setTimeout(cleanup, 820);
            }
        });
    };

    const persistPlaylistOrder = async (orderedIds) => {
        try {
            const ids = Array.isArray(orderedIds) ? orderedIds.map((id) => String(id)).filter(Boolean) : [];
            if (!ids.length) return;
            const res = await fetch('/api/playlists/manager/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds: ids }),
            });
            if (!res.ok) throw new Error('Failed to save playlist order');
            window.dispatchEvent(new Event('playlists-changed'));
        } catch {
            // If save failed, sync UI back to server state by reloading in parent.
            window.dispatchEvent(new Event('playlists-changed'));
        }
    };

    const onPlaylistMouseMove = (e) => {
        const state = playlistDragStateRef.current;
        if (!state) return;
        state.pointerX = e.clientX;
        state.pointerY = e.clientY;

        if (!state.dragging) {
            const dx = Math.abs(e.clientX - state.startX);
            const dy = Math.abs(e.clientY - state.startY);
            if (dx > 8 || dy > 8) {
                if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
                playlistHoldTimerRef.current = null;
                playlistDragStateRef.current = null;
                window.removeEventListener('mousemove', onPlaylistMouseMove);
                window.removeEventListener('mouseup', onPlaylistMouseUp);
            }
            return;
        }

        e.preventDefault();
        const draggingId = String(state.playlistId || '');
        if (!draggingId) return;

        const mappedEl = playlistCardRefs.current.get(draggingId);
        if (mappedEl && state.dragEl !== mappedEl) {
            if (state.dragEl) {
                state.dragEl.style.pointerEvents = '';
                state.dragEl.style.zIndex = '';
                state.dragEl.style.transition = '';
                state.dragEl.style.willChange = '';
                state.dragEl.style.transform = '';
                state.dragEl.style.transformOrigin = '';
            }
            state.dragEl = mappedEl;
            mappedEl.style.pointerEvents = 'none';
            mappedEl.style.zIndex = '40';
            mappedEl.style.transition = 'none';
            mappedEl.style.willChange = 'transform';
            mappedEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            reanchorDraggingPlaylistElement(state, mappedEl);
        }

        const draggingEl = state.dragEl || mappedEl;
        if (draggingEl) {
            applyPlaylistDraggingTransform(state, draggingEl, state.pointerX, state.pointerY);
        }

        const now = Date.now();
        if (now - Number(state.lastSwapTs || 0) < 180) return;
        const current = Array.isArray(playlistOrderIdsRef.current) ? [...playlistOrderIdsRef.current] : [];
        if (current.length < 2) return;
        if (!current.includes(draggingId)) return;

        const others = current.filter((id) => id !== draggingId);
        let insertIndex = others.length;
        for (let i = 0; i < others.length; i++) {
            const el = playlistCardRefs.current.get(String(others[i]));
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const mid = r.left + (r.width / 2);
            if (e.clientX < mid) {
                insertIndex = i;
                break;
            }
        }

        const next = [...others];
        next.splice(insertIndex, 0, draggingId);
        let changed = false;
        for (let i = 0; i < next.length; i++) {
            if (next[i] !== current[i]) { changed = true; break; }
        }
        if (!changed) return;

        const movedSinceSwap = Math.abs(e.clientX - Number(state.lastSwapX ?? state.startX ?? e.clientX));
        if (movedSinceSwap < 28) return;

        state.didSwap = true;
        state.lastSwapTs = now;
        state.lastSwapX = e.clientX;
        animatePlaylistReorder(next, draggingId);
        const el = playlistCardRefs.current.get(String(state.playlistId || '')) || state.dragEl;
        if (el) {
            state.dragEl = el;
            el.style.pointerEvents = 'none';
            el.style.zIndex = '40';
            el.style.transition = 'none';
            el.style.willChange = 'transform';
            el.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
        }
    };

    const onPlaylistMouseUp = () => {
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistHoldTimerRef.current = null;
        const state = playlistDragStateRef.current;
        playlistDragStateRef.current = null;
        window.removeEventListener('mousemove', onPlaylistMouseMove);
        window.removeEventListener('mouseup', onPlaylistMouseUp);
        document.body.style.userSelect = '';
        const dragId = String(state?.playlistId || '');
        const mappedEl = dragId ? playlistCardRefs.current.get(dragId) : null;
        if (state?.dragEl) {
            state.dragEl.style.pointerEvents = '';
            state.dragEl.style.zIndex = '';
            state.dragEl.style.transform = '';
            state.dragEl.style.transition = '';
            state.dragEl.style.willChange = '';
            state.dragEl.style.transformOrigin = '';
        }
        if (mappedEl && mappedEl !== state?.dragEl) {
            mappedEl.style.pointerEvents = '';
            mappedEl.style.zIndex = '';
            mappedEl.style.transform = '';
            mappedEl.style.transition = '';
            mappedEl.style.willChange = '';
            mappedEl.style.transformOrigin = '';
        }
        if (!state?.dragging) return;
        setDraggingHomePlaylistId('');
        if (state.didSwap) {
            suppressPlaylistClickRef.current = true;
            persistPlaylistOrder(playlistOrderIdsRef.current);
        }
    };

    const cancelPlaylistHoldIfPending = () => {
        const state = playlistDragStateRef.current;
        if (state?.dragging) return;
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistHoldTimerRef.current = null;
        playlistDragStateRef.current = null;
        document.body.style.userSelect = '';
    };

    const onPlaylistMouseDown = (e, playlistId) => {
        if (e.button !== 0) return;
        suppressPlaylistClickRef.current = false;
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistDragStateRef.current = {
            playlistId: String(playlistId || ''),
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            reordered: false,
            didSwap: false,
            lastSwapTs: 0,
            lastSwapX: e.clientX,
        };
        window.addEventListener('mouseup', cancelPlaylistHoldIfPending, { once: true });
        playlistHoldTimerRef.current = setTimeout(() => {
            const state = playlistDragStateRef.current;
            if (!state || String(state.playlistId) !== String(playlistId)) return;
            state.dragging = true;
            state.lastX = state.startX;
            setDraggingHomePlaylistId(String(playlistId));
            document.body.style.userSelect = 'none';
            const dragEl = playlistCardRefs.current.get(String(playlistId));
            if (dragEl) {
                const rect = dragEl.getBoundingClientRect();
                state.dragEl = dragEl;
                state.pointerOffsetX = state.startX - rect.left;
                state.pointerOffsetY = state.startY - rect.top;
                state.originLeft = rect.left;
                state.originTop = rect.top;
                state.currentTx = 0;
                state.currentTy = 0;
                dragEl.style.pointerEvents = 'none';
                dragEl.style.zIndex = '40';
                dragEl.style.transition = 'none';
                dragEl.style.willChange = 'transform';
                dragEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            }
            window.addEventListener('mousemove', onPlaylistMouseMove);
            window.addEventListener('mouseup', onPlaylistMouseUp);
        }, 280);
    };

    const onPlaylistCardClick = (playlistId) => {
        if (suppressPlaylistClickRef.current) {
            suppressPlaylistClickRef.current = false;
            return;
        }
        onOpenPlaylists(playlistId);
    };

    useEffect(() => () => {
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        window.removeEventListener('mousemove', onPlaylistMouseMove);
        window.removeEventListener('mouseup', onPlaylistMouseUp);
    }, []);

    const continueWatchingVideos = useMemo(() => (
        (continueWatchingItems || []).map((entry) => ({
            id: entry.id,
            title: entry.title || `${t('video', 'Video')} ${entry.id}`,
            filePath: entry.filePath || '',
            path: entry.filePath || '',
            libraryId: entry.libraryId || entry.library_id || '',
            libraryType: entry.libraryType || entry.library_type || '',
            tags: Array.isArray(entry?.tags) ? entry.tags : [],
            performers: Array.isArray(entry?.performers) ? entry.performers : [],
            size: Number(entry.size || 0) || 0,
            modifiedAt: Number(entry.modifiedAt || entry.updatedAt || Date.now()) || Date.now(),
            thumbVersion: Number(entry.thumbVersion || entry.modifiedAt || entry.updatedAt || 0) || 0,
            // Always try video thumbnail endpoint for continue-watching items.
            // VideoCard already falls back gracefully if loading fails.
            hasThumbnail: true,
            hasFunscript: !!entry.hasFunscript,
            isMultiAxis: !!entry.isMultiAxis,
            axes: Array.isArray(entry.axes) ? entry.axes : [],
            extension: entry.extension || '',
            _resumeFromSec: Math.max(0, Number(entry.lastPositionSec ?? entry.positionSec ?? 0) || 0),
            _resumeProgressRatio: (() => {
                const pos = Number(entry.lastPositionSec ?? entry.positionSec ?? 0);
                const dur = Number(entry.durationSec || 0);
                if (!Number.isFinite(pos) || pos <= 0) return null;
                if (!Number.isFinite(dur) || dur <= 0) return null;
                return Math.max(0, Math.min(1, pos / dur));
            })(),
        }))
    ), [continueWatchingItems, t]);
    const continueWatchingKeySet = useMemo(
        () => new Set((continueWatchingVideos || []).map(homeVideoSelectionKey).filter(Boolean)),
        [continueWatchingVideos]
    );
    const selectedContinueKeys = useMemo(
        () => selectedHomeVideoKeys.filter((k) => continueWatchingKeySet.has(k)),
        [selectedHomeVideoKeys, continueWatchingKeySet]
    );
    const selectedContinueVideos = useMemo(() => {
        const keySet = new Set(selectedContinueKeys);
        return (continueWatchingVideos || []).filter((v) => keySet.has(homeVideoSelectionKey(v)));
    }, [continueWatchingVideos, selectedContinueKeys]);
    const toggleHomeVideoSelection = (video, e = null) => {
        const key = homeVideoSelectionKey(video);
        if (!key) return;
        const ordered = homeVisibleVideoKeys;
        const hasRange = !!(e?.shiftKey && selectionAnchorRef.current && ordered.includes(selectionAnchorRef.current) && ordered.includes(key));
        if (hasRange) {
            const a = ordered.indexOf(selectionAnchorRef.current);
            const b = ordered.indexOf(key);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedHomeVideoKeys(prev => [...new Set([...prev, ...range])]);
            return;
        }
        selectionAnchorRef.current = key;
        setSelectedHomeVideoKeys(prev => (
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        ));
    };

    const selectHomeVideoFromContextMenu = (video) => {
        const key = homeVideoSelectionKey(video);
        if (!key) return;
        selectionAnchorRef.current = key;
        setSelectedHomeVideoKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    };

    const toggleAllHomeVisibleVideos = () => {
        const keys = homeVisibleVideoKeys;
        const allSelected = keys.length > 0 && keys.every(k => selectedHomeVideoKeys.includes(k));
        if (allSelected) {
            setSelectedHomeVideoKeys(prev => prev.filter(k => !keys.includes(k)));
        } else {
            setSelectedHomeVideoKeys(prev => [...new Set([...prev, ...keys])]);
        }
    };

    const openHomeBatchTags = () => {
        if (selectedHomeVideos.length === 0) return;
        const common = (selectedHomeVideos[0]?.tags || []).filter(tag =>
            selectedHomeVideos.every(v => (v.tags || []).some(tg => String(tg).toLowerCase() === String(tag).toLowerCase()))
        );
        setBatchHomeTagDialog({
            title: `${t('batchTags', 'Batch-Tags')}: ${selectedHomeVideos.length} ${t('videos', 'Videos')}`,
            tags: common,
        });
    };

    const handleSaveHomeBatchTags = async (tags) => {
        try {
            await Promise.all(selectedHomeVideos.map(async (video) => {
                const res = await fetch(`/api/tags/video/${video.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags, videoPath: video.filePath || video.path || null }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            }));

            const selectedKeySet = new Set(selectedHomeVideoKeys);
            setRecentAddedByLibrary(prev => {
                const next = { ...prev };
                Object.keys(next).forEach((libKey) => {
                    next[libKey] = (next[libKey] || []).map((v) => {
                        const key = homeVideoSelectionKey(v);
                        return key && selectedKeySet.has(key)
                            ? { ...v, tags: Array.isArray(tags) ? tags : [] }
                            : v;
                    });
                });
                return next;
            });
            setContinueWatchingItems(prev => (
                (prev || []).map((entry) => {
                    const key = homeVideoSelectionKey(entry);
                    return key && selectedKeySet.has(key)
                        ? { ...entry, tags: Array.isArray(tags) ? tags : [] }
                        : entry;
                })
            ));

            setBatchHomeTagDialog(null);
            setSelectedHomeVideoKeys([]);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const selectionHotkeysEnabled = !contextMenu && !tagDialog && !batchHomeTagDialog && !playlistDialog && !playlistManageDialog && !propertiesVideo;
    useSelectionHotkeys({
        enabled: selectionHotkeysEnabled,
        onSelectAll: () => toggleAllHomeVisibleVideos(),
        onClearSelection: () => {
            setSelectedHomeVideoKeys([]);
            selectionAnchorRef.current = '';
        },
    });

    if (orderedLibraries.length === 0) {
        return (
            <div className="home-page home-page-empty">
                <div className="empty-state home-empty-state">
                    <div className="empty-state-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                    </div>
                    <h2>{t('welcome', 'Willkommen bei Glyph')}</h2>
                    <p>{t('welcomeHint', 'F\u00FCge eine Bibliothek in den Einstellungen hinzu, um loszulegen.')}</p>
                    <a href="#/settings" className="btn btn-primary" style={{ marginTop: '16px' }}>
                        {t('openSettings', 'Einstellungen \u00F6ffnen')}
                    </a>
                </div>
            </div>
        );
    }

    return (
        <div className="home-page">
            {/* Library Cards */}
            <div className="home-section">
                <div className="home-library-topbar">
                    <h2 className="home-section-title">{t('myLibrary', 'Meine Mediathek')}</h2>
                    <div className="home-recent-nav">
                        <button
                            type="button"
                            className={`home-recent-nav-btn ${recentFadeState.__libraries?.left ? '' : 'is-disabled'}`}
                            onClick={() => scrollLibraryRow(-1)}
                            aria-label="Scroll left"
                            disabled={!recentFadeState.__libraries?.left}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                        </button>
                        <button
                            type="button"
                            className={`home-recent-nav-btn ${recentFadeState.__libraries?.right ? '' : 'is-disabled'}`}
                            onClick={() => scrollLibraryRow(1)}
                            aria-label="Scroll right"
                            disabled={!recentFadeState.__libraries?.right}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="9 18 15 12 9 6" />
                            </svg>
                        </button>
                    </div>
                </div>
                <div className={`home-library-row-wrap ${recentFadeState.__libraries?.left ? 'fade-left' : ''} ${recentFadeState.__libraries?.right ? 'fade-right' : ''}`}>
                    <div
                        className={`home-library-row ${draggingLibraryId ? 'is-reordering' : ''}`}
                        ref={(el) => {
                            recentRowRefs.current.__libraries = el;
                            if (el) setTimeout(() => updateLibraryRowFade(), 0);
                        }}
                        onScroll={updateLibraryRowFade}
                    >
                        {orderedLibraries.map(lib => (
                            <div
                                key={lib.id}
                                data-lib-id={String(lib.id)}
                                className={`library-card ${(!hiddenPosterLibraryIds.has(String(lib.id)) && (lib.hasPoster || posterKeys[lib.id])) ? 'has-poster' : ''} ${draggingLibraryId === String(lib.id) ? 'is-dragging' : ''}`}
                                ref={(el) => {
                                    const key = String(lib.id);
                                    if (el) libraryCardRefs.current.set(key, el);
                                    else libraryCardRefs.current.delete(key);
                                }}
                                onMouseDown={(e) => onLibraryMouseDown(e, lib.id)}
                                onMouseUp={cancelLibraryHoldIfPending}
                                onMouseLeave={cancelLibraryHoldIfPending}
                                onClick={() => onLibraryCardClick(lib)}
                                onContextMenu={(e) => handleContextMenu(e, lib)}
                            >
                                <div className="library-card-bg">
                                    {(!hiddenPosterLibraryIds.has(String(lib.id)) && (lib.hasPoster || posterKeys[lib.id])) ? (
                                        <img
                                            className="library-card-poster-img"
                                            src={`/api/poster?path=${encodeURIComponent(lib.path)}${posterKeys[lib.id] ? `&t=${posterKeys[lib.id]}` : ''}`}
                                            alt=""
                                            loading="lazy"
                                            onError={(e) => { e.target.style.display = 'none'; }}
                                        />
                                    ) : (
                                        <div className={`library-card-icon ${lib.type}`}>
                                            {lib.type === 'series' ? (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                    <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                                                    <polyline points="17 2 12 7 7 2" />
                                                </svg>
                                            ) : lib.type === 'vr' ? (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                    <rect x="2" y="7" width="20" height="10" rx="3" />
                                                    <circle cx="8" cy="12" r="2.2" />
                                                    <circle cx="16" cy="12" r="2.2" />
                                                    <path d="M9 17v2h6v-2" />
                                                </svg>
                                            ) : (
                                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                    <polygon points="23 7 16 12 23 17 23 7" />
                                                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                                                </svg>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div className="library-card-info">
                                    <h3 className="library-card-name">{lib.name}</h3>
                                    <div className="library-card-meta">
                                        <span className={`lib-type-pill ${lib.type}`}>
                                            {lib.type === 'series'
                                                ? t('series', 'Serien')
                                                : lib.type === 'vr'
                                                    ? t('vr', 'VR')
                                                    : t('videos', 'Videos')}
                                        </span>
                                        <span className="library-card-count">
                                            {lib.type === 'series'
                                                ? `${lib.folderCount} ${lib.folderCount === 1 ? t('seriesOne', 'Serie') : t('series', 'Serien')}`
                                                : lib.type === 'vr'
                                                    ? `${lib.videoCount} ${lib.videoCount === 1 ? t('vrVideoOne', 'VR-Video') : t('vrVideos', 'VR-Videos')}`
                                                    : `${lib.videoCount} ${lib.videoCount === 1 ? t('video', 'Video') : t('videos', 'Videos')}`
                                            }
                                        </span>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            {continueWatchingEnabled && continueWatchingVideos.length > 0 && (
                <div className="home-recent-block home-continue-block">
                    <div className="home-recent-head">
                        <h3 className="home-recent-title">{t('continueWatching', 'Weiterschauen')}</h3>
                        <div className="home-recent-nav">
                            <button
                                type="button"
                                className="home-recent-nav-btn"
                                onClick={requestContinueDelete}
                                aria-label={selectedContinueKeys.length > 0 ? t('removeSelected', 'Auswahl entfernen') : t('clearAll', 'Alles löschen')}
                                title={selectedContinueKeys.length > 0 ? t('removeSelected', 'Auswahl entfernen') : t('clearAll', 'Alles löschen')}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <path d="M3 6h18" />
                                    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                                    <rect x="6" y="6" width="12" height="15" rx="2" />
                                    <line x1="10" y1="11" x2="10" y2="17" />
                                    <line x1="14" y1="11" x2="14" y2="17" />
                                </svg>
                            </button>
                            <button type="button" className="home-recent-nav-btn" onClick={() => scrollContinueWatchingRow(-1)} aria-label="Scroll left">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polyline points="15 18 9 12 15 6" />
                                </svg>
                            </button>
                            <button type="button" className="home-recent-nav-btn" onClick={() => scrollContinueWatchingRow(1)} aria-label="Scroll right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div className={`home-recent-row-wrap ${recentFadeState.__continue?.left ? 'fade-left' : ''} ${recentFadeState.__continue?.right ? 'fade-right' : ''} ${recentFadeState.__continue?.leftFx ? 'fade-left-fx' : ''} ${recentFadeState.__continue?.rightFx ? 'fade-right-fx' : ''}`}>
                        <div
                            className="home-recent-row"
                            ref={(el) => {
                                recentRowRefs.current.__continue = el;
                                if (el) setTimeout(() => updateContinueWatchingFade(), 0);
                            }}
                            onScroll={updateContinueWatchingFade}
                        >
                            {continueWatchingVideos.map((v) => (
                                <div key={`continue-${v.id}`} className="home-recent-card">
                                    <VideoCard
                                        video={v}
                                        onPlay={() => onPlay(v, { resumeFromSec: v._resumeFromSec })}
                                        onContextMenu={(e) => handleHomeVideoContextMenu(e, v, 'continue')}
                                        onPerformerClick={(performer) => openPerformerFromVideoCard(v, performer)}
                                        selected={selectedHomeVideoKeys.includes(homeVideoSelectionKey(v))}
                                        selectionMode={selectedHomeVideoKeys.length > 0}
                                        onToggleSelect={toggleHomeVideoSelection}
                                        reserveHeatmapSpace
                                        resumeProgress={v._resumeProgressRatio}
                                        resumePositionSec={v._resumeFromSec}
                                        showPerformers
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}
            {Array.isArray(playlists) && playlists.length > 0 && (
                <div className="home-recent-block home-playlists-row-block">
                    <div className="home-recent-head">
                        <h3 className="home-recent-title">{t('playlists', 'Playlists')}</h3>
                        <div className="home-recent-nav">
                            <button type="button" className="home-recent-nav-btn" onClick={() => scrollPlaylistsRow(-1)} aria-label="Scroll left">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polyline points="15 18 9 12 15 6" />
                                </svg>
                            </button>
                            <button type="button" className="home-recent-nav-btn" onClick={() => scrollPlaylistsRow(1)} aria-label="Scroll right">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <polyline points="9 18 15 12 9 6" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div className={`home-recent-row-wrap home-playlists-row-wrap ${recentFadeState.__playlists?.left ? 'fade-left' : ''} ${recentFadeState.__playlists?.right ? 'fade-right' : ''} ${recentFadeState.__playlists?.leftFx ? 'fade-left-fx' : ''} ${recentFadeState.__playlists?.rightFx ? 'fade-right-fx' : ''}`}>
                        <div
                            className={`home-recent-row home-playlists-row ${draggingHomePlaylistId ? 'is-reordering' : ''}`}
                            ref={(el) => {
                                recentRowRefs.current.__playlists = el;
                                if (el) setTimeout(() => updatePlaylistFade(), 0);
                            }}
                            onScroll={updatePlaylistFade}
                        >
                            {orderedPlaylists.map((playlist) => {
                                const itemCount = Number(playlist?.itemCount || 0);
                                const previewVideo = playlistPreviewById?.[playlist.id] || null;
                                const customPoster = playlistPosterById?.[playlist.id] || '';
                                return (
                                    <div
                                        key={playlist.id}
                                        className={`home-recent-card home-playlist-recent-card ${draggingHomePlaylistId === String(playlist.id) ? 'is-dragging' : ''}`}
                                        ref={(el) => {
                                            const key = String(playlist.id);
                                            if (el) playlistCardRefs.current.set(key, el);
                                            else playlistCardRefs.current.delete(key);
                                        }}
                                    >
                                        <button
                                            type="button"
                                            className="home-playlist-row-card"
                                            onMouseDown={(e) => onPlaylistMouseDown(e, playlist.id)}
                                            onMouseUp={cancelPlaylistHoldIfPending}
                                            onMouseLeave={cancelPlaylistHoldIfPending}
                                            onClick={() => onPlaylistCardClick(playlist.id)}
                                            onContextMenu={(e) => handlePlaylistContextMenu(e, playlist)}
                                        >
                                            <div className="home-playlist-row-thumb">
                                                {customPoster ? (
                                                    <img
                                                        src={customPoster}
                                                        alt={playlist.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                        draggable={false}
                                                        onError={() => { const next = { ...playlistPosterById }; delete next[playlist.id]; persistPlaylistPosterMap(next); }}
                                                    />
                                                ) : previewVideo?.id && !playlistPreviewErrorById?.[playlist.id] ? (
                                                    <img
                                                        src={`/api/videos/${previewVideo.id}/thumbnail`}
                                                        alt={playlist.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                        draggable={false}
                                                        onError={() => setPlaylistPreviewErrorById(prev => ({ ...prev, [playlist.id]: true }))}
                                                    />
                                                ) : (
                                                    <div className="home-playlist-row-icon">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                                                            <line x1="5" y1="7" x2="19" y2="7" />
                                                            <line x1="5" y1="12" x2="19" y2="12" />
                                                            <line x1="5" y1="17" x2="14" y2="17" />
                                                            <path d="M17 16l2 2 4-4" />
                                                        </svg>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="home-playlist-row-info">
                                                <div className="home-playlist-row-name" title={playlist.name}>{playlist.name}</div>
                                                <div className="home-playlist-row-meta">
                                                    {itemCount} {itemCount === 1 ? t('video', 'Video') : t('videos', 'Videos')}
                                                </div>
                                            </div>
                                        </button>
                                    </div>
                                );
                            })}
                            <div className="home-recent-card home-playlist-more-card-wrap">
                                <button
                                    type="button"
                                    className="home-playlist-more-btn"
                                    onClick={() => onOpenPlaylists()}
                                    aria-label={t('openPlaylists', 'Playlists \\u00F6ffnen')}
                                >
                                    <span className="home-playlist-more-dots" aria-hidden="true">
                                        <span />
                                        <span />
                                        <span />
                                    </span>
                                </button>
                            </div>
                    </div>
                </div>
                </div>
            )}
            <div className="home-recent-sections">
                {recentEnabledLibraries.map((lib) => {
                    const items = (recentAddedByLibrary[lib.id] || []).slice(0, 10);
                    return (
                        <div key={`recent-${lib.id}`} className="home-recent-block">
                            <div className="home-recent-head">
                                <h3 className="home-recent-title">
                                    {t('recentlyAddedIn', 'Neu hinzugef\u00FCgt in')}{' '}
                                    <button
                                        type="button"
                                        className="home-recent-title-link"
                                        onClick={() => openLibraryFromRecent(lib)}
                                    >
                                        {lib.name}
                                    </button>
                                </h3>
                                {items.length > 0 && (
                                    <div className="home-recent-nav">
                                        <button type="button" className="home-recent-nav-btn" onClick={() => scrollRecentRow(lib.id, -1)} aria-label="Scroll left">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <polyline points="15 18 9 12 15 6" />
                                            </svg>
                                        </button>
                                        <button type="button" className="home-recent-nav-btn" onClick={() => scrollRecentRow(lib.id, 1)} aria-label="Scroll right">
                                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                                <polyline points="9 18 15 12 9 6" />
                                            </svg>
                                        </button>
                                    </div>
                                )}
                            </div>
                            {items.length === 0 ? (
                                <div className="home-recent-empty">{t('noRecentAdded', 'Keine neuen Inhalte gefunden.')}</div>
                            ) : (
                                <div className={`home-recent-row-wrap ${recentFadeState[lib.id]?.left ? 'fade-left' : ''} ${recentFadeState[lib.id]?.right ? 'fade-right' : ''} ${recentFadeState[lib.id]?.leftFx ? 'fade-left-fx' : ''} ${recentFadeState[lib.id]?.rightFx ? 'fade-right-fx' : ''}`}>
                                <div
                                    className="home-recent-row"
                                    ref={(el) => {
                                        recentRowRefs.current[lib.id] = el;
                                        if (el) setTimeout(() => updateRecentFadeForLib(lib.id), 0);
                                    }}
                                    onScroll={() => updateRecentFadeForLib(lib.id)}
                                >
                                    {items.map((v) => (
                                        <div key={`${lib.id}-${v.filePath || v.id}`} className="home-recent-card">
                                            <VideoCard
                                                video={v}
                                                onPlay={onPlay}
                                                onContextMenu={(e) => handleHomeVideoContextMenu(e, v)}
                                                onPerformerClick={(performer) => openPerformerFromVideoCard(v, performer, lib.id)}
                                                selected={selectedHomeVideoKeys.includes(homeVideoSelectionKey(v))}
                                                selectionMode={selectedHomeVideoKeys.length > 0}
                                                onToggleSelect={toggleHomeVideoSelection}
                                                reserveHeatmapSpace
                                                showPerformers
                                            />
                                        </div>
                                    ))}
                                    <div className="home-recent-card home-playlist-more-card-wrap">
                                        <button
                                            type="button"
                                            className="home-playlist-more-btn home-recent-more-btn"
                                            onClick={() => openLibraryFromRecent(lib)}
                                            aria-label={t('openLibrary', 'Bibliothek \\u00F6ffnen')}
                                        >
                                            <span className="home-playlist-more-dots" aria-hidden="true">
                                                <span />
                                                <span />
                                                <span />
                                            </span>
                                        </button>
                                    </div>                                </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            {
                contextMenu && (
                    <>
                        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }} />
                        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
                            {contextMenu.items.map((item, i) => (
                                <button key={i} className="context-menu-item" onClick={() => { item.onClick(); setContextMenu(null); }}>
                                    {item.icon && <span className="context-menu-icon">{item.icon}</span>}
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </>
                )
            }
            {selectedHomeVideoKeys.length > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllHomeVisibleVideos}>
                        {t('selectAll')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setSelectedHomeVideoKeys([])}>
                        {t('deselectAll')}
                    </button>
                    <span className="batch-floating-count">{selectedHomeVideoKeys.length} {t('selected')}</span>
                    <button className="btn btn-secondary" onClick={() => openPlaylistDialogForVideos(selectedHomeVideos)}>
                        {t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}
                    </button>
                    <button className="btn btn-primary" onClick={openHomeBatchTags}>
                        {t('batchTags', 'Batch-Tags')}
                    </button>
                </div>
            )}
            {tagDialog && (
                <TagDialog
                    title={tagDialog.title}
                    initialTags={tagDialog.tags}
                    suggestions={allKnownHomeTags}
                    onSave={handleSaveVideoTags}
                    onCancel={() => setTagDialog(null)}
                />
            )}
            {playlistDialog && (
                <PlaylistPickerDialog
                    title={playlistDialog.title}
                    videos={playlistDialog.videos}
                    onApplied={handleApplyPlaylist}
                    onCancel={() => setPlaylistDialog(null)}
                />
            )}
            {playlistManageDialog && (
                <PlaylistManageDialog
                    mode={playlistManageDialog.mode}
                    playlistName={playlistManageDialog?.playlist?.name || ''}
                    onCancel={() => setPlaylistManageDialog(null)}
                    onConfirm={handleConfirmPlaylistManage}
                />
            )}
            {continueDeleteDialog && (
                <div className="modal-overlay" onClick={() => setContinueDeleteDialog(null)}>
                    <div className="modal playlist-manage-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">
                                {continueDeleteDialog.mode === 'selected'
                                    ? t('removeSelected', 'Auswahl entfernen')
                                    : t('clearAll', 'Alles löschen')}
                            </h2>
                            <button className="modal-close" onClick={() => setContinueDeleteDialog(null)} aria-label={t('close', 'Schließen')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '13px' }}>
                                {continueDeleteDialog.mode === 'selected'
                                    ? `${t('removeSelected', 'Auswahl entfernen')} (${continueDeleteDialog.count})?`
                                    : t('clearAllContinueWatchingConfirm', 'Clear all Continue Watching entries?')}
                            </p>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setContinueDeleteDialog(null)}>
                                {t('cancel', 'Abbrechen')}
                            </button>
                            <button className="btn btn-danger" onClick={confirmContinueDelete}>
                                {continueDeleteDialog.mode === 'selected' ? t('remove', 'Entfernen') : t('delete', 'Löschen')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {batchHomeTagDialog && (
                <TagDialog
                    title={batchHomeTagDialog.title}
                    initialTags={batchHomeTagDialog.tags}
                    suggestions={allKnownHomeTags}
                    onSave={handleSaveHomeBatchTags}
                    onCancel={() => setBatchHomeTagDialog(null)}
                />
            )}
            {propertiesVideo && (
                <PropertiesDialog
                    video={propertiesVideo}
                    onClose={() => setPropertiesVideo(null)}
                />
            )}
            {thumbTimestampDialogVideo && (
                <ThumbnailTimestampDialog
                    video={thumbTimestampDialogVideo}
                    onClose={() => setThumbTimestampDialogVideo(null)}
                    onApplied={() => {
                        const videoId = String(thumbTimestampDialogVideo?.id || '').trim();
                        const nextVersion = Date.now();
                        if (videoId) {
                            setRecentAddedByLibrary((prev) => {
                                const out = {};
                                for (const [libId, arr] of Object.entries(prev || {})) {
                                    out[libId] = (arr || []).map((v) => (
                                        String(v?.id || '') === videoId ? { ...v, thumbVersion: nextVersion } : v
                                    ));
                                }
                                return out;
                            });
                            setContinueWatchingItems((prev) => (prev || []).map((v) => (
                                String(v?.id || '') === videoId ? { ...v, thumbVersion: nextVersion } : v
                            )));
                            setPlaylistPreviewById((prev) => {
                                const out = { ...(prev || {}) };
                                for (const key of Object.keys(out)) {
                                    const entry = out[key];
                                    if (String(entry?.id || '') === videoId) {
                                        out[key] = { ...entry, thumbVersion: nextVersion };
                                    }
                                }
                                return out;
                            });
                        }
                        showToast(t('thumbnailRegenerated', 'Thumbnail regenerated!'));
                    }}
                />
            )}
            {toast && (
                <div className={`toast ${toast.type} ${toastClosing ? 'closing' : ''}`}>
                    <span>{toast.message}</span>
                    {toast.action?.label ? (
                        <button
                            type="button"
                            className="toast-action-btn"
                            onClick={() => {
                                const fn = toast.action?.onClick;
                                dismissToast(0);
                                if (typeof fn === 'function') fn();
                            }}
                        >
                            {toast.action.label}
                        </button>
                    ) : null}
                </div>
            )}
        </div >
    );
}

export default HomePage;


