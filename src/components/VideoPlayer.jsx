import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { clearWatchProgress, getRememberedPlaybackVideo, rememberPlaybackVideo, saveWatchProgress } from '../services/watchProgress';
import { useI18n } from '../i18n';
import { eventMatchesHotkey, getHotkeys } from '../services/hotkeys';

// -- Color gradient matching FunscriptHeatmap.jsx --
function getHeatColor(value) {
    const stops = [
        { t: 0.00, c: [34, 112, 238] }, // blue (very slow)
        { t: 0.12, c: [33, 174, 255] }, // cyan
        { t: 0.26, c: [49, 190, 103] }, // green
        { t: 0.44, c: [231, 212, 64] }, // yellow
        { t: 0.62, c: [244, 152, 53] }, // orange
        { t: 0.80, c: [232, 70, 51] },  // red
        { t: 0.93, c: [218, 58, 126] }, // magenta
        { t: 1.00, c: [245, 105, 200] }, // pink peaks
    ];
    const v = Math.max(0, Math.min(1, value));
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (v >= stops[i].t && v <= stops[i + 1].t) {
            a = stops[i]; b = stops[i + 1]; break;
        }
    }
    const span = Math.max(0.0001, b.t - a.t);
    const p = (v - a.t) / span;
    const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * p);
    const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * p);
    const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * p);
    return { r, g, bl };
}

function rgbToAss(r, g, b) {
    const hex = (n) => n.toString(16).padStart(2, '0').toUpperCase();
    return `&H${hex(b)}${hex(g)}${hex(r)}&`;
}

function percentile(values, p) {
    if (!values || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const t = idx - lo;
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
}

function normalizeByPercentile(values, p = 99.2) {
    const nonZero = values.filter((v) => v > 0);
    if (nonZero.length === 0) return values.map(() => 0);
    const scale = Math.max(percentile(nonZero, p), 1e-6);
    return values.map((v) => Math.max(0, Math.min(1, v / scale)));
}

function resolveTotalDuration(actions, durationMs) {
    const lastAt = Number(actions?.[actions.length - 1]?.at || 0);
    const external = Number(durationMs || 0);
    return Math.max(lastAt, external, 0);
}

function computeCombinedHeat(actions, numSegments = 200, totalDuration = null) {
    if (!actions || actions.length < 2) return [];

    const resolvedTotalDuration = Math.max(
        Number(totalDuration || 0),
        Number(actions[actions.length - 1]?.at || 0)
    );
    if (resolvedTotalDuration <= 0) return [];

    const segmentDuration = resolvedTotalDuration / numSegments; // ms
    const movementPerSegment = new Array(numSegments).fill(0);
    const strokePerSegment = new Array(numSegments).fill(0);

    for (let j = 0; j < actions.length - 1; j++) {
        const a1 = actions[j];
        const a2 = actions[j + 1];
        const t1 = Number(a1?.at || 0);
        const t2 = Number(a2?.at || 0);
        if (t2 <= t1) continue;

        const dt = t2 - t1;
        const dp = Math.abs(Number(a2?.pos || 0) - Number(a1?.pos || 0));
        if (dp <= 0) continue;

        const firstSeg = Math.max(0, Math.floor(t1 / segmentDuration));
        const lastSeg = Math.min(numSegments - 1, Math.floor((t2 - 1) / segmentDuration));

        for (let i = firstSeg; i <= lastSeg; i++) {
            const segStart = i * segmentDuration;
            const segEnd = segStart + segmentDuration;
            const overlapStart = Math.max(segStart, t1);
            const overlapEnd = Math.min(segEnd, t2);
            const overlap = overlapEnd - overlapStart;
            if (overlap <= 0) continue;

            const overlapRatio = overlap / dt;
            movementPerSegment[i] += dp * overlapRatio;
            strokePerSegment[i] += overlapRatio;
        }
    }

    const segSeconds = Math.max(segmentDuration / 1000, 1e-6);
    const speed = movementPerSegment.map((m) => m / segSeconds);
    const strokes = strokePerSegment.map((s) => s / segSeconds);

    const speedN = normalizeByPercentile(speed, 95);
    const strokesN = normalizeByPercentile(strokes, 95);

    return speedN.map((v, i) => (v * 0.65) + (strokesN[i] * 0.35));
}

function generateHeatmapCSV(actions, durationMs = null) {
    if (!actions || actions.length < 2) return '';

    const NUM_SEGMENTS = 200;
    const totalDuration = resolveTotalDuration(actions, durationMs);
    if (totalDuration <= 0) return '';

    const combined = computeCombinedHeat(actions, NUM_SEGMENTS, totalDuration);
    if (combined.length === 0) return '';

    const colors = [];
    for (let i = 0; i < NUM_SEGMENTS; i++) {
        // Delay high-end colors so red/pink appear mostly on true peaks.
        const normalized = Math.pow((combined[i] || 0), 1.18);
        const { r, g, bl } = getHeatColor(normalized);
        colors.push(rgbToAss(r, g, bl));
    }

    return colors.join(',');
}

function generateTimelineLineCSV(actions, durationMs = null) {
    if (!actions || actions.length < 2) return '';
    const totalDuration = resolveTotalDuration(actions, durationMs);
    if (totalDuration <= 0) return '';

    const sorted = [...actions]
        .map((a) => ({ at: Number(a?.at || 0), pos: Number(a?.pos || 0) }))
        .filter((a) => Number.isFinite(a.at) && Number.isFinite(a.pos))
        .sort((a, b) => a.at - b.at);
    if (sorted.length < 2) return '';

    // Keep IPC payload bounded while preserving local movement extremes.
    const MAX_POINTS = 6000;
    const compact = downsampleTimelinePoints(sorted, totalDuration, MAX_POINTS);

    // 1:1 action representation: each action is sent as "tNorm:posNorm"
    // where tNorm is 0..1 over full duration and posNorm is pos/100.
    const points = compact.map((a) => {
        const t = Math.max(0, Math.min(1, a.at / totalDuration));
        const v = Math.max(0, Math.min(1, a.pos / 100));
        return `${t.toFixed(5)}:${v.toFixed(5)}`;
    });

    if (!points.length) return '';
    if (!points[0].startsWith('0.00000:')) {
        const firstPos = Math.max(0, Math.min(1, (sorted[0].pos || 0) / 100));
        points.unshift(`0.00000:${firstPos.toFixed(5)}`);
    }
    const lastPos = Math.max(0, Math.min(1, (sorted[sorted.length - 1].pos || 0) / 100));
    if (!points[points.length - 1].startsWith('1.00000:')) {
        points.push(`1.00000:${lastPos.toFixed(5)}`);
    }

    return points.join(',');
}

function downsampleTimelinePoints(points, totalDuration, maxPoints) {
    if (!Array.isArray(points) || points.length <= maxPoints) return points || [];
    const safeDuration = Math.max(Number(totalDuration || 0), 1e-6);
    const bucketCount = Math.max(16, Math.floor(maxPoints / 3));
    const buckets = new Array(bucketCount).fill(null);

    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const tNorm = Math.max(0, Math.min(1, Number(p.at || 0) / safeDuration));
        let bi = Math.floor(tNorm * (bucketCount - 1));
        if (bi < 0) bi = 0;
        if (bi >= bucketCount) bi = bucketCount - 1;

        const current = buckets[bi];
        if (!current) {
            buckets[bi] = { first: p, last: p, min: p, max: p };
            continue;
        }
        current.last = p;
        if (p.pos < current.min.pos) current.min = p;
        if (p.pos > current.max.pos) current.max = p;
    }

    const reduced = [];
    const pushUnique = (p) => {
        if (!p) return;
        const prev = reduced[reduced.length - 1];
        if (!prev || prev.at !== p.at || prev.pos !== p.pos) {
            reduced.push(p);
        }
    };

    for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        if (!b) continue;
        const pack = [b.first, b.min, b.max, b.last].sort((a, b2) => a.at - b2.at);
        for (let j = 0; j < pack.length; j++) {
            pushUnique(pack[j]);
        }
    }

    if (reduced.length > maxPoints) {
        const step = Math.ceil(reduced.length / maxPoints);
        return reduced.filter((_, idx) => idx % step === 0);
    }
    return reduced;
}

