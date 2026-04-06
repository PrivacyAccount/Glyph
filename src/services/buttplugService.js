import * as Buttplug from 'buttplug';

// ── State ────────────────────────────────────────────────────────────
let client = null;
let connectedDevices = new Map(); // id -> ButtplugClientDevice
let listeners = []; // For UI updates

// Sync State
let isPlaying = false;
let currentActions = [];
let currentDurationMs = 0;
let playbackStartTime = 0; // Date.now() when playback started/resumed
let playbackOffsetMs = 0; // Video time when play was pressed
let syncTimerId = null;
let currentActionIndex = -1; // Index of the action we last dispatched
let selectedDeviceId = null; // null = all devices
let outputMode = 'auto'; // auto | linear | vibrate
let invertScript = false; // invert funscript positions (100 - pos)
let perDeviceConfig = new Map(); // id -> { offset, min, max }
let commandMonitor = new Map(); // id -> { deviceId, name, mode, outputPos, commandKey, at }
let lastMonitorNotifyAt = 0;
let deviceLastSent = new Map(); // id -> { at, pos }

// ScriptPlayer-style: send point-to-point LinearCmd with real duration.
// Only enforce a tiny floor to avoid BLE flooding on very fast scripts.
const MIN_CMD_INTERVAL_MS = 50;
const MIN_LINEAR_DURATION_MS = 20;
const MAX_LINEAR_DURATION_MS = 500;
const MIN_POS_DELTA = 0; // send every action point for smooth motion
const IO_TIMEOUT_MS = 300;

const OUTPUT_MODE_VALUES = new Set(['auto', 'linear', 'vibrate']);
const DEVICE_CONFIG_KEY = 'buttplug_device_config_v1';

// ── Helpers ──────────────────────────────────────────────────────────

const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));

const withTimeout = (promise, ms = 1200) => Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
]);

const normalizeActions = (actions) => {
    if (!Array.isArray(actions)) return [];
    const normalized = actions
        .map((a) => ({
            at: Math.max(0, Number(a?.at || 0)),
            pos: clamp(Number(a?.pos || 0), 0, 100),
        }))
        .filter((a) => Number.isFinite(a.at) && Number.isFinite(a.pos))
        .sort((a, b) => a.at - b.at);
    if (normalized.length <= 1) return normalized;
    const out = [];
    for (const item of normalized) {
        const prev = out[out.length - 1];
        if (!prev) { out.push(item); continue; }
        if (item.at === prev.at) { prev.pos = item.pos; continue; }
        out.push(item);
    }
    return out;
};

const safeHasOutput = (device, outputType) => {
    try {
        if (typeof device?.hasOutput === 'function') return !!device.hasOutput(outputType);
    } catch { }
    return false;
};

const getDeviceCaps = (device) => {
    const attrs = Array.isArray(device?.messageAttributes) ? device.messageAttributes : null;
    const hasLinearFromAttrs = !!attrs?.some((m) =>
        String(m?.featureDescriptor || '').toLowerCase() === 'linearcmd'
    );
    const hasVibrateFromAttrs = !!attrs?.some((m) => {
        const fd = String(m?.featureDescriptor || '').toLowerCase();
        return fd === 'vibratecmd' || fd === 'scalarcmd';
    });
    const hasLinearFromMethods = typeof device?.linear === 'function';
    const hasVibrateFromMethods = typeof device?.vibrate === 'function';
    const hasLinearFromOutputs =
        safeHasOutput(device, Buttplug?.OutputType?.HwPositionWithDuration) ||
        safeHasOutput(device, Buttplug?.OutputType?.Position) ||
        safeHasOutput(device, Buttplug?.OutputType?.Oscillate);
    const hasVibrateFromOutputs =
        safeHasOutput(device, Buttplug?.OutputType?.Vibrate);

    // Also check the features map directly (newer Buttplug API)
    let hasLinearFromFeatures = false;
    let hasVibrateFromFeatures = false;
    try {
        if (device?.features instanceof Map) {
            for (const feature of device.features.values()) {
                const out = feature?._feature?.Output || feature?.Output;
                if (out) {
                    if (out.HwPositionWithDuration || out.Position || out.Oscillate) hasLinearFromFeatures = true;
                    if (out.Vibrate) hasVibrateFromFeatures = true;
                }
            }
        }
    } catch { }

    // Name-based heuristic for known linear strokers
    const nameLower = String(device?.name || '').toLowerCase();
    const isKnownLinear = nameLower.includes('handy') || nameLower.includes('solace')
        || nameLower.includes('keon') || nameLower.includes('launch')
        || nameLower.includes('stroker') || nameLower.includes('onyx');

    // Detect true position-capable linear vs oscillate-only
    const hasTrueLinear =
        safeHasOutput(device, Buttplug?.OutputType?.HwPositionWithDuration) ||
        safeHasOutput(device, Buttplug?.OutputType?.Position) ||
        hasLinearFromAttrs || hasLinearFromMethods ||
        (() => { try { if (device?.features instanceof Map) { for (const f of device.features.values()) { const o = f?._feature?.Output || f?.Output; if (o && (o.HwPositionWithDuration || o.Position)) return true; } } } catch {} return false; })();
    const hasOscillate =
        safeHasOutput(device, Buttplug?.OutputType?.Oscillate) ||
        (() => { try { if (device?.features instanceof Map) { for (const f of device.features.values()) { const o = f?._feature?.Output || f?.Output; if (o && o.Oscillate) return true; } } } catch {} return false; })();

    const hasLinear = hasTrueLinear || hasOscillate || hasLinearFromFeatures || isKnownLinear;
    const hasVibrate = hasVibrateFromAttrs || hasVibrateFromMethods || hasVibrateFromOutputs || hasVibrateFromFeatures;
    // oscillateOnly = device supports Oscillate but NOT true position commands
    const oscillateOnly = hasOscillate && !hasTrueLinear;
    return {
        hasLinear,
        hasVibrate: hasVibrate && !hasLinear ? true : hasVibrate,
        oscillateOnly,
    };
};

