// tcodeService.js
// Manages Web Serial connection to TCode devices (OSR2, SR6, etc)

let port = null;
let writer = null;

let isSyncing = false;
let currentVideoId = null;
let syncTimeOffset = 0; // ms to subtract from video time
let lastKnownVideoTime = 0;
let lastVideoTimeUpdate = 0;
let isPlaying = false;

// scripts = { L0: [], R1: [], R2: [], L1: [], L2: [], R0: [] }
let activeScripts = {};
let loopTimer = null;
let lastPositions = {}; // axis → 0-100 current position

// ── Settings (persisted in localStorage) ──────────────────────────────
const SETTINGS_KEY = 'glyph_tcode_settings';

const ALL_AXES = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];
const NEUTRAL_POS = 50; // 50% = center/home
const AUTO_HOME_DURATION_MS = 600; // time to glide home
const SOFT_START_DURATION_MS = 400; // time to ramp into script position

let settings = loadSettings();

function defaultSettings() {
    const axisDefaults = {};
    for (const a of ALL_AXES) {
        axisDefaults[a] = { rangeMin: 0, rangeMax: 100, speedLimit: 0 }; // speedLimit 0 = unlimited
    }
    return {
        autoHome: true,
        softStart: true,
        smoothing: 'pchip', // 'linear' | 'pchip'
        axes: axisDefaults,
    };
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            const def = defaultSettings();
            // merge to ensure new keys exist
            return {
                autoHome: parsed.autoHome ?? def.autoHome,
                softStart: parsed.softStart ?? def.softStart,
                smoothing: parsed.smoothing ?? def.smoothing,
                axes: { ...def.axes, ...parsed.axes },
            };
        }
    } catch { }
    return defaultSettings();
}

function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { }
}

export function getSettings() { return JSON.parse(JSON.stringify(settings)); }

export function updateSettings(patch) {
    if (patch.axes) {
        settings.axes = { ...settings.axes, ...patch.axes };
        delete patch.axes;
    }
    Object.assign(settings, patch);
    saveSettings();
}

// Map funscript suffixes to TCode axes
const AXIS_MAP = {
    'main': 'L0',
    'roll': 'R1',
    'pitch': 'R2',
    'surge': 'L1',
    'sway': 'L2',
    'twist': 'R0'
};

const SYNC_INTERVAL_MS = 33; // ~30Hz

// ── Soft start state ─────────────────────────────────────────────────
let softStartActive = false;
let softStartBegin = 0;
let softStartFrom = {}; // axis → position at start of soft-start
let onDisconnectCallback = null;
let encoderStream = null;
let pipeAbort = null; // AbortController for pipeTo

export function onDeviceDisconnect(cb) {
    onDisconnectCallback = cb;
}

export async function connect() {
    if (!('serial' in navigator)) {
        throw new Error('Web Serial API not supported in this browser. Please use Chrome/Edge.');
    }

    // Clean up any leftover connection
    if (port || writer) {
        try { await disconnect(); } catch { }
    }

    // Request port
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    // Setup writing
    encoderStream = new TextEncoderStream();
    pipeAbort = new AbortController();
    encoderStream.readable.pipeTo(port.writable, { signal: pipeAbort.signal }).catch(() => {});
    writer = encoderStream.writable.getWriter();

    // Listen for physical unplug
    port.addEventListener('disconnect', () => {
        console.log('[TCode] Device physically disconnected');
        stopSync();
        writer = null;
        port = null;
        if (onDisconnectCallback) onDisconnectCallback();
    });

    return port.getInfo();
}

export async function disconnect() {
    stopSync();
    try {
        if (writer) {
            try { writer.releaseLock(); } catch { }
            writer = null;
        }
        if (pipeAbort) {
            pipeAbort.abort();
            pipeAbort = null;
        }
        if (encoderStream) {
            encoderStream = null;
        }
        if (port) {
            // Small delay to let abort propagate before closing
            await new Promise(r => setTimeout(r, 50));
            try { await port.close(); } catch { }
            port = null;
        }
    } catch (err) {
        console.error('[TCode] disconnect cleanup error:', err);
        writer = null;
        encoderStream = null;
        pipeAbort = null;
        port = null;
    }
}

export function isConnected() {
    return port !== null && writer !== null;
}

export function getActiveAxes() {
    return Object.keys(activeScripts);
}

export function getAxisPositions() {
    return { ...lastPositions };
}

