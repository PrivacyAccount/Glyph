import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useI18n } from '../i18n';
import * as handy from '../services/handyService';
import * as buttplug from '../services/buttplugService';
import * as tcode from '../services/tcodeService';
import AppDropdown from './AppDropdown';
import '../styles/device-panel.css';

const TABS = ['thehandy', 'tcode', 'buttplug'];
const DISABLED_TABS = new Set([]);
const DEBUG_ENABLE_KEY = 'glyph_device_debug_enabled';
const DEBUG_RANGE_MIN_KEY = 'glyph_device_debug_range_min';
const DEBUG_RANGE_MAX_KEY = 'glyph_device_debug_range_max';

function clampPos(pos) {
    return Math.max(0, Math.min(100, Number(pos) || 0));
}

function mapToDebugRange(pos, minPos, maxPos) {
    const low = Math.min(clampPos(minPos), clampPos(maxPos));
    const high = Math.max(clampPos(minPos), clampPos(maxPos));
    if (high <= low) return low;
    const normalized = clampPos(pos) / 100;
    return low + ((high - low) * normalized);
}

function estimatePositionAtTime(actions, timeMs) {
    if (!Array.isArray(actions) || actions.length === 0) return null;
    const t = Math.max(0, Number(timeMs) || 0);
    const sorted = [...actions].sort((a, b) => Number(a?.at || 0) - Number(b?.at || 0));
    if (sorted.length === 1) return clampPos(sorted[0]?.pos);
    const firstAt = Number(sorted[0]?.at || 0);
    if (t <= firstAt) return clampPos(sorted[0]?.pos);
    for (let i = 0; i < sorted.length - 1; i += 1) {
        const a = sorted[i];
        const b = sorted[i + 1];
        const atA = Number(a?.at || 0);
        const atB = Number(b?.at || 0);
        if (t > atB) continue;
        const posA = clampPos(a?.pos);
        const posB = clampPos(b?.pos);
        const span = Math.max(1, atB - atA);
        const ratio = Math.max(0, Math.min(1, (t - atA) / span));
        return clampPos(posA + ((posB - posA) * ratio));
    }
    return clampPos(sorted[sorted.length - 1]?.pos);
}