// ── Device I/O ───────────────────────────────────────────────────────

const sendRawOutputWithKeys = async (device, keys, intPos, durationMs = 100) => {
    if (!device || typeof device.send !== 'function') return null;
    const featureIndices = device?.features instanceof Map
        ? Array.from(device.features.keys())
        : [0];
    const normalizedPos = clamp(intPos, 0, 100) / 100;
    const positionLike = new Set([
        'PositionWithDuration',
        'HwPositionWithDuration',
        'hw_position_with_duration',
        'Position',
    ]);
    for (const featureIndex of featureIndices) {
        for (const key of keys) {
            const valuesToTry = positionLike.has(key)
                ? [intPos, normalizedPos]
                : [intPos];
            for (const value of valuesToTry) {
                const cmdBody = (key === 'PositionWithDuration' || key === 'HwPositionWithDuration' || key === 'hw_position_with_duration')
                    ? { Value: value, Duration: durationMs }
                    : { Value: value };
                const msg = {
                    OutputCmd: {
                        Id: 1,
                        DeviceIndex: Number(device.index),
                        FeatureIndex: Number(featureIndex),
                        Command: { [key]: cmdBody },
                    },
                };
                try {
                    const res = await withTimeout(device.send(msg), IO_TIMEOUT_MS);
                    if (res?.Ok || res?.OutputCmd === undefined) return key;
                } catch {
                    // try next value/key/feature
                }
            }
        }
    }
    return null;
};

const sendLinearCompat = async (device, normalizedPos, durationMs = 110) => {
    if (!device) return null;
    const p = clamp(normalizedPos, 0, 1);
    const intPos = Math.round(clamp(normalizedPos, 0, 1) * 100);
    const dur = Math.max(MIN_LINEAR_DURATION_MS, Math.min(MAX_LINEAR_DURATION_MS, Math.round(Number(durationMs) || 110)));
    const deviceName = String(device?.name || '').toLowerCase();
    const isHandyLike = deviceName.includes('handy');

    // Deterministic path for The Handy via Intiface:
    if (isHandyLike) {
        try {
            const rawKey = await sendRawOutputWithKeys(
                device,
                ['HwPositionWithDuration', 'hw_position_with_duration'],
                intPos,
                dur
            );
            if (rawKey) return rawKey;
        } catch { }
    }

    // Generic Buttplug runOutput linear commands.
    try {
        if (typeof device.runOutput === 'function' && Buttplug?.DeviceOutput?.PositionWithDuration) {
            await withTimeout(device.runOutput(Buttplug.DeviceOutput.PositionWithDuration.percent(p, dur)), IO_TIMEOUT_MS);
            return 'PositionWithDuration';
        }
    } catch { }
    try {
        if (typeof device.runOutput === 'function' && Buttplug?.DeviceOutput?.Position) {
            await withTimeout(device.runOutput(Buttplug.DeviceOutput.Position.percent(p)), IO_TIMEOUT_MS);
            return 'Position';
        }
    } catch { }

    if (isHandyLike) return null;

    // Additional generic fallbacks.
    try {
        if (typeof device.runOutput === 'function' && Buttplug?.DeviceOutput?.Rotate) {
            await withTimeout(device.runOutput(Buttplug.DeviceOutput.Rotate.percent(p)), IO_TIMEOUT_MS);
            return 'Rotate';
        }
    } catch { }
    // Raw fallback
    try {
        const rawKey = await sendRawOutputWithKeys(
            device,
            ['HwPositionWithDuration', 'hw_position_with_duration', 'PositionWithDuration', 'Position'],
            intPos,
            dur
        );
        if (rawKey) return rawKey;
    } catch { }
    try {
        const rawKey = await sendRawOutputWithKeys(
            device,
            ['Position', 'Rotate', 'PositionWithDuration'],
            intPos,
            100
        );
        if (rawKey) return rawKey;
    } catch { }
    return null;
};

