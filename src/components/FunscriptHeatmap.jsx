import React, { useRef, useEffect } from 'react';

/**
 * FunscriptHeatmap - Canvas-based heatmap visualization for funscript data.
 *
 * - Uses combined intensity: speed + stroke density.
 * - Keeps absolute script timeline (no forced shift to t=0).
 * - No movement remains neutral/dark.
 */
function FunscriptHeatmap({ actions, width = 300, height = 6, className = '', durationMs = null, variant = 'detailed', videoId = null, cacheKey = null }) {
    const canvasRef = useRef(null);
    const normalizedId = String(videoId || '').trim();
    const HEATMAP_RENDER_VERSION = 'v10';
    const cachedHeatmapUrl = normalizedId
        ? `/api/videos/${encodeURIComponent(normalizedId)}/heatmap?variant=${encodeURIComponent(String(variant || 'detailed'))}${cacheKey !== null && cacheKey !== undefined ? `&v=${encodeURIComponent(String(cacheKey))}` : ''}&rv=${encodeURIComponent(HEATMAP_RENDER_VERSION)}`
        : '';

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !actions || actions.length < 2) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(width * dpr));
        canvas.height = Math.max(1, Math.floor(height * dpr));

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const totalDuration = resolveTotalDuration(actions, durationMs);
        if (totalDuration <= 0) return;

        if (variant === 'detailed') {
            drawDetailedHeatmap(ctx, actions, width, height, totalDuration);
            return;
        }

        const numSegments = Math.max(1, Math.min(Math.floor(width), 240));
        const segmentWidth = width / numSegments;
        const combined = computeCombinedHeat(actions, numSegments, totalDuration);

        for (let i = 0; i < numSegments; i++) {
            const normalized = combined[i] || 0;
            ctx.fillStyle = getHeatColor(normalized);
            ctx.fillRect(i * segmentWidth, 0, segmentWidth + 0.5, height);
        }
    }, [actions, width, height, durationMs, variant]);

    if (normalizedId) {
        return (
            <img
                className={className}
                src={cachedHeatmapUrl}
                alt=""
                loading="lazy"
                draggable={false}
                style={{ width: `${width}px`, height: `${height}px`, display: 'block', objectFit: 'fill' }}
                onError={(e) => {
                    // Fallback to canvas rendering only if actions were provided.
                    if (!actions || actions.length < 2) {
                        e.currentTarget.style.display = 'none';
                    }
                }}
            />
        );
    }

    if (!actions || actions.length < 2) return null;

    return (
        <canvas
            ref={canvasRef}
            className={className}
            style={{ width: `${width}px`, height: `${height}px`, display: 'block' }}
        />
    );
}

function drawDetailedHeatmap(ctx, actions, width, height, totalDuration) {
    const numColumns = Math.max(1, Math.min(Math.floor(width * 2), 540));
    const columnWidth = width / numColumns;
    const intensity = computeCombinedHeat(actions, numColumns, totalDuration);

    ctx.fillStyle = 'rgb(18, 22, 30)';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < numColumns; i++) {
        const v = Math.max(0, Math.min(1, intensity[i] || 0));
        if (v <= 0.005) continue;

        const eased = Math.pow(v, 0.9);
        const barHeight = Math.max(1, Math.round((0.06 + (eased * 0.94)) * height));
        const y = height - barHeight;
        ctx.fillStyle = getDetailedHeatColor(v);
        ctx.fillRect(i * columnWidth, y, Math.max(1, columnWidth + 0.3), barHeight);
    }
}

function resolveTotalDuration(actions, durationMs) {
    const lastAt = Number(actions?.[actions.length - 1]?.at || 0);
    const external = Number(durationMs || 0);
    return Math.max(lastAt, external, 0);
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

function normalizeByPercentile(values, p = 95) {
    const nonZero = values.filter((v) => v > 0);
    if (nonZero.length === 0) return values.map(() => 0);
    const scale = Math.max(percentile(nonZero, p), 1e-6);
    return values.map((v) => Math.max(0, Math.min(1, v / scale)));
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

    const segmentSeconds = Math.max(segmentDuration / 1000, 1e-6);
    const speed = movementPerSegment.map((m) => m / segmentSeconds);
    const strokes = strokePerSegment.map((s) => s / segmentSeconds);

    const speedN = normalizeByPercentile(speed, 95);
    const strokesN = normalizeByPercentile(strokes, 95);

    return speedN.map((v, i) => (v * 0.65) + (strokesN[i] * 0.35));
}

function getHeatColor(value) {
    const stops = [
        { t: 0.0, c: [34, 38, 46] },
        { t: 0.25, c: [57, 166, 88] },
        { t: 0.55, c: [190, 200, 63] },
        { t: 0.80, c: [236, 154, 63] },
        { t: 1.0, c: [225, 63, 63] },
    ];

    const v = Math.max(0, Math.min(1, value));
    let a = stops[0];
    let b = stops[stops.length - 1];

    for (let i = 0; i < stops.length - 1; i++) {
        const s1 = stops[i];
        const s2 = stops[i + 1];
        if (v >= s1.t && v <= s2.t) {
            a = s1;
            b = s2;
            break;
        }
    }

    const span = Math.max(0.0001, b.t - a.t);
    const p = (v - a.t) / span;
    const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * p);
    const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * p);
    const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * p);
    return `rgb(${r}, ${g}, ${bl})`;
}

function getDetailedHeatColor(value) {
    const stops = [
        { t: 0.00, c: [18, 22, 30] },
        { t: 0.03, c: [34, 112, 238] },
        { t: 0.14, c: [33, 174, 255] },
        { t: 0.28, c: [49, 190, 103] },
        { t: 0.46, c: [231, 212, 64] },
        { t: 0.64, c: [244, 152, 53] },
        { t: 0.82, c: [232, 70, 51] },
        { t: 0.93, c: [218, 58, 126] },
        { t: 1.00, c: [245, 105, 200] },
    ];

    const v = Math.max(0, Math.min(1, value));
    let a = stops[0];
    let b = stops[stops.length - 1];

    for (let i = 0; i < stops.length - 1; i++) {
        const s1 = stops[i];
        const s2 = stops[i + 1];
        if (v >= s1.t && v <= s2.t) {
            a = s1;
            b = s2;
            break;
        }
    }

    const span = Math.max(0.0001, b.t - a.t);
    const p = (v - a.t) / span;
    const r = Math.round(a.c[0] + (b.c[0] - a.c[0]) * p);
    const g = Math.round(a.c[1] + (b.c[1] - a.c[1]) * p);
    const bl = Math.round(a.c[2] + (b.c[2] - a.c[2]) * p);
    return `rgb(${r}, ${g}, ${bl})`;
}

export default FunscriptHeatmap;
