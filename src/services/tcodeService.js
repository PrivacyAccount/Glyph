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
const clientLogThrottleMap = new Map();

function logDashboard(level, message, meta = undefined, opts = {}) {
    try {
        const key = String(opts?.key || `${level}:${message}`);
        const throttleMs = Number(opts?.throttleMs || 0);
        if (throttleMs > 0) {
            const now = Date.now();
            const last = Number(clientLogThrottleMap.get(key) || 0);
            if (now - last < throttleMs) return;
            clientLogThrottleMap.set(key, now);
        }
        fetch('/api/logs/client', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                level: String(level || 'info'),
                area: 'tcode',
                message: String(message || ''),
                meta: (meta && typeof meta === 'object') ? meta : undefined,
            }),
        }).catch(() => { });
    } catch {
        // no-op
    }
}

function defaultSettings() {
    const axisDefaults = {};
    for (const a of ALL_AXES) {
        axisDefaults[a] = {
            rangeMin: 0,
            rangeMax: 100,
            speedLimit: 0, // 0 = unlimited
            motionProvider: 'auto', // 'auto' | 'off' | 'random' | 'link'
            randomSpeed: 50,        // 1-100, controls cycle rate
            randomSmooth: 50,       // 1-100, low = jagged, high = smooth
            linkAxis: 'L0',         // which axis to follow
            linkInvert: false,      // invert the linked position
        };
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

// ── Simplex noise for random motion ──────────────────────────────────
// 2D OpenSimplex-style noise (gradient noise, smooth, no visible grid artifacts)
const GRAD2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
const PERM = new Uint8Array(512);
(function initPerm() {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // deterministic shuffle (seed = 42)
    let s = 42;
    for (let i = 255; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        const j = s % (i + 1);
        [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
})();

function simplex2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = x - X0, y0 = y - Y0;
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const dot = (gi, dx, dy) => { const g = GRAD2[gi % 8]; return g[0] * dx + g[1] * dy; };
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { t0 *= t0; n0 = t0 * t0 * dot(PERM[ii + PERM[jj]], x0, y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { t1 *= t1; n1 = t1 * t1 * dot(PERM[ii + i1 + PERM[jj + j1]], x1, y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { t2 *= t2; n2 = t2 * t2 * dot(PERM[ii + 1 + PERM[jj + 1]], x2, y2); }
    return 70 * (n0 + n1 + n2); // returns -1..1
}

function fractalNoise(x, y, octaves, persistence, lacunarity) {
    let total = 0, amplitude = 1, frequency = 1, maxAmp = 0;
    for (let o = 0; o < octaves; o++) {
        total += simplex2D(x * frequency, y * frequency) * amplitude;
        maxAmp += amplitude;
        amplitude *= persistence;
        frequency *= lacunarity;
    }
    return total / maxAmp;
}

// Per-axis noise state
const noiseTime = {};  // axis → accumulated time
const noiseOffset = {}; // axis → random offset so axes don't correlate
function initNoiseForAxis(axis) {
    if (noiseTime[axis] == null) noiseTime[axis] = 0;
    if (noiseOffset[axis] == null) noiseOffset[axis] = Math.random() * 1000;
}

function getRandomPosition(axis, deltaSeconds) {
    initNoiseForAxis(axis);
    const cfg = settings.axes[axis] || {};
    // Speed: 1-100 mapped to 0.05-2.0 noise time advance per second
    const speed = 0.05 + ((cfg.randomSpeed ?? 50) / 100) * 1.95;
    // Smooth: 1-100 mapped to octaves 1-4 and persistence
    const smoothVal = (cfg.randomSmooth ?? 50) / 100;
    const octaves = Math.max(1, Math.round(1 + (1 - smoothVal) * 3)); // low smooth = more octaves = jagged
    const persistence = 0.4 + smoothVal * 0.4; // 0.4-0.8
    const lacunarity = 2.0;

    noiseTime[axis] += speed * deltaSeconds;
    const n = fractalNoise(noiseTime[axis], noiseOffset[axis], octaves, persistence, lacunarity);
    // Map -1..1 → 0..100
    return Math.max(0, Math.min(100, (n + 1) * 50));
}

function getLinkedPosition(axis) {
    const cfg = settings.axes[axis] || {};
    const sourceAxis = cfg.linkAxis || 'L0';
    const sourcePos = lastPositions[sourceAxis];
    if (sourcePos == null) return NEUTRAL_POS;
    return cfg.linkInvert ? (100 - sourcePos) : sourcePos;
}

// Determine effective provider for an axis (auto resolves based on script presence)
function getEffectiveProvider(axis) {
    const cfg = settings.axes[axis] || {};
    const provider = cfg.motionProvider || 'auto';
    if (provider === 'auto') {
        return activeScripts[axis] ? 'script' : 'off';
    }
    return provider;
}

export function getEffectiveProviders() {
    const result = {};
    for (const axis of ALL_AXES) {
        result[axis] = getEffectiveProvider(axis);
    }
    return result;
}

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
        logDashboard('error', 'Web Serial API not supported', undefined, { key: 'tcode-webserial-unsupported', throttleMs: 10000 });
        throw new Error('Web Serial API not supported in this browser. Please use Chrome/Edge.');
    }

    try {
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
        encoderStream.readable.pipeTo(port.writable, { signal: pipeAbort.signal }).catch(() => { });
        writer = encoderStream.writable.getWriter();

        // Listen for physical unplug
        port.addEventListener('disconnect', () => {
            console.log('[TCode] Device physically disconnected');
            logDashboard('warn', 'T-Code device physically disconnected');
            stopSync();
            if (writer) { try { writer.releaseLock(); } catch { } }
            if (pipeAbort) { pipeAbort.abort(); }
            writer = null;
            encoderStream = null;
            pipeAbort = null;
            port = null;
            if (onDisconnectCallback) onDisconnectCallback();
        });

        const info = port.getInfo?.() || {};
        logDashboard('info', 'T-Code connected', {
            usbVendorId: info?.usbVendorId ?? null,
            usbProductId: info?.usbProductId ?? null,
            hasVendorId: Number.isFinite(Number(info?.usbVendorId)),
            hasProductId: Number.isFinite(Number(info?.usbProductId)),
        }, { key: 'tcode-connected', throttleMs: 500 });
        return info;
    } catch (err) {
        logDashboard('error', 'T-Code connect failed', { error: String(err?.message || err || '') }, { key: 'tcode-connect-failed', throttleMs: 1000 });
        throw err;
    }
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
            try { await encoderStream.writable.close(); } catch { }
            encoderStream = null;
        }
        if (port) {
            // Wait for streams to fully settle before closing
            await new Promise(r => setTimeout(r, 200));
            try { await port.close(); } catch { }
            port = null;
        }
    } catch (err) {
        console.error('[TCode] disconnect cleanup error:', err);
        logDashboard('error', 'T-Code disconnect cleanup failed', { error: String(err?.message || err || '') }, { key: 'tcode-disconnect-failed', throttleMs: 1000 });
        writer = null;
        encoderStream = null;
        pipeAbort = null;
        port = null;
    }
    logDashboard('info', 'T-Code disconnected', undefined, { key: 'tcode-disconnected', throttleMs: 500 });
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
    logDashboard('info', 'T-Code script prepared', {
        videoId: String(videoId || ''),
        activeAxes: Object.keys(activeScripts),
        activeAxisCount: Object.keys(activeScripts).length,
    }, { key: `tcode-prepare-${String(videoId || '')}`, throttleMs: 1000 });
}

export function syncPlay(videoTimeMs) {
    if (!isConnected()) return;
    if (!Object.keys(activeScripts || {}).length) {
        logDashboard('warn', 'T-Code syncPlay without active scripts', { videoTimeMs: Number(videoTimeMs || 0) }, { key: 'tcode-syncplay-no-scripts', throttleMs: 5000 });
    }
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
    // Reset interpolation indices to avoid stale position
    for (const axis in activeScripts) {
        activeScripts[axis].lastIndex = 0;
    }

    // Cancel any pending loop tick so it doesn't fire with stale timing
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    softStartActive = false;

    if (isPlaying && isConnected()) {
        // Restart soft start so the device doesn't hard-jump
        if (settings.softStart) {
            softStartActive = true;
            softStartBegin = performance.now();
            softStartFrom = {};
            for (const axis of ALL_AXES) {
                softStartFrom[axis] = lastPositions[axis] ?? NEUTRAL_POS;
            }
        }
        // Restart the sync loop immediately with correct timing
        isSyncing = true;
        syncLoop();
    }
    // If paused, do nothing — the loop will resume on next syncPlay
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
    const deltaSec = SYNC_INTERVAL_MS / 1000;

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

    for (const axis of ALL_AXES) {
        const provider = getEffectiveProvider(axis);
        let targetPos = null;

        if (provider === 'script') {
            const data = activeScripts[axis];
            if (data) {
                const { actions } = data;
                if (settings.smoothing === 'pchip') {
                    targetPos = calculatePositionPCHIP(actions, targetVideoTime, data);
                } else {
                    targetPos = calculatePositionLinear(actions, targetVideoTime, data);
                }
            }
        } else if (provider === 'random') {
            targetPos = getRandomPosition(axis, deltaSec);
        } else if (provider === 'link') {
            targetPos = getLinkedPosition(axis);
        }
        // provider === 'off' or 'auto' with no script → targetPos stays null

        if (targetPos !== null) {
            // Apply range limits
            const axCfg = settings.axes[axis];
            if (axCfg) {
                const rMin = axCfg.rangeMin ?? 0;
                const rMax = axCfg.rangeMax ?? 100;
                targetPos = rMin + (targetPos / 100) * (rMax - rMin);
            }

            // Apply soft start blending (only for script, not random/link)
            if (provider === 'script' && softStartActive && softBlend < 1) {
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
            logDashboard('error', 'T-Code serial write failed', {
                error: String(err?.message || err || ''),
                commandLength: tcodeCommand.trim().length,
            }, { key: 'tcode-write-failed', throttleMs: 3000 });
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