const sendVibrateCompat = async (device, normalizedPos) => {
    if (!device) return null;
    const p = clamp(normalizedPos, 0, 1);
    const intPos = Math.round(clamp(normalizedPos, 0, 1) * 100);
    try {
        if (typeof device.vibrate === 'function') {
            await withTimeout(device.vibrate(p), IO_TIMEOUT_MS);
            return 'Vibrate';
        }
    } catch { }
    try {
        if (typeof device.runOutput === 'function' && Buttplug?.DeviceOutput?.Vibrate) {
            await withTimeout(device.runOutput(Buttplug.DeviceOutput.Vibrate.percent(p)), IO_TIMEOUT_MS);
            return 'Vibrate';
        }
    } catch { }
    try {
        const rawKey = await sendRawOutputWithKeys(device, ['Vibrate'], intPos, 0);
        if (rawKey) return rawKey;
    } catch { }
    return null;
};

/**
 * Send Oscillate command with a speed value (0-1).
 * Used for oscillate-only strokers (e.g. Lovense Solace Pro) where Oscillate
 * controls stroke speed/intensity, not position.
 */
const sendOscillateCompat = async (device, normalizedSpeed) => {
    if (!device) return null;
    const p = clamp(normalizedSpeed, 0, 1);
    const intPos = Math.round(p * 100);
    try {
        if (typeof device.runOutput === 'function' && Buttplug?.DeviceOutput?.Oscillate) {
            await withTimeout(device.runOutput(Buttplug.DeviceOutput.Oscillate.percent(p)), IO_TIMEOUT_MS);
            return 'Oscillate';
        }
    } catch { }
    try {
        if (typeof device.oscillate === 'function') {
            await withTimeout(device.oscillate(p), IO_TIMEOUT_MS);
            return 'Oscillate';
        }
    } catch { }
    try {
        const rawKey = await sendRawOutputWithKeys(device, ['Oscillate'], intPos, 0);
        if (rawKey) return rawKey;
    } catch { }
    return null;
};

/**
 * Convert funscript position delta + duration into a normalized speed (0-1)
 * for oscillate-only devices.
 * Speed = |Δposition| / Δtime, normalized so that typical fast strokes ≈ 1.0
 */
const positionDeltaToSpeed = (posDelta, durationMs) => {
    if (!durationMs || durationMs <= 0) return 0;
    const absDelta = Math.abs(posDelta);
    // Speed in position-units per millisecond.
    // A full stroke (100 units) in 200ms is very fast → should map to ~1.0
    // A full stroke in 500ms is moderate → ~0.4
    // Scale: speed = (absDelta / durationMs) * 200 / 100, clamped to [0, 1]
    const speed = (absDelta / durationMs) * 2.0;
    return clamp(speed, 0, 1);
};

const sendStopCompat = async (device) => {
    if (!device) return false;
    const caps = getDeviceCaps(device);
    if (caps.oscillateOnly) return !!(await sendOscillateCompat(device, 0));
    if (caps.hasLinear) return !!(await sendLinearCompat(device, 0, 90));
    if (caps.hasVibrate) return !!(await sendVibrateCompat(device, 0));
    const linearOk = await sendLinearCompat(device, 0);
    if (linearOk) return true;
    return !!(await sendVibrateCompat(device, 0));
};

const stopAllDevicesCompat = async () => {
    const stops = [];
    for (const device of connectedDevices.values()) {
        if (!device) continue;
        stops.push(withTimeout(sendStopCompat(device).catch(() => false), 800));
    }
    await Promise.allSettled(stops);
};

// ── Transport / Connection Internals ─────────────────────────────────

const hardCloseClientTransport = async (c) => {
    if (!c) return;
    const connector = c?.connector || c?._connector || c?.mConnector || c?.transport || null;
    try { if (connector?.ws && typeof connector.ws.close === 'function') { connector.ws.close(); return; } } catch { }
    try { if (connector?.socket && typeof connector.socket.close === 'function') { connector.socket.close(); return; } } catch { }
    try { if (typeof connector?.close === 'function') { await withTimeout(connector.close(), 400); return; } } catch { }
    try { if (typeof connector?.disconnect === 'function') { await withTimeout(connector.disconnect(), 400); } } catch { }
};