function VideoPlayer({ onBack }) {
    const { id } = useParams();
    const location = useLocation();
    const { t } = useI18n();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [funscriptActions, setFunscriptActions] = useState([]);
    const [videoDurationMs, setVideoDurationMs] = useState(0);
    const [activeHeatmapVideoId, setActiveHeatmapVideoId] = useState(String(id));
    const [loopEnabled, setLoopEnabled] = useState(false);
    const [scriptSyncEnabled, setScriptSyncEnabled] = useState(true);
    const [playerLaunchContext, setPlayerLaunchContext] = useState(null);
    const playbackTimeRef = useRef(0);
    const durationSecRef = useRef(0);
    const lastPersistMsRef = useRef(0);
    const endedRef = useRef(false);
    const clockBaseSecRef = useRef(0);
    const clockStartedAtRef = useRef(0);
    const clockPausedRef = useRef(true);
    const sessionStartedAtRef = useRef(0);
    const sessionStartPosRef = useRef(0);
    const currentVideoIdRef = useRef(String(id));
    const currentVideoPathRef = useRef('');
    const vrEnabledRef = useRef(false);
    const vrProjectionRef = useRef('360');
    const vrStereoRef = useRef('mono');
    const vrFovRef = useRef(105);
    const vrYawRef = useRef(0);
    const vrPitchRef = useRef(0);
    const scriptSyncEnabledRef = useRef(true);
    const scriptSyncAutoEnabledVideoRef = useRef('');
    const latestFunscriptPayloadRef = useRef(null);
    const [vrState, setVrState] = useState({
        enabled: false,
        projection: '360',
        stereoMode: 'mono',
        fov: 105,
        yaw: 0,
        pitch: 0,
    });

    const resumeSeconds = useMemo(() => {
        const stateValue = Number(location?.state?.resumeFromSec || 0);
        if (Number.isFinite(stateValue) && stateValue > 0) {
            return Math.floor(stateValue);
        }
        try {
            const params = new URLSearchParams(location.search || '');
            const value = Number(params.get('t') || 0);
            if (Number.isFinite(value) && value > 0) return Math.floor(value);
        } catch { }
        try {
            const hash = String(window.location.hash || '');
            const idx = hash.indexOf('?');
            if (idx >= 0) {
                const search = hash.slice(idx + 1);
                const params = new URLSearchParams(search);
                const value = Number(params.get('t') || 0);
                if (Number.isFinite(value) && value > 0) return Math.floor(value);
            }
        } catch { }
        return 0;
    }, [location.search, location.state]);

    useEffect(() => {
        scriptSyncEnabledRef.current = scriptSyncEnabled;
    }, [scriptSyncEnabled]);

    useEffect(() => {
        try {
            const localSettings = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            const enabled = localSettings.playerScriptSyncEnabled !== false;
            setScriptSyncEnabled(enabled);
            scriptSyncEnabledRef.current = enabled;
        } catch {
            setScriptSyncEnabled(true);
            scriptSyncEnabledRef.current = true;
        }
    }, []);

    const persistScriptSyncEnabled = (enabled) => {
        setScriptSyncEnabled(enabled);
        scriptSyncEnabledRef.current = enabled;
        try {
            const localSettings = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            localSettings.playerScriptSyncEnabled = enabled;
            localStorage.setItem('glyph_settings', JSON.stringify(localSettings));
        } catch { }
        const detail = {
            enabled,
            videoId: String(currentVideoIdRef.current || id),
            timeMs: (Number(playbackTimeRef.current) || 0) * 1000,
        };
        window.dispatchEvent(new CustomEvent('mpv-script-toggle', { detail }));
        window.electronAPI?.emitDeviceSyncEvent?.({ eventName: 'mpv-script-toggle', detail });
    };

    const dispatchScriptSyncEvent = (eventName, detail = {}) => {
        if (!scriptSyncEnabledRef.current) return;
        window.dispatchEvent(new CustomEvent(eventName, { detail }));
        window.electronAPI?.emitDeviceSyncEvent?.({ eventName, detail });
    };

    const dispatchDeviceStopEvent = (detail = {}) => {
        window.dispatchEvent(new CustomEvent('mpv-handy-stop', { detail }));
        window.electronAPI?.emitDeviceSyncEvent?.({ eventName: 'mpv-handy-stop', detail });
    };

    useEffect(() => {
        let cancelled = false;
        const hasQueueInRouteState = Array.isArray(location?.state?.queueVideos) && location.state.queueVideos.length > 0;
        if (hasQueueInRouteState) {
            setPlayerLaunchContext(null);
            return () => { cancelled = true; };
        }
        const getter = window?.electronAPI?.getPlayerLaunchContext;
        if (typeof getter !== 'function') return () => { cancelled = true; };
        getter({ videoId: String(id || '') })
            .then((ctx) => {
                if (cancelled) return;
                if (ctx && Array.isArray(ctx.queueVideos) && ctx.queueVideos.length > 0) {
                    setPlayerLaunchContext(ctx);
                } else {
                    setPlayerLaunchContext(null);
                }
            })
            .catch(() => {
                if (!cancelled) setPlayerLaunchContext(null);
            });
        return () => { cancelled = true; };
    }, [id, location?.state]);

    const queueState = useMemo(() => {
        const raw = Array.isArray(location?.state?.queueVideos)
            ? location.state.queueVideos
            : (Array.isArray(playerLaunchContext?.queueVideos) ? playerLaunchContext.queueVideos : []);
        if (!raw.length) return [];
        return raw
            .map((entry) => ({
                id: entry?.id,
                title: String(entry?.title || ''),
                filePath: String(entry?.filePath || ''),
                libraryType: String(entry?.libraryType || '').toLowerCase() || 'videos',
                libraryId: String(entry?.libraryId || ''),
                isVr: !!entry?.isVr,
                vrProjection: String(entry?.vrProjection || 'unknown'),
                vrStereoMode: String(entry?.vrStereoMode || 'mono'),
            }))
            .filter((entry) => !!entry.id && !!entry.filePath);
    }, [location?.state, playerLaunchContext]);

    const queueMetaById = useMemo(() => {
        const map = new Map();
        queueState.forEach((entry) => {
            map.set(String(entry.id), {
                id: String(entry.id),
                title: String(entry.title || ''),
                filePath: String(entry.filePath || ''),
                libraryType: String(entry.libraryType || 'videos'),
                libraryId: String(entry.libraryId || ''),
                isVr: !!entry.isVr,
                vrProjection: String(entry.vrProjection || 'unknown'),
                vrStereoMode: String(entry.vrStereoMode || 'mono'),
            });
        });
        return map;
    }, [queueState]);

    const queueIdByPath = useMemo(() => {
        const normalize = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
        const map = new Map();
        queueState.forEach((entry) => {
            map.set(normalize(entry.filePath), String(entry.id));
        });
        return map;
    }, [queueState]);

    const currentQueueIndex = useMemo(() => {
        const currentId = String(activeHeatmapVideoId || id || '');
        if (!currentId || !queueState.length) return -1;
        return queueState.findIndex((entry) => String(entry.id) === currentId);
    }, [activeHeatmapVideoId, id, queueState]);

    const nextQueueEntry = useMemo(() => {
        if (currentQueueIndex < 0) return null;
        return queueState[currentQueueIndex + 1] || null;
    }, [currentQueueIndex, queueState]);

    const resolveMetaForId = (videoId) => {
        const idKey = String(videoId || '').trim();
        if (!idKey) return null;
        return getRememberedPlaybackVideo(idKey) || queueMetaById.get(idKey) || { id: idKey };
    };

    const persistProgress = (positionSec, force = false, videoIdOverride = null) => {
        const activeId = String(videoIdOverride || currentVideoIdRef.current || id);
        const now = Date.now();
        const shouldWrite = force || (now - lastPersistMsRef.current >= 5000);
        if (!shouldWrite) return;
        lastPersistMsRef.current = now;
        saveWatchProgress({
            videoId: activeId,
            positionSec,
            durationSec: durationSecRef.current,
            videoMeta: resolveMetaForId(activeId),
        });
    };

    const getClockPositionSec = () => {
        if (clockPausedRef.current) return Number(clockBaseSecRef.current || 0);
        const started = Number(clockStartedAtRef.current || 0);
        if (started <= 0) return Number(clockBaseSecRef.current || 0);
        const elapsedSec = Math.max(0, (Date.now() - started) / 1000);
        return Number(clockBaseSecRef.current || 0) + elapsedSec;
    };

    const clockSetPlaying = (positionSec = null) => {
        const hinted = Number(positionSec);
        const base = Number.isFinite(hinted) && hinted >= 0 ? hinted : getClockPositionSec();
        clockBaseSecRef.current = Math.max(0, base);
        clockStartedAtRef.current = Date.now();
        clockPausedRef.current = false;
    };

    const clockSetPaused = (positionSec = null) => {
        const hinted = Number(positionSec);
        const base = Number.isFinite(hinted) && hinted >= 0 ? hinted : getClockPositionSec();
        clockBaseSecRef.current = Math.max(0, base);
        clockStartedAtRef.current = 0;
        clockPausedRef.current = true;
    };

    const finalizeProgressOnEof = async (playbackHintSec = null) => {
        let positionSec = Number(playbackHintSec);
        if (!Number.isFinite(positionSec) || positionSec < 0) positionSec = Number(playbackTimeRef.current || 0);
        const clockPos = Number(getClockPositionSec());
        if (Number.isFinite(clockPos) && clockPos > positionSec) positionSec = clockPos;
        let durationSec = Number(durationSecRef.current || 0);

        if (window.electronAPI?.mpvGetProperty) {
            try {
                const [posVal, durVal] = await Promise.all([
                    window.electronAPI.mpvGetProperty('time-pos').catch(() => null),
                    window.electronAPI.mpvGetProperty('duration').catch(() => null),
                ]);
                const pos = Number(posVal);
                const dur = Number(durVal);
                if (Number.isFinite(pos) && pos >= 0) positionSec = pos;
                if (Number.isFinite(dur) && dur > 0) durationSec = dur;
            } catch { }
        }

        playbackTimeRef.current = Number.isFinite(positionSec) && positionSec >= 0 ? positionSec : 0;
        clockSetPaused(playbackTimeRef.current);
        if (Number.isFinite(durationSec) && durationSec > 0) durationSecRef.current = durationSec;

        const remainingSec = durationSec > 0 ? (durationSec - playbackTimeRef.current) : Number.POSITIVE_INFINITY;
        const nearEnd = durationSec > 0 && remainingSec <= 15;
        if (nearEnd) {
            clearWatchProgress(String(currentVideoIdRef.current || id));
            return;
        }
        saveWatchProgress({
            videoId: String(currentVideoIdRef.current || id),
            positionSec: playbackTimeRef.current,
            durationSec: durationSecRef.current,
            videoMeta: resolveMetaForId(String(currentVideoIdRef.current || id)),
        });
    };

    const applyVrToMpv = async ({ enabled, projection, stereoMode, fov, yaw, pitch }) => {
        if (!window.electronAPI?.mpvScriptMessage) return;
        const safeProjection = String(projection || '360') === '180' ? '180' : '360';
        const stereoRaw = String(stereoMode || 'mono').toLowerCase();
        const safeStereo = stereoRaw === 'sbs' || stereoRaw === 'ou' ? stereoRaw : 'mono';
        const safeFov = Number.isFinite(Number(fov)) ? Math.max(45, Math.min(140, Number(fov))) : 105;
        const safeYaw = Number.isFinite(Number(yaw)) ? Math.max(-180, Math.min(180, Number(yaw))) : 0;
        const safePitch = Number.isFinite(Number(pitch)) ? Math.max(-89, Math.min(89, Number(pitch))) : 0;

        await window.electronAPI.mpvScriptMessage('vr-set-enabled', enabled ? '1' : '0').catch(() => { });
        if (!enabled) return;
        await window.electronAPI.mpvScriptMessage('vr-set-mode', safeProjection, safeStereo).catch(() => { });
        await window.electronAPI.mpvScriptMessage('vr-set-fov', String(safeFov)).catch(() => { });
        if (safeYaw !== 0 || safePitch !== 0) {
            await window.electronAPI.mpvScriptMessage('vr-look', String(safeYaw), String(safePitch)).catch(() => { });
        }
    };

    const resolveVrStateForVideo = async (videoId) => {
        const stateProjection = String(location?.state?.vrProjection || 'unknown');
        const stateStereo = String(location?.state?.vrStereoMode || 'mono').toLowerCase();
        const stateIsVr = !!location?.state?.isVrPlayback;
        const meta = queueMetaById.get(String(videoId || ''));
        let enabled = stateIsVr || String(meta?.libraryType || '').toLowerCase() === 'vr';
        let projection = String(meta?.vrProjection || stateProjection || 'unknown');
        let stereoMode = String(meta?.vrStereoMode || stateStereo || 'mono');

        if ((!enabled || projection === 'unknown') && videoId) {
            try {
                const res = await fetch(`/api/videos/${videoId}/details`);
                const data = res.ok ? await res.json() : null;
                if (data) {
                    if (!enabled) enabled = !!data?.isVr || String(data?.libraryType || '').toLowerCase() === 'vr';
                    projection = String(data?.vrProjection || projection || 'unknown');
                    stereoMode = String(data?.vrStereoMode || stereoMode || 'mono');
                }
            } catch { }
        }

        const safeProjection = projection === '180' ? '180' : (projection === '360' ? '360' : 'unknown');
        const safeStereo = stereoMode === 'sbs' || stereoMode === 'ou' ? stereoMode : 'mono';
        return {
            enabled: !!enabled,
            projection: safeProjection,
            stereoMode: safeStereo,
            fov: vrFovRef.current,
            yaw: 0,
            pitch: 0,
        };
    };

    useEffect(() => {
        endedRef.current = false;
        playbackTimeRef.current = 0;
        durationSecRef.current = 0;
        lastPersistMsRef.current = 0;
        clockBaseSecRef.current = 0;
        clockStartedAtRef.current = 0;
        clockPausedRef.current = true;
        sessionStartedAtRef.current = 0;
        sessionStartPosRef.current = 0;
        currentVideoIdRef.current = String(id);
        scriptSyncAutoEnabledVideoRef.current = '';
        currentVideoPathRef.current = '';
        setActiveHeatmapVideoId(String(id));
        vrYawRef.current = 0;
        vrPitchRef.current = 0;
        setVrState(prev => ({ ...prev, yaw: 0, pitch: 0 }));
    }, [id]);

    useEffect(() => {
        if (!activeHeatmapVideoId) {
            setFunscriptActions([]);
            setVideoDurationMs(0);
            latestFunscriptPayloadRef.current = null;
            window.electronAPI?.mpvScriptMessage?.('glyph-set-script-available', '0').catch(() => { });
            return;
        }

        setFunscriptActions([]);
        setVideoDurationMs(0);
        window.electronAPI?.mpvScriptMessage?.('glyph-set-script-available', '0').catch(() => { });
        let mounted = true;
        fetch(`/api/videos/${activeHeatmapVideoId}/funscript`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!mounted) return;
                const actions = Array.isArray(data?.actions) ? data.actions : [];
                const hasFunscript = actions.length >= 2;
                latestFunscriptPayloadRef.current = data && typeof data === 'object' ? data : { actions };
                setFunscriptActions(hasFunscript ? actions : []);
                window.electronAPI?.mpvScriptMessage?.('glyph-set-script-available', hasFunscript ? '1' : '0').catch(() => { });
                if (hasFunscript) {
                    if (scriptSyncEnabledRef.current) {
                        const detail = { actions, videoId: activeHeatmapVideoId, allData: data };
                        window.dispatchEvent(new CustomEvent('funscript-loaded', { detail }));
                        window.electronAPI?.emitDeviceSyncEvent?.({ eventName: 'funscript-loaded', detail });
                    }
                }
            })
            .catch(() => {
                window.electronAPI?.mpvScriptMessage?.('glyph-set-script-available', '0').catch(() => { });
            });
        return () => { mounted = false; };
    }, [activeHeatmapVideoId]);

    useEffect(() => {
        if (!activeHeatmapVideoId) return;
        if (funscriptActions.length < 2) return;
        if (!scriptSyncEnabled) return;
        const payload = latestFunscriptPayloadRef.current && typeof latestFunscriptPayloadRef.current === 'object'
            ? latestFunscriptPayloadRef.current
            : { actions: funscriptActions };
        const detail = { actions: funscriptActions, videoId: activeHeatmapVideoId, allData: payload };
        window.dispatchEvent(new CustomEvent('funscript-loaded', { detail }));
        window.electronAPI?.emitDeviceSyncEvent?.({ eventName: 'funscript-loaded', detail });
    }, [scriptSyncEnabled, activeHeatmapVideoId, funscriptActions]);

    useEffect(() => {
        if (!activeHeatmapVideoId) {
            setVideoDurationMs(0);
            return;
        }
        let mounted = true;
        fetch(`/api/videos/${activeHeatmapVideoId}/details`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!mounted) return;
                const sec = Number(data?.duration || 0);
                if (sec > 0) {
                    setVideoDurationMs(sec * 1000);
                    durationSecRef.current = sec;
                }
            })
            .catch(() => { });
        return () => { mounted = false; };
    }, [activeHeatmapVideoId]);

    useEffect(() => {
        window.electronAPI?.mpvScriptMessage?.('clear-heatmap-colors').catch(() => { });
        window.electronAPI?.mpvScriptMessage?.('set-timeline-line-enabled', '0').catch(() => { });
        window.electronAPI?.mpvScriptMessage?.('clear-timeline-line-data').catch(() => { });
    }, [activeHeatmapVideoId]);

    useEffect(() => {
        if (funscriptActions.length < 2) {
            window.electronAPI?.mpvScriptMessage?.('set-timeline-line-enabled', '0').catch(() => { });
            window.electronAPI?.mpvScriptMessage?.('clear-timeline-line-data').catch(() => { });
            return;
        }
        if (loading) return;

        let showHeatmap = true;
        let showTimelineGraph = false;
        let thumbfastEnabled = true;
        try {
            const localSettings = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            if (localSettings.showHeatmap === false) showHeatmap = false;
            showTimelineGraph = localSettings.showTimelineGraph === true;
            thumbfastEnabled = localSettings.thumbfastEnabled !== false;
        } catch (e) { }

        // Avoid visual overlap on seekbar hover when thumbnails are enabled.
        const timelineMode = showHeatmap && showTimelineGraph === true && !thumbfastEnabled;
        const effectiveHeatmap = showHeatmap;

        if (!effectiveHeatmap) {
            window.electronAPI?.mpvScriptMessage?.('clear-heatmap-colors').catch(() => { });
        }

        window.electronAPI?.mpvScriptMessage?.('set-timeline-line-enabled', timelineMode ? '1' : '0').catch(() => { });

        if (!window.electronAPI?.mpvScriptMessage) return;

        if (effectiveHeatmap) {
            const csv = generateHeatmapCSV(funscriptActions, videoDurationMs);
            if (csv) {
                window.electronAPI.mpvScriptMessage('set-heatmap-colors', csv)
                    .catch(err => console.warn('[Heatmap] Failed to send:', err));
            }
        }

        if (timelineMode) {
            const lineCsv = generateTimelineLineCSV(funscriptActions, videoDurationMs);
            if (lineCsv) {
                window.electronAPI.mpvScriptMessage('set-timeline-line-data', lineCsv).catch(() => { });
            } else {
                window.electronAPI.mpvScriptMessage('clear-timeline-line-data').catch(() => { });
            }
        } else {
            window.electronAPI?.mpvScriptMessage?.('clear-timeline-line-data').catch(() => { });
        }
    }, [funscriptActions, loading, videoDurationMs]);

    useEffect(() => {
        if (loading) return;
        if (!window.electronAPI?.mpvScriptMessage) return;

        const accentHex = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent-primary').trim() || '#a855f7';

        const hex = accentHex.replace('#', '');
        if (hex.length >= 6) {
            const r = hex.substring(0, 2).toUpperCase();
            const g = hex.substring(2, 4).toUpperCase();
            const b = hex.substring(4, 6).toUpperCase();
            const assColor = `&H${b}${g}${r}&`;
            window.electronAPI.mpvScriptMessage('set-seekbar-color', assColor)
                .catch(err => console.warn('[Theme] Failed to send seekbar color:', err));
        }
    }, [loading]);

    useEffect(() => {
        if (loading) return;
        if (!window.electronAPI?.mpvScriptMessage) return;
        window.electronAPI
            .mpvScriptMessage('glyph-set-script-sync', scriptSyncEnabled ? '1' : '0')
            .catch(() => { });
    }, [loading, scriptSyncEnabled]);

    useEffect(() => {
        if (loading) return;
        if (!window.electronAPI?.mpvScriptMessage) return;
        const hasFunscript = Array.isArray(funscriptActions) && funscriptActions.length >= 2;
        const videoKey = String(activeHeatmapVideoId || id || '');
        if (hasFunscript && !scriptSyncEnabledRef.current && scriptSyncAutoEnabledVideoRef.current !== videoKey) {
            scriptSyncAutoEnabledVideoRef.current = videoKey;
            persistScriptSyncEnabled(true);
        }
        window.electronAPI
            .mpvScriptMessage('glyph-set-script-available', hasFunscript ? '1' : '0')
            .catch(() => { });
    }, [loading, funscriptActions, activeHeatmapVideoId]);

    useEffect(() => {
        let mounted = true;

        const init = async () => {
            if (!window.electronAPI?.mpvLoadFile) {
                setError('mpv player not available (electron API missing)');
                setLoading(false);
                return;
            }

            setLoading(true);
            setError(null);

            try {
                const pathRes = await fetch(`/api/videos/${id}/filepath`);
                if (!pathRes.ok) throw new Error('Failed to get video file path');
                const { filePath } = await pathRes.json();
                currentVideoPathRef.current = String(filePath || '');

                if (!mounted) return;

                let subtitleStyles = {};
                let thumbfastEnabled = true;
                let playerAutoFullscreen = false;
                try {
                    const localSettings = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                    if (localSettings.subtitleStyles) subtitleStyles = localSettings.subtitleStyles;
                    if (localSettings.thumbfastEnabled === false) thumbfastEnabled = false;
                    if (localSettings.playerAutoFullscreen === true) playerAutoFullscreen = true;
                } catch (e) {
                    console.warn('Failed to parse glyph_settings:', e);
                }

                const queueFiles = queueState.map((entry) => entry.filePath);
                let playlistFiles = queueFiles;
                let playlistStartIndex = queueState.findIndex((entry) => String(entry.id) === String(id));
                if (!playlistFiles.length) {
                    playlistFiles = [filePath];
                    playlistStartIndex = 0;
                } else if (playlistStartIndex < 0) {
                    playlistFiles = [filePath, ...playlistFiles.filter((p) => p !== filePath)];
                    playlistStartIndex = 0;
                }
                if (playlistFiles[playlistStartIndex]) {
                    const normalize = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
                    const matchedId = queueIdByPath.get(normalize(playlistFiles[playlistStartIndex]));
                    if (matchedId) currentVideoIdRef.current = String(matchedId);
                }

                const initialVr = await resolveVrStateForVideo(String(currentVideoIdRef.current || id));
                vrEnabledRef.current = !!initialVr.enabled;
                vrProjectionRef.current = initialVr.projection;
                vrStereoRef.current = initialVr.stereoMode;
                vrFovRef.current = Number(initialVr.fov || 105);
                vrYawRef.current = 0;
                vrPitchRef.current = 0;
                setVrState({
                    enabled: !!initialVr.enabled,
                    projection: initialVr.projection,
                    stereoMode: initialVr.stereoMode,
                    fov: Number(initialVr.fov || 105),
                    yaw: 0,
                    pitch: 0,
                });

                const result = await window.electronAPI.mpvLoadFile(filePath, {
                    subtitleStyles,
                    thumbfastEnabled,
                    autoFullscreen: playerAutoFullscreen,
                    startSeconds: resumeSeconds > 0 ? resumeSeconds : 0,
                    playlistFiles,
                    playlistStartIndex,
                    vr: {
                        enabled: !!initialVr.enabled,
                        projection: initialVr.projection,
                        stereoMode: initialVr.stereoMode,
                        fov: Number(initialVr.fov || 105),
                    },
                });
                if (!result?.ok) {
                    throw new Error(result?.error || 'Failed to start mpv');
                }

                await applyVrToMpv(initialVr);

                if (resumeSeconds > 0) {
                    await window.electronAPI.mpvSeek(resumeSeconds).catch(() => { });
                }

                if (mounted) {
                    setLoading(false);
                    rememberPlaybackVideo(resolveMetaForId(String(currentVideoIdRef.current || id)) || { id: String(currentVideoIdRef.current || id), filePath });
                    clockSetPlaying(resumeSeconds > 0 ? resumeSeconds : 0);
                    sessionStartedAtRef.current = Date.now();
                    sessionStartPosRef.current = resumeSeconds > 0 ? resumeSeconds : 0;
                }
            } catch (err) {
                console.error('Player init error:', err);
                if (mounted) {
                    setError(err.message || 'Failed to initialize player');
                    setLoading(false);
                }
            }
        };

        if (id) init();

        return () => {
            mounted = false;
            dispatchDeviceStopEvent({ videoId: String(currentVideoIdRef.current || id) });
            const elapsedFromSession = (() => {
                const started = Number(sessionStartedAtRef.current || 0);
                if (started <= 0) return 0;
                const elapsed = Math.max(0, (Date.now() - started) / 1000);
                return Number(sessionStartPosRef.current || 0) + elapsed;
            })();
            const bestKnownSec = Math.max(
                Number(playbackTimeRef.current || 0),
                Number(getClockPositionSec() || 0),
                Number(elapsedFromSession || 0),
            );
            if (!endedRef.current && window.electronAPI?.mpvGetProperty) {
                Promise.all([
                    window.electronAPI.mpvGetProperty('time-pos').catch(() => null),
                    window.electronAPI.mpvGetProperty('duration').catch(() => null),
                ])
                    .then(([timeValue, durationValue]) => {
                        const sec = Number(timeValue || 0);
                        const dur = Number(durationValue || 0);
                        if (Number.isFinite(sec) && sec >= 0) {
                            playbackTimeRef.current = Math.max(sec, bestKnownSec);
                            clockSetPaused(playbackTimeRef.current);
                        } else {
                            playbackTimeRef.current = bestKnownSec;
                            clockSetPaused(playbackTimeRef.current);
                        }
                        if (Number.isFinite(dur) && dur > 0) {
                            durationSecRef.current = dur;
                        }
                    })
                    .catch(() => { })
                    .finally(() => persistProgress(playbackTimeRef.current, true));
            } else if (!endedRef.current) {
                playbackTimeRef.current = bestKnownSec;
                clockSetPaused(playbackTimeRef.current);
                persistProgress(playbackTimeRef.current, true);
            }
            window.electronAPI?.mpvStop?.().catch(() => { });
        };
    }, [id, resumeSeconds, queueState, queueIdByPath]);

    useEffect(() => {
        if (loading) return undefined;
        if (!window.electronAPI?.mpvGetProperty) return undefined;

        const timer = setInterval(() => {
            Promise.all([
                window.electronAPI.mpvGetProperty('time-pos').catch(() => null),
                window.electronAPI.mpvGetProperty('duration').catch(() => null),
            ])
                .then(([timeValue, durationValue]) => {
                    const sec = Number(timeValue || 0);
                    const dur = Number(durationValue || 0);
                    if (!Number.isFinite(sec) || sec < 0) return;
                    playbackTimeRef.current = sec;
                    if (clockPausedRef.current) clockSetPaused(sec);
                    else clockSetPlaying(sec);
                    if (Number.isFinite(dur) && dur > 0) durationSecRef.current = dur;
                    persistProgress(sec, false);
                })
                .catch(() => { });
        }, 2000);

        return () => clearInterval(timer);
    }, [id, loading]);

    useEffect(() => {
        if (!window.electronAPI?.onMpvEvent) return;

        const unsubscribe = window.electronAPI.onMpvEvent((data) => {
            if (!data) return;
            if (data.event === 'client-message' && Array.isArray(data.args) && data.args[0] === 'glyph-script-sync-state') {
                const nextEnabled = String(data.args[1] || '').toLowerCase();
                const enabled = (nextEnabled === '1' || nextEnabled === 'true' || nextEnabled === 'yes' || nextEnabled === 'on');
                if (enabled !== scriptSyncEnabledRef.current) {
                    persistScriptSyncEnabled(enabled);
                }
                return;
            }
            if (data.event === 'eof') {
                endedRef.current = true;
                const hintSec = Number(data.playbackTime);
                finalizeProgressOnEof(Number.isFinite(hintSec) ? hintSec : null)
                    .catch(() => { })
                    .finally(() => {
                        dispatchDeviceStopEvent({ videoId: String(currentVideoIdRef.current || id) });
                        onBack();
                    });
                return;
            }
            if (data.event === 'property-change' && data.name === 'time-pos') {
                const sec = Number(data.data || 0);
                if (Number.isFinite(sec) && sec >= 0) {
                    playbackTimeRef.current = sec;
                    if (clockPausedRef.current) clockSetPaused(sec);
                    else clockSetPlaying(sec);
                    persistProgress(sec, false);
                }
            }
            if (data.event === 'property-change' && data.name === 'duration') {
                const durationSec = Number(data.data || 0);
                if (Number.isFinite(durationSec) && durationSec > 0) {
                    durationSecRef.current = durationSec;
                }
            }
            if (data.event === 'property-change' && data.name === 'pause') {
                const isPaused = data.data === true || data.data === 'yes';
                if (isPaused) {
                    clockSetPaused(playbackTimeRef.current);
                    persistProgress(playbackTimeRef.current, true);
                    dispatchScriptSyncEvent('mpv-handy-pause', {
                        videoId: String(currentVideoIdRef.current || id)
                    });
                } else {
                    const timeMs = (Number(playbackTimeRef.current) || 0) * 1000;
                    clockSetPlaying(playbackTimeRef.current);
                    dispatchScriptSyncEvent('mpv-handy-play', {
                        timeMs, videoId: String(currentVideoIdRef.current || id)
                    });
                }
            }
            if (data.event === 'property-change' && data.name === 'path') {
                const normalize = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
                const nextPath = String(data.data || '');
                if (!nextPath) return;
                const prevId = String(currentVideoIdRef.current || id);
                const nextId = queueIdByPath.get(normalize(nextPath));
                if (nextId && nextId !== prevId) {
                    persistProgress(playbackTimeRef.current, true, prevId);
                    currentVideoIdRef.current = String(nextId);
                    currentVideoPathRef.current = nextPath;
                    setActiveHeatmapVideoId(String(nextId));
                    playbackTimeRef.current = 0;
                    durationSecRef.current = 0;
                    lastPersistMsRef.current = 0;
                    sessionStartedAtRef.current = Date.now();
                    sessionStartPosRef.current = 0;
                    rememberPlaybackVideo(resolveMetaForId(String(nextId)) || { id: String(nextId), filePath: nextPath });
                    if (clockPausedRef.current) clockSetPaused(0);
                    else clockSetPlaying(0);
                    resolveVrStateForVideo(String(nextId))
                        .then((nextVr) => {
                            vrEnabledRef.current = !!nextVr.enabled;
                            vrProjectionRef.current = nextVr.projection;
                            vrStereoRef.current = nextVr.stereoMode;
                            vrYawRef.current = 0;
                            vrPitchRef.current = 0;
                            setVrState({
                                enabled: !!nextVr.enabled,
                                projection: nextVr.projection,
                                stereoMode: nextVr.stereoMode,
                                fov: Number(vrFovRef.current || 105),
                                yaw: 0,
                                pitch: 0,
                            });
                            return applyVrToMpv({
                                enabled: !!nextVr.enabled,
                                projection: nextVr.projection,
                                stereoMode: nextVr.stereoMode,
                                fov: vrFovRef.current,
                                yaw: 0,
                                pitch: 0,
                            });
                        })
                        .catch(() => { });
                }
            }
            // Sync events for DevicePanel / TheHandy
            if (data.event === 'playback-restart' || data.event === 'unpause') {
                const timeMs = (Number(data.playbackTime) || 0) * 1000;
                playbackTimeRef.current = timeMs / 1000;
                clockSetPlaying(playbackTimeRef.current);
                dispatchScriptSyncEvent('mpv-handy-play', {
                    timeMs, videoId: String(currentVideoIdRef.current || id)
                });
            }
            if (data.event === 'pause') {
                const timeMs = (Number(data.playbackTime) || 0) * 1000;
                if (Number.isFinite(timeMs) && timeMs >= 0) {
                    playbackTimeRef.current = timeMs / 1000;
                }
                clockSetPaused(playbackTimeRef.current);
                persistProgress(playbackTimeRef.current, true);
                dispatchScriptSyncEvent('mpv-handy-pause', {
                    videoId: String(currentVideoIdRef.current || id)
                });
            }
            if (data.event === 'seek') {
                const fallbackTimeMs = (Number(data.playbackTime) || 0) * 1000;
                Promise.all([
                    window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null),
                    window.electronAPI?.mpvGetProperty?.('duration').catch(() => null),
                ])
                    .then(([timeValue, durationValue]) => {
                        const pos = Number(timeValue);
                        const dur = Number(durationValue);
                        if (Number.isFinite(pos) && pos >= 0) {
                            playbackTimeRef.current = pos;
                        } else {
                            playbackTimeRef.current = fallbackTimeMs / 1000;
                        }
                        if (Number.isFinite(dur) && dur > 0) durationSecRef.current = dur;
                        if (clockPausedRef.current) clockSetPaused(playbackTimeRef.current);
                        else clockSetPlaying(playbackTimeRef.current);
                        persistProgress(playbackTimeRef.current, true);
                        dispatchScriptSyncEvent('mpv-handy-seek', {
                            timeMs: playbackTimeRef.current * 1000, videoId: String(currentVideoIdRef.current || id)
                        });
                    })
                    .catch(() => {
                        playbackTimeRef.current = fallbackTimeMs / 1000;
                        if (clockPausedRef.current) clockSetPaused(playbackTimeRef.current);
                        else clockSetPlaying(playbackTimeRef.current);
                        persistProgress(playbackTimeRef.current, true);
                        dispatchScriptSyncEvent('mpv-handy-seek', {
                            timeMs: fallbackTimeMs, videoId: String(currentVideoIdRef.current || id)
                        });
                    });
            }
        });

        return () => {
            if (typeof unsubscribe === 'function') unsubscribe();
        };
    }, [id, onBack, queueIdByPath]);

    useEffect(() => {
        const onKeyDown = (e) => {
            if (!e.altKey) return;
            let handled = true;
            if (!vrEnabledRef.current) return;
            if (e.key === 'ArrowLeft') {
                vrYawRef.current = Math.max(-180, Math.min(180, vrYawRef.current - 5));
            } else if (e.key === 'ArrowRight') {
                vrYawRef.current = Math.max(-180, Math.min(180, vrYawRef.current + 5));
            } else if (e.key === 'ArrowUp') {
                vrPitchRef.current = Math.max(-89, Math.min(89, vrPitchRef.current + 3));
            } else if (e.key === 'ArrowDown') {
                vrPitchRef.current = Math.max(-89, Math.min(89, vrPitchRef.current - 3));
            } else if (e.key === 'PageUp') {
                vrFovRef.current = Math.max(45, Math.min(140, vrFovRef.current - 5));
            } else if (e.key === 'PageDown') {
                vrFovRef.current = Math.max(45, Math.min(140, vrFovRef.current + 5));
            } else if (e.key.toLowerCase() === 'r') {
                vrYawRef.current = 0;
                vrPitchRef.current = 0;
            } else {
                handled = false;
            }
            if (!handled) return;
            e.preventDefault();
            setVrState(prev => ({
                ...prev,
                yaw: vrYawRef.current,
                pitch: vrPitchRef.current,
                fov: vrFovRef.current,
            }));
            applyVrToMpv({
                enabled: true,
                projection: vrProjectionRef.current,
                stereoMode: vrStereoRef.current,
                fov: vrFovRef.current,
                yaw: vrYawRef.current,
                pitch: vrPitchRef.current,
            }).catch(() => { });
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    const updateVrMode = (projection, stereoMode) => {
        vrProjectionRef.current = projection;
        vrStereoRef.current = stereoMode;
        setVrState(prev => ({ ...prev, projection, stereoMode }));
        applyVrToMpv({
            enabled: true,
            projection,
            stereoMode,
            fov: vrFovRef.current,
            yaw: vrYawRef.current,
            pitch: vrPitchRef.current,
        }).catch(() => { });
    };

    const resetVrView = () => {
        vrYawRef.current = 0;
        vrPitchRef.current = 0;
        setVrState(prev => ({ ...prev, yaw: 0, pitch: 0 }));
        if (window.electronAPI?.mpvScriptMessage) {
            window.electronAPI.mpvScriptMessage('vr-reset-view').catch(() => { });
        }
    };

    const setPlayerLoop = async (enabled) => {
        if (!window.electronAPI?.mpvSetProperty) return;
        await window.electronAPI.mpvSetProperty('loop-file', enabled ? 'inf' : 'no').catch(() => { });
        setLoopEnabled(!!enabled);
    };

    const toggleLoop = () => {
        setPlayerLoop(!loopEnabled).catch(() => { });
    };

    const playNextInQueue = () => {
        if (!window.electronAPI?.mpvCommand || !nextQueueEntry) return;
        window.electronAPI.mpvCommand('playlist-next', 'force').catch(() => { });
    };

    useEffect(() => {
        if (loading || error) return undefined;
        window.electronAPI?.mpvGetProperty?.('loop-file')
            .then((value) => {
                const normalized = String(value || '').toLowerCase();
                setLoopEnabled(normalized === 'inf');
            })
            .catch(() => { });
        return undefined;
    }, [loading, error]);

    useEffect(() => {
        const onKeyDown = (e) => {
            const target = e.target;
            const isTyping = !!target && (
                target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.tagName === 'SELECT'
                || target.isContentEditable
            );
            if (isTyping) return;
            const hotkeys = getHotkeys();

            if (eventMatchesHotkey(e, hotkeys.toggleLoop)) {
                e.preventDefault();
                toggleLoop();
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.toggleScriptSync)) {
                e.preventDefault();
                persistScriptSyncEnabled(!scriptSyncEnabledRef.current);
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.playPause)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('cycle', 'pause').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.seekBackward)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('seek', '-5', 'relative').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.seekForward)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('seek', '5', 'relative').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.volumeDown)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('add', 'volume', '-5').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.volumeUp)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('add', 'volume', '5').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.mute)) {
                e.preventDefault();
                window.electronAPI?.mpvCommand?.('cycle', 'mute').catch(() => { });
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.nextVideo)) {
                e.preventDefault();
                playNextInQueue();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [loopEnabled]);

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'transparent' }}>
            {!loading && !error && (
                <div style={{
                    position: 'fixed',
                    top: 10,
                    right: 10,
                    zIndex: 25,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    background: 'rgba(12,16,24,0.58)',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 10,
                    padding: '6px 8px',
                    backdropFilter: 'blur(8px)',
                }}>
                    <button
                        className="btn btn-secondary"
                        style={{ padding: '5px 10px', fontSize: 12 }}
                        title={t('back', 'Back')}
                        onClick={onBack}
                    >
                        {t('back', 'Back')}
                    </button>
                    <button
                        className="btn btn-secondary"
                        style={{
                            padding: '5px 10px',
                            fontSize: 12,
                            borderColor: loopEnabled ? 'var(--accent-primary)' : undefined,
                            color: loopEnabled ? 'var(--accent-primary)' : undefined,
                        }}
                        title={loopEnabled ? t('disableLoop', 'Disable Loop') : t('enableLoop', 'Enable Loop')}
                        onClick={toggleLoop}
                    >
                        {loopEnabled ? t('loopOn', 'Loop: On') : t('loopOff', 'Loop: Off')}
                    </button>
                    <button
                        className="btn btn-secondary"
                        style={{
                            padding: '5px 8px',
                            fontSize: 12,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderColor: scriptSyncEnabled ? 'var(--accent-primary)' : undefined,
                            color: scriptSyncEnabled ? 'var(--accent-primary)' : undefined,
                        }}
                        title={scriptSyncEnabled ? t('disableScriptSync', 'Disable Script Sync') : t('enableScriptSync', 'Enable Script Sync')}
                        aria-label={scriptSyncEnabled ? t('disableScriptSync', 'Disable Script Sync') : t('enableScriptSync', 'Enable Script Sync')}
                        onClick={() => persistScriptSyncEnabled(!scriptSyncEnabled)}
                    >
                        <span
                            aria-hidden="true"
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                width: 18,
                                height: 18,
                                border: '1px solid currentColor',
                                borderRadius: 4,
                                fontSize: 10,
                                fontWeight: 700,
                                lineHeight: 1,
                                letterSpacing: 0.2,
                                flexShrink: 0,
                            }}
                        >
                            FS
                        </span>
                    </button>
                    {nextQueueEntry && (
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '5px 10px', fontSize: 12 }}
                            title={`${t('next', 'Next')}: ${nextQueueEntry.title || String(nextQueueEntry.id)}`}
                            onClick={playNextInQueue}
                        >
                            {t('next', 'Next')}
                        </button>
                    )}
                </div>
            )}
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                {loading && <div style={{ color: 'white', fontSize: '1.2rem' }}>Starte mpv Player...</div>}
                {error && <div style={{ color: '#ff5f56', fontSize: '1.2rem' }}>Fehler: {error}</div>}
            </div>
            {false && vrState.enabled && !loading && !error && (
                <div style={{
                    position: 'fixed',
                    right: 10,
                    bottom: 10,
                    zIndex: 20,
                    background: 'rgba(12,16,24,0.75)',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 8,
                    padding: '7px 8px',
                    color: '#f8fafc',
                    fontSize: 10,
                    minWidth: 172,
                    backdropFilter: 'blur(8px)',
                }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>VR Modus</div>
                    <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '2px 6px', fontSize: 10 }}
                            onClick={() => updateVrMode(vrState.projection === '180' ? '360' : '180', vrState.stereoMode)}
                        >
                            {vrState.projection}
                        </button>
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '2px 6px', fontSize: 10 }}
                            onClick={() => {
                                const next = vrState.stereoMode === 'mono'
                                    ? 'sbs'
                                    : vrState.stereoMode === 'sbs'
                                        ? 'ou'
                                        : 'mono';
                                updateVrMode(vrState.projection, next);
                            }}
                        >
                            {String(vrState.stereoMode || 'mono').toUpperCase()}
                        </button>
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '2px 6px', fontSize: 10 }}
                            onClick={resetVrView}
                        >
                            Reset
                        </button>
                    </div>
                    <div style={{ opacity: 0.9, lineHeight: 1.3 }}>
                        <div>Alt+Pfeile Kamera</div>
                        <div>Alt+PgUp/PgDn FOV ({Math.round(vrState.fov)}) | Alt+R Reset</div>
                        <div style={{ opacity: 0.75, marginTop: 3 }}>
                            Yaw {Math.round(vrState.yaw)} | Pitch {Math.round(vrState.pitch)}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default VideoPlayer;
