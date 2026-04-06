import React, { useState, useEffect, useRef } from 'react';
import FunscriptHeatmap from '../components/FunscriptHeatmap';
import PropertiesDialog from '../components/PropertiesDialog';
import ContextMenu from '../components/ContextMenu';
import TMDBDialog from '../components/TMDBDialog';
import TagDialog from '../components/TagDialog';
import PlaylistPickerDialog from '../components/PlaylistPickerDialog';
import VideoCard from '../components/VideoCard';
import ThumbnailTimestampDialog from '../components/ThumbnailTimestampDialog';
import { useI18n } from '../i18n';
import useThumbnailHeatmapMode from '../hooks/useThumbnailHeatmapMode';
import useHoverPreviewEnabled from '../hooks/useHoverPreviewEnabled';
import useSelectionHotkeys from '../hooks/useSelectionHotkeys';
import { fetchVideoDetails } from '../services/videoMetaService';

function SeriesDetail({ folderPath, folderName, openImagesOnLoad = false, onBack, onPlay, onOpenFunscriptManager }) {
    const { t } = useI18n();
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [activeSeason, setActiveSeason] = useState(null);
    const [viewMode, setViewMode] = useState('thumbnails');
    const [contextMenu, setContextMenu] = useState(null);
    const [tmdbDialog, setTmdbDialog] = useState(null);
    const [seriesImageDialog, setSeriesImageDialog] = useState(null);
    const [propertiesVideo, setPropertiesVideo] = useState(null);
    const [thumbTimestampDialogVideo, setThumbTimestampDialogVideo] = useState(null);
    const [tagDialog, setTagDialog] = useState(null);
    const [batchTagDialog, setBatchTagDialog] = useState(null);
    const [playlistDialog, setPlaylistDialog] = useState(null);
    const [selectedEpisodeKeys, setSelectedEpisodeKeys] = useState([]);
    const [toast, setToast] = useState(null);
    const [heatmapDurations, setHeatmapDurations] = useState({});
    const showThumbnailHeatmap = useThumbnailHeatmapMode();

    const abortControllerRef = useRef(null);
    const preloadTimerRef = useRef(null);
    const preloadTokenRef = useRef(0);
    const selectionAnchorRef = useRef('');
    const autoOpenImagesDoneRef = useRef(false);

    const fetchDetail = async () => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const signal = controller.signal;

        setLoading(true);
        try {
            const res = await fetch(`/api/series/detail?path=${encodeURIComponent(folderPath)}`, { signal });
            const data = await res.json();
            if (signal.aborted) return;

            setDetail(data);
            if (data.seasons?.length > 0 && !activeSeason) {
                setActiveSeason(data.seasons[0].name);
            }
            const allVideos = [
                ...(data.directVideos || []),
                ...(data.seasons || []).flatMap(s => s.videos),
            ];
            scheduleEpisodeMetaPreload(allVideos, signal);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Failed to fetch series detail:', err);
            }
        } finally {
            if (!signal.aborted) {
                setLoading(false);
            }
        }
    };

    const scheduleEpisodeMetaPreload = async (allVideos, signal) => {
        const token = ++preloadTokenRef.current;
        if (preloadTimerRef.current) {
            clearTimeout(preloadTimerRef.current);
            preloadTimerRef.current = null;
        }
        const withFunscript = (allVideos || []).filter(v => !!v?.hasFunscript && !!v?.id);
        if (withFunscript.length === 0) return;

        const applyMeta = (videoId, details) => {
            if (signal.aborted || token !== preloadTokenRef.current) return;
            const sec = Number(details?.duration || 0);
            const durationMs = sec > 0 ? sec * 1000 : 0;
            if (durationMs > 0) {
                setHeatmapDurations(prev => (prev[videoId] === durationMs ? prev : { ...prev, [videoId]: durationMs }));
            }
        };

        const loadOne = async (video) => {
            if (!video?.id || signal.aborted || token !== preloadTokenRef.current) return;
            try {
                const details = await fetchVideoDetails(video.id, { signal, priority: -20 });
                applyMeta(video.id, details);
            } catch { }
        };

        // Prioritize cards likely visible first, then stream the rest in small batches.
        const firstBatch = withFunscript.slice(0, 24);
        const rest = withFunscript.slice(24);
        await Promise.all(firstBatch.map(loadOne));

        let cursor = 0;
        const step = async () => {
            if (signal.aborted || token !== preloadTokenRef.current) return;
            if (cursor >= rest.length) return;
            const chunk = rest.slice(cursor, cursor + 14);
            cursor += 14;
            await Promise.all(chunk.map(loadOne));
            if (cursor < rest.length) {
                preloadTimerRef.current = setTimeout(() => {
                    step().catch(() => { });
                }, 120);
            }
        };
        step().catch(() => { });
    };

    useEffect(() => {
        setActiveSeason(null);
        setHeatmapDurations({});
        setSelectedEpisodeKeys([]);
        selectionAnchorRef.current = '';
        autoOpenImagesDoneRef.current = false;
        setBatchTagDialog(null);
        fetchDetail();

        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            if (preloadTimerRef.current) {
                clearTimeout(preloadTimerRef.current);
                preloadTimerRef.current = null;
            }
            preloadTokenRef.current += 1;
        };
    }, [folderPath]);

    useEffect(() => {
        if (!openImagesOnLoad || !detail || autoOpenImagesDoneRef.current) return;
        autoOpenImagesDoneRef.current = true;
        openSeriesImagesDialog();
    }, [openImagesOnLoad, detail]);

    const currentSeason = detail?.seasons?.find(s => s.name === activeSeason);
    const hasSeasons = detail?.seasons?.length > 0;
    const videos = hasSeasons ? (currentSeason?.videos || []) : (detail?.directVideos || []);
    const allEpisodes = [
        ...(detail?.directVideos || []),
        ...((detail?.seasons || []).flatMap(s => s.videos || [])),
    ];
    const allKnownTags = [
        ...new Set(
            allEpisodes.flatMap(v => (v.tags || []).map(tag => String(tag)))
        ),
    ].sort((a, b) => a.localeCompare(b));
    const handlePlayInSeasonQueue = (video, options = {}) => {
        onPlay(video, { ...options, queueVideos: videos });
    };

    const selectedEpisodes = allEpisodes.filter(v => {
        const key = v.filePath || v.id;
        return selectedEpisodeKeys.includes(key);
    });

    const handleEditVideoTags = (video) => {
        setTagDialog({
            videoId: video.id,
            videoPath: video.filePath || null,
            title: `${t('editTags', 'Tags bearbeiten')}: ${video.title}`,
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
            await fetchDetail();
            setTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const toggleEpisodeSelection = (video, e = null) => {
        const key = video.filePath || video.id;
        if (!key) return;
        const ordered = videos.map(v => v.filePath || v.id).filter(Boolean);
        const hasRange = !!(e?.shiftKey && selectionAnchorRef.current && ordered.includes(selectionAnchorRef.current) && ordered.includes(key));
        if (hasRange) {
            const a = ordered.indexOf(selectionAnchorRef.current);
            const b = ordered.indexOf(key);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedEpisodeKeys(prev => [...new Set([...prev, ...range])]);
            return;
        }
        selectionAnchorRef.current = key;
        setSelectedEpisodeKeys(prev => (
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        ));
    };

    const selectEpisodeFromContextMenu = (video) => {
        const key = video?.filePath || video?.id;
        if (!key) return;
        selectionAnchorRef.current = key;
        setSelectedEpisodeKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    };

    const toggleAllVisibleEpisodes = () => {
        const keys = videos.map(v => v.filePath || v.id).filter(Boolean);
        const allSelected = keys.length > 0 && keys.every(k => selectedEpisodeKeys.includes(k));
        if (allSelected) {
            setSelectedEpisodeKeys(prev => prev.filter(k => !keys.includes(k)));
        } else {
            setSelectedEpisodeKeys(prev => [...new Set([...prev, ...keys])]);
        }
    };

    const openBatchTagDialog = () => {
        if (selectedEpisodes.length === 0) return;
        const first = selectedEpisodes[0]?.tags || [];
        const firstSet = new Set(first.map(t => String(t).toLowerCase()));
        const common = (first || []).filter(tag =>
            selectedEpisodes.every(ep => (ep.tags || []).some(t => String(t).toLowerCase() === String(tag).toLowerCase()))
        );
        setBatchTagDialog({
            tags: common,
            title: `${t('batchTags', 'Batch-Tags')}: ${selectedEpisodes.length} ${t('episodes', 'Episoden')}`,
            allSelected: firstSet.size > 0,
        });
    };

    const handleSaveBatchTags = async (tags) => {
        try {
            const jobs = selectedEpisodes.map(async (video) => {
                const res = await fetch(`/api/tags/video/${video.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags, videoPath: video.filePath || null }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            });
            await Promise.all(jobs);
            await fetchDetail();
            setSelectedEpisodeKeys([]);
            setBatchTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const openPlaylistDialogForVideos = (videos, title) => {
        const normalized = Array.isArray(videos) ? videos.filter(v => !!(v?.filePath || v?.path)) : [];
        if (normalized.length === 0) return;
        setPlaylistDialog({
            title: title || `${t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}: ${normalized.length} ${t('episodes', 'Episoden')}`,
            videos: normalized,
        });
    };

    const handleApplyPlaylist = (data) => {
        const addedCount = Number(data?.addedCount || 0);
        const playlistName = data?.playlist?.name || t('playlists', 'Playlists');
        showToast(`${addedCount} ${t('addedToPlaylist', 'zur Playlist hinzugef\u00FCgt')}: ${playlistName}`);
        setPlaylistDialog(null);
    };

    const handleContextMenu = (e, video) => {
        e.preventDefault();
        setContextMenu({
            x: e.clientX, y: e.clientY,
            items: [{
                label: t('play', 'Abspielen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
                onClick: () => handlePlayInSeasonQueue(video),
            }, {
                label: t('select', 'Ausw\u00E4hlen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 11 12 14 20 6" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
                onClick: () => selectEpisodeFromContextMenu(video),
            }, {
                label: t('editTags', 'Tags bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                onClick: () => handleEditVideoTags(video),
            }, {
                label: t('manageScript', 'Script verwalten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" /><rect x="2.5" y="4" width="19" height="16" rx="3" /></svg>,
                onClick: () => onOpenFunscriptManager?.({
                    videoId: video?.id,
                    libraryId: video?.libraryId || video?.library_id || null,
                    title: video?.title || video?.fileName || '',
                }),
            }, {
                label: t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h10" /><path d="m17 15 3 3-3 3" /><path d="M20 18h-6" /></svg>,
                onClick: () => openPlaylistDialogForVideos([video], `${t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}: ${video.title}`),
            }, {
                label: t('regenerateThumbnailShort', 'Regenerate thumbnail'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="14" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /><path d="M12 19v2" /><path d="M8 21h8" /></svg>,
                onClick: () => setThumbTimestampDialogVideo(video),
            }, {
                label: t('properties', 'Eigenschaften'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>,
                onClick: () => setPropertiesVideo(video),
            }],
        });
    };

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    const pickImageData = async () => {
        if (window.electronAPI?.selectImage) {
            const result = await window.electronAPI.selectImage();
            return result?.base64 || null;
        }
        return await new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = () => {
                const file = input.files?.[0];
                if (!file) return resolve(null);
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.readAsDataURL(file);
            };
            input.click();
        });
    };

    const openSeriesImagesDialog = async () => {
        const currentMeta = detail?.metadata || {};
        const tmdbId = Number(currentMeta?.tmdbId || 0);
        if (!tmdbId) {
            showToast(t('tmdbMissingHint', 'Bitte zuerst TMDB-Metadaten setzen.'), 'error');
            return;
        }

        const type = String(currentMeta?.type || '').toLowerCase() === 'movie' ? 'movie' : 'series';
        setSeriesImageDialog({
            loading: true,
            saving: false,
            error: '',
            type,
            tmdbId,
            images: { posters: [], backdrops: [] },
            selectedPoster: currentMeta?.posterPath || null,
            selectedBackdrop: currentMeta?.backdropIsLocal ? null : (currentMeta?.backdropPath || null),
        });

        try {
            const res = await fetch('/api/tmdb/images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tmdbId, type }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('loadFailed', 'Laden fehlgeschlagen'));
            const posters = Array.isArray(data?.posters) ? data.posters : [];
            const backdrops = Array.isArray(data?.backdrops) ? data.backdrops : [];
            setSeriesImageDialog((prev) => prev ? ({
                ...prev,
                loading: false,
                images: { posters, backdrops },
                selectedPoster: prev.selectedPoster || posters[0]?.file_path || null,
                selectedBackdrop: prev.selectedBackdrop || backdrops[0]?.file_path || null,
            }) : prev);
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? ({
                ...prev,
                loading: false,
                error: String(err?.message || t('loadFailed', 'Laden fehlgeschlagen')),
            }) : prev);
        }
    };

    const applySeriesImages = async () => {
        if (!seriesImageDialog || !detail) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/tmdb/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tmdbId: seriesImageDialog.tmdbId,
                    type: seriesImageDialog.type,
                    folderPath,
                    posterPath: seriesImageDialog.selectedPoster || undefined,
                    backdropPath: seriesImageDialog.selectedBackdrop || undefined,
                    titleOverride: detail?.metadata?.title || detail?.name || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('saveFailed', 'Speichern fehlgeschlagen'));
            await fetchDetail();
            setSeriesImageDialog(null);
            showToast(t('metadataSaved', 'Metadaten gespeichert!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('saveFailed', 'Speichern fehlgeschlagen')),
            } : prev);
        }
    };

    const uploadSeriesPoster = async () => {
        const imageData = await pickImageData();
        if (!imageData) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/poster/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath, imageData }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('uploadFailed', 'Upload fehlgeschlagen'));
            await fetchDetail();
            setSeriesImageDialog(null);
            showToast(t('posterUpdated', 'Poster aktualisiert!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('uploadFailed', 'Upload fehlgeschlagen')),
            } : prev);
        }
    };

    const uploadSeriesBackdrop = async () => {
        const imageData = await pickImageData();
        if (!imageData) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/backdrop/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath, imageData }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('uploadFailed', 'Upload fehlgeschlagen'));
            await fetchDetail();
            setSeriesImageDialog(null);
            showToast(t('backdropSet', 'Backdrop gesetzt!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('uploadFailed', 'Upload fehlgeschlagen')),
            } : prev);
        }
    };

    const selectionHotkeysEnabled = !contextMenu && !tagDialog && !batchTagDialog && !playlistDialog && !propertiesVideo && !tmdbDialog && !seriesImageDialog;
    useSelectionHotkeys({
        enabled: selectionHotkeysEnabled,
        onSelectAll: () => toggleAllVisibleEpisodes(),
        onClearSelection: () => {
            setSelectedEpisodeKeys([]);
            selectionAnchorRef.current = '';
        },
    });

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;
    if (!detail) return <div className="empty-state"><h2>{t('seriesNotFound', 'Serie nicht gefunden')}</h2></div>;

    const meta = detail.metadata;
    const backdropSrc = meta?.backdropIsLocal
        ? `/api/backdrop?path=${encodeURIComponent(folderPath)}&v=${encodeURIComponent(meta?.backdropUpdatedAt || 0)}`
        : (meta?.backdropPath ? `https://image.tmdb.org/t/p/w1280${meta.backdropPath}` : '');
    const posterSrc = `/api/poster?path=${encodeURIComponent(folderPath)}&v=${encodeURIComponent(Number(detail?.posterVersion || 0))}`;

    return (
        <div className="series-detail">
            {/* Hero section */}
            <div className="series-hero">
                {backdropSrc && (
                    <img className="series-hero-backdrop" src={backdropSrc} alt="" />
                )}
                <div className="series-hero-gradient" />
                <div className="series-hero-content">
                    <div className="series-poster-wrapper series-poster-wrap">
                        <button
                            type="button"
                            className="performer-detail-quickedit"
                            onClick={openSeriesImagesDialog}
                            title={t('changePosterBackdrop', 'Poster/Backdrop ändern')}
                            aria-label={t('changePosterBackdrop', 'Poster/Backdrop ändern')}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="5" width="18" height="14" rx="2" />
                                <circle cx="9" cy="10" r="2" />
                                <path d="m21 15-4-4L8 20" />
                            </svg>
                        </button>
                        {detail.hasPoster ? (
                            <img className="series-poster" src={posterSrc} alt={meta?.title || detail.name} />
                        ) : (
                            <div className="series-poster-placeholder">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                                <span>{t('noPoster', 'Kein Poster')}</span>
                            </div>
                        )}
                    </div>
                    <div className="series-info">
                        <h1 className="series-title">{meta?.title || detail.name}</h1>
                        {meta?.originalTitle && meta.originalTitle !== meta.title && (
                            <p className="series-original-title">{meta.originalTitle}</p>
                        )}
                        <div className="series-meta-row">
                            {meta?.releaseDate && <span className="series-meta-tag">{meta.releaseDate.substring(0, 4)}</span>}
                            {meta?.voteAverage && <span className="series-meta-tag series-rating">{t('rating', 'Rating')} {meta.voteAverage.toFixed(1)}</span>}
                            {meta?.numberOfSeasons && <span className="series-meta-tag">{meta.numberOfSeasons} {t('seasons', 'Staffeln')}</span>}
                            {meta?.numberOfEpisodes && <span className="series-meta-tag">{meta.numberOfEpisodes} {t('episodes', 'Episoden')}</span>}
                            {meta?.status && <span className="series-meta-tag series-status">{meta.status}</span>}
                        </div>
                        {meta?.genres?.length > 0 && (
                            <div className="series-genres">
                                {meta.genres.map(g => <span key={g} className="series-genre-pill">{g}</span>)}
                            </div>
                        )}
                        {meta?.overview && <p className="series-overview">{meta.overview}</p>}
                        <div className="series-actions">
                            <button className="btn btn-secondary" onClick={onBack}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m15 18-6-6 6-6" /></svg>
                                {t('back', 'ZurÃ¼ck')}
                            </button>
                            <button className="btn btn-primary" onClick={() => setTmdbDialog({ query: detail.name, type: 'tv', folderPath })}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>
                                TMDB
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {/* Episodes section (no sidebar here) */}
            <div className="series-content">
                <div className="series-content-header">
                    {hasSeasons && (
                        <div className="season-tabs">
                            {detail.seasons.map(season => (
                                <button key={season.name} className={`season-tab ${activeSeason === season.name ? 'active' : ''}`} onClick={() => setActiveSeason(season.name)}>
                                    {season.name}
                                    <span className="season-tab-count">{season.videos.length}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="view-mode-toggle">
                        <button className={`view-mode-btn ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => setViewMode('grid')} title={t('gridView', 'Grid')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
                        </button>
                        <button className={`view-mode-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')} title={t('listView', 'Liste')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                            </svg>
                        </button>
                        <button className={`view-mode-btn ${viewMode === 'thumbnails' ? 'active' : ''}`} onClick={() => setViewMode('thumbnails')} title={t('thumbnailsView', 'Thumbnails')}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="6" y1="21" x2="18" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>
                        </button>
                    </div>
                </div>

                {viewMode === 'list' && (
                    <EpisodeListView
                        videos={videos}
                        onPlay={handlePlayInSeasonQueue}
                        onContextMenu={handleContextMenu}
                        heatmapDurations={heatmapDurations}
                        showThumbnailHeatmap={showThumbnailHeatmap}
                        selectedEpisodeKeys={selectedEpisodeKeys}
                        onToggleSelect={toggleEpisodeSelection}
                    />
                )}
                {viewMode === 'grid' && (
                    <EpisodeGridView
                        videos={videos}
                        onPlay={handlePlayInSeasonQueue}
                        onContextMenu={handleContextMenu}
                        heatmapDurations={heatmapDurations}
                        showThumbnailHeatmap={showThumbnailHeatmap}
                        selectedEpisodeKeys={selectedEpisodeKeys}
                        onToggleSelect={toggleEpisodeSelection}
                    />
                )}
                {viewMode === 'thumbnails' && (
                    <EpisodeThumbnailView
                        videos={videos}
                        onPlay={handlePlayInSeasonQueue}
                        onContextMenu={handleContextMenu}
                        selectedEpisodeKeys={selectedEpisodeKeys}
                        onToggleSelect={toggleEpisodeSelection}
                    />
                )}
            </div>

            {selectedEpisodeKeys.length > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllVisibleEpisodes}>
                        {t('selectAll', 'Alle auswählen')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setSelectedEpisodeKeys([])}>
                        {t('deselectAll', 'Alle abwählen')}
                    </button>
                    <span className="batch-floating-count">{selectedEpisodeKeys.length} {t('selected', 'ausgewÃ¤hlt')}</span>
                    <button className="btn btn-secondary" onClick={() => openPlaylistDialogForVideos(selectedEpisodes)}>
                        {t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}
                    </button>
                    <button className="btn btn-primary" onClick={openBatchTagDialog}>
                        {t('batchTags', 'Batch-Tags')}
                    </button>
                </div>
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
                        fetchDetail();
                        showToast(t('thumbnailRegenerated', 'Thumbnail regenerated!'));
                    }}
                />
            )}
            {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
            {tmdbDialog && (
                <TMDBDialog query={tmdbDialog.query} type={tmdbDialog.type} folderPath={tmdbDialog.folderPath} onClose={() => setTmdbDialog(null)}
                    onApplied={() => { fetchDetail(); showToast(t('metadataSaved', 'Metadaten gespeichert!'), 'success'); }} />
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
                    onApplied={handleApplyPlaylist}
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
            {seriesImageDialog && (
                <div className="modal-overlay" onClick={() => !seriesImageDialog.saving && setSeriesImageDialog(null)}>
                    <div className="modal tmdb-modal series-images-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('changePosterBackdrop', 'Poster/Backdrop ändern')}</h2>
                            <button
                                className="modal-close"
                                onClick={() => !seriesImageDialog.saving && setSeriesImageDialog(null)}
                                disabled={seriesImageDialog.saving}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="modal-body custom-scrollbar">
                            {seriesImageDialog.loading ? (
                                <div className="loading-spinner"><div className="spinner" /></div>
                            ) : (
                                <div className="tmdb-images-step">
                                    {seriesImageDialog.error ? (
                                        <div className="tmdb-error">{seriesImageDialog.error}</div>
                                    ) : null}
                                    <div className="tmdb-images-section">
                                        <h3>{t('selectPoster', 'Poster auswählen')} ({seriesImageDialog.images.posters.length})</h3>
                                        <div className="tmdb-image-grid posters">
                                            {seriesImageDialog.images.posters.map((img) => (
                                                <button
                                                    key={img.file_path}
                                                    type="button"
                                                    className={`tmdb-image-card poster ${seriesImageDialog.selectedPoster === img.file_path ? 'selected' : ''}`}
                                                    onClick={() => setSeriesImageDialog((prev) => prev ? { ...prev, selectedPoster: img.file_path } : prev)}
                                                >
                                                    <img src={`https://image.tmdb.org/t/p/w185${img.file_path}`} alt="" loading="lazy" />
                                                </button>
                                            ))}
                                            {seriesImageDialog.images.posters.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noPosterAvailablePlural', 'Keine Poster verfügbar')}</p>}
                                        </div>
                                    </div>
                                    <div className="tmdb-images-section">
                                        <h3>{t('selectBackdrop', 'Backdrop auswählen')} ({seriesImageDialog.images.backdrops.length})</h3>
                                        <div className="tmdb-image-grid backdrops">
                                            {seriesImageDialog.images.backdrops.map((img) => (
                                                <button
                                                    key={img.file_path}
                                                    type="button"
                                                    className={`tmdb-image-card backdrop ${seriesImageDialog.selectedBackdrop === img.file_path ? 'selected' : ''}`}
                                                    onClick={() => setSeriesImageDialog((prev) => prev ? { ...prev, selectedBackdrop: img.file_path } : prev)}
                                                >
                                                    <img src={`https://image.tmdb.org/t/p/w300${img.file_path}`} alt="" loading="lazy" />
                                                </button>
                                            ))}
                                            {seriesImageDialog.images.backdrops.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noBackdropAvailablePlural', 'Keine Backdrops verfügbar')}</p>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="modal-footer series-images-footer">
                            <div className="series-images-footer-left">
                                <button className="btn btn-secondary" onClick={uploadSeriesBackdrop} disabled={seriesImageDialog.saving || seriesImageDialog.loading}>
                                    {t('uploadBackdrop', 'Backdrop hochladen')}
                                </button>
                                <button className="btn btn-secondary" onClick={uploadSeriesPoster} disabled={seriesImageDialog.saving || seriesImageDialog.loading}>
                                    {t('uploadPoster', 'Poster hochladen')}
                                </button>
                            </div>
                            <div className="series-images-footer-right">
                                <button className="btn btn-secondary" onClick={() => setSeriesImageDialog(null)} disabled={seriesImageDialog.saving}>
                                    {t('cancel', 'Abbrechen')}
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={applySeriesImages}
                                    disabled={seriesImageDialog.saving || seriesImageDialog.loading || (!seriesImageDialog.selectedPoster && !seriesImageDialog.selectedBackdrop)}
                                >
                                    {seriesImageDialog.saving ? t('saving', 'Speichere...') : t('apply', 'Anwenden')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

/* â•â•â• LIST VIEW â•â•â• */
function EpisodeListView({ videos, onPlay, onContextMenu, heatmapDurations, selectedEpisodeKeys, onToggleSelect, showThumbnailHeatmap }) {
    return (
        <div className="episode-list">
            {videos.map((video, i) => (
                <div
                    key={video.id}
                    className="episode-row"
                    onClick={(e) => {
                        if (selectedEpisodeKeys.length > 0 || e.shiftKey || e.ctrlKey || e.metaKey) onToggleSelect(video, e);
                        else onPlay(video);
                    }}
                    onContextMenu={(e) => onContextMenu(e, video)}
                >
                    <span className="episode-number">{i + 1}</span>
                    <div className="episode-thumb">
                        <div
                            className={`folder-select-corner ${selectedEpisodeKeys.includes(video.filePath || video.id) ? 'selected' : ''} ${selectedEpisodeKeys.length > 0 ? 'selection-mode' : ''}`}
                            onPointerDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onToggleSelect(video, e);
                            }}
                            onContextMenu={(e) => e.stopPropagation()}
                        >
                            <button
                                type="button"
                                className={`folder-select-checkbox ${selectedEpisodeKeys.includes(video.filePath || video.id) ? 'checked' : ''}`}
                                aria-label={selectedEpisodeKeys.includes(video.filePath || video.id) ? 'Auswahl entfernen' : 'AuswÃ¤hlen'}
                                onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                    >
                                <span className="folder-select-check" />
                            </button>
                        </div>
                        {video.hasThumbnail ? (
                            <img src={`/api/videos/${video.id}/thumbnail`} alt="" loading="lazy" />
                        ) : (
                            <div className="episode-thumb-placeholder">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                            </div>
                        )}
                    </div>
                    <div className="episode-info">
                        <div className="episode-title">{video.title}</div>
                        <div className="episode-meta">
                            <span>{video.extension.replace('.', '').toUpperCase()}</span>
                            {video.hasFunscript && <span className="episode-fs-badge">FS</span>}
                        </div>
                        {Array.isArray(video.tags) && video.tags.length > 0 && (
                            <div className="item-tag-row">
                                {video.tags.slice(0, 3).map(tag => (
                                    <span key={tag} className="item-tag">{tag}</span>
                                ))}
                            </div>
                        )}
                        {video.hasFunscript && showThumbnailHeatmap && (
                            <div className="episode-heatmap">
                                <FunscriptHeatmap
                                    videoId={video.id}
                                    cacheKey={video.modifiedAt || 0}
                                    durationMs={heatmapDurations?.[video.id] || null}
                                    width={300}
                                    height={4}
                                    variant="detailed"
                                />
                            </div>
                        )}
                    </div>
                    <div className="episode-play-btn">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M8 5v14l11-7L8 5z" /></svg>
                    </div>
                </div>
            ))}
        </div>
    );
}

/* â•â•â• GRID VIEW â•â•â• */
function EpisodeGridView({ videos, onPlay, onContextMenu, heatmapDurations, selectedEpisodeKeys, onToggleSelect, showThumbnailHeatmap }) {
    return (
        <div className="episode-grid">
            {videos.map((video, i) => (
                <EpisodeGridCard
                    key={video.id}
                    video={video}
                    index={i}
                    onPlay={onPlay}
                    onContextMenu={onContextMenu}
                    heatmapDurationMs={heatmapDurations?.[video.id] || null}
                    showThumbnailHeatmap={showThumbnailHeatmap}
                    selected={selectedEpisodeKeys.includes(video.filePath || video.id)}
                    selectionMode={selectedEpisodeKeys.length > 0}
                    onToggleSelect={onToggleSelect}
                />
            ))}
        </div>
    );
}

function EpisodeGridCard({ video, index, onPlay, onContextMenu, heatmapDurationMs, showThumbnailHeatmap, selected, selectionMode, onToggleSelect }) {
    const [cardWidth, setCardWidth] = useState(200);
    const cardRef = useRef(null);
    useEffect(() => {
        if (cardRef.current) {
            const observer = new ResizeObserver(entries => { for (const entry of entries) setCardWidth(entry.contentRect.width); });
            observer.observe(cardRef.current);
            return () => observer.disconnect();
        }
    }, []);
    const hue = video.title.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return (
        <div
            ref={cardRef}
            className="episode-grid-card"
            onClick={(e) => {
                if (selectionMode || e.shiftKey || e.ctrlKey || e.metaKey) onToggleSelect(video, e);
                else onPlay(video);
            }}
            onContextMenu={(e) => onContextMenu(e, video)}
        >
            <div className="episode-grid-thumb">
                <div
                    className={`folder-select-corner ${selected ? 'selected' : ''} ${selectionMode ? 'selection-mode' : ''}`}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleSelect(video, e);
                    }}
                    onContextMenu={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className={`folder-select-checkbox ${selected ? 'checked' : ''}`}
                        aria-label={selected ? 'Auswahl entfernen' : 'AuswÃ¤hlen'}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                    >
                        <span className="folder-select-check" />
                    </button>
                </div>
                {video.hasThumbnail ? (
                    <img src={`/api/videos/${video.id}/thumbnail`} alt="" loading="lazy" />
                ) : (
                    <div className="episode-grid-thumb-fallback" style={{ background: `linear-gradient(135deg, hsl(${hue}, 40%, 12%) 0%, hsl(${(hue + 40) % 360}, 30%, 8%) 100%)` }} />
                )}
                <div className="episode-grid-play-overlay">
                    <div className="episode-play-circle">
                        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z" /></svg>
                    </div>
                </div>
                <span className="episode-grid-number">{index + 1}</span>
                {video.hasFunscript && <span className="episode-grid-fs-badge">FS</span>}
            </div>
            {video.hasFunscript && showThumbnailHeatmap && (
                <FunscriptHeatmap
                    videoId={video.id}
                    cacheKey={video.modifiedAt || 0}
                    durationMs={heatmapDurationMs || null}
                    width={cardWidth}
                    height={4}
                    variant="detailed"
                />
            )}
            <div className="episode-grid-info">
                <div className="episode-grid-title">{video.title}</div>
                <div className="episode-grid-meta">{video.extension.replace('.', '').toUpperCase()}</div>
                {Array.isArray(video.tags) && video.tags.length > 0 && (
                    <div className="item-tag-row">
                        {video.tags.slice(0, 2).map(tag => (
                            <span key={tag} className="item-tag">{tag}</span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/* â•â•â• THUMBNAIL VIEW â•â•â• */
function EpisodeThumbnailView({ videos, onPlay, onContextMenu, selectedEpisodeKeys, onToggleSelect }) {
    return (
        <div className="video-grid episode-thumbnail-grid">
            {videos.map((video) => (
                <VideoCard
                    key={video.id}
                    video={video}
                    onPlay={onPlay}
                    onContextMenu={(e) => onContextMenu(e, video)}
                    selected={selectedEpisodeKeys.includes(video.filePath || video.id)}
                    selectionMode={selectedEpisodeKeys.length > 0}
                    onToggleSelect={onToggleSelect}
                />
            ))}
        </div>
    );
}

function EpisodeThumbnailCard({ video, index, onPlay, onContextMenu, heatmapDurationMs, showThumbnailHeatmap, selected, selectionMode, onToggleSelect }) {
    const [cardWidth, setCardWidth] = useState(280);
    const [showPreview, setShowPreview] = useState(false);
    const [previewReady, setPreviewReady] = useState(false);
    const [previewError, setPreviewError] = useState(false);
    const [previewAttempt, setPreviewAttempt] = useState(0);
    const cardRef = useRef(null);
    const previewTimerRef = useRef(null);
    const previewRetryRef = useRef(null);
    const previewCacheSeedRef = useRef(Date.now());
    const hoverPreviewEnabled = useHoverPreviewEnabled();
    const heatmapHeight = 12;
    useEffect(() => {
        if (cardRef.current) {
            const observer = new ResizeObserver(entries => { for (const entry of entries) setCardWidth(entry.contentRect.width); });
            observer.observe(cardRef.current);
            return () => observer.disconnect();
        }
    }, []);
    useEffect(() => {
        return () => {
            if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
            if (previewRetryRef.current) clearTimeout(previewRetryRef.current);
        };
    }, []);
    const hue = video.title.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    return (
        <div
            ref={cardRef}
            className="episode-thumb-card"
            onClick={(e) => {
                if (selectionMode || e.shiftKey || e.ctrlKey || e.metaKey) onToggleSelect(video, e);
                else onPlay(video);
            }}
            onContextMenu={(e) => onContextMenu(e, video)}
            onMouseEnter={() => {
                if (!hoverPreviewEnabled) return;
                if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
                setPreviewError(false);
                setPreviewAttempt(0);
                fetch(`/api/videos/${video.id}/preview?warm=1`).catch(() => { });
                previewTimerRef.current = setTimeout(() => setShowPreview(true), 140);
            }}
            onMouseLeave={() => {
                if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
                if (previewRetryRef.current) clearTimeout(previewRetryRef.current);
                previewTimerRef.current = null;
                previewRetryRef.current = null;
                setShowPreview(false);
                setPreviewReady(false);
                setPreviewAttempt(0);
            }}
        >
            <div className="episode-thumb-card-img">
                <div
                    className={`folder-select-corner ${selected ? 'selected' : ''} ${selectionMode ? 'selection-mode' : ''}`}
                    onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleSelect(video, e);
                    }}
                    onContextMenu={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className={`folder-select-checkbox ${selected ? 'checked' : ''}`}
                        aria-label={selected ? 'Auswahl entfernen' : 'AuswÃ¤hlen'}
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                    >
                        <span className="folder-select-check" />
                    </button>
                </div>
                {video.hasThumbnail ? (
                    <img src={`/api/videos/${video.id}/thumbnail`} alt="" loading="lazy" />
                ) : (
                    <div className="episode-thumb-card-fallback" style={{ background: `linear-gradient(135deg, hsl(${hue}, 35%, 10%) 0%, hsl(${(hue + 30) % 360}, 25%, 7%) 100%)` }}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="32" height="32"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                    </div>
                )}
                {hoverPreviewEnabled && showPreview && !previewError && (
                    <video
                        key={`${video.id}-${previewAttempt}`}
                        className={`episode-thumb-card-preview ${previewReady ? 'ready' : ''}`}
                        src={`/api/videos/${video.id}/preview?v=${previewAttempt}&s=${previewCacheSeedRef.current}`}
                        muted
                        playsInline
                        autoPlay
                        loop
                        preload="metadata"
                        onCanPlay={() => setPreviewReady(true)}
                        onError={() => {
                            setPreviewReady(false);
                            if (previewAttempt < 18 && hoverPreviewEnabled) {
                                const mode = previewAttempt === 0 ? 'regen=1' : 'warm=1';
                                fetch(`/api/videos/${video.id}/preview?${mode}`).catch(() => { });
                                previewRetryRef.current = setTimeout(() => {
                                    setPreviewAttempt(prev => prev + 1);
                                }, 1200);
                            } else {
                                setPreviewError(true);
                                setShowPreview(false);
                            }
                        }}
                    />
                )}
                <div className="episode-thumb-card-hover">
                    <div className="episode-play-circle">
                        <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z" /></svg>
                    </div>
                </div>
                {video.hasFunscript && <span className="episode-thumb-card-fs">FS</span>}
            </div>
            {video.hasFunscript && showThumbnailHeatmap && (
                <FunscriptHeatmap
                    videoId={video.id}
                    cacheKey={video.modifiedAt || 0}
                    durationMs={heatmapDurationMs || null}
                    width={cardWidth}
                    height={heatmapHeight}
                    variant="detailed"
                />
            )}
            <div className="episode-thumb-card-info">
                <span className="episode-thumb-card-num">E{index + 1}</span>
                <div className="episode-thumb-card-text">
                    <span className="episode-thumb-card-title">{video.title}</span>
                    {Array.isArray(video.tags) && video.tags.length > 0 && (
                        <div className="item-tag-row episode-thumb-tag-row">
                            {video.tags.slice(0, 2).map(tag => (
                                <span key={tag} className="item-tag">{tag}</span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default SeriesDetail;






