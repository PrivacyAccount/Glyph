import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';

function parseTimestampInput(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
        const sec = Number(raw.replace(',', '.'));
        return Number.isFinite(sec) && sec >= 0 ? sec : null;
    }
    const parts = raw.split(':').map((p) => p.trim());
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    const nums = parts.map((p) => Number(p));
    let h = 0;
    let m = 0;
    let s = 0;
    if (nums.length === 2) {
        [m, s] = nums;
    } else {
        [h, m, s] = nums;
    }
    if (m >= 60 || s >= 60) return null;
    return (h * 3600) + (m * 60) + s;
}

function formatTimestamp(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseDurationSecondsFromVideo(video) {
    const candidates = [
        video?.durationSec,
        video?.durationSeconds,
        video?.videoLength,
        video?.lengthSec,
        video?.lengthSeconds,
        video?.duration,
    ];
    for (const value of candidates) {
        if (value == null) continue;
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
        const raw = String(value).trim();
        if (!raw) continue;
        if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
            const sec = Number(raw.replace(',', '.'));
            if (Number.isFinite(sec) && sec >= 0) return sec;
            continue;
        }
        const parts = raw.split(':').map((p) => p.trim());
        if (parts.length === 2 || parts.length === 3) {
            if (!parts.every((p) => /^\d+$/.test(p))) continue;
            const nums = parts.map((p) => Number(p));
            let h = 0; let m = 0; let s = 0;
            if (nums.length === 2) [m, s] = nums;
            else [h, m, s] = nums;
            if (m >= 60 || s >= 60) continue;
            return (h * 3600) + (m * 60) + s;
        }
    }
    return 0;
}

