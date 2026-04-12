import React, { useState, useEffect, useRef } from 'react';
import FunscriptHeatmap from './FunscriptHeatmap';
import { useI18n } from '../i18n';
import useThumbnailHeatmapMode from '../hooks/useThumbnailHeatmapMode';
import useHoverPreviewEnabled from '../hooks/useHoverPreviewEnabled';
import { fetchVideoDetails } from '../services/videoMetaService';

function VideoCard({
    video,
    onPlay,
    onContextMenu,
    selected = false,
    selectionMode = false,
    onToggleSelect = null,
    reserveHeatmapSpace = false,
    resumeProgress = null,
    resumePositionSec = null,
    viewMode = 'grid',
    showPerformers = false,
    onPerformerClick = null,
    onTagClick = null,
}) {
    const { t } = useI18n();
    const [videoDurationMs, setVideoDurationMs] = useState(0);
    const [heatmapWidth, setHeatmapWidth] = useState(260);
    const [thumbError, setThumbError] = useState(false);
    const [thumbLoaded, setThumbLoaded] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [previewReady, setPreviewReady] = useState(false);
    const [previewError, setPreviewError] = useState(false);
    const [previewAttempt, setPreviewAttempt] = useState(0);
    const [isNearViewport, setIsNearViewport] = useState(false);
    const [isInViewport, setIsInViewport] = useState(false);
    const [thumbAttempt, setThumbAttempt] = useState(0);
    const [isFavorite, setIsFavorite] = useState(!!video?.isFavorite);
    const [favoriteSaving, setFavoriteSaving] = useState(false);
    const [resolutionLabel, setResolutionLabel] = useState('');
    const cardRef = useRef(null);
    const previewTimerRef = useRef(null);
    const previewRetryRef = useRef(null);
    const thumbRetryRef = useRef(null);
    const previewCacheSeedRef = useRef(Date.now());
    const showThumbnailHeatmap = useThumbnailHeatmapMode();
    const hoverPreviewEnabled = useHoverPreviewEnabled();
    const heatmapHeight = 14;

    useEffect(() => {
        const node = cardRef.current;
        if (!node || isNearViewport) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                if (entry.isIntersecting || entry.intersectionRatio > 0) {
                    setIsNearViewport(true);
                    observer.disconnect();
                }
            },
            { root: null, rootMargin: '900px 0px', threshold: 0.01 }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [isNearViewport]);

    useEffect(() => {
        const node = cardRef.current;
        if (!node) return;
        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                setIsInViewport(!!entry.isIntersecting && entry.intersectionRatio > 0);
            },
            { root: null, rootMargin: '0px', threshold: [0, 0.05, 0.25] }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        let mounted = true;
        const controller = new AbortController();
        if (!isNearViewport) return () => { mounted = false; };
        const shouldLoadDetails = true;
        const reqPriority = isInViewport ? 100 : 35;

        if (shouldLoadDetails) {
            fetchVideoDetails(video.id, { signal: controller.signal, priority: reqPriority })
                .then((data) => {
                    if (!mounted) return;
                    const sec = Number(data?.duration || 0);
                    if (sec > 0) setVideoDurationMs(sec * 1000);
                    const label = computeResolutionLabel(data?.width, data?.height);
                    if (label) setResolutionLabel(label);
                })
                .catch(() => { });
        }
        return () => {
            mounted = false;
            controller.abort();
        };
    }, [video.id, video.hasFunscript, resumePositionSec, isNearViewport, isInViewport]);

    useEffect(() => {
        const label = computeResolutionLabel(video?.width, video?.height);
        setResolutionLabel(label || '');
    }, [video?.id, video?.width, video?.height]);

    useEffect(() => {
        if (cardRef.current) {
            const targetNode = cardRef.current.querySelector('.video-card-thumbnail') || cardRef.current;
            const observer = new ResizeObserver(entries => {
                for (const entry of entries) {
                    setHeatmapWidth(entry.contentRect.width);
                }
            });
            observer.observe(targetNode);
            return () => observer.disconnect();
        }
    }, [viewMode]);

    const safeTitle = String(video?.title || video?.name || '').trim();

    const formatDate = (timestamp) => {
        const ts = Number(timestamp);
        if (!Number.isFinite(ts) || ts <= 0) return '';
        return new Date(ts).toLocaleDateString('de-DE', {
            day: '2-digit', month: '2-digit', year: 'numeric',
        });
    };
    const formatDurationShort = (durationMs) => {
        const totalSec = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
        if (!totalSec) return null;
        const sec = totalSec % 60;
        const min = Math.floor(totalSec / 60) % 60;
        const hrs = Math.floor(totalSec / 3600);
        if (hrs > 0) {
            return `${String(hrs)}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        }
        return `${String(min)}:${String(sec).padStart(2, '0')}`;
    };

    const computeResolutionLabel = (widthRaw, heightRaw) => {
        const width = Number(widthRaw || 0);
        const height = Number(heightRaw || 0);
        if (!(width > 0) || !(height > 0)) return '';
        const longEdge = Math.max(width, height);
        const shortEdge = Math.min(width, height);
        if (longEdge >= 7680 || shortEdge >= 4320) return '8K';
        if (longEdge >= 6144 || shortEdge >= 3160) return '6K';
        if (longEdge >= 5120 || shortEdge >= 2880) return '5K';
        if (longEdge >= 3840 || shortEdge >= 2160) return '4K';
        if (shortEdge >= 1440) return '1440p';
        if (shortEdge >= 1080) return '1080p';
        if (shortEdge >= 720) return '720p';
        if (shortEdge >= 480) return '480p';
        return `${Math.round(shortEdge)}p`;
    };

    const isFemalePerformer = (performer) => {
        const raw = String(performer?.gender || '').trim().toLowerCase();
        if (!raw) return false;
        const tokens = raw.split(/[^a-z]+/).filter(Boolean);
        const hasMale = tokens.some((token) => token === 'male' || token === 'man');
        if (hasMale) return false;
        return tokens.some((token) => token === 'female' || token === 'woman' || token === 'f');
    };

    const titleHash = safeTitle.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const hue = titleHash % 360;
    const hasThumbnail = video.hasThumbnail && !thumbError;
    const progressRatioRaw = Number(resumeProgress);
    const explicitRatio = Number.isFinite(progressRatioRaw) ? Math.max(0, Math.min(1, progressRatioRaw)) : null;
    const resumePosSec = Number(resumePositionSec || 0);
    const durationSec = Number(videoDurationMs || 0) / 1000;
    const fallbackRatio = (Number.isFinite(resumePosSec) && resumePosSec > 0 && Number.isFinite(durationSec) && durationSec > 0)
        ? Math.max(0, Math.min(1, resumePosSec / durationSec))
        : null;
    const progressRatioRawValue = explicitRatio !== null ? explicitRatio : fallbackRatio;
    const progressRatio = (progressRatioRawValue !== null && progressRatioRawValue > 0.001)
        ? progressRatioRawValue
        : null;
    const handleCardClick = (e) => {
        const multiSelectModifier = !!(e?.metaKey || e?.ctrlKey || e?.shiftKey);
        if ((selectionMode || multiSelectModifier) && onToggleSelect) {
            onToggleSelect(video, e);
            return;
        }
        if (typeof onPlay === 'function') onPlay(video);
    };

    const handleCornerAction = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onToggleSelect) onToggleSelect(video, e);
    };

    const handleMouseEnter = () => {
        if (!hoverPreviewEnabled || !video?.id || !isNearViewport) return;
        if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
        setPreviewError(false);
        setPreviewAttempt(0);
        fetch(`/api/videos/${video.id}/preview?warm=1`).catch(() => { });
        previewTimerRef.current = setTimeout(() => {
            setShowPreview(true);
        }, 140);
    };

    const handleMouseLeave = () => {
        if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
        if (previewRetryRef.current) clearTimeout(previewRetryRef.current);
        previewTimerRef.current = null;
        previewRetryRef.current = null;
        setShowPreview(false);
        setPreviewReady(false);
        setPreviewAttempt(0);
    };

    const handleToggleFavorite = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (favoriteSaving || !video?.id) return;
        const next = !isFavorite;
        setIsFavorite(next);
        setFavoriteSaving(true);
        try {
            const res = await fetch(`/api/videos/${encodeURIComponent(String(video.id))}/favorite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isFavorite: next }),
            });
            if (!res.ok) throw new Error('favorite-update-failed');
            const data = await res.json().catch(() => ({}));
            setIsFavorite(typeof data?.isFavorite === 'boolean' ? data.isFavorite : next);
        } catch {
            setIsFavorite(!next);
        } finally {
            setFavoriteSaving(false);
        }
    };

    useEffect(() => {
        return () => {
            if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
            if (previewRetryRef.current) clearTimeout(previewRetryRef.current);
            if (thumbRetryRef.current) clearTimeout(thumbRetryRef.current);
        };
    }, []);

    useEffect(() => {
        setThumbError(false);
        setThumbLoaded(false);
        setThumbAttempt(0);
        if (thumbRetryRef.current) {
            clearTimeout(thumbRetryRef.current);
            thumbRetryRef.current = null;
        }
    }, [video.id, video.thumbVersion]);

    useEffect(() => {
        setIsFavorite(!!video?.isFavorite);
    }, [video?.id, video?.isFavorite]);

    const performerEntries = Array.isArray(video?.performers)
        ? video.performers
            .map((p) => {
                if (typeof p === 'string') return { id: '', name: p.trim() };
                return {
                    id: String(p?.id || '').trim(),
                    name: String(p?.name || '').trim(),
                    gender: String(p?.gender || '').trim(),
                };
            })
            .filter((p) => !!p.name)
        : [];
    const femalePerformerEntries = performerEntries.filter((p) => isFemalePerformer(p));

    return (
        <div
            className={`video-card ${selectionMode ? 'selectable' : ''} ${viewMode === 'list' ? 'list-mode' : ''}`}
            ref={cardRef}
            onClick={handleCardClick}
            onContextMenu={onContextMenu}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
        >
            <div className="video-card-thumbnail">
                <div
                    className={`folder-select-corner ${selected ? 'selected' : ''} ${selectionMode ? 'selection-mode' : ''}`}
                    onClick={handleCornerAction}
                    onContextMenu={(e) => e.stopPropagation()}
                >
                    <button
                        type="button"
                        className={`folder-select-checkbox ${selected ? 'checked' : ''}`}
                        aria-label={selected ? 'Auswahl entfernen' : 'Auswaehlen'}
                        onClick={handleCornerAction}
                    >
                        <span className="folder-select-check" />
                    </button>
                </div>
                <div
                    className="video-card-thumb-fallback"
                    style={{
                        opacity: (hasThumbnail && isNearViewport && thumbLoaded) ? 0 : 1,
                        background: `linear-gradient(135deg, hsl(${hue}, 40%, 12%) 0%, hsl(${(hue + 40) % 360}, 30%, 8%) 100%)`,
                    }}
                />
                {hasThumbnail && isNearViewport && (
                    <img
                        className={`video-card-thumb-img ${thumbLoaded ? 'loaded' : ''}`}
                        src={`/api/videos/${video.id}/thumbnail?fast=1&t=${thumbAttempt}&v=${Number(video?.thumbVersion || 0)}`}
                        alt={safeTitle}
                        loading={isInViewport ? 'eager' : 'lazy'}
                        decoding="async"
                        fetchPriority={isInViewport ? 'high' : 'auto'}
                        onLoad={() => {
                            setThumbError(false);
                            setThumbLoaded(true);
                        }}
                        onError={() => {
                            setThumbLoaded(false);
                            if (thumbAttempt >= 12) {
                                setThumbError(true);
                                return;
                            }
                            if (thumbRetryRef.current) clearTimeout(thumbRetryRef.current);
                            const jitter = thumbAttempt < 4
                                ? (80 + Math.floor(Math.random() * 120))
                                : (200 + Math.floor(Math.random() * 300));
                            const retryDelay = thumbAttempt < 4 ? 260 + jitter : 900 + jitter;
                            thumbRetryRef.current = setTimeout(() => {
                                setThumbAttempt((prev) => prev + 1);
                            }, retryDelay);
                        }}
                        draggable={false}
                    />
                )}
                {hoverPreviewEnabled && showPreview && !previewError && (
                    <video
                        key={`${video.id}-${previewAttempt}`}
                        className={`video-card-thumb-preview ${previewReady ? 'ready' : ''}`}
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
                <div className="video-card-play-icon">
                    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z" /></svg>
                </div>
                <button
                    type="button"
                    className={`video-card-favorite-btn ${isFavorite ? 'active' : ''}`}
                    title={isFavorite ? t('removeFavorite', 'Nicht mehr Favorit') : t('addFavorite', 'Favorit')}
                    aria-label={isFavorite ? t('removeFavorite', 'Nicht mehr Favorit') : t('addFavorite', 'Favorit')}
                    onClick={handleToggleFavorite}
                    disabled={favoriteSaving}
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 3.4l2.6 5.25 5.8.84-4.2 4.1.99 5.79L12 16.9l-5.19 2.48.99-5.79-4.2-4.1 5.8-.84L12 3.4z" />
                    </svg>
                </button>
                {videoDurationMs > 0 && (
                    <span className="video-card-duration-badge" title={`${t('duration', 'Duration')}: ${formatDurationShort(videoDurationMs)}`}>
                        {formatDurationShort(videoDurationMs)}
                    </span>
                )}
                {resolutionLabel && (
                    <span className="video-card-resolution-badge" title={`${t('resolution', 'Resolution')}: ${resolutionLabel}`}>
                        {resolutionLabel}
                    </span>
                )}
                {video.isVr && (
                    <span className="video-card-vr-badge">
                        VR {video.vrProjection === 'unknown' ? '' : video.vrProjection} {String(video.vrStereoMode || '').toUpperCase()}
                    </span>
                )}
                {video.hasFunscript && (
                    <span className="video-card-funscript-badge">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                        </svg>
                        FS
                    </span>
                )}
                {video.isMultiAxis && (
                    <span className="video-card-multiaxis-badge" title={`${t('axesLabel', 'Axes')}: ${(video.axes || []).join(', ')}`}>
                        MA {(video.axes || []).length}
                    </span>
                )}
                {progressRatio !== null && (
                    <div className="video-card-resume-track" aria-hidden="true">
                        <span className="video-card-resume-fill" style={{ width: `${progressRatio * 100}%` }} />
                    </div>
                )}
            </div>

            {viewMode !== 'list' && video.hasFunscript && showThumbnailHeatmap ? (
                <FunscriptHeatmap
                    videoId={video.id}
                    cacheKey={video.modifiedAt || 0}
                    width={heatmapWidth}
                    height={heatmapHeight}
                    variant="detailed"
                    className="video-card-heatmap"
                />
            ) : viewMode !== 'list' && reserveHeatmapSpace ? (
                <div className="video-card-heatmap-spacer" style={{ height: `${heatmapHeight}px` }} aria-hidden="true" />
            ) : null}

            <div className="video-card-info">
                <div className="video-card-title" title={safeTitle}>{safeTitle || '—'}</div>
                <div className="video-card-meta">
                    <span>{formatDate(video?.modifiedAt) || '—'}</span>
                    {showPerformers && femalePerformerEntries.length > 0 && (
                        <>
                            <span aria-hidden="true">|</span>
                            <div className="video-card-meta-performers">
                                {femalePerformerEntries.slice(0, 2).map((performer) => (
                                    typeof onPerformerClick === 'function' ? (
                                        <button
                                            key={`${performer.id || performer.name}-${video.id}`}
                                            type="button"
                                            className="video-card-meta-performer-btn item-tag"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onPerformerClick(performer);
                                            }}
                                            title={performer.name}
                                        >
                                            {performer.name}
                                        </button>
                                    ) : (
                                        <span
                                            key={`${performer.id || performer.name}-${video.id}`}
                                            className="video-card-meta-performer-btn video-card-meta-performer-static item-tag"
                                            title={performer.name}
                                        >
                                            {performer.name}
                                        </span>
                                    )
                                ))}
                                {femalePerformerEntries.length > 2 && (
                                    <span className="video-card-meta-performer-more">+{femalePerformerEntries.length - 2}</span>
                                )}
                            </div>
                        </>
                    )}
                </div>
                {Array.isArray(video.tags) && video.tags.length > 0 && (
                    <div className="item-tag-row video-tag-row">
                        {video.tags.slice(0, 3).map(tag => (
                            <span key={tag} className={`item-tag${onTagClick ? ' item-tag-clickable' : ''}`}
                                onClick={onTagClick ? (e) => { e.stopPropagation(); onTagClick(tag); } : undefined}
                            >{tag}</span>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export default VideoCard;