export function setOffset(offsetMs) {
    syncTimeOffset = offsetMs;
}

export function prepareSync(videoId, allFunscriptData) {
    currentVideoId = videoId;
    activeScripts = {};

    if (!allFunscriptData) return;

    // Load main action array
    if (allFunscriptData.actions && allFunscriptData.actions.length > 0) {
        activeScripts['L0'] = {
            actions: allFunscriptData.actions,
            lastIndex: 0
        };
    }

    // Load multi-axis
    for (const [key, tcodeAxis] of Object.entries(AXIS_MAP)) {
        if (key === 'main') continue; // handled above
        if (allFunscriptData[key] && allFunscriptData[key].length > 0) {
            activeScripts[tcodeAxis] = {
                actions: allFunscriptData[key],
                lastIndex: 0
            };
        }
    }
}

export function syncPlay(videoTimeMs) {
    if (!isConnected()) return;
    lastKnownVideoTime = videoTimeMs;
    lastVideoTimeUpdate = performance.now();
    isPlaying = true;

    // Reset loop indices
    for (const axis in activeScripts) {
        activeScripts[axis].lastIndex = 0;
    }

    // Soft start: remember where each axis currently sits
    if (settings.softStart) {
        softStartActive = true;
        softStartBegin = performance.now();
        softStartFrom = {};
        for (const axis of ALL_AXES) {
            softStartFrom[axis] = lastPositions[axis] ?? NEUTRAL_POS;
        }
    }

    if (!isSyncing) {
        isSyncing = true;
        syncLoop();
    }
}

export function syncPause() {
    isPlaying = false;
    isSyncing = false;
    softStartActive = false;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }

    // Auto-home: glide all active axes back to neutral
    if (settings.autoHome && isConnected()) {
        sendAutoHome();
    }
}

function sendAutoHome() {
    let cmd = '';
    const interval = AUTO_HOME_DURATION_MS;
    for (const axis of ALL_AXES) {
        const neutralTcode = Math.round(NEUTRAL_POS * 99.99);
        const str = String(neutralTcode).padStart(4, '0');
        cmd += `${axis}${str}I${interval} `;
        lastPositions[axis] = NEUTRAL_POS;
    }
    if (cmd && writer) {
        writer.write(cmd.trim() + '\n').catch(err => {
            console.error('[TCode] Auto-home write error:', err);
        });
    }
}

export function syncSeek(videoTimeMs) {
    lastKnownVideoTime = videoTimeMs;
    lastVideoTimeUpdate = performance.now();
    // Re-calculate lastIndex when seek happens to avoid lagging interpolator
    for (const axis in activeScripts) {
        activeScripts[axis].lastIndex = 0;
    }
}

export function stopSync() {
    syncPause();
    activeScripts = {};
    lastPositions = {};
    currentVideoId = null;
}

function syncLoop() {
    if (!isSyncing || !isPlaying || !isConnected()) {
        isSyncing = false;
        return;
    }

    const now = performance.now();
    const elapsed = now - lastVideoTimeUpdate;
    const targetVideoTime = lastKnownVideoTime + elapsed - syncTimeOffset;

    // Soft start blend factor (0 = use softStartFrom, 1 = use script)
    let softBlend = 1;
    if (softStartActive) {
        const softElapsed = now - softStartBegin;
        if (softElapsed >= SOFT_START_DURATION_MS) {
            softStartActive = false;
        } else {
            // ease-out quad
            const t = softElapsed / SOFT_START_DURATION_MS;
            softBlend = t * (2 - t);
        }
    }

    let tcodeCommand = '';

    for (const [axis, data] of Object.entries(activeScripts)) {
        const { actions } = data;
        let targetPos;
        if (settings.smoothing === 'pchip') {
            targetPos = calculatePositionPCHIP(actions, targetVideoTime, data);
        } else {
            targetPos = calculatePositionLinear(actions, targetVideoTime, data);
        }

        if (targetPos !== null) {
            // Apply range limits
            const axCfg = settings.axes[axis];
            if (axCfg) {
                const rMin = axCfg.rangeMin ?? 0;
                const rMax = axCfg.rangeMax ?? 100;
                // Map 0-100 script range into rMin-rMax
                targetPos = rMin + (targetPos / 100) * (rMax - rMin);
            }

            // Apply soft start blending
            if (softStartActive && softBlend < 1) {
                const from = softStartFrom[axis] ?? NEUTRAL_POS;
                targetPos = from + (targetPos - from) * softBlend;
            }

            // Apply speed limit (units per second, 0 = unlimited)
            const speedLimit = axCfg?.speedLimit || 0;
            if (speedLimit > 0 && lastPositions[axis] != null) {
                const maxDelta = speedLimit * (SYNC_INTERVAL_MS / 1000);
                const delta = targetPos - lastPositions[axis];
                if (Math.abs(delta) > maxDelta) {
                    targetPos = lastPositions[axis] + Math.sign(delta) * maxDelta;
                }
            }

            // Clamp final
            targetPos = Math.max(0, Math.min(100, targetPos));
            lastPositions[axis] = Math.round(targetPos);

            // TCode format: 0 to 9999 (funscript 0-100 mapped)
            const tcodeVal = Math.max(0, Math.min(9999, Math.round(targetPos * 99.99)));
            const tcodeStr = String(tcodeVal).padStart(4, '0');
            const intervalStr = String(SYNC_INTERVAL_MS);

            tcodeCommand += `${axis}${tcodeStr}I${intervalStr} `;
        }
    }

    if (tcodeCommand.trim().length > 0) {
        writer.write(tcodeCommand.trim() + '\n').catch(err => {
            console.error('[TCode] Write error:', err);
            disconnect();
        });
    }

    loopTimer = setTimeout(syncLoop, SYNC_INTERVAL_MS);
}

