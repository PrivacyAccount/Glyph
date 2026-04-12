import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import ContextMenu from './ContextMenu';
import PropertiesDialog from './PropertiesDialog';
import VideoCard from './VideoCard';
import TagDialog from './TagDialog';
import PlaylistPickerDialog from './PlaylistPickerDialog';
import ThumbnailTimestampDialog from './ThumbnailTimestampDialog';
import { useI18n } from '../i18n';
import useHoverPreviewEnabled from '../hooks/useHoverPreviewEnabled';
import useSelectionHotkeys from '../hooks/useSelectionHotkeys';

function FileBrowser({
    library,
    onPlay,
    onOpenFunscriptManager,
    onFetchMetadata = null,
    refreshKey = 0,
    search = '',
    filters = {},
    selectedTagFilters = [],
    tagFilterMode = 'or',
    onTagClick = null,
    onVideosChange = null,
}) {
    const { t } = useI18n();
    const [currentPath, setCurrentPath] = useState(library.path);
    const [currentFolderName, setCurrentFolderName] = useState(null);
    const [content, setContent] = useState({ folders: [], videos: [], parent: null });
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [viewMode, setViewMode] = useState('thumbnail');
    const [contextMenu, setContextMenu] = useState(null);
    const [propertiesVideo, setPropertiesVideo] = useState(null);
    const [thumbTimestampDialogVideo, setThumbTimestampDialogVideo] = useState(null);
    const [tagDialog, setTagDialog] = useState(null);
    const [batchTagDialog, setBatchTagDialog] = useState(null);
    const [playlistDialog, setPlaylistDialog] = useState(null);
    const [selectedVideoKeys, setSelectedVideoKeys] = useState([]);
    const [selectionModeActive, setSelectionModeActive] = useState(false);
    const [toast, setToast] = useState(null);
    const hoverPreviewEnabled = useHoverPreviewEnabled();
    const [hoveredVideoId, setHoveredVideoId] = useState(null);
    const [previewReadyById, setPreviewReadyById] = useState({});
    const [previewErrorById, setPreviewErrorById] = useState({});
    const [previewAttemptById, setPreviewAttemptById] = useState({});
    const previewTimerRef = useRef(null);
    const previewRetryTimersRef = useRef({});
    const previewCacheSeedRef = useRef(Date.now());
    const browseAbortRef = useRef(null);
    const selectionAnchorRef = useRef('');

    // Thumbnail size state (persisted in localStorage)
    const [folderSize, setFolderSize] = useState(() => {
        const saved = localStorage.getItem('fb-folder-size');
        return saved ? Number(saved) : 160;
    });
    const [videoSize, setVideoSize] = useState(() => {
        const saved = localStorage.getItem('glyph_video_thumb_size');
        return saved ? Number(saved) : 240;
    });

    const handleFolderSizeChange = (val) => {
        const v = Number(val);
        setFolderSize(v);
        localStorage.setItem('fb-folder-size', v);
    };
    const handleVideoSizeChange = (val) => {
        const v = Number(val);
        setVideoSize(v);
        localStorage.setItem('glyph_video_thumb_size', v);
    };

    const handleThumbEnter = (videoId) => {
        if (!hoverPreviewEnabled || !videoId) return;
        if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
        setPreviewErrorById(prev => ({ ...prev, [videoId]: false }));
        setPreviewAttemptById(prev => ({ ...prev, [videoId]: 0 }));
        fetch(`/api/videos/${videoId}/preview?warm=1`).catch(() => { });
        previewTimerRef.current = setTimeout(() => setHoveredVideoId(videoId), 140);
    };

    const handleThumbLeave = (videoId) => {
        if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
        if (previewRetryTimersRef.current[videoId]) {
            clearTimeout(previewRetryTimersRef.current[videoId]);
            delete previewRetryTimersRef.current[videoId];
        }
        setHoveredVideoId(prev => (prev === videoId ? null : prev));
        setPreviewReadyById(prev => ({ ...prev, [videoId]: false }));
        setPreviewAttemptById(prev => ({ ...prev, [videoId]: 0 }));
    };

    useEffect(() => {
        return () => {
            if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
            for (const key of Object.keys(previewRetryTimersRef.current || {})) {
                try { clearTimeout(previewRetryTimersRef.current[key]); } catch { }
            }
            if (browseAbortRef.current) {
                try { browseAbortRef.current.abort(); } catch { }
                browseAbortRef.current = null;
            }
        };
    }, []);

    const fetchPath = async (browsePath, folderName = null) => {
        if (browseAbortRef.current) {
            try { browseAbortRef.current.abort(); } catch { }
        }
        const controller = new AbortController();
        browseAbortRef.current = controller;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/libraries/${library.id}/browse?path=${encodeURIComponent(browsePath)}`, { signal: controller.signal });
            if (!res.ok) throw new Error(`${t('errorPrefix', 'Fehler: ')}${res.status}`);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            setContent(data);
            setCurrentPath(data.path);
            setCurrentFolderName(folderName);
            setSelectedVideoKeys([]);
            setSelectionModeActive(false);
            selectionAnchorRef.current = '';
        } catch (err) {
            if (err?.name !== 'AbortError') {
                setError(err.message);
            }
        } finally {
            if (!controller.signal.aborted) {
                setLoading(false);
            }
        }
    };

    useEffect(() => {
        fetchPath(library.path, null);
        return () => {
            if (browseAbortRef.current) {
                try { browseAbortRef.current.abort(); } catch { }
                browseAbortRef.current = null;
            }
        };
    }, [library.id]);

    useEffect(() => {
        if (!refreshKey) return;
        fetchPath(currentPath || library.path, currentFolderName);
    }, [refreshKey]);

    const handleNavigate = (p, name) => fetchPath(p, name);
    const handleUp = () => { if (content.parent) fetchPath(content.parent, null); };

    const playVideo = (video) => {
        const queueVideos = (filteredVideos || []).map((entry) => ({
            id: entry?.id,
            title: entry?.title || entry?.name || '',
            filePath: entry?.filePath || entry?.path || '',
            libraryType: library?.type || 'videos',
            isVr: !!entry?.isVr,
            vrProjection: String(entry?.vrProjection || 'unknown'),
            vrStereoMode: String(entry?.vrStereoMode || 'mono'),
        })).filter((entry) => !!entry.id && !!entry.filePath);
        onPlay(
            {
                id: video.id,
                title: video.title || video.name,
                filePath: video.filePath || video.path,
                libraryType: library?.type || 'videos',
                isVr: !!video?.isVr,
                vrProjection: String(video?.vrProjection || 'unknown'),
                vrStereoMode: String(video?.vrStereoMode || 'mono'),
            },
            { queueVideos }
        );
    };

    const videoSelectionKey = (video) => video?.filePath || video?.path || video?.id;
    const allKnownTags = useMemo(() => (
        [...new Set((content?.videos || []).flatMap((v) => (v.tags || []).map((tag) => String(tag))))].sort((a, b) => a.localeCompare(b))
    ), [content?.videos]);

    useEffect(() => {
        if (onVideosChange) onVideosChange(content?.videos || []);
    }, [content?.videos]);

    const selectedTagSet = useMemo(
        () => new Set((selectedTagFilters || []).map((v) => String(v).toLowerCase())),
        [selectedTagFilters],
    );

    const matchesTagSelection = useCallback((rawTags = []) => {
        if (selectedTagSet.size === 0) return true;
        const videoTagSet = new Set((rawTags || []).map((tg) => String(tg).toLowerCase()));
        if ((tagFilterMode || 'or') === 'and') {
            return [...selectedTagSet].every((wanted) => videoTagSet.has(wanted));
        }
        return [...selectedTagSet].some((wanted) => videoTagSet.has(wanted));
    }, [selectedTagSet, tagFilterMode]);

    const filteredFolders = useMemo(() => {
        const q = String(search || '').trim().toLowerCase();
        const base = Array.isArray(content?.folders) ? content.folders : [];
        if (!q) return base;
        return base.filter((f) => String(f?.name || '').toLowerCase().includes(q));
    }, [content?.folders, search]);

    const filteredVideos = useMemo(() => {
        const base = Array.isArray(content?.videos) ? [...content.videos] : [];
        const q = String(search || '').trim().toLowerCase();
        let next = base;
        if (q) {
            next = next.filter((v) => {
                const title = String(v?.title || v?.name || '').toLowerCase();
                const fileName = String(v?.fileName || '').toLowerCase();
                return title.includes(q) || fileName.includes(q);
            });
        }
        next = next.filter((v) => matchesTagSelection(v?.tags || []));
        if ((filters?.favorite || '') === 'yes') next = next.filter((v) => !!v?.isFavorite);
        if ((filters?.funscript || '') === 'yes') next = next.filter((v) => !!v?.hasFunscript);
        if ((filters?.funscript || '') === 'no') next = next.filter((v) => !v?.hasFunscript);
        if ((filters?.multiaxis || '') === 'yes') next = next.filter((v) => !!v?.isMultiAxis);
        if ((filters?.audio || '') === 'yes') next = next.filter((v) => v?.hasAudio === true);
        if ((filters?.audio || '') === 'no') next = next.filter((v) => v?.hasAudio !== true);

        const ext = String(filters?.extension || '').trim().toLowerCase();
        if (ext) {
            const wanted = `.${ext}`;
            next = next.filter((v) => String(v?.extension || '').toLowerCase() === wanted);
        }

        if (String(library?.type || '').toLowerCase() === 'vr') {
            const projection = String(filters?.vrProjection || '').trim().toLowerCase();
            const stereo = String(filters?.vrStereoMode || '').trim().toLowerCase();
            if (projection) next = next.filter((v) => String(v?.vrProjection || '').toLowerCase() === projection);
            if (stereo) next = next.filter((v) => String(v?.vrStereoMode || '').toLowerCase() === stereo);
        }

        const sort = String(filters?.sort || 'name');
        const order = String(filters?.sortOrder || 'asc') === 'desc' ? -1 : 1;
        if (sort === 'date') {
            next.sort((a, b) => (Number(a?.modifiedAt || 0) - Number(b?.modifiedAt || 0)) * order);
        } else if (sort === 'size') {
            next.sort((a, b) => (Number(a?.size || 0) - Number(b?.size || 0)) * order);
        } else if (sort === 'duration') {
            next.sort((a, b) => {
                const aDur = Number(a?.durationSec || a?.duration || 0);
                const bDur = Number(b?.durationSec || b?.duration || 0);
                return (aDur - bDur) * order;
            });
        } else {
            next.sort((a, b) => String(a?.title || a?.name || '').localeCompare(String(b?.title || b?.name || '')) * order);
        }

        return next;
    }, [content?.videos, search, matchesTagSelection, filters, library?.type]);

    const selectedVideos = useMemo(() => {
        const keySet = new Set(selectedVideoKeys);
        return (filteredVideos || []).filter((v) => keySet.has(videoSelectionKey(v)));
    }, [filteredVideos, selectedVideoKeys]);

    const toggleVideoSelection = (video, e = null) => {
        const key = videoSelectionKey(video);
        if (!key) return;
        const ordered = (filteredVideos || []).map(videoSelectionKey).filter(Boolean);
        const hasRange = !!(e?.shiftKey && selectionAnchorRef.current && ordered.includes(selectionAnchorRef.current) && ordered.includes(key));
        if (hasRange) {
            const a = ordered.indexOf(selectionAnchorRef.current);
            const b = ordered.indexOf(key);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedVideoKeys((prev) => [...new Set([...prev, ...range])]);
            return;
        }
        selectionAnchorRef.current = key;
        setSelectedVideoKeys((prev) => (
            prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
        ));
    };

    const toggleAllVisibleVideos = () => {
        const keys = (filteredVideos || []).map(videoSelectionKey).filter(Boolean);
        const allSelected = keys.length > 0 && keys.every((k) => selectedVideoKeys.includes(k));
        if (allSelected) setSelectedVideoKeys((prev) => prev.filter((k) => !keys.includes(k)));
        else setSelectedVideoKeys((prev) => [...new Set([...prev, ...keys])]);
    };

    const openPlaylistDialogForVideos = (videos, title) => {
        const normalized = Array.isArray(videos) ? videos.filter(v => !!(v?.filePath || v?.path)) : [];
        if (normalized.length === 0) return;
        setPlaylistDialog({
            title: title || `${t('addToPlaylist', 'Zur Playlist hinzufügen')}: ${normalized.length} ${t('videos', 'Videos')}`,
            videos: normalized,
        });
    };

    const handleApplyPlaylist = (data) => {
        const addedCount = Number(data?.addedCount || 0);
        const playlistName = data?.playlist?.name || t('playlists', 'Playlists');
        showToast(`${addedCount} ${t('addedToPlaylist', 'zur Playlist hinzugefügt')}: ${playlistName}`);
        setPlaylistDialog(null);
    };

    const handleEditVideoTags = (video) => {
        setTagDialog({
            videoId: video.id,
            videoPath: video.filePath || null,
            title: `${t('editTags', 'Tags bearbeiten')}: ${video.title || video.name || ''}`,
            tags: video.tags || [],
        });
    };

    const handleSaveTags = async (tags) => {
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
            setContent((prev) => ({
                ...prev,
                videos: (prev.videos || []).map((v) => (
                    (v.filePath && tagDialog.videoPath && v.filePath === tagDialog.videoPath)
                        ? { ...v, tags: Array.isArray(tags) ? tags : [] }
                        : v
                )),
            }));
            setTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const openBatchTagDialog = () => {
        if (selectedVideos.length === 0) return;
        const common = (selectedVideos[0]?.tags || []).filter((tag) =>
            selectedVideos.every((v) => (v.tags || []).some((tg) => String(tg).toLowerCase() === String(tag).toLowerCase()))
        );
        setBatchTagDialog({
            title: `${t('batchTags', 'Batch-Tags')}: ${selectedVideos.length} ${t('videos', 'Videos')}`,
            tags: common,
        });
    };

    const handleSaveBatchTags = async (tags) => {
        try {
            await Promise.all(selectedVideos.map(async (video) => {
                const res = await fetch(`/api/tags/video/${video.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags, videoPath: video.filePath || null }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            }));
            const selectedSet = new Set(selectedVideoKeys);
            setContent((prev) => ({
                ...prev,
                videos: (prev.videos || []).map((v) => (
                    selectedSet.has(videoSelectionKey(v))
                        ? { ...v, tags: Array.isArray(tags) ? tags : [] }
                        : v
                )),
            }));
            setBatchTagDialog(null);
            setSelectedVideoKeys([]);
            selectionAnchorRef.current = '';
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const showToast = (msg, type = 'success') => { setToast({ message: msg, type }); setTimeout(() => setToast(null), 3000); };

    const pickImage = () => {
        return new Promise(resolve => {
            if (window.electronAPI?.selectImage) {
                window.electronAPI.selectImage().then(result => {
                    resolve(result ? result.base64 : null);
                }).catch(() => resolve(null));
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

    const handleCustomThumbnail = async (video) => {
        const imageData = await pickImage();
        if (!imageData) return;
        try {
            const res = await fetch(`/api/videos/${video.id}/thumbnail/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData }),
            });
            if (!res.ok) throw new Error(t('uploadFailed', 'Upload fehlgeschlagen'));
            fetchPath(currentPath, currentFolderName);
            showToast(t('thumbnailUpdated', 'Thumbnail aktualisiert!'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        }
    };

    const handleCustomFolderPoster = async (folderPath) => {
        const imageData = await pickImage();
        if (!imageData) return;
        try {
            const res = await fetch('/api/poster/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath, imageData }),
            });
            if (!res.ok) throw new Error(t('uploadFailed', 'Upload fehlgeschlagen'));
            fetchPath(currentPath, currentFolderName);
            showToast(t('posterUpdated', 'Poster aktualisiert!'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        }
    };

    const handleVideoContextMenu = (e, video) => {
        e.preventDefault();
        e.stopPropagation();
        const isSelected = selectedVideoKeys.includes(videoSelectionKey(video));
        const items = [
            {
                label: isSelected ? t('removeSelection', 'Auswahl entfernen') : t('select', 'Auswählen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8 12 2.5 2.5L16 9" /></svg>,
                onClick: () => {
                    setSelectionModeActive(true);
                    toggleVideoSelection(video);
                },
            },
            {
                label: t('play', 'Abspielen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
                onClick: () => playVideo(video),
            },
            {
                label: t('editTags', 'Tags bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                onClick: () => handleEditVideoTags(video),
            },
            {
                label: t('fetchMetadata', 'Fetch metadata'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M21 21l-4.35-4.35" /><circle cx="10.5" cy="10.5" r="7.5" /><path d="M10.5 6.5v8" /><path d="M6.5 10.5h8" /></svg>,
                onClick: () => {
                    if (typeof onFetchMetadata === 'function') {
                        onFetchMetadata(video);
                    }
                },
            },
            {
                label: t('manageScript', 'Script verwalten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" /><rect x="2.5" y="4" width="19" height="16" rx="3" /></svg>,
                onClick: () => onOpenFunscriptManager?.({
                    videoId: video?.id,
                    libraryId: library?.id,
                    title: video?.title || video?.name || '',
                }),
            },
            {
                label: t('addToPlaylist', 'Zur Playlist hinzufügen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h10" /><path d="m17 15 3 3-3 3" /><path d="M20 18h-6" /></svg>,
                onClick: () => openPlaylistDialogForVideos([video], `${t('addToPlaylist', 'Zur Playlist hinzufügen')}: ${video.title || video.name || ''}`),
            },
            {
                label: t('changeThumbnail', 'Thumbnail \u00E4ndern'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                onClick: () => handleCustomThumbnail(video),
            },
            {
                label: t('regenerateThumbnailShort', 'Regenerate thumbnail'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="14" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /><path d="M12 19v2" /><path d="M8 21h8" /></svg>,
                onClick: () => setThumbTimestampDialogVideo(video),
            },
            {
                label: t('properties', 'Eigenschaften'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>,
                onClick: () => setPropertiesVideo(video),
            },
        ];
        if (String(library?.type || '').toLowerCase() === 'vr') {
            items.push({
                label: t('editVrMeta', 'VR-Meta bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c3 3 3 15 0 18" /></svg>,
                onClick: async () => {
                    try {
                        const res = await fetch(`/api/videos/${video.id}/vr-meta`);
                        if (!res.ok) throw new Error(t('loadFailed', 'Laden fehlgeschlagen'));
                        const data = await res.json();
                        const projection = (window.prompt('VR Projektion (unknown/180/360)', String(data?.projection || 'unknown')) || '').trim().toLowerCase();
                        if (!projection) return;
                        const stereoMode = (window.prompt('VR Stereo (mono/sbs/ou)', String(data?.stereoMode || 'mono')) || '').trim().toLowerCase();
                        if (!stereoMode) return;
                        const save = await fetch(`/api/videos/${video.id}/vr-meta`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ projection, stereoMode }),
                        });
                        if (!save.ok) throw new Error(t('saveFailed', 'Speichern fehlgeschlagen'));
                        await fetchPath(currentPath, currentFolderName);
                        showToast(t('saved', 'Gespeichert'));
                    } catch (err) {
                        showToast(t('errorPrefix', 'Fehler: ') + (err?.message || ''), 'error');
                    }
                },
            });
        }
        setContextMenu({ x: e.clientX, y: e.clientY, items });
    };

    const handleFolderContextMenu = (e, folder) => {
        e.preventDefault();
        e.stopPropagation();
        const items = [
            {
                label: t('changePoster', 'Poster/Thumbnail \u00E4ndern'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                onClick: () => handleCustomFolderPoster(folder.path),
            },
        ];
        setContextMenu({ x: e.clientX, y: e.clientY, items });
    };

    const isInSubfolder = content.parent != null;
    const hasFolders = filteredFolders.length > 0;
    const hasVideos = filteredVideos.length > 0;
    const selectionHotkeysEnabled = !contextMenu && !tagDialog && !batchTagDialog && !playlistDialog && !propertiesVideo;
    useSelectionHotkeys({
        enabled: selectionHotkeysEnabled,
        onSelectAll: () => {
            setSelectionModeActive(true);
            toggleAllVisibleVideos();
        },
        onClearSelection: () => {
            setSelectedVideoKeys([]);
            setSelectionModeActive(false);
            selectionAnchorRef.current = '';
        },
    });

    return (
        <div className="file-browser">
            <div className="file-browser-header">
                <div className="file-browser-nav">
                    {isInSubfolder && (
                        <button className="file-browser-up" onClick={handleUp} title={t('upOneLevel', 'Eine Ebene nach oben')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                                <polyline points="15 18 9 12 15 6" />
                            </svg>
                            {t('back', 'Zur\u00FCck')}
                        </button>
                    )}
                    {currentFolderName && (
                        <span className="file-browser-folder-name">{currentFolderName}</span>
                    )}
                </div>
                <div className="file-browser-controls">
                    {viewMode === 'thumbnail' && (hasFolders || hasVideos) && (
                        <div className="fb-size-controls">
                            {hasFolders && (
                                <div className="fb-size-slider" title={t('folderSize', 'Ordnergröße')}>
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>
                                    <input type="range" min="100" max="300" value={folderSize} onChange={e => handleFolderSizeChange(e.target.value)} />
                                </div>
                            )}
                            {hasVideos && (
                                <div className="fb-size-slider" title={t('videoSize', 'Videogröße')}>
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z" /></svg>
                                    <input type="range" min="120" max="400" value={videoSize} onChange={e => handleVideoSizeChange(e.target.value)} />
                                </div>
                            )}
                        </div>
                    )}
                    <div className="file-browser-view-toggle">
                        <button className={`fb-view-btn ${viewMode === 'thumbnail' ? 'active' : ''}`} onClick={() => setViewMode('thumbnail')} title={t('thumbnailsView', 'Thumbnails')}>
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                                <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                            </svg>
                        </button>
                        <button className={`fb-view-btn list-icon ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')} title={t('listView', 'Liste')}>
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                            </svg>
                        </button>
                        {hasVideos && (
                            <button
                                className={`fb-view-btn ${selectionModeActive || selectedVideoKeys.length > 0 ? 'active' : ''}`}
                                onClick={() => setSelectionModeActive((prev) => !prev)}
                                title={t('select', 'Auswählen')}
                                aria-label={t('select', 'Auswählen')}
                            >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="4" y="4" width="16" height="16" rx="3" />
                                    <path d="m8 12 2.5 2.5L16 9" />
                                </svg>
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {loading ? (
                <div className="loading-spinner"><div className="spinner" /></div>
            ) : error ? (
                <div className="error-message">{error}</div>
            ) : viewMode === 'list' ? (
                /* -- LIST VIEW -- */
                <div className="file-browser-list">
                    {filteredFolders.map(folder => (
                        <div key={folder.path} className="file-browser-item folder" onClick={() => handleNavigate(folder.path, folder.name)} onContextMenu={(e) => handleFolderContextMenu(e, folder)}>
                            <div className="file-browser-icon">
                                {folder.hasPoster ? (
                                    <img src={`/api/poster?path=${encodeURIComponent(folder.path)}`} alt="" className="fb-list-poster" />
                                ) : (
                                    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>
                                )}
                            </div>
                            <div className="file-browser-name">{folder.name}</div>
                            {folder.videoCount > 0 && <div className="file-browser-count">{folder.videoCount} {t('videos', 'Videos')}</div>}
                            <div className="file-browser-arrow">›</div>
                        </div>
                    ))}
                    {hasVideos && (
                        <div className="video-grid list-mode">
                            {filteredVideos.map((video) => (
                                <VideoCard
                                    key={video.id || video.path}
                                    video={video}
                                    onPlay={playVideo}
                                    onContextMenu={(e) => handleVideoContextMenu(e, video)}
                                    selected={selectedVideoKeys.includes(videoSelectionKey(video))}
                                    selectionMode={selectionModeActive || selectedVideoKeys.length > 0}
                                    onToggleSelect={toggleVideoSelection}
                                    viewMode="list"
                                    reserveHeatmapSpace
                                    onTagClick={onTagClick}
                                />
                            ))}
                        </div>
                    )}
                    {filteredFolders.length === 0 && filteredVideos.length === 0 && (
                        <div className="empty-state-small">{t('folderEmpty', 'Ordner ist leer')}</div>
                    )}
                </div>
            ) : (
                /* -- THUMBNAIL VIEW -- */
                <div className="file-browser-grid-wrap">
                    {hasFolders && (
                        <div className="file-browser-grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${folderSize}px, 1fr))` }}>
                            {filteredFolders.map(folder => (
                                <div key={folder.path} className="fb-grid-card folder-card" onClick={() => handleNavigate(folder.path, folder.name)} onContextMenu={(e) => handleFolderContextMenu(e, folder)}>
                                    <div className="fb-grid-thumb folder-thumb">
                                        {folder.hasPoster ? (
                                            <img src={`/api/poster?path=${encodeURIComponent(folder.path)}`} alt="" loading="lazy" />
                                        ) : (
                                            <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" /></svg>
                                        )}
                                    </div>
                                    <div className="fb-grid-info">
                                        <div className="fb-grid-name">{folder.name}</div>
                                        {folder.videoCount > 0 && <div className="fb-grid-count">{folder.videoCount} {t('videos', 'Videos')}</div>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                    {hasVideos && (
                        <div className="video-grid" style={{ '--video-grid-min': `${videoSize}px` }}>
                            {filteredVideos.map((video) => (
                                <VideoCard
                                    key={video.id || video.path}
                                    video={video}
                                    onPlay={playVideo}
                                    onContextMenu={(e) => handleVideoContextMenu(e, video)}
                                    selected={selectedVideoKeys.includes(videoSelectionKey(video))}
                                    selectionMode={selectionModeActive || selectedVideoKeys.length > 0}
                                    onToggleSelect={toggleVideoSelection}
                                    viewMode="grid"
                                    reserveHeatmapSpace
                                    onTagClick={onTagClick}
                                />
                            ))}
                        </div>
                    )}
                    {!hasFolders && !hasVideos && (
                        <div className="empty-state-small">{t('folderEmpty', 'Ordner ist leer')}</div>
                    )}
                </div>
            )}

            {selectedVideoKeys.length > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllVisibleVideos}>
                        {t('selectAll', 'Alle auswählen')}
                    </button>
                    <button
                        className="btn btn-secondary"
                        onClick={() => {
                            setSelectedVideoKeys([]);
                            setSelectionModeActive(false);
                            selectionAnchorRef.current = '';
                        }}
                    >
                        {t('deselectAll', 'Alle abwählen')}
                    </button>
                    <span className="batch-floating-count">{selectedVideoKeys.length} {t('selected', 'ausgewählt')}</span>
                    <button className="btn btn-secondary" onClick={() => openPlaylistDialogForVideos(selectedVideos)}>
                        {t('addToPlaylist', 'Zur Playlist hinzufügen')}
                    </button>
                    <button className="btn btn-primary" onClick={openBatchTagDialog}>
                        {t('batchTags', 'Batch-Tags')}
                    </button>
                </div>
            )}

            {tagDialog && (
                <TagDialog
                    title={tagDialog.title}
                    initialTags={tagDialog.tags}
                    suggestions={allKnownTags}
                    onSave={handleSaveTags}
                    onCancel={() => setTagDialog(null)}
                />
            )}
            {playlistDialog && (
                <PlaylistPickerDialog
                    title={playlistDialog.title}
                    videos={playlistDialog.videos}
                    onApply={handleApplyPlaylist}
                    onCancel={() => setPlaylistDialog(null)}
                />
            )}
            {batchTagDialog && (
                <TagDialog
                    title={batchTagDialog.title}
                    initialTags={batchTagDialog.tags}
                    suggestions={allKnownTags}
                    onSave={handleSaveBatchTags}
                    onCancel={() => setBatchTagDialog(null)}
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
                        fetchPath(currentPath, currentFolderName);
                        showToast(t('thumbnailRegenerated', 'Thumbnail regenerated!'));
                    }}
                />
            )}
            {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default FileBrowser;