const refreshDeviceListCompat = async () => {
    if (!client || !client.connected) return;
    try {
        let list = null;
        if (typeof client.requestDeviceList === 'function') list = await client.requestDeviceList();
        else if (typeof client.getDeviceList === 'function') list = await client.getDeviceList();
        else if (typeof client.devices === 'function') list = await client.devices();
        else if (Array.isArray(client.devices)) list = client.devices;
        if (!Array.isArray(list)) return;
        for (const device of list) {
            if (!device) continue;
            const idx = Number(device.index);
            if (!Number.isFinite(idx)) continue;
            connectedDevices.set(idx, device);
        }
        notifyListeners();
    } catch { }
};

const getConnectorClass = () => {
    if (typeof Buttplug.ButtplugBrowserWebsocketClientConnector === 'function')
        return Buttplug.ButtplugBrowserWebsocketClientConnector;
    if (typeof Buttplug.ButtplugNodeWebsocketClientConnector === 'function')
        return Buttplug.ButtplugNodeWebsocketClientConnector;
    if (typeof Buttplug.ButtplugWebsocketClientConnector === 'function')
        return Buttplug.ButtplugWebsocketClientConnector;
    return null;
};

// ── Per-Device Config ────────────────────────────────────────────────

const loadPerDeviceConfig = () => {
    try {
        const raw = localStorage.getItem(DEVICE_CONFIG_KEY);
        if (!raw) return new Map();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return new Map();
        const map = new Map();
        for (const [id, value] of Object.entries(parsed)) {
            const key = Number(id);
            if (!Number.isFinite(key)) continue;
            const offset = Math.round(clamp(value?.offset, -100, 100));
            const min = Math.round(clamp(value?.min, 0, 100));
            const max = Math.round(clamp(value?.max, 0, 100));
            map.set(key, { offset, min: Math.min(min, max), max: Math.max(min, max) });
        }
        return map;
    } catch { return new Map(); }
};

const savePerDeviceConfig = () => {
    try {
        const obj = {};
        for (const [id, cfg] of perDeviceConfig.entries()) obj[String(id)] = cfg;
        localStorage.setItem(DEVICE_CONFIG_KEY, JSON.stringify(obj));
    } catch { }
};

const getDeviceConfig = (deviceId) => {
    const key = Number(deviceId);
    if (!Number.isFinite(key)) return { offset: 0, min: 0, max: 100 };
    if (!perDeviceConfig.has(key)) perDeviceConfig.set(key, { offset: 0, min: 0, max: 100 });
    return perDeviceConfig.get(key);
};

const mapPositionForDevice = (rawPos, deviceId) => {
    const cfg = getDeviceConfig(deviceId);
    const base = clamp(rawPos, 0, 100);
    const min = clamp(cfg.min, 0, 100);
    const max = clamp(cfg.max, 0, 100);
    const ranged = min + ((base / 100) * (Math.max(min, max) - Math.min(min, max)));
    const withOffset = ranged + clamp(cfg.offset, -100, 100);
    return clamp(withOffset, 0, 100);
};

// ── Listeners / UI Notify ────────────────────────────────────────────

const notifyListeners = () => {
    const devices = Array.from(connectedDevices.values()).map(d => ({
        ...getDeviceCaps(d),
        id: d.index,
        name: d.name,
        selected: selectedDeviceId === null ? false : Number(d.index) === Number(selectedDeviceId),
        config: getDeviceConfig(d.index),
    }));
    const monitor = Array.from(commandMonitor.values())
        .sort((a, b) => Number(b?.at || 0) - Number(a?.at || 0));
    listeners.forEach(fn => fn({
        connected: !!client?.connected,
        devices,
        commandMonitor: monitor,
        selectedDeviceId,
        outputMode,
        invertScript,
    }));
};

const maybeNotifyMonitor = () => {
    const now = Date.now();
    if (now - lastMonitorNotifyAt < 200) return;
    lastMonitorNotifyAt = now;
    notifyListeners();
};

export const subscribe = (fn) => {
    listeners.push(fn);
    notifyListeners();
    return () => { listeners = listeners.filter(l => l !== fn); };
};

// ── Persistence ─────────────────────────────────────────────────────

export const getSavedUrl = () => {
    try {
        const raw = String(localStorage.getItem('buttplug_url') || '').trim();
        if (!raw) return 'ws://127.0.0.1:12345';
        if (raw === 'ws://127.0.0.1:12000') return 'ws://127.0.0.1:12345';
        return raw;
    } catch { return 'ws://127.0.0.1:12345'; }
};