// ── Linear interpolation (original) ──────────────────────────────────

function calculatePositionLinear(actions, timeMs, dataRef) {
    if (actions.length === 0) return null;
    if (timeMs <= actions[0].at) return actions[0].pos;
    if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;

    let i = seekIndex(actions, timeMs, dataRef);

    const current = actions[i];
    const next = actions[i + 1];
    if (!next) return current.pos;

    const dt = next.at - current.at;
    if (dt === 0) return current.pos;

    const progress = (timeMs - current.at) / dt;
    return current.pos + (next.pos - current.pos) * progress;
}

// ── PCHIP (Piecewise Cubic Hermite) interpolation ────────────────────

function calculatePositionPCHIP(actions, timeMs, dataRef) {
    if (actions.length === 0) return null;
    if (timeMs <= actions[0].at) return actions[0].pos;
    if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;

    let i = seekIndex(actions, timeMs, dataRef);

    const n = actions.length;

    // We need points i-1, i, i+1, i+2 for tangent estimation
    const p0 = actions[Math.max(0, i - 1)];
    const p1 = actions[i];
    const p2 = actions[Math.min(n - 1, i + 1)];
    const p3 = actions[Math.min(n - 1, i + 2)];

    if (!p2 || p2.at === p1.at) return p1.pos;

    const dt = p2.at - p1.at;
    const t = (timeMs - p1.at) / dt;

    // Compute slopes
    const d1 = pchipSlope(p0, p1, p2);
    const d2 = pchipSlope(p1, p2, p3);

    // Hermite basis
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * p1.pos + h10 * dt * d1 + h01 * p2.pos + h11 * dt * d2;
}

function pchipSlope(pLeft, pMid, pRight) {
    // Finite difference slopes
    const dLeft = (pLeft.at !== pMid.at) ? (pMid.pos - pLeft.pos) / (pMid.at - pLeft.at) : 0;
    const dRight = (pMid.at !== pRight.at) ? (pRight.pos - pMid.pos) / (pRight.at - pMid.at) : 0;

    // PCHIP: if slopes have different signs, tangent is 0 (monotone preserving)
    if (dLeft * dRight <= 0) return 0;

    // Weighted harmonic mean (shape-preserving)
    const w1 = 2 * (pRight.at - pMid.at) + (pMid.at - pLeft.at);
    const w2 = (pRight.at - pMid.at) + 2 * (pMid.at - pLeft.at);
    return (w1 + w2) / (w1 / dLeft + w2 / dRight);
}

// ── Shared index seeker ──────────────────────────────────────────────

function seekIndex(actions, timeMs, dataRef) {
    let i = dataRef.lastIndex;

    // Fast Forward
    while (i < actions.length - 2 && actions[i + 1].at < timeMs) {
        i++;
    }
    // Rewind
    while (i > 0 && actions[i].at > timeMs) {
        i--;
    }

    dataRef.lastIndex = i;
    return i;
}
