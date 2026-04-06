/**
 * handyService.js – TheHandy API v2 wrapper
 *
 * All communication goes through the Handyfeeling cloud API.
 * The device must be connected to Wi-Fi (steady purple LED).
 *
 * API docs: https://handyfeeling.com/api/handy/v2
 */

const BASE = 'https://www.handyfeeling.com/api/handy/v2';

const LS_KEY = 'glyph_device_handy_key';
const LS_OFFSET_KEY = 'glyph_device_handy_offset';

// ── Helpers ────────────────────────────────────────────────────────────

const API_TIMEOUT_MS = 5000;

function headers(connectionKey) {
    return {
        'X-Connection-Key': connectionKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    };
}

async function api(method, path, connectionKey, body = null, timeoutMs = API_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const opts = { method, headers: headers(connectionKey), signal: controller.signal };
        if (body !== null) opts.body = JSON.stringify(body);
        const res = await fetch(`${BASE}${path}`, opts);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Handy API ${method} ${path} → ${res.status}: ${text}`);
        }
        return res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error(`Handy API ${method} ${path} timed out after ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

// ── Public API ─────────────────────────────────────────────────────────

/** Check if device is online */
export async function isConnected(connectionKey) {
    const data = await api('GET', '/connected', connectionKey);
    return !!data?.connected;
}

/** Get device info (model, fwVersion, fwStatus, etc.) */
export async function getInfo(connectionKey) {
    return api('GET', '/info', connectionKey);
}

/** Get current mode (0=HAMP, 1=HSSP, 2=HDSP, 3=MAINTENANCE) */
export async function getMode(connectionKey) {
    return api('GET', '/mode', connectionKey);
}

/** Set device mode */
export async function setMode(connectionKey, mode) {
    return api('PUT', '/mode', connectionKey, { mode });
}

/** Get estimated server time for HSSP sync */
export async function getServerTime(connectionKey) {
    const data = await api('GET', '/servertime', connectionKey);
    return data?.serverTime ?? Date.now();
}

/**
 * Upload funscript JSON to Handyfeeling temporary storage.
 * Returns the URL to use with HSSP setup.
 * We route this through our own server to avoid CORS.
 */
export async function uploadFunscript(connectionKey, funscriptJson) {
    const res = await fetch('/api/handy/upload-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            connectionKey: String(connectionKey || ''),
            script: funscriptJson,
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upload failed: ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.url;
}

/** HSSP setup – provide the script URL */
export async function hsspSetup(connectionKey, scriptUrl) {
    return api('PUT', '/hssp/setup', connectionKey, { url: scriptUrl });
}

/** HSSP play – start script playback at a given time */
export async function hsspPlay(connectionKey, estimatedServerTime, startTimeMs = 0) {
    return api('PUT', '/hssp/play', connectionKey, {
        estimatedServerTime,
        startTime: Math.round(startTimeMs),
    });
}

/** HSSP stop */
export async function hsspStop(connectionKey) {
    return api('PUT', '/hssp/stop', connectionKey);
}

/** Set HSSP offset (sync fine-tuning) */
export async function setOffset(connectionKey, offsetMs) {
    return api('PUT', '/hstp/offset', connectionKey, { offset: Math.round(offsetMs) });
}

// ── Persistence helpers ────────────────────────────────────────────────

export function getSavedKey() {
    return localStorage.getItem(LS_KEY) || '';
}

export function saveKey(key) {
    localStorage.setItem(LS_KEY, key);
}

export function getSavedOffset() {
    const raw = localStorage.getItem(LS_OFFSET_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}

export function saveOffset(offset) {
    localStorage.setItem(LS_OFFSET_KEY, String(offset));
}

// ── High-level sync helpers ────────────────────────────────────────────

/**
 * Full sync sequence:
 * 1. Set mode to HSSP (1)
 * 2. Upload funscript → get URL
 * 3. Call HSSP setup with the URL
 * Returns the script URL for later reference.
 */
export async function prepareSync(connectionKey, funscriptActions) {
    await setMode(connectionKey, 1);
    const funscriptJson = { actions: funscriptActions };
    const url = await uploadFunscript(connectionKey, funscriptJson);
    await hsspSetup(connectionKey, url);
    return url;
}

/**
 * Start playback at a given video time (ms).
 * Calculates estimated server time automatically.
 */
export async function syncPlay(connectionKey, videoTimeMs = 0) {
    let serverTime;
    try {
        serverTime = await getServerTime(connectionKey);
    } catch {
        // Fallback: use local clock if cloud server-time request fails
        serverTime = Date.now();
    }
    await hsspPlay(connectionKey, serverTime, videoTimeMs);
}

/** Stop / pause playback on device. */
export async function syncStop(connectionKey) {
    await hsspStop(connectionKey);
}

/**
 * Debug helper: move device to an absolute position (0-100) without a video.
 * Uses HDSP mode (Mode 2) for direct absolute positioning – faster and more
 * reliable than the HSSP workaround with temporary scripts.
 */
export async function moveToPosition(connectionKey, position) {
    const pos = Math.max(0, Math.min(100, Math.round(Number(position) || 0)));
    // Switch to HDSP mode (absolute position control)
    await setMode(connectionKey, 2);
    // Send absolute position via HDSP xpva endpoint
    await api('PUT', '/hdsp/xpva', connectionKey, {
        stopOnTarget: true,
        immediateResponse: true,
        duration: 400,
        position: pos / 100,
    });
}