export const saveUrl = (url) => {
    try { localStorage.setItem('buttplug_url', url); } catch { }
};

export const getSavedSelectedDeviceId = () => {
    try {
        const raw = localStorage.getItem('buttplug_selected_device');
        if (raw === null || raw === '' || raw === 'all') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
};

export const saveSelectedDeviceId = (id) => {
    try {
        if (id === null || id === undefined || id === 'all') localStorage.setItem('buttplug_selected_device', 'all');
        else localStorage.setItem('buttplug_selected_device', String(id));
    } catch { }
};

export const getSavedOutputMode = () => {
    try {
        const raw = String(localStorage.getItem('buttplug_output_mode') || 'auto').trim().toLowerCase();
        return OUTPUT_MODE_VALUES.has(raw) ? raw : 'auto';
    } catch { return 'auto'; }
};

export const saveOutputMode = (mode) => {
    const safe = OUTPUT_MODE_VALUES.has(String(mode || '').toLowerCase()) ? String(mode).toLowerCase() : 'auto';
    try { localStorage.setItem('buttplug_output_mode', safe); } catch { }
};

export const setSelectedDevice = (id) => {
    if (id === null || id === undefined || id === 'all') selectedDeviceId = null;
    else {
        const n = Number(id);
        selectedDeviceId = Number.isFinite(n) ? n : null;
    }
    saveSelectedDeviceId(selectedDeviceId);
    notifyListeners();
};

export const setOutputMode = (mode) => {
    const safe = OUTPUT_MODE_VALUES.has(String(mode || '').toLowerCase()) ? String(mode).toLowerCase() : 'auto';
    outputMode = safe;
    saveOutputMode(safe);
    // Auto-enable invert for vibrate mode, auto-disable for other modes
    if (safe === 'vibrate') {
        invertScript = true;
        saveInvertScript(true);
    } else {
        invertScript = false;
        saveInvertScript(false);
    }
    notifyListeners();
};

export const getSavedInvertScript = () => {
    try {
        return localStorage.getItem('buttplug_invert_script') === '1';
    } catch { return false; }
};

export const saveInvertScript = (val) => {
    try { localStorage.setItem('buttplug_invert_script', val ? '1' : '0'); } catch { }
};

export const setInvertScript = (val) => {
    invertScript = !!val;
    saveInvertScript(invertScript);
    notifyListeners();
};

export const setDeviceOffset = (deviceId, offset) => {
    const key = Number(deviceId);
    if (!Number.isFinite(key)) return;
    const prev = getDeviceConfig(key);
    perDeviceConfig.set(key, { ...prev, offset: Math.round(clamp(offset, -100, 100)) });
    savePerDeviceConfig();
    notifyListeners();
};

export const setDeviceRange = (deviceId, min, max) => {
    const key = Number(deviceId);
    if (!Number.isFinite(key)) return;
    const lo = Math.round(clamp(min, 0, 100));
    const hi = Math.round(clamp(max, 0, 100));
    const prev = getDeviceConfig(key);
    perDeviceConfig.set(key, { ...prev, min: Math.min(lo, hi), max: Math.max(lo, hi) });
    savePerDeviceConfig();
    notifyListeners();
};

export const sendDeviceTest = async (deviceId, percentOrStop) => {
    const key = Number(deviceId);
    if (!Number.isFinite(key)) return;
    const device = connectedDevices.get(key);
    if (!device) return;
    const now = Date.now();
    try {
        if (percentOrStop === null || percentOrStop === undefined) {
            await sendStopCompat(device);
            commandMonitor.set(key, { deviceId: key, name: device.name, mode: 'stop', outputPos: 0, commandKey: '', at: now });
            notifyListeners();
            return;
        }
        const absolutePercent = clamp(percentOrStop, 0, 100);
        const normalized = absolutePercent / 100;
        let mode = 'none';
        let commandKey = '';
        const caps = getDeviceCaps(device);
        // Oscillate-only: test sends speed directly
        if (caps.oscillateOnly && outputMode !== 'vibrate') {
            const k = await sendOscillateCompat(device, normalized);
            if (k) { mode = 'oscillate'; commandKey = String(k); }
        } else if (outputMode === 'linear') {
            const k = await sendLinearCompat(device, normalized, 110);
            if (k) { mode = 'linear'; commandKey = String(k); }
        } else if (outputMode === 'vibrate') {
            const k = await sendVibrateCompat(device, normalized);
            if (k) { mode = 'vibrate'; commandKey = String(k); }
        } else {
            const lk = await sendLinearCompat(device, normalized, 110);
            if (lk) { mode = 'linear'; commandKey = String(lk); }
            else {
                const vk = await sendVibrateCompat(device, normalized);
                if (vk) { mode = 'vibrate'; commandKey = String(vk); }
            }
        }
        commandMonitor.set(key, {
            deviceId: key, name: device.name,
            mode: mode === 'none' ? 'unsupported' : `test-${mode}`,
            outputPos: Math.round(absolutePercent), commandKey, at: now,
        });
        notifyListeners();
    } catch { }
};

// ── Connection ───────────────────────────────────────────────────────

export const connect = async (url) => {
    if (client && client.connected) await disconnect();

    client = new Buttplug.ButtplugClient("Glyph Media Player");
    selectedDeviceId = getSavedSelectedDeviceId();
    outputMode = getSavedOutputMode();
    invertScript = getSavedInvertScript();
    perDeviceConfig = loadPerDeviceConfig();
    commandMonitor.clear();

    client.addListener('deviceadded', (device) => {
        console.log('[Buttplug] Device added:', device.name);
        connectedDevices.set(device.index, device);
        notifyListeners();
    });

    client.addListener('deviceremoved', (device) => {
        console.log('[Buttplug] Device removed:', device.name);
        connectedDevices.delete(device.index);
        commandMonitor.delete(Number(device.index));
        if (selectedDeviceId !== null && Number(selectedDeviceId) === Number(device.index)) {
            selectedDeviceId = null;
            saveSelectedDeviceId('all');
        }
        notifyListeners();
    });

    client.addListener('disconnect', () => {
        console.log('[Buttplug] Disconnected');
        connectedDevices.clear();
        commandMonitor.clear();
        cancelSyncTimer();
        isPlaying = false;
        notifyListeners();
    });

    try {
        const Connector = getConnectorClass();
        if (!Connector) throw new Error('No compatible Buttplug websocket connector found in installed package');
        await client.connect(new Connector(url));
        console.log('[Buttplug] Connected successfully');
        saveUrl(url);

        await refreshDeviceListCompat();
        await client.startScanning();
        await refreshDeviceListCompat();
        notifyListeners();

        setTimeout(() => {
            if (client && client.connected) client.stopScanning().catch(() => { });
        }, 10000);
    } catch (err) {
        console.error('[Buttplug] Connection failed:', err);
        client = null;
        throw err;
    }
};

export const disconnect = async () => {
    const c = client;
    isPlaying = false;
    cancelSyncTimer();
    client = null;
    deviceLastSent.clear();
    const prevDevices = new Map(connectedDevices);
    connectedDevices.clear();
    commandMonitor.clear();
    notifyListeners();

    if (c && c.connected) {
        try {
            const stopJobs = [];
            for (const device of prevDevices.values()) {
                if (!device) continue;
                stopJobs.push(withTimeout(sendStopCompat(device).catch(() => false), 800));
            }
            await Promise.allSettled(stopJobs);
            await hardCloseClientTransport(c);
        } catch { }
    }
};

export const startScanning = async () => {
    if (!client || !client.connected) return;
    await client.startScanning();
    await refreshDeviceListCompat();
    setTimeout(() => {
        if (client && client.connected) {
            client.stopScanning().catch(() => { });
            refreshDeviceListCompat().catch(() => { });
        }
    }, 10000);
};

// ── Funscript Sync (ScriptPlayer-style point-to-point) ──────────────
//
// Instead of polling interpolated positions at a fixed interval, we:
// 1. Find the next funscript action point from the current video time
// 2. Send LinearCmd(targetPos, durationUntilThatPoint) to all selected devices
// 3. Schedule a timer to fire at exactly the time of the next action point
// 4. Repeat → the device performs smooth motions between points on its own

const cancelSyncTimer = () => {
    if (syncTimerId !== null) {
        clearTimeout(syncTimerId);
        syncTimerId = null;
    }
};

const getCurrentVideoTimeMs = () => {
    return playbackOffsetMs + (Date.now() - playbackStartTime);
};

/** Binary search: find index of the first action with at >= timeMs */
const findActionIndexAtOrAfter = (timeMs) => {
    if (!currentActions.length) return -1;
    let lo = 0, hi = currentActions.length - 1;
    if (timeMs <= currentActions[0].at) return 0;
    if (timeMs > currentActions[hi].at) return -1;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (currentActions[mid].at < timeMs) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

const shouldTargetDevice = (deviceId) => {
    if (selectedDeviceId === null) return true;
    return Number(deviceId) === Number(selectedDeviceId);
};

/** Send a single position command to all targeted devices */
const sendToDevices = async (rawPos, durationMs, prevRawPos = null) => {
    if (!client || !client.connected) return;
    const now = Date.now();

    for (const [id, device] of connectedDevices.entries()) {
        if (!shouldTargetDevice(id)) continue;

        const mappedPos = mapPositionForDevice(rawPos, id);
        const normalizedPos = clamp(mappedPos / 100, 0, 1);
        const key = Number(id);

        // Skip if same position sent too recently
        const last = deviceLastSent.get(key);
        if (last && (now - last.at) < MIN_CMD_INTERVAL_MS && Math.abs(Math.round(mappedPos) - last.pos) <= MIN_POS_DELTA) {
            continue;
        }

        const dur = Math.max(MIN_LINEAR_DURATION_MS, Math.min(MAX_LINEAR_DURATION_MS, Math.round(durationMs)));
        let mode = 'unsupported';
        let commandKey = '';

        try {
            const caps = getDeviceCaps(device);
            const isHandyLike = String(device?.name || '').toLowerCase().includes('handy');

            // Apply invert if enabled: flip position (0↔100)
            const effectiveNormalized = invertScript ? (1 - normalizedPos) : normalizedPos;

            // Oscillate-only devices: convert position delta to speed
            if (caps.oscillateOnly && outputMode !== 'vibrate') {
                const prevPos = prevRawPos !== null ? mapPositionForDevice(prevRawPos, id) : (last?.pos ?? mappedPos);
                const posDelta = mappedPos - prevPos;
                const speed = positionDeltaToSpeed(posDelta, durationMs);
                const ok = await sendOscillateCompat(device, speed);
                if (ok) { mode = 'oscillate'; commandKey = String(ok); }
            } else if (outputMode === 'linear') {
                const ok = await sendLinearCompat(device, effectiveNormalized, dur);
                if (ok) { mode = 'linear'; commandKey = String(ok); }
            } else if (outputMode === 'vibrate') {
                const ok = await sendVibrateCompat(device, effectiveNormalized);
                if (ok) { mode = 'vibrate'; commandKey = String(ok); }
            } else {
                // auto: prefer linear for Handy-like and linear-capable devices
                if (isHandyLike || caps.hasLinear) {
                    const ok = await sendLinearCompat(device, effectiveNormalized, dur);
                    if (ok) { mode = 'linear'; commandKey = String(ok); }
                }
                // fallback to vibrate if linear wasn't tried or failed
                if (mode === 'unsupported' && (caps.hasVibrate || !caps.hasLinear)) {
                    const ok = await sendVibrateCompat(device, effectiveNormalized);
                    if (ok) { mode = 'vibrate'; commandKey = String(ok); }
                }
            }

            deviceLastSent.set(key, { at: Date.now(), pos: Math.round(mappedPos) });
            commandMonitor.set(key, {
                deviceId: key, name: device.name, mode, outputPos: Math.round(mappedPos),
                commandKey, at: now,
            });
        } catch { }
    }
    maybeNotifyMonitor();
};

/**
 * Core sync tick: send the current action's position, then schedule the next.
 * This is the ScriptPlayer-style algorithm:
 * - Each funscript action = one LinearCmd with exact travel duration
 * - Timer fires at the exact moment the next action should begin
 */
const scheduleNextAction = () => {
    if (!isPlaying || !client || !client.connected || currentActions.length < 2) {
        syncTimerId = null;
        return;
    }

    const videoTimeMs = getCurrentVideoTimeMs();

    // Find next action at or after current video time
    let nextIdx = findActionIndexAtOrAfter(videoTimeMs);
    if (nextIdx < 0) {
        // Past end of script – nothing more to do
        syncTimerId = null;
        return;
    }

    // If we're exactly on or past this action point, send it immediately
    // and advance to prepare for the one after it.
    const nextAction = currentActions[nextIdx];
    const timeUntilNext = nextAction.at - videoTimeMs;

    if (timeUntilNext <= 5) {
        // We're at (or very close to) this action point.
        // Calculate duration: time from this action to the NEXT action in the script.
        const afterIdx = nextIdx + 1;
        if (afterIdx < currentActions.length) {
            const durationToNext = currentActions[afterIdx].at - nextAction.at;
            // Send command: move to THIS action's position over durationToNext
            // (The device should arrive here now, then we'll send the next point)
            // Actually: we send the NEXT action's target with the duration to reach it.
            // This is how LinearCmd works: "go to position X in Y milliseconds".
            sendToDevices(currentActions[afterIdx].pos, durationToNext, nextAction.pos);
            currentActionIndex = afterIdx;

            // Schedule for when we need to send the action AFTER that
            const delay = Math.max(1, durationToNext);
            syncTimerId = setTimeout(() => { scheduleNextAction(); }, delay);
        } else {
            // Last action – send final position
            sendToDevices(nextAction.pos, 100, currentActions[Math.max(0, nextIdx - 1)]?.pos ?? null);
            currentActionIndex = nextIdx;
            syncTimerId = null;
        }
    } else {
        // We're between two action points. Send immediate position to the current
        // next target, then schedule to fire when we arrive there.
        // First: interpolate where we should be right now, send that as a catch-up.
        const prevIdx = Math.max(0, nextIdx - 1);
        if (prevIdx !== nextIdx) {
            const durationToTarget = nextAction.at - videoTimeMs;
            sendToDevices(nextAction.pos, durationToTarget, currentActions[prevIdx]?.pos ?? null);
            currentActionIndex = nextIdx;
        }

        // Schedule for when the next action point arrives
        syncTimerId = setTimeout(() => { scheduleNextAction(); }, Math.max(1, timeUntilNext));
    }
};

export const prepareSync = (actions, durationMs = 0) => {
    currentActions = normalizeActions(actions || []);
    currentDurationMs = Math.max(
        Number(durationMs || 0),
        Number(currentActions[currentActions.length - 1]?.at || 0)
    );
    playbackOffsetMs = 0;
    playbackStartTime = Date.now();
    currentActionIndex = -1;
    deviceLastSent.clear();
    console.log(`[Buttplug] Sync prepared with ${currentActions.length} actions.`);
};

export const syncPlay = (videoTimeMs) => {
    if (!client || !client.connected || currentActions.length === 0) return;
    playbackStartTime = Date.now();
    playbackOffsetMs = Math.max(0, Number(videoTimeMs || 0));
    isPlaying = true;
    currentActionIndex = -1;
    deviceLastSent.clear();

    cancelSyncTimer();
    scheduleNextAction();
    console.log(`[Buttplug] Play at ${videoTimeMs}ms`);
};

export const syncSeek = (videoTimeMs, isCurrentlyPlaying = true) => {
    if (!client || !client.connected || currentActions.length === 0) return;
    playbackStartTime = Date.now();
    playbackOffsetMs = Math.max(0, Number(videoTimeMs || 0));
    currentActionIndex = -1;
    deviceLastSent.clear();

    if (isCurrentlyPlaying) {
        isPlaying = true;
        cancelSyncTimer();
        scheduleNextAction();
    } else {
        isPlaying = false;
        cancelSyncTimer();
    }
};

/**
 * Lightweight clock recalibration: re-bases the internal clock to the real
 * MPV video time without doing a full restart. If the drift is small the
 * current schedule stays; if it exceeds DRIFT_THRESHOLD_MS the schedule is
 * rebuilt so the device catches up smoothly.
 */
const DRIFT_THRESHOLD_MS = 80;

export const syncRebase = (videoTimeMs) => {
    if (!isPlaying || !client || !client.connected || currentActions.length === 0) return;
    const realTimeMs = Math.max(0, Number(videoTimeMs || 0));
    const estimatedTimeMs = getCurrentVideoTimeMs();
    const drift = Math.abs(realTimeMs - estimatedTimeMs);

    // Always recalibrate the clock
    playbackStartTime = Date.now();
    playbackOffsetMs = realTimeMs;

    // Only reschedule if drift is noticeable
    if (drift > DRIFT_THRESHOLD_MS) {
        cancelSyncTimer();
        currentActionIndex = -1;
        scheduleNextAction();
    }
};

export const syncStop = async () => {
    isPlaying = false;
    cancelSyncTimer();
    currentActionIndex = -1;
    deviceLastSent.clear();

    if (client && client.connected) {
        await stopAllDevicesCompat();
    }
    const now = Date.now();
    for (const [id, device] of connectedDevices.entries()) {
        commandMonitor.set(Number(id), {
            deviceId: Number(id), name: device.name,
            mode: 'stop', outputPos: 0, commandKey: '', at: now,
        });
    }
    notifyListeners();
    console.log('[Buttplug] Stop / Pause');
};

// Legacy export to keep getValueAtTime available if anything else uses it
export const getValueAtTime = (timeMs) => {
    if (!currentActions || currentActions.length === 0) return 0;
    if (timeMs <= currentActions[0].at) return currentActions[0].pos;
    if (timeMs >= currentActions[currentActions.length - 1].at) return currentActions[currentActions.length - 1].pos;
    let idx = 0;
    while (idx < currentActions.length - 1 && currentActions[idx + 1].at < timeMs) idx++;
    const a = currentActions[idx];
    const b = currentActions[idx + 1];
    if (a.at === b.at) return a.pos;
    const t = (timeMs - a.at) / (b.at - a.at);
    return Math.round(a.pos + t * (b.pos - a.pos));
};