function DevicePanel({ open, onClose }) {
    const { t } = useI18n();
    const [activeTab, setActiveTab] = useState('thehandy');

    useEffect(() => {
        if (DISABLED_TABS.has(activeTab)) setActiveTab('thehandy');
    }, [activeTab]);

    // â”€â”€ TheHandy state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [connectionKey, setConnectionKey] = useState(handy.getSavedKey);
    const [status, setStatus] = useState('disconnected'); // disconnected | connecting | connected | error
    const [deviceInfo, setDeviceInfo] = useState(null);
    const [errorMsg, setErrorMsg] = useState('');
    const [offset, setOffset] = useState(handy.getSavedOffset);
    const [syncState, setSyncState] = useState('idle'); // idle | uploading | ready
    const connectedKeyRef = useRef('');
    const handyReadyRef = useRef(false);
    const handyPreparedVideoIdRef = useRef('');
    const lastFunscriptActionsRef = useRef(null);
    const lastFunscriptVideoIdRef = useRef('');
    const lastFunscriptAllDataRef = useRef(null);
    const lastPlayTimeMsRef = useRef(0);
    const isPlaybackActiveRef = useRef(false);
    const scriptSyncEnabledRef = useRef(true);
    const handyPrepareInFlightRef = useRef(null);
    const playResyncTimersRef = useRef([]);

    // â”€â”€ Buttplug.io state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [bpUrl, setBpUrl] = useState(buttplug.getSavedUrl());
    const [bpStatus, setBpStatus] = useState('disconnected'); // disconnected | connecting | connected | error
    const [bpError, setBpError] = useState('');
    const [bpDevices, setBpDevices] = useState([]);
    const [bpSyncState, setBpSyncState] = useState('idle'); // idle | ready
    const [bpSelectedDeviceId, setBpSelectedDeviceId] = useState(buttplug.getSavedSelectedDeviceId());
    const [bpOutputMode, setBpOutputMode] = useState(buttplug.getSavedOutputMode());
    const [bpInvertScript, setBpInvertScript] = useState(buttplug.getSavedInvertScript());
    const [bpCommandMonitor, setBpCommandMonitor] = useState([]);
    const isBpConnectedRef = useRef(false);
    const bpWasPlayingRef = useRef(false);

    // â”€â”€ TCode state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [tcStatus, setTcStatus] = useState('disconnected'); // disconnected | connected
    const [tcPortInfo, setTcPortInfo] = useState(null);
    const [tcSyncState, setTcSyncState] = useState('idle'); // idle | ready
    const [tcExpandedAxes, setTcExpandedAxes] = useState({});
    const isTcConnectedRef = useRef(false);

    // Debug mode (device setup & script visibility)
    const [debugEnabled, setDebugEnabled] = useState(() => {
        try { return localStorage.getItem(DEBUG_ENABLE_KEY) === '1'; } catch { return false; }
    });
    const [debugRangeMin, setDebugRangeMin] = useState(() => {
        try {
            const raw = Number(localStorage.getItem(DEBUG_RANGE_MIN_KEY));
            if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return Math.round(raw);
        } catch { }
        return 0;
    });
    const [debugRangeMax, setDebugRangeMax] = useState(() => {
        try {
            const raw = Number(localStorage.getItem(DEBUG_RANGE_MAX_KEY));
            if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return Math.round(raw);
        } catch { }
        return 100;
    });
    const [debugAxisRows, setDebugAxisRows] = useState([]);
    const [debugScriptVideo, setDebugScriptVideo] = useState('');
    const [debugLastAction, setDebugLastAction] = useState('');
    const [debugBusy, setDebugBusy] = useState(false);
    const [debugLivePosition, setDebugLivePosition] = useState(null);
    const [debugLiveAxisPositions, setDebugLiveAxisPositions] = useState({});
    const debugRangeMinRef = useRef(debugRangeMin);
    const debugRangeMaxRef = useRef(debugRangeMax);

    const withTimeout = useCallback((promise, ms = 2500) => {
        return Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
        ]);
    }, []);

    useEffect(() => {
        try { localStorage.setItem(DEBUG_ENABLE_KEY, debugEnabled ? '1' : '0'); } catch { }
    }, [debugEnabled]);

    useEffect(() => {
        const next = Math.max(0, Math.min(100, Number(debugRangeMin) || 0));
        debugRangeMinRef.current = next;
        try { localStorage.setItem(DEBUG_RANGE_MIN_KEY, String(next)); } catch { }
    }, [debugRangeMin]);

    useEffect(() => {
        const next = Math.max(0, Math.min(100, Number(debugRangeMax) || 100));
        debugRangeMaxRef.current = next;
        try { localStorage.setItem(DEBUG_RANGE_MAX_KEY, String(next)); } catch { }
    }, [debugRangeMax]);

    const applyDebugScaleToActions = useCallback((actions) => {
        if (!Array.isArray(actions)) return [];
        const minPos = debugRangeMinRef.current;
        const maxPos = debugRangeMaxRef.current;
        return actions.map((action) => ({
            ...action,
            pos: Math.round(mapToDebugRange(action?.pos, minPos, maxPos)),
        }));
    }, []);

    const applyDebugScaleToAllData = useCallback((allData) => {
        if (!allData || typeof allData !== 'object') return allData;
        const keys = ['actions', 'main', 'roll', 'twist', 'surge', 'sway', 'pitch'];
        const out = { ...allData };
        for (const key of keys) {
            if (Array.isArray(allData[key])) out[key] = applyDebugScaleToActions(allData[key]);
        }
        return out;
    }, [applyDebugScaleToActions]);

    const refreshDebugAxisRows = useCallback(async (videoId, allData) => {
        const id = String(videoId || '').trim();
        if (!id) {
            setDebugScriptVideo('');
            setDebugAxisRows([]);
            return;
        }
        const raw = (allData && typeof allData === 'object') ? allData : (lastFunscriptAllDataRef.current || {});
        const axisPayload = [
            { axis: 'main', actions: Array.isArray(raw.actions) ? raw.actions : Array.isArray(raw.main) ? raw.main : [] },
            { axis: 'roll', actions: Array.isArray(raw.roll) ? raw.roll : [] },
            { axis: 'twist', actions: Array.isArray(raw.twist) ? raw.twist : [] },
            { axis: 'surge', actions: Array.isArray(raw.surge) ? raw.surge : [] },
            { axis: 'sway', actions: Array.isArray(raw.sway) ? raw.sway : [] },
            { axis: 'pitch', actions: Array.isArray(raw.pitch) ? raw.pitch : [] },
        ].filter((row) => Array.isArray(row.actions) && row.actions.length > 0);

        let mappingRows = [];
        try {
            const res = await fetch(`/api/videos/${encodeURIComponent(id)}/funscript/mappings`);
            const json = await res.json().catch(() => ({}));
            mappingRows = Array.isArray(json?.mappings) ? json.mappings : [];
        } catch { }

        const byAxis = new Map();
        for (const map of mappingRows) {
            const axis = String(map?.axis || 'main').toLowerCase() || 'main';
            if (!byAxis.has(axis)) byAxis.set(axis, []);
            byAxis.get(axis).push(map);
        }

        const rows = axisPayload.map((row) => {
            const maps = byAxis.get(row.axis) || [];
            const preferred = maps.find((m) => Number(m?.isDefault) === 1 || m?.isDefault === true) || maps[0] || null;
            const metadataScriptPaths = (raw && typeof raw.metadata === 'object' && raw.metadata !== null && raw.metadata.scriptPaths && typeof raw.metadata.scriptPaths === 'object')
                ? raw.metadata.scriptPaths
                : {};
            const fallbackMain = String(raw?.metadata?.mainScriptPath || '');
            const fallbackAxis = String(metadataScriptPaths?.[row.axis] || '');
            const scriptPath = String(preferred?.scriptPath || (row.axis === 'main' ? (fallbackMain || fallbackAxis) : fallbackAxis) || '');
            const scriptFile = scriptPath ? scriptPath.split(/[/\\]/).pop() : '';
            const durationMs = Number(row.actions[row.actions.length - 1]?.at || 0);
            const min = Math.min(...row.actions.map((a) => clampPos(a?.pos)));
            const max = Math.max(...row.actions.map((a) => clampPos(a?.pos)));
            return {
                axis: row.axis,
                scriptFile,
                scriptPath,
                actions: row.actions.length,
                durationSec: Math.max(0, Math.round(durationMs / 1000)),
                min: Math.round(min),
                max: Math.round(max),
            };
        });

        setDebugScriptVideo(id);
        setDebugAxisRows(rows);
    }, []);

    const startHandyIfMpvPlaying = useCallback(async (key) => {
        if (!key || !handyReadyRef.current) return;
        try {
            const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
            if (paused === true || paused === 'yes') return;
            const timePos = await window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null);
            const timeMs = Math.max(0, Number(timePos || 0) * 1000);
            await handy.syncPlay(key, Number.isFinite(timeMs) ? timeMs : 0);
            isPlaybackActiveRef.current = true;
            lastPlayTimeMsRef.current = Number.isFinite(timeMs) ? timeMs : 0;
        } catch (err) {
            console.warn('[Handy] startHandyIfMpvPlaying failed:', err);
        }
    }, []);

    const clearPlayResyncTimers = useCallback(() => {
        for (const t of playResyncTimersRef.current) {
            try { clearTimeout(t); } catch { }
        }
        playResyncTimersRef.current = [];
    }, []);

    const forceHandyDisconnected = useCallback(() => {
        connectedKeyRef.current = '';
        handyReadyRef.current = false;
        handyPreparedVideoIdRef.current = '';
        isPlaybackActiveRef.current = false;
        setStatus('disconnected');
        setSyncState('idle');
        setDeviceInfo(null);
    }, []);

    const syncHandyToCurrentMpvTime = useCallback(async (key, fallbackTimeMs = 0) => {
        if (!key) return;
        const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
        if (paused === true || paused === 'yes') return;
        const timePos = await window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null);
        const mpvMs = Math.max(0, Number(timePos || 0) * 1000);
        const syncMs = Math.max(Number(fallbackTimeMs || 0), Number.isFinite(mpvMs) ? mpvMs : 0);
        await handy.syncPlay(key, syncMs);
        lastPlayTimeMsRef.current = syncMs;
    }, []);

    const ensureHandyPreparedForVideo = useCallback(async (key, videoId = '') => {
        if (!key) return false;
        const incomingId = String(videoId || '').trim();
        const preparedVideoId = String(handyPreparedVideoIdRef.current || '').trim();
        if (handyReadyRef.current && (!incomingId || incomingId === preparedVideoId)) return true;
        if (handyPrepareInFlightRef.current) {
            try { await handyPrepareInFlightRef.current; } catch { }
            if (!incomingId) return !!handyReadyRef.current;
            return !!handyReadyRef.current && String(handyPreparedVideoIdRef.current || '').trim() === incomingId;
        }
        const run = (async () => {
            let actions = Array.isArray(lastFunscriptActionsRef.current) ? lastFunscriptActionsRef.current : null;
            const cachedId = String(lastFunscriptVideoIdRef.current || '').trim();
            if (!actions || actions.length < 2 || (incomingId && cachedId && incomingId !== cachedId)) {
                if (!incomingId) throw new Error('Missing videoId for handy prepare');
                const res = await fetch(`/api/videos/${encodeURIComponent(incomingId)}/funscript`);
                const data = await res.json().catch(() => ({}));
                actions = Array.isArray(data?.actions) ? data.actions : null;
                if (!actions || actions.length < 2) throw new Error('No funscript actions');
                lastFunscriptActionsRef.current = actions;
                lastFunscriptVideoIdRef.current = incomingId;
            }
            setSyncState('uploading');
            await handy.prepareSync(key, applyDebugScaleToActions(actions));
            handyReadyRef.current = true;
            handyPreparedVideoIdRef.current = String(incomingId || cachedId || '');
            setSyncState('ready');
        })();
        handyPrepareInFlightRef.current = run;
        try {
            await run;
            return true;
        } catch (err) {
            console.warn('[Handy] ensure prepared failed:', err);
            handyReadyRef.current = false;
            handyPreparedVideoIdRef.current = '';
            setSyncState('idle');
            return false;
        } finally {
            handyPrepareInFlightRef.current = null;
        }
    }, [applyDebugScaleToActions]);

    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    // Receive player sync events from other renderer windows (e.g. separate player window).
    useEffect(() => {
        if (!window.electronAPI?.onDeviceSyncEvent) return undefined;
        const unsubscribe = window.electronAPI.onDeviceSyncEvent((payload) => {
            const eventName = String(payload?.eventName || '').trim();
            if (!eventName) return;
            const detail = (payload && typeof payload.detail === 'object' && payload.detail !== null) ? payload.detail : {};
            window.dispatchEvent(new CustomEvent(eventName, { detail }));
        });
        return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
    }, []);

    // â”€â”€ Buttplug Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    useEffect(() => {
        const unsub = buttplug.subscribe(({ connected, devices, selectedDeviceId, outputMode, invertScript, commandMonitor }) => {
            if (connected) {
                setBpStatus('connected');
                isBpConnectedRef.current = true;
            } else {
                if (bpStatus === 'connected') setBpStatus('disconnected');
                isBpConnectedRef.current = false;
                bpWasPlayingRef.current = false;
            }
            setBpDevices(devices || []);
            setBpSelectedDeviceId(selectedDeviceId ?? null);
            setBpOutputMode(outputMode || 'auto');
            setBpInvertScript(!!invertScript);
            setBpCommandMonitor(Array.isArray(commandMonitor) ? commandMonitor : []);
        });
        return unsub;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        buttplug.setSelectedDevice(bpSelectedDeviceId);
    }, [bpSelectedDeviceId]);

    useEffect(() => {
        buttplug.setOutputMode(bpOutputMode);
    }, [bpOutputMode]);

    useEffect(() => {
        buttplug.setInvertScript(bpInvertScript);
    }, [bpInvertScript]);

    // â”€â”€ Handy Connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleConnect = useCallback(async () => {
        const key = connectionKey.trim();
        if (!key) return;
        setStatus('connecting');
        setErrorMsg('');
        setDeviceInfo(null);
        try {
            const online = await handy.isConnected(key);
            if (!online) throw new Error(t('deviceNotOnline', 'Device is not online. Check Wi-Fi + LED.'));
            const info = await handy.getInfo(key);
            setDeviceInfo(info);
            setStatus('connected');
            connectedKeyRef.current = key;
            handy.saveKey(key);
            handyReadyRef.current = false;
            handyPreparedVideoIdRef.current = '';
            isPlaybackActiveRef.current = false;
            setSyncState('idle');

            // apply saved offset
            try { await handy.setOffset(key, offset); } catch { }
            // Always stop any stale remote state after connect; real playback will prepare on fresh events.
            try { await handy.syncStop(key); } catch { }
        } catch (err) {
            setStatus('error');
            setErrorMsg(err.message || 'Connection failed');
            connectedKeyRef.current = '';
            handyReadyRef.current = false;
            handyPreparedVideoIdRef.current = '';
        }
    }, [connectionKey, offset, t]);

    const handleDisconnect = useCallback(async () => {
        const key = connectedKeyRef.current;
        // Force local disconnect state immediately; network/API may hang if device is offline.
        connectedKeyRef.current = '';
        handyReadyRef.current = false;
        handyPreparedVideoIdRef.current = '';
        isPlaybackActiveRef.current = false;
        setStatus('disconnected');
        setDeviceInfo(null);
        setErrorMsg('');
        setSyncState('idle');
        if (key) {
            try { await withTimeout(handy.syncStop(key), 1500); } catch { }
        }
    }, [withTimeout]);

    // Live health-check: if device goes offline/unplugged, update UI automatically.
    useEffect(() => {
        const timer = setInterval(async () => {
            const key = connectedKeyRef.current;
            if (!key) return;
            try {
                const online = await withTimeout(handy.isConnected(key), 2500);
                // Additional liveness probe to avoid stale "connected" cloud state.
                if (online) await withTimeout(handy.getServerTime(key), 2500);
                if (!online) forceHandyDisconnected();
            } catch {
                forceHandyDisconnected();
            }
        }, 2500);
        return () => clearInterval(timer);
    }, [withTimeout, forceHandyDisconnected]);

    const handleOffsetChange = useCallback((val) => {
        const n = Number(val);
        setOffset(n);
        handy.saveOffset(n);
        const key = connectedKeyRef.current;
        if (key) {
            handy.setOffset(key, n).catch(() => { });
        }
    }, []);

    const handleDebugMoveTo = useCallback(async (targetPos) => {
        const key = connectedKeyRef.current;
        if (!key) return;
        const scaledTarget = Math.round(
            mapToDebugRange(targetPos, debugRangeMinRef.current, debugRangeMaxRef.current)
        );
        setDebugBusy(true);
        setDebugLastAction('');
        try {
            await handy.moveToPosition(key, scaledTarget);
            setDebugLastAction(`${Math.round(clampPos(targetPos))}% -> ${scaledTarget}%`);
            setDebugLivePosition(scaledTarget);
        } catch (err) {
            setDebugLastAction(`Error: ${err?.message || 'move failed'}`);
        } finally {
            setDebugBusy(false);
        }
    }, []);

    // â”€â”€ Buttplug Connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleBpConnect = useCallback(async () => {
        const url = bpUrl.trim();
        if (!url) return;
        setBpStatus('connecting');
        setBpError('');
        try {
            await buttplug.connect(url);
        } catch (err) {
            setBpStatus('error');
            setBpError(err.message || 'Connection to Intiface failed');
        }
    }, [bpUrl]);

    const handleBpDisconnect = useCallback(async () => {
        setBpStatus('disconnected');
        isBpConnectedRef.current = false;
        bpWasPlayingRef.current = false;
        try {
            await buttplug.disconnect();
        } catch {
            // ignore forced disconnect errors
        }
        setBpStatus('disconnected');
        setBpError('');
        setBpSyncState('idle');
    }, []);

    const handleBpDeviceTest = useCallback(async (deviceId, percentOrStop) => {
        await buttplug.sendDeviceTest(deviceId, percentOrStop);
    }, []);

    const handleBpDeviceOffsetChange = useCallback((deviceId, value) => {
        buttplug.setDeviceOffset(deviceId, value);
    }, []);

    const handleBpDeviceRangeChange = useCallback((deviceId, min, max) => {
        buttplug.setDeviceRange(deviceId, min, max);
    }, []);

    // â”€â”€ TCode Connect â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const handleTcConnect = useCallback(async () => {
        try {
            setTcStatus('connecting');
            const info = await tcode.connect();
            setTcPortInfo(info);
            setTcStatus('connected');
            isTcConnectedRef.current = true;
        } catch (err) {
            console.error('[TCode] Connection error:', err);
            setTcStatus('disconnected');
            if (err?.name !== 'NotFoundError') {
                // NotFoundError = user cancelled port picker, no need to alert
                alert(`TCode: ${err.message || err}`);
            }
        }
    }, []);

    const handleTcDisconnect = useCallback(async () => {
        try {
            await tcode.disconnect();
        } catch (err) {
            console.error('[TCode] Disconnect error:', err);
        }
        setTcStatus('disconnected');
        setTcPortInfo(null);
        setTcSyncState('idle');
        isTcConnectedRef.current = false;
    }, []);

    // Auto-disconnect when device is physically unplugged
    useEffect(() => {
        tcode.onDeviceDisconnect(() => {
            setTcStatus('disconnected');
            setTcPortInfo(null);
            setTcSyncState('idle');
            isTcConnectedRef.current = false;
        });
    }, []);

    // â”€â”€ Listen for funscript-loaded events from VideoPlayer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    useEffect(() => {
        const handler = async (e) => {
            const actions = e.detail?.actions;
            if (!actions || actions.length < 2) return;
            const videoId = String(e.detail?.videoId || '');
            lastFunscriptActionsRef.current = actions;
            lastFunscriptVideoIdRef.current = videoId;
            lastFunscriptAllDataRef.current = e.detail?.allData || { actions };
            refreshDebugAxisRows(videoId, lastFunscriptAllDataRef.current).catch(() => { });
            if (!scriptSyncEnabledRef.current) return;

            // 1. Handy Sync
            const key = connectedKeyRef.current;
            if (key) {
                setSyncState('uploading');
                try {
                    await handy.prepareSync(key, applyDebugScaleToActions(actions));
                    handyReadyRef.current = true;
                    handyPreparedVideoIdRef.current = videoId;
                    setSyncState('ready');
                    if (isPlaybackActiveRef.current) {
                        await handy.syncPlay(key, Number(lastPlayTimeMsRef.current || 0));
                    }
                    await startHandyIfMpvPlaying(key);
                } catch (err) {
                    console.error('[DevicePanel] Handy Sync prep failed:', err);
                    handyReadyRef.current = false;
                    handyPreparedVideoIdRef.current = '';
                    setSyncState('idle');
                }
            }

            // 2. Buttplug Sync (Local)
            if (isBpConnectedRef.current) {
                // Determine duration for Buttplug (estimation based on last action)
                const durationMs = Number(actions[actions.length - 1]?.at || 0);
                buttplug.prepareSync(actions, durationMs);
                setBpSyncState('ready');
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                if (!(paused === true || paused === 'yes')) {
                    buttplug.syncPlay(Number(lastPlayTimeMsRef.current || 0));
                    isPlaybackActiveRef.current = true;
                    bpWasPlayingRef.current = true;
                }
            }

            // 3. TCode Sync (Web Serial)
            if (isTcConnectedRef.current) {
                tcode.prepareSync(videoId, applyDebugScaleToAllData(e.detail?.allData || { actions }));
                setTcSyncState('ready');
            }
        };
        window.addEventListener('funscript-loaded', handler);
        return () => window.removeEventListener('funscript-loaded', handler);
    }, [applyDebugScaleToActions, applyDebugScaleToAllData, refreshDebugAxisRows, startHandyIfMpvPlaying]);

    // Re-apply current script when stroke range changes, so min/max works live during playback.
    useEffect(() => {
        const key = connectedKeyRef.current;
        if (!key) return undefined;
        if (!scriptSyncEnabledRef.current) return undefined;
        const actions = Array.isArray(lastFunscriptActionsRef.current) ? lastFunscriptActionsRef.current : null;
        if (!actions || actions.length < 2) return undefined;
        const timer = setTimeout(async () => {
            try {
                setSyncState('uploading');
                await handy.prepareSync(key, applyDebugScaleToActions(actions));
                handyReadyRef.current = true;
                setSyncState('ready');
                if (isPlaybackActiveRef.current) {
                    await syncHandyToCurrentMpvTime(key, lastPlayTimeMsRef.current);
                }
                if (isBpConnectedRef.current) {
                    const durationMs = Number(actions[actions.length - 1]?.at || 0);
                    buttplug.prepareSync(actions, durationMs);
                    setBpSyncState('ready');
                    if (isPlaybackActiveRef.current) {
                        buttplug.syncPlay(Number(lastPlayTimeMsRef.current || 0));
                        bpWasPlayingRef.current = true;
                    }
                }
                if (isTcConnectedRef.current && lastFunscriptVideoIdRef.current) {
                    tcode.prepareSync(
                        lastFunscriptVideoIdRef.current,
                        applyDebugScaleToAllData(lastFunscriptAllDataRef.current || { actions })
                    );
                    setTcSyncState('ready');
                    if (isPlaybackActiveRef.current) {
                        tcode.syncSeek(Number(lastPlayTimeMsRef.current || 0));
                    }
                }
            } catch (err) {
                console.warn('[DevicePanel] range reapply failed:', err);
                setSyncState('idle');
            }
        }, 180);
        return () => clearTimeout(timer);
    }, [debugRangeMin, debugRangeMax, applyDebugScaleToActions, applyDebugScaleToAllData, syncHandyToCurrentMpvTime]);

    // â”€â”€ Listen for MPV play/pause/seek â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    useEffect(() => {
        const onScriptToggle = async (e) => {
            const enabled = e?.detail?.enabled !== false;
            const toggleVideoId = String(e?.detail?.videoId || '').trim();
            scriptSyncEnabledRef.current = enabled;
            const timeMs = Math.max(0, Number(e?.detail?.timeMs || lastPlayTimeMsRef.current || 0));
            if (!enabled) {
                isPlaybackActiveRef.current = false;
                clearPlayResyncTimers();
                const k = connectedKeyRef.current;
                if (k) {
                    try { await handy.syncStop(k); } catch { }
                }
                handyReadyRef.current = false;
                handyPreparedVideoIdRef.current = '';
                if (isBpConnectedRef.current) {
                    try { await buttplug.syncStop(); } catch { }
                    bpWasPlayingRef.current = false;
                }
                if (isTcConnectedRef.current) {
                    try { tcode.syncPause(); } catch { }
                }
                return;
            }

            const k = connectedKeyRef.current;
            if (k) {
                const prepared = await ensureHandyPreparedForVideo(k, toggleVideoId || String(lastFunscriptVideoIdRef.current || ''));
                if (prepared) {
                    const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                    if (!(paused === true || paused === 'yes')) {
                        try {
                            await syncHandyToCurrentMpvTime(k, timeMs);
                            isPlaybackActiveRef.current = true;
                        } catch { }
                    }
                }
            }

            if (isBpConnectedRef.current && Array.isArray(lastFunscriptActionsRef.current) && lastFunscriptActionsRef.current.length > 1) {
                const actions = lastFunscriptActionsRef.current;
                const durationMs = Number(actions[actions.length - 1]?.at || 0);
                buttplug.prepareSync(actions, durationMs);
                setBpSyncState('ready');
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                if (!(paused === true || paused === 'yes')) {
                    buttplug.syncPlay(timeMs);
                    bpWasPlayingRef.current = true;
                }
            }

            if (isTcConnectedRef.current && lastFunscriptVideoIdRef.current) {
                tcode.prepareSync(
                    lastFunscriptVideoIdRef.current,
                    applyDebugScaleToAllData(lastFunscriptAllDataRef.current || { actions: lastFunscriptActionsRef.current || [] })
                );
                setTcSyncState('ready');
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                if (!(paused === true || paused === 'yes')) {
                    tcode.syncPlay(timeMs);
                }
            }
        };

        const key = () => connectedKeyRef.current;

        const onPlay = async (e) => {
            if (!scriptSyncEnabledRef.current) return;
            const timeMs = e.detail?.timeMs ?? 0;
            lastPlayTimeMsRef.current = Number(timeMs || 0);
            isPlaybackActiveRef.current = true;
            clearPlayResyncTimers();
            // Handy
            const k = key();
            if (k) {
                const prepared = await ensureHandyPreparedForVideo(k, String(e.detail?.videoId || ''));
                if (prepared) {
                    try {
                        await syncHandyToCurrentMpvTime(k, timeMs);
                        // Stabilize resume-start by re-syncing shortly after play.
                        playResyncTimersRef.current.push(setTimeout(() => {
                            if (!isPlaybackActiveRef.current) return;
                            syncHandyToCurrentMpvTime(k, lastPlayTimeMsRef.current).catch(() => { });
                        }, 700));
                        playResyncTimersRef.current.push(setTimeout(() => {
                            if (!isPlaybackActiveRef.current) return;
                            syncHandyToCurrentMpvTime(k, lastPlayTimeMsRef.current).catch(() => { });
                        }, 1700));
                    }
                    catch (err) { console.warn('[Handy] play sync error:', err); }
                }
            }
            // Buttplug
            if (isBpConnectedRef.current) {
                if (bpSyncState !== 'ready' && Array.isArray(lastFunscriptActionsRef.current) && lastFunscriptActionsRef.current.length > 1) {
                    const actions = lastFunscriptActionsRef.current;
                    const durationMs = Number(actions[actions.length - 1]?.at || 0);
                    buttplug.prepareSync(actions, durationMs);
                    setBpSyncState('ready');
                }
                buttplug.syncPlay(timeMs);
                bpWasPlayingRef.current = true;
            }
            // TCode
            if (isTcConnectedRef.current) {
                tcode.syncPlay(timeMs);
            }
        };

        const onPause = async () => {
            if (!scriptSyncEnabledRef.current) return;
            isPlaybackActiveRef.current = false;
            clearPlayResyncTimers();
            // Handy
            const k = key();
            if (k) {
                try { await handy.syncStop(k); }
                catch (err) { console.warn('[Handy] pause sync error:', err); }
            }
            // Buttplug
            if (isBpConnectedRef.current) {
                buttplug.syncStop();
                bpWasPlayingRef.current = false;
            }
            // TCode
            if (isTcConnectedRef.current) {
                tcode.syncPause();
            }
        };

        const onSeek = async (e) => {
            if (!scriptSyncEnabledRef.current) return;
            const timeMs = e.detail?.timeMs ?? 0;
            lastPlayTimeMsRef.current = Number(timeMs || 0);
            clearPlayResyncTimers();
            // Handy
            const k = key();
            if (k && handyReadyRef.current) {
                try {
                    await handy.syncStop(k);
                    await syncHandyToCurrentMpvTime(k, timeMs);
                }
                catch (err) { console.warn('[Handy] seek sync error:', err); }
            } else if (k) {
                const prepared = await ensureHandyPreparedForVideo(k, String(e.detail?.videoId || ''));
                if (prepared) {
                    try { await syncHandyToCurrentMpvTime(k, timeMs); } catch { }
                }
            }
            // Buttplug
            if (isBpConnectedRef.current) {
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                const isPlayingNow = !(paused === true || paused === 'yes');
                buttplug.syncSeek(timeMs, isPlayingNow);
                bpWasPlayingRef.current = isPlayingNow;
            }
            // TCode
            if (isTcConnectedRef.current) {
                tcode.syncSeek(timeMs);
            }
        };

        window.addEventListener('mpv-handy-play', onPlay);
        window.addEventListener('mpv-handy-pause', onPause);
        window.addEventListener('mpv-handy-seek', onSeek);
        window.addEventListener('mpv-script-toggle', onScriptToggle);
        return () => {
            window.removeEventListener('mpv-handy-play', onPlay);
            window.removeEventListener('mpv-handy-pause', onPause);
            window.removeEventListener('mpv-handy-seek', onSeek);
            window.removeEventListener('mpv-script-toggle', onScriptToggle);
        };
    }, [applyDebugScaleToActions, applyDebugScaleToAllData, clearPlayResyncTimers, ensureHandyPreparedForVideo, syncHandyToCurrentMpvTime]);

    // Pause watchdog + periodic drift correction for Intiface.
    // Every 3s: enforce stop while paused, and re-sync clock to real MPV time while playing.
    useEffect(() => {
        const timer = setInterval(async () => {
            if (!isBpConnectedRef.current || !scriptSyncEnabledRef.current) return;
            try {
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                if (paused === true || paused === 'yes') {
                    if (bpWasPlayingRef.current) {
                        buttplug.syncStop();
                        bpWasPlayingRef.current = false;
                    }
                    return;
                }
                // Drift correction: read real MPV time and recalibrate
                if (bpWasPlayingRef.current) {
                    const timePos = await window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null);
                    const realMs = Math.max(0, Number(timePos || 0) * 1000);
                    if (Number.isFinite(realMs) && realMs > 0) {
                        buttplug.syncRebase(realMs);
                    }
                }
            } catch {
                // ignore watchdog errors
            }
        }, 3000);
        return () => clearInterval(timer);
    }, []);

    // Live debug position (estimated from active script + current playback time).
    useEffect(() => {
        let cancelled = false;
        const tick = async () => {
            if (cancelled) return;
            if (status !== 'connected') {
                setDebugLivePosition(null);
                setDebugLiveAxisPositions({});
                return;
            }
            const actions = Array.isArray(lastFunscriptActionsRef.current) ? lastFunscriptActionsRef.current : null;
            if (!actions || actions.length < 2 || !scriptSyncEnabledRef.current || !handyReadyRef.current) return;
            const timePos = await window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null);
            const timeMs = Math.max(0, Number(timePos || 0) * 1000);
            const scaled = applyDebugScaleToActions(actions);
            const pos = estimatePositionAtTime(scaled, timeMs);
            if (!cancelled && Number.isFinite(pos)) setDebugLivePosition(Math.round(pos));

            const raw = (lastFunscriptAllDataRef.current && typeof lastFunscriptAllDataRef.current === 'object')
                ? lastFunscriptAllDataRef.current
                : { actions };
            const axisEntries = [
                { axis: 'main', actions: Array.isArray(raw.actions) ? raw.actions : Array.isArray(raw.main) ? raw.main : [] },
                { axis: 'roll', actions: Array.isArray(raw.roll) ? raw.roll : [] },
                { axis: 'twist', actions: Array.isArray(raw.twist) ? raw.twist : [] },
                { axis: 'surge', actions: Array.isArray(raw.surge) ? raw.surge : [] },
                { axis: 'sway', actions: Array.isArray(raw.sway) ? raw.sway : [] },
                { axis: 'pitch', actions: Array.isArray(raw.pitch) ? raw.pitch : [] },
            ];
            const liveByAxis = {};
            for (const entry of axisEntries) {
                if (!Array.isArray(entry.actions) || entry.actions.length < 2) continue;
                const scaledAxis = applyDebugScaleToActions(entry.actions);
                const axisPos = estimatePositionAtTime(scaledAxis, timeMs);
                if (Number.isFinite(axisPos)) liveByAxis[entry.axis] = Math.round(axisPos);
            }
            if (!cancelled) setDebugLiveAxisPositions(liveByAxis);
        };
        const timer = setInterval(() => {
            tick().catch(() => { });
        }, 250);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [status, applyDebugScaleToActions]);

    // Periodic re-sync while playing to reduce drift.
    useEffect(() => {
        const timer = setInterval(async () => {
            const k = connectedKeyRef.current;
            if (!k || !scriptSyncEnabledRef.current || !isPlaybackActiveRef.current || !handyReadyRef.current) return;
            try {
                const paused = await window.electronAPI?.mpvGetProperty?.('pause').catch(() => null);
                if (paused === true || paused === 'yes') return;
                const timePos = await window.electronAPI?.mpvGetProperty?.('time-pos').catch(() => null);
                const timeMs = Math.max(0, Number(timePos || 0) * 1000);
                await handy.syncPlay(k, Number.isFinite(timeMs) ? timeMs : 0);
            } catch (err) {
                console.warn('[Handy] periodic sync error:', err);
                forceHandyDisconnected();
            }
        }, 9000);
        return () => clearInterval(timer);
    }, [forceHandyDisconnected]);

    // â”€â”€ Reset sync state when video stops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    useEffect(() => {
        const handler = () => {
            isPlaybackActiveRef.current = false;
            clearPlayResyncTimers();
            lastPlayTimeMsRef.current = 0;
            handyReadyRef.current = false;
            handyPreparedVideoIdRef.current = '';
            setSyncState('idle');
            setBpSyncState('idle');
            setTcSyncState('idle');
            const k = connectedKeyRef.current;
            if (k) {
                handy.syncStop(k).catch(() => { });
            }
            if (isBpConnectedRef.current) {
                buttplug.syncStop();
                bpWasPlayingRef.current = false;
            }
            if (isTcConnectedRef.current) tcode.stopSync();
        };
        window.addEventListener('mpv-handy-stop', handler);
        return () => window.removeEventListener('mpv-handy-stop', handler);
    }, [clearPlayResyncTimers]);

    // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return (
        <>
            <div className={`device-panel-backdrop ${open ? 'open' : ''}`} onClick={onClose} />
            <aside className={`device-panel ${open ? 'open' : ''}`}>
                {/* Header */}
                <div className="device-panel-header">
                    <h2>
                        <svg
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                        >
                            <rect x="9.5" y="4" width="5" height="14" rx="2.5" />
                            <rect x="10" y="18" width="4" height="3" rx="0.4" />
                            <path d="M5.1 7a8.2 8.2 0 0 0 0 10" />
                            <path d="M7.2 9a5.2 5.2 0 0 0 0 6" />
                            <path d="M18.9 7a8.2 8.2 0 0 1 0 10" />
                            <path d="M16.8 9a5.2 5.2 0 0 1 0 6" />
                        </svg>
                        {t('devicePanel', 'GerÃ¤te')}
                    </h2>
                    <button className="device-panel-close" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>
                {/* Tab bar */}
                <div className="device-tab-bar">
                    {TABS.map((tab) => {
                        const disabled = DISABLED_TABS.has(tab);
                        return (
                        <button
                            key={tab}
                            className={`device-tab-btn ${activeTab === tab ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                            onClick={() => { if (!disabled) setActiveTab(tab); }}
                            disabled={disabled}
                        >
                            {tab === 'thehandy' && t('deviceTheHandy', 'TheHandy')}
                            {tab === 'tcode' && t('deviceTCode', 'TCode')}
                            {tab === 'buttplug' && t('deviceButtplug', 'Initface')}
                        </button>
                        );
                    })}
                </div>

                {/* Tab content */}
                <div className="device-tab-content">
                    {activeTab === 'thehandy' && (
                        <TheHandyTab
                            connectionKey={connectionKey}
                            onKeyChange={setConnectionKey}
                            status={status}
                            deviceInfo={deviceInfo}
                            errorMsg={errorMsg}
                            offset={offset}
                            onOffsetChange={handleOffsetChange}
                            syncState={syncState}
                            debugEnabled={debugEnabled}
                            onDebugEnabledChange={setDebugEnabled}
                            debugRangeMin={debugRangeMin}
                            onDebugRangeMinChange={setDebugRangeMin}
                            debugRangeMax={debugRangeMax}
                            onDebugRangeMaxChange={setDebugRangeMax}
                            debugAxisRows={debugAxisRows}
                            debugScriptVideo={debugScriptVideo}
                            debugLastAction={debugLastAction}
                            debugLivePosition={debugLivePosition}
                            debugLiveAxisPositions={debugLiveAxisPositions}
                            debugBusy={debugBusy}
                            onDebugMoveTo={handleDebugMoveTo}
                            onConnect={handleConnect}
                            onDisconnect={handleDisconnect}
                            t={t}
                        />
                    )}

                    {activeTab === 'buttplug' && (
                        <ButtplugTab
                            url={bpUrl}
                            onUrlChange={setBpUrl}
                            status={bpStatus}
                            errorMsg={bpError}
                            devices={bpDevices}
                            selectedDeviceId={bpSelectedDeviceId}
                            onSelectedDeviceChange={setBpSelectedDeviceId}
                            outputMode={bpOutputMode}
                            onOutputModeChange={setBpOutputMode}
                            invertScript={bpInvertScript}
                            onInvertScriptChange={setBpInvertScript}
                            commandMonitor={bpCommandMonitor}
                            syncState={bpSyncState}
                            onConnect={handleBpConnect}
                            onDisconnect={handleBpDisconnect}
                            onScan={buttplug.startScanning}
                            onDeviceTest={handleBpDeviceTest}
                            onDeviceOffsetChange={handleBpDeviceOffsetChange}
                            onDeviceRangeChange={handleBpDeviceRangeChange}
                            t={t}
                        />
                    )}

                    {activeTab === 'tcode' && (
                        <TCodeTab
                            status={tcStatus}
                            portInfo={tcPortInfo}
                            syncState={tcSyncState}
                            expandedAxes={tcExpandedAxes}
                            setExpandedAxes={setTcExpandedAxes}
                            onConnect={handleTcConnect}
                            onDisconnect={handleTcDisconnect}
                            t={t}
                        />
                    )}
                </div>
            </aside>
        </>
    );
}

// â”€â”€ TheHandy tab content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function TheHandyTab({
    connectionKey, onKeyChange, status, deviceInfo, errorMsg,
    offset, onOffsetChange, syncState,
    debugEnabled, onDebugEnabledChange, debugRangeMin, onDebugRangeMinChange, debugRangeMax, onDebugRangeMaxChange,
    debugAxisRows, debugScriptVideo, debugLastAction, debugLivePosition, debugLiveAxisPositions, debugBusy, onDebugMoveTo,
    onConnect, onDisconnect, t
}) {
    const dualTrackRef = useRef(null);
    const dualDragRef = useRef(null);
    const dualCleanupRef = useRef(null);
    const isConnected = status === 'connected';
    const isConnecting = status === 'connecting';
    const rangeMin = Math.max(0, Math.min(100, Number(debugRangeMin) || 0));
    const rangeMax = Math.max(0, Math.min(100, Number(debugRangeMax) || 100));
    const low = Math.min(rangeMin, rangeMax);
    const high = Math.max(rangeMin, rangeMax);
    const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const pickThumb = (pct) => {
        const dMin = Math.abs(pct - rangeMin);
        const dMax = Math.abs(pct - rangeMax);
        return dMin <= dMax ? 'min' : 'max';
    };
    const setFromClientX = (clientX, thumb) => {
        const el = dualTrackRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const rawPct = ((clientX - rect.left) / rect.width) * 100;
        const pct = clampPct(rawPct);
        if (thumb === 'min') onDebugRangeMinChange(Math.min(pct, rangeMax));
        else onDebugRangeMaxChange(Math.max(pct, rangeMin));
    };
    const startDualDrag = (thumb, e) => {
        e.preventDefault();
        try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { }
        dualDragRef.current = thumb;
        setFromClientX(e.clientX, thumb);
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
        const onMove = (ev) => {
            if (!dualDragRef.current) return;
            setFromClientX(ev.clientX, dualDragRef.current);
        };
        const onUp = () => {
            dualDragRef.current = null;
            if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
        dualCleanupRef.current = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            dualCleanupRef.current = null;
        };
    };
    const onDualPointerMove = (e) => {
        if (!dualDragRef.current) return;
        setFromClientX(e.clientX, dualDragRef.current);
    };
    const stopDualDrag = () => {
        dualDragRef.current = null;
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
    };
    const onDualTrackPointerDown = (e) => {
        const el = dualTrackRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const rawPct = ((e.clientX - rect.left) / rect.width) * 100;
        const pct = clampPct(rawPct);
        const thumb = pickThumb(pct);
        startDualDrag(thumb, e);
    };
    useEffect(() => () => {
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
    }, []);

    return (
        <>
            <div className="handy-section">
                <div className="handy-section-title">{t('deviceConnectionKey', 'Connection Key')}</div>
                <div className="handy-key-group">
                    <input
                        type="text"
                        className="handy-key-input"
                        placeholder={t('deviceKeyPlaceholder', 'z.B. a1b2c3d4e5')}
                        value={connectionKey}
                        onChange={(e) => onKeyChange(e.target.value)}
                        disabled={isConnected || isConnecting}
                        spellCheck={false}
                    />
                    {!isConnected ? (
                        <button
                            className="handy-connect-btn connect"
                            onClick={onConnect}
                            disabled={!connectionKey.trim() || isConnecting}
                        >
                            {isConnecting ? '...' : t('deviceConnect', 'Verbinden')}
                        </button>
                    ) : (
                        <button
                            className="handy-connect-btn disconnect"
                            onClick={onDisconnect}
                        >
                            {t('deviceDisconnect', 'Trennen')}
                        </button>
                    )}
                </div>
            </div>

            <div className="handy-section">
                <div className="handy-section-title">{t('status', 'Status')}</div>
                <div className="handy-status-card">
                    <div className={`handy-status-dot ${status}`} />
                    <div className="handy-status-info">
                        <div className="handy-status-label">
                            {status === 'connected' && t('deviceConnected', 'Verbunden')}
                            {status === 'connecting' && t('deviceConnecting', 'Verbinde...')}
                            {status === 'disconnected' && t('deviceDisconnected', 'Nicht verbunden')}
                            {status === 'error' && t('deviceError', 'Fehler')}
                        </div>
                        {isConnected && deviceInfo && (
                            <div className="handy-status-detail">
                                {t('deviceFirmware', 'Firmware')}: {deviceInfo.fwVersion || '?'}
                                {deviceInfo.model ? ` Â· ${deviceInfo.model}` : ''}
                            </div>
                        )}
                    </div>
                </div>
                {errorMsg && <div className="handy-error" style={{ marginTop: 10 }}>{errorMsg}</div>}
            </div>

            {isConnected && (
                <div className="handy-section">
                    <div className="handy-section-title">{t('deviceOffset', 'Offset (Sync)')}</div>
                    <div className="handy-offset-group">
                        <div className="handy-offset-header">
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>-500ms</span>
                            <span className="handy-offset-value">{offset > 0 ? '+' : ''}{offset}ms</span>
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>+500ms</span>
                        </div>
                        <input
                            type="range"
                            className="handy-offset-slider"
                            min={-500}
                            max={500}
                            step={10}
                            value={offset}
                            onChange={(e) => onOffsetChange(Number(e.target.value))}
                        />
                    </div>
                    <div className="device-debug-row" style={{ marginTop: '18px' }}>
                        <div className="handy-section-title" style={{ marginBottom: 0 }}>
                            {t('deviceDebugMinMax', 'Stroke Min/Max')}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: 'var(--text-secondary, #9ca3af)' }}>
                            <span>Min {low}%</span>
                            <span>Max {high}%</span>
                        </div>
                        <div
                            style={{ position: 'relative', height: 16, overflow: 'visible' }}
                            onPointerMove={onDualPointerMove}
                            onPointerUp={stopDualDrag}
                            onPointerCancel={stopDualDrag}
                        >
                            <div
                                aria-hidden="true"
                                ref={dualTrackRef}
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    top: '50%',
                                    transform: 'translateY(-50%)',
                                    height: 4,
                                    borderRadius: 2,
                                    background: 'rgba(255, 255, 255, 0.85)',
                                    border: '1px solid rgba(0, 0, 0, 0.12)',
                                    boxSizing: 'border-box',
                                    pointerEvents: 'none',
                                    zIndex: 1,
                                }}
                            />
                            <div
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    left: `${low}%`,
                                    width: `${high - low}%`,
                                    top: '50%',
                                    transform: 'translateY(-50%)',
                                    height: 4,
                                    borderRadius: 2,
                                    background: 'var(--accent-primary, #a855f7)',
                                    pointerEvents: 'none',
                                    zIndex: 2,
                                }}
                            />
                            <div
                                role="slider"
                                aria-label="Stroke min"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={rangeMin}
                                style={{
                                    position: 'absolute',
                                    left: `${rangeMin}%`,
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: 16,
                                    height: 16,
                                    borderRadius: '50%',
                                    background: 'var(--accent-primary, #a855f7)',
                                    boxShadow: '0 0 6px rgba(168, 85, 247, 0.4)',
                                    cursor: 'pointer',
                                    zIndex: 3,
                                }}
                                onPointerDown={(e) => startDualDrag('min', e)}
                            />
                            <div
                                role="slider"
                                aria-label="Stroke max"
                                aria-valuemin={0}
                                aria-valuemax={100}
                                aria-valuenow={rangeMax}
                                style={{
                                    position: 'absolute',
                                    left: `${rangeMax}%`,
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: 16,
                                    height: 16,
                                    borderRadius: '50%',
                                    background: 'var(--accent-primary, #a855f7)',
                                    boxShadow: '0 0 6px rgba(168, 85, 247, 0.4)',
                                    cursor: 'pointer',
                                    zIndex: 3,
                                }}
                                onPointerDown={(e) => startDualDrag('max', e)}
                            />
                            <div
                                aria-hidden="true"
                                style={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    top: '50%',
                                    transform: 'translateY(-50%)',
                                    height: 16,
                                    cursor: 'pointer',
                                    zIndex: 2,
                                }}
                                onPointerDown={onDualTrackPointerDown}
                            />
                        </div>
                    </div>
                </div>
            )}

            {isConnected && (
                <div className="handy-section">
                    <div className="handy-section-header">
                        <div className="handy-section-title" style={{ marginBottom: 0 }}>
                            {t('deviceDebugMode', 'Device Debug Mode')}
                        </div>
                        <label className="device-debug-toggle" style={{ marginTop: 6 }}>
                            <input
                                type="checkbox"
                                checked={!!debugEnabled}
                                onChange={(e) => onDebugEnabledChange(!!e.target.checked)}
                            />
                            <span>{debugEnabled ? t('enabled', 'Enabled') : t('disabled', 'Disabled')}</span>
                        </label>
                    </div>

                    {debugEnabled && (
                        <div className="device-debug-card">
                            <div className="device-debug-row">
                                <div className="device-debug-label">{t('deviceDebugSetPosition', 'Set Position')}</div>
                                <div className="device-debug-btns">
                                    {[0, 50, 100].map((p) => (
                                        <button
                                            key={p}
                                            className="handy-connect-btn"
                                            onClick={() => onDebugMoveTo(p)}
                                            disabled={debugBusy}
                                        >
                                            {p}%
                                        </button>
                                    ))}
                                </div>
                                {Number.isFinite(debugLivePosition) ? (
                                    <div className="device-debug-last">
                                        {t('deviceDebugLivePosition', 'Live device position')}: <span className="device-debug-live-value">{debugLivePosition}%</span>
                                    </div>
                                ) : null}
                            </div>

                            <div className="device-debug-row">
                                <div className="device-debug-label">
                                    {t('deviceDebugLoadedScript', 'Loaded Script Axes')}
                                    {debugScriptVideo ? ` (${debugScriptVideo})` : ''}
                                </div>
                                {debugAxisRows?.length ? (
                                    <div className="device-debug-axis-list">
                                        {debugAxisRows.map((row) => (
                                            <div key={row.axis} className="device-debug-axis-row">
                                                <div className="device-debug-axis-top">
                                                    <strong>{String(row.axis || '').toUpperCase()}</strong>
                                                    <span>{row.actions} actions</span>
                                                </div>
                                                {row.scriptFile ? (
                                                    <div className="device-debug-script" title={row.scriptPath || ''}>
                                                        {row.scriptFile}
                                                    </div>
                                                ) : (
                                                    <div className="device-debug-script muted">No mapped file</div>
                                                )}
                                                <div className="device-debug-axis-meta">
                                                    {row.durationSec}s | {row.min}-{row.max}
                                                    {Number.isFinite(debugLiveAxisPositions?.[row.axis])
                                                        ? ` | ${t('deviceDebugLivePosition', 'Live device position')}: `
                                                        : ''}
                                                    {Number.isFinite(debugLiveAxisPositions?.[row.axis]) ? (
                                                        <span className="device-debug-live-value">{debugLiveAxisPositions[row.axis]}%</span>
                                                    ) : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="device-debug-script muted">
                                        {t('deviceNoFunscript', 'Waiting for funscript...')}
                                    </div>
                                )}
                            </div>
                            {debugLastAction ? <div className="device-debug-last">{debugLastAction}</div> : null}
                        </div>
                    )}
                </div>
            )}

        </>
    );
}

function DualRangeSlider({ minValue, maxValue, onChange }) {
    const dualTrackRef = useRef(null);
    const dualDragRef = useRef(null);
    const dualCleanupRef = useRef(null);
    const rangeMin = Math.max(0, Math.min(100, Number(minValue) || 0));
    const rangeMax = Math.max(0, Math.min(100, Number(maxValue) || 100));
    const low = Math.min(rangeMin, rangeMax);
    const high = Math.max(rangeMin, rangeMax);
    const clampPct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    const pickThumb = (pct) => {
        const dMin = Math.abs(pct - rangeMin);
        const dMax = Math.abs(pct - rangeMax);
        return dMin <= dMax ? 'min' : 'max';
    };
    const setFromClientX = (clientX, thumb) => {
        const el = dualTrackRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const rawPct = ((clientX - rect.left) / rect.width) * 100;
        const pct = clampPct(rawPct);
        if (thumb === 'min') onChange(Math.min(pct, rangeMax), rangeMax);
        else onChange(rangeMin, Math.max(pct, rangeMin));
    };
    const startDualDrag = (thumb, e) => {
        e.preventDefault();
        try { e.currentTarget?.setPointerCapture?.(e.pointerId); } catch { }
        dualDragRef.current = thumb;
        setFromClientX(e.clientX, thumb);
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
        const onMove = (ev) => {
            if (!dualDragRef.current) return;
            setFromClientX(ev.clientX, dualDragRef.current);
        };
        const onUp = () => {
            dualDragRef.current = null;
            if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
        dualCleanupRef.current = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            dualCleanupRef.current = null;
        };
    };
    const onDualPointerMove = (e) => {
        if (!dualDragRef.current) return;
        setFromClientX(e.clientX, dualDragRef.current);
    };
    const stopDualDrag = () => {
        dualDragRef.current = null;
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
    };
    const onDualTrackPointerDown = (e) => {
        const el = dualTrackRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;
        const rawPct = ((e.clientX - rect.left) / rect.width) * 100;
        const pct = clampPct(rawPct);
        const thumb = pickThumb(pct);
        startDualDrag(thumb, e);
    };
    useEffect(() => () => {
        if (typeof dualCleanupRef.current === 'function') dualCleanupRef.current();
    }, []);

    return (
        <div
            style={{ position: 'relative', height: 16, overflow: 'visible' }}
            onPointerMove={onDualPointerMove}
            onPointerUp={stopDualDrag}
            onPointerCancel={stopDualDrag}
        >
            <div
                aria-hidden="true"
                ref={dualTrackRef}
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    height: 4,
                    borderRadius: 2,
                    background: 'rgba(255, 255, 255, 0.85)',
                    border: '1px solid rgba(0, 0, 0, 0.12)',
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                    zIndex: 1,
                }}
            />
            <div
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    left: `${low}%`,
                    width: `${high - low}%`,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    height: 4,
                    borderRadius: 2,
                    background: 'var(--accent-primary, #a855f7)',
                    pointerEvents: 'none',
                    zIndex: 2,
                }}
            />
            <div
                role="slider"
                aria-label="Min"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={rangeMin}
                style={{
                    position: 'absolute',
                    left: `${rangeMin}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--accent-primary, #a855f7)',
                    boxShadow: '0 0 6px rgba(168, 85, 247, 0.4)',
                    cursor: 'pointer',
                    zIndex: 3,
                }}
                onPointerDown={(e) => startDualDrag('min', e)}
            />
            <div
                role="slider"
                aria-label="Max"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={rangeMax}
                style={{
                    position: 'absolute',
                    left: `${rangeMax}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: 'var(--accent-primary, #a855f7)',
                    boxShadow: '0 0 6px rgba(168, 85, 247, 0.4)',
                    cursor: 'pointer',
                    zIndex: 3,
                }}
                onPointerDown={(e) => startDualDrag('max', e)}
            />
            <div
                aria-hidden="true"
                style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    height: 16,
                    cursor: 'pointer',
                    zIndex: 2,
                }}
                onPointerDown={onDualTrackPointerDown}
            />
        </div>
    );
}

// â”€â”€ Buttplug tab content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ButtplugTab({
    url, onUrlChange, status, errorMsg, devices,
    selectedDeviceId, onSelectedDeviceChange,
    outputMode, onOutputModeChange,
    invertScript, onInvertScriptChange,
    commandMonitor,
    syncState, onConnect, onDisconnect, onScan,
    onDeviceTest, onDeviceOffsetChange, onDeviceRangeChange,
    t
}) {
    const isConnected = status === 'connected';
    const isConnecting = status === 'connecting';
    const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
    const selectedDevice =
        selectedDeviceId === null || selectedDeviceId === undefined
            ? null
            : (devices || []).find((d) => Number(d.id) === Number(selectedDeviceId)) || null;
    const modeLabel =
        outputMode === 'linear'
            ? t('bpModeLinear', 'Linear only')
            : outputMode === 'vibrate'
                ? t('bpModeVibrate', 'Vibrate only')
                : t('bpModeAuto', 'Auto (Linear, fallback Vibrate)');

    return (
        <>
            <div className="handy-section">
                <div className="handy-section-title">{t('bpIntifaceUrl', 'Intiface Central URL')}</div>
                <div className="handy-key-group">
                    <input
                        type="text"
                        className="handy-key-input"
                        placeholder="ws://127.0.0.1:12345"
                        value={url}
                        onChange={(e) => onUrlChange(e.target.value)}
                        disabled={isConnected || isConnecting}
                        spellCheck={false}
                    />
                    {!isConnected ? (
                        <button
                            className="handy-connect-btn connect"
                            onClick={onConnect}
                            disabled={!url.trim() || isConnecting}
                        >
                            {isConnecting ? '...' : t('deviceConnect', 'Verbinden')}
                        </button>
                    ) : (
                        <button
                            className="handy-connect-btn disconnect"
                            onClick={onDisconnect}
                        >
                            {t('deviceDisconnect', 'Trennen')}
                        </button>
                    )}
                </div>
            </div>

            <div className="handy-section">
                <div className="handy-section-title">{t('bpOutputMode', 'Output mode')}</div>
                <div className="handy-key-group" style={{ marginBottom: 10 }}>
                    <AppDropdown
                        value={String(outputMode || 'auto')}
                        onChange={(val) => onOutputModeChange(val)}
                        options={[
                            { value: 'auto', label: t('bpModeAuto', 'Auto (Linear, fallback Vibrate)') },
                            { value: 'linear', label: t('bpModeLinear', 'Linear only') },
                            { value: 'vibrate', label: t('bpModeVibrate', 'Vibrate only') },
                        ]}
                        className="settings-playback-select"
                    />
                </div>
                <div className="handy-key-group" style={{ marginBottom: 10 }}>
                    <label className="device-debug-toggle">
                        <input
                            type="checkbox"
                            checked={!!invertScript}
                            onChange={(e) => onInvertScriptChange(e.target.checked)}
                        />
                        {t('bpInvertScript', 'Script invertieren')}
                    </label>
                </div>
                <div className="handy-section-title">{t('bpTargetDevice', 'Target device')}</div>
                <div className="handy-key-group">
                    <AppDropdown
                        value={selectedDeviceId === null || selectedDeviceId === undefined ? 'all' : String(selectedDeviceId)}
                        onChange={(val) => onSelectedDeviceChange(val === 'all' ? null : Number(val))}
                        options={[
                            { value: 'all', label: t('bpAllDevices', 'All connected devices') },
                            ...(devices || []).map((d) => ({
                                value: String(d.id),
                                label: `${d.name}${d.hasLinear ? (d.oscillateOnly ? ' · Oscillate' : ' · Linear') : d.hasVibrate ? ' · Vibrate' : ''}`,
                            })),
                        ]}
                        className="settings-playback-select"
                    />
                </div>
                {isConnected ? (
                    <div className="handy-status-card" style={{ marginTop: 10 }}>
                        <div className="handy-status-info">
                            <div className="handy-status-label">
                                {t('bpActiveTarget', 'Active target')}: {selectedDevice ? selectedDevice.name : t('bpAllDevices', 'All connected devices')}
                            </div>
                            <div className="handy-status-detail">
                                {t('bpActiveMode', 'Active mode')}: {modeLabel}
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>

            <div className="handy-section">
                <div className="handy-section-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 10 }}>
                    <div className="handy-section-title" style={{ margin: 0 }}>{t('bpDevices', 'Lokale GerÃ¤te')}</div>
                    {isConnected && (
                        <button onClick={onScan} className="bp-scan-btn">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12" style={{ marginRight: 4 }}>
                                <circle cx="11" cy="11" r="8" />
                                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                            {t('bpScan', 'Scan')}
                        </button>
                    )}
                </div>

                {!isConnected ? (
                    <div className="handy-status-card">
                        <div className={`handy-status-dot ${status}`} />
                        <div className="handy-status-info">
                            <div className="handy-status-label">
                                {status === 'connecting' && t('deviceConnecting', 'Verbinde...')}
                                {status === 'disconnected' && t('deviceDisconnected', 'Nicht verbunden')}
                                {status === 'error' && t('deviceError', 'Fehler')}
                            </div>
                        </div>
                    </div>
                ) : devices.length === 0 ? (
                    <div className="handy-status-card">
                        <div className="handy-status-info">
                            <div className="handy-status-label" style={{ color: 'var(--text-secondary)' }}>
                                {t('bpNoDevices', 'Keine GerÃ¤te gefunden (Bluetooth scannt...)')}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {devices.map(d => (
                            <div key={d.id} className="handy-status-card">
                                <div className="handy-status-dot connected" />
                                <div className="handy-status-info">
                                    <div className="handy-status-label">{d.name}</div>
                                    <div className="handy-status-detail">
                                        {d.hasLinear
                                            ? (d.oscillateOnly ? t('bpOscillateMotor', 'Oscillate stroker') : t('bpLinearMotor', 'Linear motor'))
                                            : (d.hasVibrate ? t('bpVibration', 'Vibration') : t('bpUnknown', 'Unknown'))}
                                    </div>
                                    <div className="bp-device-controls">
                                        <div className="bp-device-row">
                                            <span className="bp-device-label">{t('bpTest', 'Test')}</span>
                                            <div className="bp-test-buttons">
                                                <button type="button" className="bp-test-btn stop" onClick={() => onDeviceTest(d.id, null)}>
                                                    {t('bpStop', 'Stop')}
                                                </button>
                                                {[20, 50, 80, 100].map((p) => (
                                                    <button
                                                        key={p}
                                                        type="button"
                                                        className="bp-test-btn"
                                                        onClick={() => onDeviceTest(d.id, p)}
                                                    >
                                                        {p}%
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="bp-slider-block">
                                            <div className="bp-slider-head">
                                                <span className="bp-device-label">{t('bpRange', 'Range')}</span>
                                                <span className="bp-slider-values">
                                                    Min {Math.round(clamp(d?.config?.min ?? 0, 0, 100))}% · Max {Math.round(clamp(d?.config?.max ?? 100, 0, 100))}%
                                                </span>
                                            </div>
                                            <DualRangeSlider
                                                minValue={Math.round(clamp(d?.config?.min ?? 0, 0, 100))}
                                                maxValue={Math.round(clamp(d?.config?.max ?? 100, 0, 100))}
                                                onChange={(nextMin, nextMax) => onDeviceRangeChange(d.id, nextMin, nextMax)}
                                            />
                                        </div>
                                        <div className="bp-slider-block">
                                            <div className="bp-slider-head">
                                                <span className="bp-device-label">{t('bpOffset', 'Offset')}</span>
                                                <span className="bp-slider-values">{Math.round(clamp(d?.config?.offset ?? 0, -100, 100))}%</span>
                                            </div>
                                            <input
                                                type="range"
                                                className="handy-offset-slider"
                                                min={-100}
                                                max={100}
                                                step={1}
                                                value={Math.round(clamp(d?.config?.offset ?? 0, -100, 100))}
                                                onChange={(e) => onDeviceOffsetChange(d.id, clamp(e.target.value, -100, 100))}
                                            />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
                {errorMsg && <div className="handy-error" style={{ marginTop: 10 }}>{errorMsg}</div>}
            </div>

            {isConnected && (
                <div className="handy-section">
                    <div className="handy-section-title">{t('bpLiveMonitor', 'Live command monitor')}</div>
                    {!Array.isArray(commandMonitor) || commandMonitor.length === 0 ? (
                        <div className="handy-status-card">
                            <div className="handy-status-info">
                                <div className="handy-status-label" style={{ color: 'var(--text-secondary)' }}>
                                    {t('bpMonitorEmpty', 'No commands yet')}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="bp-monitor-list">
                            {commandMonitor.map((row) => (
                                <div key={`${row.deviceId}-${row.at}`} className="bp-monitor-row">
                                    <div className="bp-monitor-name">{row.name}</div>
                                    <div className="bp-monitor-meta">
                                        {String(row.mode || '').toUpperCase()}
                                        {row.commandKey ? ` (${row.commandKey})` : ''}
                                        {' | '}
                                        {Math.round(Number(row.outputPos || 0))}% | {new Date(Number(row.at || 0)).toLocaleTimeString()}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {isConnected && devices.length > 0 && (
                <div className="handy-section">
                    <div className="handy-section-title">{t('deviceSyncStatus', 'Sync Status')}</div>
                    {syncState === 'idle' && (
                        <div className="handy-sync-card idle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            <span>{t('deviceNoFunscript', 'Warte auf Funscript...')}</span>
                        </div>
                    )}
                    {syncState === 'ready' && (
                        <div className="handy-sync-card ready">
                            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                <polyline points="22 4 12 14.01 9 11.01" />
                            </svg>
                            <span>{t('deviceSyncReadyLocal', 'Lokal berechnet â€” Wiedergabe startet automatisch')}</span>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}

// â”€â”€ Coming Soon placeholder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function ComingSoon({ label }) {
    const { t } = useI18n();
    return (
        <div className="device-coming-soon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
            </svg>
            <span>{label} â€” {t('deviceComingSoon', 'Kommt bald')}</span>
        </div>
    );
}

// â”€â”€ TCode tab content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function TCodeTab({ status, portInfo, syncState, expandedAxes, setExpandedAxes, onConnect, onDisconnect, t }) {
    const isConnected = status === 'connected';
    const activeAxes = isConnected ? tcode.getActiveAxes() : [];
    const [axisPositions, setAxisPositions] = useState({});
    const [tcSettings, setTcSettings] = useState(() => tcode.getSettings());
    const [effectiveProviders, setEffectiveProviders] = useState({});

    // Poll axis positions at ~15Hz when connected and syncing
    useEffect(() => {
        if (!isConnected) { setAxisPositions({}); setEffectiveProviders({}); return; }
        const iv = setInterval(() => {
            setAxisPositions(tcode.getAxisPositions());
            setEffectiveProviders(tcode.getEffectiveProviders());
        }, 66);
        return () => clearInterval(iv);
    }, [isConnected]);

    const handleSettingChange = useCallback((key, value) => {
        const patch = { [key]: value };
        tcode.updateSettings(patch);
        setTcSettings(tcode.getSettings());
    }, []);

    const handleAxisSettingChange = useCallback((axis, key, value) => {
        const axPatch = { [axis]: { ...tcSettings.axes[axis], [key]: value } };
        tcode.updateSettings({ axes: axPatch });
        setTcSettings(tcode.getSettings());
    }, [tcSettings]);

    const AXIS_LABELS = {
        'L0': 'Stroke (L0)',
        'L1': 'Surge (L1)',
        'L2': 'Sway (L2)',
        'R0': 'Twist (R0)',
        'R1': 'Roll (R1)',
        'R2': 'Pitch (R2)',
    };

    const SHORT_LABELS = {
        'L0': 'Stroke', 'L1': 'Surge', 'L2': 'Sway',
        'R0': 'Twist', 'R1': 'Roll', 'R2': 'Pitch',
    };

    const ALL_AXES_LIST = ['L0', 'L1', 'L2', 'R0', 'R1', 'R2'];

    return (
        <>
            <div className="handy-section">
                <div className="handy-section-title">{t('deviceTCode', 'TCode')} (Web Serial)</div>
                <div className="handy-key-group">
                    {!isConnected ? (
                        <button
                            className="handy-connect-btn connect"
                            onClick={onConnect}
                            disabled={status === 'connecting'}
                            style={{ width: '100%' }}
                        >
                            {status === 'connecting'
                                ? t('deviceConnecting', 'Verbinde...')
                                : t('tcSelectPort', 'Seriellen Port wÃ¤hlen...')}
                        </button>
                    ) : (
                        <button
                            className="handy-connect-btn disconnect"
                            onClick={onDisconnect}
                            style={{ width: '100%' }}
                        >
                            {t('deviceDisconnect', 'Trennen')}
                        </button>
                    )}
                </div>
            </div>

            <div className="handy-section">
                <div className="handy-section-title">{t('status', 'Status')}</div>
                <div className="handy-status-card">
                    <div className={`handy-status-dot ${status}`} />
                    <div className="handy-status-info">
                        <div className="handy-status-label">
                            {status === 'connected' && t('deviceConnected', 'Verbunden')}
                            {status === 'connecting' && t('deviceConnecting', 'Verbinde...')}
                            {status === 'disconnected' && t('deviceDisconnected', 'Nicht verbunden')}
                        </div>
                        {isConnected && portInfo && (
                            <div className="handy-status-detail">
                                {Number.isFinite(Number(portInfo?.usbProductId))
                                    ? `${t('tcPortActive', 'Port aktiv')} (USB PID: ${portInfo.usbProductId})`
                                    : `${t('tcPortActive', 'Port aktiv')} (${t('tcUsbPidUnavailable', 'USB PID unavailable')})`}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {isConnected && (
                <div className="handy-section">
                    <div className="handy-section-title">{t('deviceSyncStatus', 'Sync Status')}</div>
                    {syncState === 'idle' && (
                        <div className="handy-sync-card idle">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="10" />
                                <line x1="12" y1="8" x2="12" y2="12" />
                                <line x1="12" y1="16" x2="12.01" y2="16" />
                            </svg>
                            <span>{t('deviceNoFunscript', 'Warte auf Funscript...')}</span>
                        </div>
                    )}
                    {syncState === 'ready' && (
                        <div className="handy-sync-card ready">
                            <svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                                <polyline points="22 4 12 14.01 9 11.01" />
                            </svg>
                            <span>{t('deviceSyncReadyLocal', 'Lokal berechnet â€” Wiedergabe startet automatisch')}</span>
                        </div>
                    )}
                </div>
            )}
        
            {/* ── TCode Settings ─────────────────────────────── */}
            <div className="handy-section">
                <div className="handy-section-title">{t('navSettings', 'Einstellungen')}</div>
                <div className="tcode-settings-row">
                    <button
                        className={`tcode-toggle-btn ${tcSettings.autoHome ? 'active' : ''}`}
                        onClick={() => handleSettingChange('autoHome', !tcSettings.autoHome)}
                        title={t('tcAutoHomeHint', 'Bei Pause zur Mitte fahren')}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 10.5L12 3l9 7.5" /><path d="M5 10v9a1 1 0 001 1h3v-5h6v5h3a1 1 0 001-1v-9" />
                        </svg>
                    </button>
                    <button
                        className={`tcode-toggle-btn ${tcSettings.softStart ? 'active' : ''}`}
                        onClick={() => handleSettingChange('softStart', !tcSettings.softStart)}
                        title={t('tcSoftStartHint', 'Sanft in Bewegung einsteigen')}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 20c2-4 6-16 10-16s6 8 10 16" />
                        </svg>
                    </button>
                    <div className="tcode-smoothing-label">
                        <span>{t('tcSmoothing', 'Glättung')}</span>
                        <AppDropdown
                            className="tcode-smoothing-select"
                            menuClassName="tcode-smoothing-menu"
                            value={tcSettings.smoothing}
                            onChange={(next) => handleSettingChange('smoothing', next)}
                            options={[
                                { value: 'linear', label: 'Linear' },
                                { value: 'pchip', label: 'PCHIP (Smooth)' },
                            ]}
                            ariaLabel={t('tcSmoothing', 'Glättung')}
                        />
                    </div>
                </div>
            </div>

            {/* ── Axes ───────────────────────────────────────── */}
            {isConnected && (
                <div className="handy-section">
                    <div className="tcode-cards-head-row" aria-hidden="true">
                        <div className="handy-section-title">{t('tcActiveAxes', 'Achsen')} ({activeAxes.length}/6)</div>
                        <div className="tcode-cards-compact-head">
                            <span>{t('tcRange', 'Range')}</span>
                            <span>{t('tcSpeedLimit', 'Speed limit')}</span>
                        </div>
                    </div>
                    <table className="tcode-axes-table tcode-axes-cards-table">
                        <thead>
                            <tr>
                                <th></th>
                                <th>{t('tcAxisCol', 'Achse')}</th>
                                <th>{t('tcMotion', 'Motion')}</th>
                                <th>{t('tcPosCol', 'Pos')}</th>
                                <th>{t('tcRange', 'Bereich')}</th>
                                <th>{t('tcSpeedLimit', 'Speed limit')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {['L0', 'L1', 'L2', 'R0', 'R1', 'R2'].map(axis => {
                                const active = activeAxes.includes(axis);
                                const pos = axisPositions[axis];
                                const hasPos = pos != null;
                                const axCfg = tcSettings.axes[axis] || {};
                                const provider = axCfg.motionProvider || 'auto';
                                const effective = effectiveProviders[axis] || 'off';
                                const isExpanded = !!expandedAxes[axis];
                                return (
                                    <React.Fragment key={axis}>
                                        <tr className={`${active ? 'tcode-row-active' : effective !== 'off' && effective !== 'script' ? 'tcode-row-provider' : 'tcode-row-inactive'} ${isExpanded && (provider === 'random' || provider === 'link') ? 'tcode-row-with-expanded' : ''}`}
                                        >
                                            <td><div className={`tcode-axis-dot ${active ? 'active' : effective !== 'off' && effective !== 'script' ? 'provider' : ''}`} /></td>
                                            <td className="tcode-cell-name">{SHORT_LABELS[axis]}</td>
                                            <td className="tcode-cell-motion" onClick={e => e.stopPropagation()}>
                                                <AppDropdown
                                                    className="tcode-select-mini"
                                                    menuClassName="tcode-select-mini-menu"
                                                    usePortal={true}
                                                    portalOffset={0}
                                                    value={provider}
                                                    onChange={(nextProvider) => {
                                                        handleAxisSettingChange(axis, 'motionProvider', nextProvider);
                                                        setExpandedAxes((prev) => ({
                                                            ...prev,
                                                            [axis]: nextProvider === 'link' || nextProvider === 'random',
                                                        }));
                                                    }}
                                                    options={[
                                                        { value: 'auto', label: 'Auto' },
                                                        { value: 'off', label: 'Off' },
                                                        { value: 'random', label: 'Random' },
                                                        { value: 'link', label: 'Link' },
                                                    ]}
                                                    ariaLabel={t('tcMotion', 'Motion')}
                                                />
                                            </td>
                                            <td className="tcode-cell-pos">
                                                <div className="tcode-axis-bar-row">
                                                    <div className="tcode-axis-bar">
                                                        <div className="tcode-axis-bar-fill" style={{ width: `${hasPos ? Math.min(100, Math.max(0, pos)) : 0}%` }} />
                                                    </div>
                                                    <span className={`tcode-axis-value ${hasPos ? '' : 'tcode-cell-muted'}`}>{hasPos ? pos : '–'}</span>
                                                </div>
                                            </td>
                                            <td className="tcode-cell-range" onClick={e => e.stopPropagation()}>
                                                <input type="number" min="0" max="100" value={axCfg.rangeMin ?? 0}
                                                    onChange={e => handleAxisSettingChange(axis, 'rangeMin', Math.max(0, Math.min(100, Number(e.target.value))))} />
                                                <span>–</span>
                                                <input type="number" min="0" max="100" value={axCfg.rangeMax ?? 100}
                                                    onChange={e => handleAxisSettingChange(axis, 'rangeMax', Math.max(0, Math.min(100, Number(e.target.value))))} />
                                            </td>
                                            <td className="tcode-cell-speed" onClick={e => e.stopPropagation()}>
                                                <input type="number" min="0" max="1000" step="10" value={axCfg.speedLimit ?? 0}
                                                    onChange={e => handleAxisSettingChange(axis, 'speedLimit', Math.min(1000, Math.max(0, Number(e.target.value) || 0)))} />
                                                {(axCfg.speedLimit ?? 0) === 0 && <span className="tcode-hint-small">∞</span>}
                                            </td>
                                        </tr>
                                        {isExpanded && (provider === 'random' || provider === 'link') && (
                                            <tr className="tcode-row-expanded">
                                                <td colSpan="6">
                                                    <div className="tcode-expanded-settings" onClick={e => e.stopPropagation()}>
                                                        {provider === 'random' && (
                                                            <>
                                                                <label className="tcode-mini-label">
                                                                    <span>{t('tcRandomSpeed', 'Speed')}</span>
                                                                    <input type="range" min="1" max="100" value={axCfg.randomSpeed ?? 50}
                                                                        style={{ '--range-pct': `${axCfg.randomSpeed ?? 50}%` }}
                                                                        onChange={e => handleAxisSettingChange(axis, 'randomSpeed', Number(e.target.value))} />
                                                                    <span className="tcode-mini-value">{axCfg.randomSpeed ?? 50}</span>
                                                                </label>
                                                                <label className="tcode-mini-label">
                                                                    <span>{t('tcRandomSmooth', 'Smooth')}</span>
                                                                    <input type="range" min="1" max="100" value={axCfg.randomSmooth ?? 50}
                                                                        style={{ '--range-pct': `${axCfg.randomSmooth ?? 50}%` }}
                                                                        onChange={e => handleAxisSettingChange(axis, 'randomSmooth', Number(e.target.value))} />
                                                                    <span className="tcode-mini-value">{axCfg.randomSmooth ?? 50}</span>
                                                                </label>
                                                            </>
                                                        )}
                                                        {provider === 'link' && (
                                                            <>
                                                                <label className="tcode-mini-label">
                                                                    <span>{t('tcLinkAxis', 'Quelle')}</span>
                                                                    <AppDropdown
                                                                        className="tcode-select-mini tcode-link-source-select"
                                                                        menuClassName="tcode-select-mini-menu"
                                                                        usePortal={true}
                                                                        portalOffset={0}
                                                                        value={axCfg.linkAxis || 'L0'}
                                                                        onChange={(next) => handleAxisSettingChange(axis, 'linkAxis', next)}
                                                                        options={ALL_AXES_LIST.filter(a => a !== axis).map(a => ({
                                                                            value: a,
                                                                            label: `${SHORT_LABELS[a]} (${a})`,
                                                                        }))}
                                                                        ariaLabel={t('tcLinkAxis', 'Quelle')}
                                                                    />
                                                                </label>
                                                                <label className="tcode-mini-label tcode-mini-check">
                                                                    <input type="checkbox" checked={!!axCfg.linkInvert}
                                                                        onChange={e => handleAxisSettingChange(axis, 'linkInvert', e.target.checked)} />
                                                                    <span>{t('tcLinkInvert', 'Invertieren')}</span>
                                                                </label>
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}

export default DevicePanel;