function ThumbnailTimestampDialog({ video, onClose, onApplied }) {
    const { t } = useI18n();
    const [hours, setHours] = useState(0);
    const [minutes, setMinutes] = useState(0);
    const [seconds, setSeconds] = useState(0);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [previewNonce, setPreviewNonce] = useState(0);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState('');
    const [previewDisplayUrl, setPreviewDisplayUrl] = useState('');
    const previewRequestIdRef = useRef(0);

    const videoTitle = useMemo(
        () => String(video?.title || video?.fileName || video?.name || ''),
        [video?.title, video?.fileName, video?.name],
    );
    const videoDurationSec = useMemo(() => parseDurationSecondsFromVideo(video), [video]);
    const canUseHours = videoDurationSec >= 3600;
    const parsedSeconds = useMemo(() => (
        ((canUseHours ? Math.max(0, Number(hours) || 0) : 0) * 3600) +
        (Math.max(0, Number(minutes) || 0) * 60) +
        Math.max(0, Number(seconds) || 0)
    ), [hours, minutes, seconds, canUseHours]);

    useEffect(() => {
        if (!canUseHours && hours !== 0) setHours(0);
    }, [canUseHours, hours]);
    const previewUrl = useMemo(() => {
        if (!video?.id) return '';
        if (parsedSeconds == null) return '';
        const qs = new URLSearchParams({
            timestamp: String(parsedSeconds),
            n: String(previewNonce),
        });
        return `/api/videos/${encodeURIComponent(video.id)}/thumbnail/preview?${qs.toString()}`;
    }, [video?.id, parsedSeconds, previewNonce]);

    useEffect(() => {
        if (!video?.id) return;
        if (parsedSeconds == null) {
            setPreviewLoading(false);
            setPreviewError('');
            return;
        }
        setPreviewError('');
        setPreviewLoading(true);
        const id = setTimeout(() => {
            setPreviewNonce((n) => n + 1);
        }, 220);
        return () => clearTimeout(id);
    }, [video?.id, parsedSeconds]);

    useEffect(() => {
        if (!previewUrl) {
            setPreviewLoading(false);
            return;
        }
        const reqId = ++previewRequestIdRef.current;
        const img = new Image();
        img.onload = () => {
            if (previewRequestIdRef.current !== reqId) return;
            setPreviewDisplayUrl(previewUrl);
            setPreviewLoading(false);
            setPreviewError('');
        };
        img.onerror = () => {
            if (previewRequestIdRef.current !== reqId) return;
            setPreviewLoading(false);
            setPreviewError(t('thumbnailPreviewLoadFailed', 'Preview could not be loaded.'));
        };
        img.src = previewUrl;
        return () => {
            img.onload = null;
            img.onerror = null;
        };
    }, [previewUrl, t]);

    const useCurrentPlayerTime = async () => {
        setError('');
        const getter = window?.electronAPI?.mpvGetProperty;
        if (typeof getter !== 'function') {
            setError(t('thumbnailTimestampNoPlayerTime', 'Current player time is not available.'));
            return;
        }
        try {
            const timePos = await getter('time-pos').catch(() => null);
            const sec = Number(timePos);
            if (!Number.isFinite(sec) || sec < 0) {
                setError(t('thumbnailTimestampNoPlayerTime', 'Current player time is not available.'));
                return;
            }
            const total = Math.max(0, Math.floor(sec));
            setHours(Math.floor(total / 3600));
            setMinutes(Math.floor((total % 3600) / 60));
            setSeconds(total % 60);
            setPreviewError('');
            setPreviewLoading(true);
            setPreviewNonce((n) => n + 1);
        } catch {
            setError(t('thumbnailTimestampNoPlayerTime', 'Current player time is not available.'));
        }
    };

    const apply = async () => {
        if (!video?.id) return;
        const sec = parsedSeconds;
        setSaving(true);
        setError('');
        try {
            const res = await fetch(`/api/videos/${encodeURIComponent(video.id)}/thumbnail/regenerate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timestamp: sec }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('unknown', 'Unknown'));
            onApplied?.(data);
            onClose?.();
        } catch (err) {
            setError(String(err?.message || t('unknown', 'Unknown')));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={() => !saving && onClose?.()}>
            <div className="modal playlist-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{t('regenerateThumbnailShort', 'Regenerate thumbnail')}</h2>
                    <button className="modal-close" onClick={() => !saving && onClose?.()} aria-label={t('close', 'Close')}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                <div className="modal-body">
                    {videoTitle ? (
                        <div className="playlist-dialog-hint" style={{ marginBottom: 10 }}>{videoTitle}</div>
                    ) : null}
                    <div className="thumbnail-ts-layout">
                        <div className="thumbnail-ts-left">
                            <div className="playlist-dialog-section" style={{ marginBottom: 0 }}>
                                <label className="playlist-dialog-label" htmlFor="thumbnail-ts-input" style={{ display: 'block', marginBottom: 8 }}>
                                    {t('timestampLabel', 'Timestamp')}
                                </label>
                                <div className="playlist-dialog-input-row thumbnail-ts-row">
                                    <div className="thumbnail-time-controls">
                                        <div className="thumbnail-time-part">
                                            <span className="thumbnail-time-label">HH</span>
                                            <input
                                                id="thumbnail-ts-input"
                                                className="tmdb-search-input thumbnail-ts-input"
                                                type="number"
                                                min={0}
                                                max={999}
                                                step={1}
                                                value={hours}
                                                onChange={(e) => {
                                                    const next = Math.max(0, Math.min(999, Number(e.target.value) || 0));
                                                    setHours(next);
                                                }}
                                                disabled={saving || !canUseHours}
                                                autoFocus
                                            />
                                        </div>
                                        <div className="thumbnail-time-part">
                                            <span className="thumbnail-time-label">MM</span>
                                            <input
                                                className="tmdb-search-input thumbnail-ts-input"
                                                type="number"
                                                min={0}
                                                max={59}
                                                step={1}
                                                value={minutes}
                                                onChange={(e) => {
                                                    const next = Math.max(0, Math.min(59, Number(e.target.value) || 0));
                                                    setMinutes(next);
                                                }}
                                                disabled={saving}
                                            />
                                        </div>
                                        <div className="thumbnail-time-part">
                                            <span className="thumbnail-time-label">SS</span>
                                            <input
                                                className="tmdb-search-input thumbnail-ts-input"
                                                type="number"
                                                min={0}
                                                max={59}
                                                step={1}
                                                value={seconds}
                                                onChange={(e) => {
                                                    const next = Math.max(0, Math.min(59, Number(e.target.value) || 0));
                                                    setSeconds(next);
                                                }}
                                                disabled={saving}
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div className="playlist-dialog-hint" style={{ marginTop: 8 }}>
                                    {t('thumbnailTimestampHint', 'You can enter mm:ss, hh:mm:ss, or seconds.')} ({formatTimestamp(parsedSeconds)})
                                </div>
                                <div className="playlist-dialog-section">
                                    <button className="btn btn-secondary" onClick={useCurrentPlayerTime} disabled={saving}>
                                        {t('useCurrentPlayerTime', 'Use current player time')}
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div className="thumbnail-ts-right">
                            <div className="playlist-dialog-label thumbnail-preview-label">
                                {t('thumbnailPreviewLabel', 'Preview')}
                            </div>
                            {parsedSeconds == null ? (
                                <div className="thumbnail-preview-box">
                                    <div className="playlist-dialog-hint">{t('thumbnailPreviewHint', 'Enter a valid timestamp to see preview.')}</div>
                                </div>
                            ) : (
                                <div className="thumbnail-preview-box">
                                    {previewDisplayUrl ? (
                                        <img
                                            src={previewDisplayUrl}
                                            alt={t('thumbnailPreviewLabel', 'Preview')}
                                            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
                                        />
                                    ) : null}
                                    {previewLoading ? (
                                        <div className="playlist-dialog-hint thumbnail-preview-overlay">{t('loadingLoad', 'Loading...')}</div>
                                    ) : null}
                                    {previewError ? (
                                        <div className="thumbnail-preview-overlay thumbnail-preview-error">{previewError}</div>
                                    ) : null}
                                </div>
                            )}
                        </div>
                    </div>
                    {error ? (
                        <div className="tmdb-error" style={{ marginTop: 6 }}>{error}</div>
                    ) : null}
                </div>
                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={() => onClose?.()} disabled={saving}>
                        {t('cancel', 'Cancel')}
                    </button>
                    <button className="btn btn-primary" onClick={apply} disabled={saving}>
                        {saving ? t('thumbnailRegenerating', 'Regenerating...') : t('apply', 'Apply')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default ThumbnailTimestampDialog;


