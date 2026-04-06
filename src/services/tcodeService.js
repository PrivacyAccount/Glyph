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

export async function connect() {
    if (!('serial' in navigator)) {
        throw new Error('Web Serial API not supported in this browser. Please use Chrome/Edge.');
    }

    // Request port
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });

    // Setup writing
    const encoder = new TextEncoderStream();
    encoder.readable.pipeTo(port.writable);
    writer = encoder.writable.getWriter();

    return port.getInfo();
}

export async function disconnect() {
    stopSync();
    if (writer) {
        await writer.close();
        writer = null;
    }
    if (port) {
        await port.close();
        port = null;
    }
}

export function isConnected() {
    return port !== null && writer !== null;
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

    if (!isSyncing) {
        isSyncing = true;
        syncLoop();
    }
}

export function syncPause() {
    isPlaying = false;
    isSyncing = false;
    if (loopTimer) {
        clearTimeout(loopTimer);
        loopTimer = null;
    }
    // Optional: send a stop command or return to neutral? TCode doesn't have a strict 'pause' command, typically we just stop sending.
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

    let tcodeCommand = '';

    for (const [axis, data] of Object.entries(activeScripts)) {
        const { actions, lastIndex } = data;
        const targetPos = calculatePosition(actions, targetVideoTime, data);

        if (targetPos !== null) {
            // TCode format: 0 to 9999
            // Funscript is 0 to 100
            const tcodeVal = Math.max(0, Math.min(9999, Math.round(targetPos * 99.99)));
            const tcodeStr = String(tcodeVal).padStart(4, '0'); // e.g., '0750'
            const intervalStr = String(SYNC_INTERVAL_MS);      // e.g., '33'

            // Format: L00750I33
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

function calculatePosition(actions, timeMs, dataRef) {
    if (actions.length === 0) return null;
    if (timeMs <= actions[0].at) return actions[0].pos;
    if (timeMs >= actions[actions.length - 1].at) return actions[actions.length - 1].pos;

    let i = dataRef.lastIndex;

    // Fast Forward (e.g. normal playback)
    while (i < actions.length - 2 && actions[i + 1].at < timeMs) {
        i++;
    }

    // Rewind (e.g. user seeking backwards)
    while (i > 0 && actions[i].at > timeMs) {
        i--;
    }

    dataRef.lastIndex = i;

    const current = actions[i];
    const next = actions[i + 1];

    if (!next) return current.pos;

    const dt = next.at - current.at;
    if (dt === 0) return current.pos;

    const progress = (timeMs - current.at) / dt;
    return current.pos + (next.pos - current.pos) * progress;
}
