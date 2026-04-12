import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import AppDropdown from '../components/AppDropdown';

const POLL_MS = 1000;
const HISTORY_LIMIT = 60;

function formatDuration(totalSeconds) {
    const s = Math.max(0, Number(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function formatTime(ts) {
    if (!ts) return '-';
    try {
        return new Date(ts).toLocaleTimeString();
    } catch {
        return '-';
    }
}

function formatMs(ms) {
    const n = Math.max(0, Number(ms || 0));
    if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
    return `${Math.round(n)}ms`;
}

function StatCard({ title, value, hint, accent = 'var(--accent-primary)' }) {
    return (
        <div className="stat-card" style={{ background: 'var(--bg-card)', padding: '20px', borderRadius: '12px', border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '0.85rem', opacity: 0.7, marginBottom: '6px' }}>{title}</div>
            <div style={{ fontSize: '2rem', fontWeight: 700, color: accent, lineHeight: 1.1 }}>{value}</div>
            <div style={{ fontSize: '0.78rem', opacity: 0.6, marginTop: '6px' }}>{hint}</div>
        </div>
    );
}

function MiniBars({ data, color = 'var(--accent-primary)' }) {
    const padded = [...Array(Math.max(0, HISTORY_LIMIT - data.length)).fill(0), ...data].slice(-HISTORY_LIMIT);
    const max = Math.max(1, ...padded.map(v => Number(v || 0)));
    return (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${HISTORY_LIMIT}, minmax(0, 1fr))`, alignItems: 'end', gap: '2px', height: '54px', width: '100%' }}>
            {padded.map((v, i) => {
                const ratio = Number(v || 0) / max;
                const h = ratio <= 0 ? 0 : Math.max(6, Math.min(100, ratio * 100));
                return (
                    <div
                        key={i}
                        style={{
                            height: `${h}%`,
                            background: color,
                            borderRadius: '2px',
                            opacity: 0.9,
                        }}
                    />
                );
            })}
        </div>
    );
}

function Dashboard() {
    const { t } = useI18n();
    const [status, setStatus] = useState({
        activeTasks: [],
        queueSize: 0,
        isScanning: false,
        uptimeSeconds: 0,
        librariesTotal: 0,
        librariesReachable: 0,
        cachedLibraries: 0,
        indexedVideos: 0,
        totalVideos: 0,
        totalSeriesFolders: 0,
        lastScanStartedAt: null,
        lastScanFinishedAt: null,
        lastScanDurationMs: 0,
        now: Date.now(),
    });
    const [history, setHistory] = useState([]);
    const [paused, setPaused] = useState(false);
    const [lastFetchAt, setLastFetchAt] = useState(null);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    const [scanBusy, setScanBusy] = useState(false);
    const [cleanupBusy, setCleanupBusy] = useState(false);
    const [maintenanceBusy, setMaintenanceBusy] = useState(false);
    const [maintenanceMode, setMaintenanceMode] = useState('regenerate_missing');
    const [maintenanceScopeKind, setMaintenanceScopeKind] = useState('all');
    const [maintenanceLibraryId, setMaintenanceLibraryId] = useState('');
    const [maintenanceTypes, setMaintenanceTypes] = useState({
        thumbnails: true,
        previews: true,
        heatmaps: true,
    });
    const [libraries, setLibraries] = useState([]);
    const [thumbControl, setThumbControl] = useState({ mode: 'running', queueSize: 0, running: 0 });
    const [perf, setPerf] = useState({
        now: Date.now(),
        scan: { isScanning: false, lastScanStartedAt: null, lastScanFinishedAt: null, lastScanDurationMs: 0 },
        thumbnails: { queueSize: 0, running: 0, concurrency: 0, queuedDistinct: 0, activeTasks: 0, mode: 'running' },
        previews: { queueSize: 0, running: 0, concurrency: 0, inFlight: 0, blockedByCooldown: 0 },
        audioIndex: { queueSize: 0, running: 0, concurrency: 0, queuedDistinct: 0 },
        ffmpeg: { runningCount: 0, running: [], recent: [] },
    });
    const [perfHistory, setPerfHistory] = useState([]);
    const [logs, setLogs] = useState([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [logLevel, setLogLevel] = useState('');
    const [logArea, setLogArea] = useState('');
    const [logQuery, setLogQuery] = useState('');
    const [logLimit, setLogLimit] = useState(200);
    const logsScrollRef = useRef(null);

    const fetchStatus = async () => {
        try {
            const res = await fetch('/api/status');
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const data = await res.json();
            setStatus(data);
            setLastFetchAt(Date.now());
            setError('');
            setHistory(prev => {
                const next = [...prev, {
                    queueSize: data.queueSize || 0,
                    active: (data.activeTasks || []).length,
                }];
                return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
            });
        } catch (err) {
            setError(`${t('statusLoadFailed', 'Status konnte nicht geladen werden')}: ${err.message}`);
        }
    };

    const fetchThumbControl = async () => {
        try {
            const res = await fetch('/api/thumbnails/control');
            if (!res.ok) return;
            const data = await res.json();
            setThumbControl(data || { mode: 'running', queueSize: 0, running: 0 });
        } catch { }
    };

    const fetchPerf = async () => {
        try {
            const res = await fetch('/api/status/perf');
            if (!res.ok) throw new Error(`Perf ${res.status}`);
            const data = await res.json();
            setPerf(data || {});
            setPerfHistory((prev) => {
                const next = [...prev, {
                    thumbQueue: Number(data?.thumbnails?.queueSize || 0),
                    previewQueue: Number(data?.previews?.queueSize || 0),
                    ffmpegWorkers: Number(data?.ffmpeg?.runningCount || 0),
                }];
                return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
            });
        } catch {
            // Keep dashboard resilient if perf endpoint is temporarily unavailable.
        }
    };

    const fetchLibraries = async () => {
        try {
            const res = await fetch('/api/libraries');
            if (!res.ok) return;
            const data = await res.json();
            setLibraries(Array.isArray(data) ? data : []);
        } catch { }
    };

    const fetchLogs = async (opts = {}) => {
        try {
            if (!opts.silent) setLogsLoading(true);
            const params = new URLSearchParams();
            if (logLimit) params.set('limit', String(logLimit));
            if (logLevel) params.set('level', logLevel);
            if (logArea) params.set('area', logArea);
            if (logQuery.trim()) params.set('q', logQuery.trim());
            const url = `/api/logs${params.toString() ? `?${params.toString()}` : ''}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Logs ${res.status}`);
            const data = await res.json();
            setLogs(Array.isArray(data?.items) ? data.items : []);
        } catch (err) {
            setError(`${t('errorPrefix', 'Fehler: ')}${err.message}`);
        } finally {
            if (!opts.silent) setLogsLoading(false);
        }
    };

    useEffect(() => {
        fetchStatus();
        fetchThumbControl();
        fetchPerf();
        fetchLogs();
        fetchLibraries();
    }, []);

    useEffect(() => {
        fetchLogs();
    }, [logLevel, logArea, logLimit]);

    useEffect(() => {
        if (paused) return;
        const interval = setInterval(() => {
            fetchStatus();
            fetchThumbControl();
            fetchPerf();
            fetchLogs({ silent: true });
        }, POLL_MS);
        return () => clearInterval(interval);
    }, [paused, logLevel, logArea, logQuery, logLimit]);

    useEffect(() => {
        if (maintenanceScopeKind !== 'library') setMaintenanceLibraryId('');
    }, [maintenanceScopeKind]);

    const handleThumbControl = async (action) => {
        try {
            const res = await fetch('/api/thumbnails/control', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            if (!res.ok) throw new Error(`Thumb ${res.status}`);
            const data = await res.json();
            setThumbControl(data || { mode: 'running', queueSize: 0, running: 0 });
            await fetchStatus();
        } catch (err) {
            setError(`${t('errorPrefix', 'Fehler: ')}${err.message}`);
        }
    };

    const handleManualScan = async () => {
        setScanBusy(true);
        try {
            const res = await fetch('/api/scan', { method: 'POST' });
            if (!res.ok) throw new Error(`Scan ${res.status}`);
            await fetchStatus();
        } catch (err) {
            setError(`${t('scanFailed', 'Scan fehlgeschlagen')}: ${err.message}`);
        } finally {
            setScanBusy(false);
        }
    };
    const handleClearLogs = async () => {
        try {
            const res = await fetch('/api/logs/clear', { method: 'POST' });
            if (!res.ok) throw new Error(`Logs ${res.status}`);
            setLogs([]);
        } catch (err) {
            setError(`${t('errorPrefix', 'Fehler: ')}${err.message}`);
        }
    };

    const handleCleanupLooseFiles = async () => {
        setCleanupBusy(true);
        setNotice('');
        try {
            const res = await fetch('/api/status/cleanup-loose-files', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `Cleanup ${res.status}`);
            const totalDeleted = Number(data?.totalDeleted || 0);
            const s = data?.stats || {};
            setNotice(
                `${t('cleanupLooseDone', 'Loose files bereinigt')}: ${totalDeleted} | ` +
                `Thumbs ${Number(s.thumbnailsDeleted || 0)}, TPDB Thumbs ${Number(s.tpdbThumbnailsDeleted || 0)}, ` +
                `Performer Images ${Number(s.tpdbPerformerImagesDeleted || 0)}, ` +
                `Previews ${Number(s.previewsDeleted || 0)}, Posters ${Number(s.postersDeleted || 0)}`
            );
            await fetchLogs();
        } catch (err) {
            setError(`${t('errorPrefix', 'Fehler: ')}${err.message}`);
        } finally {
            setCleanupBusy(false);
        }
    };

    const handleArtifactMaintenance = async () => {
        const selectedTypes = Object.entries(maintenanceTypes)
            .filter(([, enabled]) => !!enabled)
            .map(([key]) => key);
        if (selectedTypes.length === 0) {
            setError(t('errorPrefix', 'Fehler: ') + t('selectAtLeastOneType', 'Bitte mindestens einen Typ auswählen.'));
            return;
        }
        if (maintenanceMode === 'rebuild_all') {
            const ok = window.confirm(
                t('confirmRebuildAllArtifacts', 'Das löscht bestehende Artefakte und baut sie neu auf. Fortfahren?')
            );
            if (!ok) return;
        }

        setMaintenanceBusy(true);
        setError('');
        setNotice('');
        try {
            const payload = {
                mode: maintenanceMode,
                types: selectedTypes,
                scope: maintenanceScopeKind === 'library'
                    ? { kind: 'library', libraryId: String(maintenanceLibraryId || '').trim() }
                    : { kind: 'all' },
            };
            const res = await fetch('/api/artifacts/maintenance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `Maintenance ${res.status}`);

            const r = data?.results || {};
            const thumbMsg = `T: del ${Number(r?.thumbnails?.deleted || 0)}, q ${Number(r?.thumbnails?.queued || 0)}, gen ${Number(r?.thumbnails?.generated || 0)}`;
            const prevMsg = `P: del ${Number(r?.previews?.deleted || 0)}, q ${Number(r?.previews?.queued || 0)}`;
            const heatMsg = `H: del ${Number(r?.heatmaps?.deleted || 0)}, gen ${Number(r?.heatmaps?.generated || 0)}`;
            setNotice(
                `${t('artifactMaintenanceDone', 'Artifact Maintenance abgeschlossen')} (${Number(data?.processedVideos || 0)} Videos) | ${thumbMsg} | ${prevMsg} | ${heatMsg}`
            );
            await fetchStatus();
            await fetchThumbControl();
            await fetchPerf();
            await fetchLogs();
        } catch (err) {
            setError(`${t('errorPrefix', 'Fehler: ')}${err.message}`);
        } finally {
            setMaintenanceBusy(false);
        }
    };
    const handleLogsWheel = (e) => {
        const el = logsScrollRef.current;
        if (!el) return;
        if (el.scrollHeight <= el.clientHeight) return;
        e.preventDefault();
        e.stopPropagation();
        el.scrollTop += e.deltaY;
    };

    const queueHistory = history.map(h => h.queueSize);
    const activeHistory = history.map(h => h.active);
    const totalLibraries = Number(status.librariesTotal || status.cachedLibraries || 0);
    const totalVideos = Number(status.totalVideos || status.indexedVideos || 0);
    const totalSeries = Number(status.totalSeriesFolders || 0);
    const logAreas = Array.from(new Set((logs || []).map(l => String(l.area || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

    return (
        <div className="dashboard-page" style={{ height: '100%', overflowY: 'auto', padding: '26px', maxWidth: '1200px', margin: '0 auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                <div>
                    <h1 className="dashboard-title" style={{ fontSize: '1.9rem', marginBottom: '4px' }}>{t('dashboardTitle', 'Server Dashboard')}</h1>
                    <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                        {t('lastUpdate', 'Letztes Update')}: {lastFetchAt ? new Date(lastFetchAt).toLocaleTimeString() : '-'} | Polling: {paused ? t('paused', 'pausiert') : `${POLL_MS} ms`}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-secondary" onClick={() => setPaused(p => !p)}>
                        {paused ? t('resumeLive', 'Live fortsetzen') : t('pauseLive', 'Live pausieren')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => { fetchStatus(); fetchThumbControl(); fetchPerf(); fetchLogs(); fetchLibraries(); }}>{t('dashboardRefresh', 'Aktualisieren')}</button>
                    <button className="btn btn-secondary" onClick={handleCleanupLooseFiles} disabled={cleanupBusy}>
                        {cleanupBusy ? t('cleanupRunning', 'Bereinige...') : t('cleanupLooseFiles', 'Loose Files bereinigen')}
                    </button>
                    <button className="btn btn-primary" onClick={handleManualScan} disabled={scanBusy || status.isScanning}>
                        {scanBusy || status.isScanning ? t('dashboardScanning', 'Scan laeuft...') : t('dashboardScanNow', 'Jetzt scannen')}
                    </button>
                </div>
            </div>
            {notice && (
                <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: 'color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card))', color: 'var(--text-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))' }}>
                    {notice}
                </div>
            )}
            <div className="home-stats-bar" style={{ marginBottom: '18px' }}>
                <div className="home-stat">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <div className="home-stat-info">
                        <span className="home-stat-num">{totalLibraries}</span>
                        <span className="home-stat-label">{totalLibraries === 1 ? t('library', 'Bibliothek') : t('libraries', 'Bibliotheken')}</span>
                    </div>
                </div>
                <div className="home-stat">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                        <polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <div className="home-stat-info">
                        <span className="home-stat-num">{totalVideos}</span>
                        <span className="home-stat-label">{t('videos', 'Videos')}</span>
                    </div>
                </div>
                {totalSeries > 0 && (
                    <div className="home-stat">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                            <rect x="2" y="7" width="20" height="15" rx="2" ry="2" /><polyline points="17 2 12 7 7 2" />
                        </svg>
                        <div className="home-stat-info">
                            <span className="home-stat-num">{totalSeries}</span>
                            <span className="home-stat-label">{t('series', 'Serien')}</span>
                        </div>
                    </div>
                )}
            </div>
            {error && (
                <div style={{ marginBottom: '14px', padding: '10px 12px', borderRadius: '8px', background: 'rgba(239,68,68,0.12)', color: '#fda4af', border: '1px solid rgba(239,68,68,0.3)' }}>
                    {error}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '14px', marginBottom: '16px' }}>
                <StatCard title={t('queueLabel', 'Warteschlange')} value={status.queueSize} hint={t('thumbJobsPending', 'Thumbnail Jobs ausstehend')} />
                <StatCard title={t('activeTasksLabel', 'Aktive Tasks')} value={(status.activeTasks || []).length} hint={t('currentlyProcessing', 'Aktuell verarbeitet')} accent="var(--accent-secondary)" />
                <StatCard title={t('uptime', 'Uptime')} value={formatDuration(status.uptimeSeconds)} hint={t('serverRuntime', 'Server Laufzeit')} />
            </div>

            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px', marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <h2 style={{ fontSize: '1rem', margin: 0 }}>{t('perfOverlayTitle', 'Performance Overlay')}</h2>
                    <span style={{ fontSize: '0.76rem', opacity: 0.72 }}>
                        {t('lastUpdate', 'Letztes Update')}: {formatTime(perf.now)}
                    </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px', marginBottom: '10px' }}>
                    <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '4px' }}>Scan Queue</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{perf.scan?.isScanning ? t('scanActive', 'Scan aktiv') : t('idle', 'Idle')}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Last: {perf.scan?.lastScanDurationMs ? formatMs(perf.scan.lastScanDurationMs) : '-'}</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '4px' }}>Thumbnail Queue</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{perf.thumbnails?.queueSize || 0}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Running: {perf.thumbnails?.running || 0}/{perf.thumbnails?.concurrency || 0}</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '4px' }}>Preview Queue</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{perf.previews?.queueSize || 0}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Running: {perf.previews?.running || 0}/{perf.previews?.concurrency || 0} | In-flight: {perf.previews?.inFlight || 0}</div>
                    </div>
                    <div style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7, marginBottom: '4px' }}>ffmpeg Workers</div>
                        <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{perf.ffmpeg?.runningCount || 0}</div>
                        <div style={{ fontSize: '0.75rem', opacity: 0.7 }}>Audio Index Queue: {perf.audioIndex?.queueSize || 0}</div>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '10px', marginBottom: '10px' }}>
                    <div>
                        <div style={{ fontSize: '0.78rem', opacity: 0.7, marginBottom: '6px' }}>Thumb Queue</div>
                        <MiniBars data={perfHistory.map((h) => h.thumbQueue || 0)} color="var(--accent-primary)" />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.78rem', opacity: 0.7, marginBottom: '6px' }}>Preview Queue</div>
                        <MiniBars data={perfHistory.map((h) => h.previewQueue || 0)} color="#38bdf8" />
                    </div>
                    <div>
                        <div style={{ fontSize: '0.78rem', opacity: 0.7, marginBottom: '6px' }}>ffmpeg</div>
                        <MiniBars data={perfHistory.map((h) => h.ffmpegWorkers || 0)} color="#f59e0b" />
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '10px' }}>
                    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '10px', background: 'var(--bg-tertiary)' }}>
                        <div style={{ padding: '8px 10px', fontSize: '0.8rem', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)' }}>Running ffmpeg</div>
                        <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                            {(perf.ffmpeg?.running || []).length === 0 ? (
                                <div style={{ padding: '10px', opacity: 0.7 }}>{t('noActiveTasks', 'Keine aktiven Aufgaben.')}</div>
                            ) : (perf.ffmpeg.running || []).map((job) => (
                                <div key={job.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                                    <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>{job.kind} {job.mode ? `(${job.mode})` : ''}</div>
                                    <div style={{ fontSize: '0.74rem', opacity: 0.72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.video}</div>
                                    <div style={{ fontSize: '0.72rem', opacity: 0.62 }}>PID {job.pid || '-'} | {formatMs(job.runtimeMs)}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '10px', background: 'var(--bg-tertiary)' }}>
                        <div style={{ padding: '8px 10px', fontSize: '0.8rem', fontWeight: 600, borderBottom: '1px solid var(--border-subtle)' }}>Recent ffmpeg</div>
                        <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                            {(perf.ffmpeg?.recent || []).length === 0 ? (
                                <div style={{ padding: '10px', opacity: 0.7 }}>{t('noLogsYet', 'Noch keine Logs')}</div>
                            ) : (perf.ffmpeg.recent || []).slice(0, 12).map((job) => (
                                <div key={job.id} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                                    <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                                        {job.kind} <span style={{ opacity: 0.7, fontWeight: 500 }}>{job.status}</span>
                                    </div>
                                    <div style={{ fontSize: '0.74rem', opacity: 0.72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{job.video}</div>
                                    <div style={{ fontSize: '0.72rem', opacity: 0.62 }}>{formatMs(job.durationMs)}{job.error ? ` | ${job.error}` : ''}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(240px, 1fr)', gap: '14px', marginBottom: '16px', alignItems: 'stretch' }}>
                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px', overflow: 'hidden' }}>
                    <div style={{ fontWeight: 600, marginBottom: '12px' }}>{t('liveTrends', 'Live Trends')} ({t('lastSamples', 'letzte')} {HISTORY_LIMIT} {t('samples', 'Samples')})</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px' }}>
                        <div>
                            <div style={{ fontSize: '0.78rem', opacity: 0.7, marginBottom: '6px' }}>{t('queueLabelEn', 'Queue')}</div>
                            <MiniBars data={queueHistory} color="var(--accent-primary)" />
                        </div>
                        <div>
                            <div style={{ fontSize: '0.78rem', opacity: 0.7, marginBottom: '6px' }}>{t('activeLabelEn', 'Active')}</div>
                            <MiniBars data={activeHistory} color="var(--accent-secondary)" />
                        </div>
                    </div>
                </div>

                <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px' }}>
                    <div style={{ fontWeight: 600, marginBottom: '10px' }}>{t('scanStatus', 'Scan Status')}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                        <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: status.isScanning ? '#f59e0b' : '#22c55e' }} />
                        <span style={{ color: status.isScanning ? '#fbbf24' : '#86efac', fontWeight: 600 }}>
                            {status.isScanning ? t('scanActive', 'Scan aktiv') : t('idle', 'Idle')}
                        </span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'grid', gap: '6px' }}>
                        <div>{t('started', 'Gestartet')}: {formatTime(status.lastScanStartedAt)}</div>
                        <div>{t('ended', 'Beendet')}: {formatTime(status.lastScanFinishedAt)}</div>
                        <div>{t('duration', 'Dauer')}: {status.lastScanDurationMs ? `${Math.round(status.lastScanDurationMs / 1000)}s` : '-'}</div>
                        <div>{t('seriesFolders', 'Series-Folder')}: {status.totalSeriesFolders}</div>
                    </div>
                </div>
            </div>

            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px' }}>
                <h2 style={{ fontSize: '1rem', marginBottom: '10px' }}>{t('activeTasks', 'Aktive Aufgaben')}</h2>
                {(status.activeTasks || []).length === 0 ? (
                    <div style={{ padding: '14px', opacity: 0.6 }}>{t('noActiveTasks', 'Keine aktiven Aufgaben.')}</div>
                ) : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '8px' }}>
                        {status.activeTasks.map((task, i) => {
                            const label = String(task || '').split(/[\\/]/).pop() || task;
                            return (
                                <li
                                    key={`${task}-${i}`}
                                    style={{
                                        background: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border-subtle)',
                                        borderRadius: '8px',
                                        padding: '10px 12px',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: '10px',
                                    }}
                                >
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 600, fontSize: '0.88rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
                                        <div style={{ fontSize: '0.75rem', opacity: 0.6, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{task}</div>
                                    </div>
                                    <span style={{ fontSize: '0.74rem', color: 'var(--accent-primary)' }}>{t('processing', 'processing')}</span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px', marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600 }}>{t('runtimeLogs', 'Laufzeit-Logs')}</div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary" onClick={() => fetchLogs()}>{t('dashboardRefresh', 'Aktualisieren')}</button>
                        <button className="btn btn-danger" onClick={handleClearLogs}>{t('clearLogs', 'Logs leeren')}</button>
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', marginBottom: '10px' }}>
                    <AppDropdown
                        className="input"
                        value={logLevel}
                        options={[
                            { value: '', label: t('logLevelAll', 'Alle Level') },
                            { value: 'error', label: 'Error' },
                            { value: 'warn', label: 'Warn' },
                            { value: 'info', label: 'Info' },
                        ]}
                        onChange={setLogLevel}
                    />
                    <AppDropdown
                        className="input"
                        value={logArea}
                        options={[
                            { value: '', label: t('logAreaAll', 'Alle Bereiche') },
                            ...logAreas.map((area) => ({ value: area, label: area })),
                        ]}
                        onChange={setLogArea}
                    />
                    <AppDropdown
                        className="input"
                        value={String(logLimit)}
                        options={[
                            { value: '100', label: '100' },
                            { value: '200', label: '200' },
                            { value: '500', label: '500' },
                            { value: '800', label: '800' },
                        ]}
                        onChange={(val) => setLogLimit(Number(val) || 200)}
                    />
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <div className="settings-search-wrap" style={{ minWidth: 0, flex: 1 }}>
                            <input
                                className="input"
                                value={logQuery}
                                onChange={(e) => setLogQuery(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') fetchLogs();
                                }}
                                placeholder={t('searchLogs', 'Logs durchsuchen...')}
                                style={{ minWidth: 0, flex: 1 }}
                            />
                            {logQuery ? (
                                <button
                                    type="button"
                                    className="search-clear-btn compact"
                                    onClick={() => setLogQuery('')}
                                    aria-label={t('clearSearch', 'Clear search')}
                                    title={t('clearSearch', 'Clear search')}
                                >
                                    ×
                                </button>
                            ) : null}
                        </div>
                        <button className="btn btn-secondary" onClick={() => fetchLogs()}>{t('search', 'Suchen')}</button>
                    </div>
                </div>

                <div ref={logsScrollRef} onWheel={handleLogsWheel} style={{ height: '280px', overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', borderRadius: '10px', border: '1px solid var(--border-subtle)', background: 'var(--bg-tertiary)' }}>
                    {logsLoading && (logs || []).length === 0 ? (
                        <div style={{ padding: '12px', opacity: 0.7 }}>{t('loadingLoad', 'Lade...')}</div>
                    ) : (logs || []).length === 0 ? (
                        <div style={{ padding: '12px', opacity: 0.7 }}>{t('noLogsYet', 'Noch keine Logs')}</div>
                    ) : (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                            {logs.map((log) => {
                                const level = String(log?.level || 'info').toLowerCase();
                                const levelColor = level === 'error' ? '#fca5a5' : level === 'warn' ? '#fcd34d' : '#93c5fd';
                                return (
                                    <li key={log.id} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                                <span style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.4px', borderRadius: '999px', padding: '2px 8px', border: '1px solid var(--border-subtle)', color: levelColor }}>{level}</span>
                                                <span style={{ fontSize: '0.72rem', opacity: 0.7, textTransform: 'uppercase' }}>{log.area}</span>
                                            </div>
                                            <span style={{ fontSize: '0.75rem', opacity: 0.65 }}>{new Date(log.ts).toLocaleString()}</span>
                                        </div>
                                        <div style={{ fontSize: '0.9rem', marginBottom: log.meta ? '6px' : 0 }}>{log.message}</div>
                                        {log.meta && (
                                            <pre style={{ margin: 0, padding: '8px', borderRadius: '8px', fontSize: '0.72rem', overflow: 'auto', background: 'rgba(0,0,0,0.15)', color: 'var(--text-secondary)' }}>{JSON.stringify(log.meta, null, 2)}</pre>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px', marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600 }}>{t('artifactMaintenance', 'Artifact Maintenance')}</div>
                    <span style={{ fontSize: '0.75rem', opacity: 0.75 }}>
                        {t('artifactMaintenanceHint', 'Löschen und/oder neu erzeugen für Thumbnails, Previews und Heatmaps')}
                    </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', marginBottom: '10px' }}>
                    <AppDropdown
                        className="input"
                        value={maintenanceMode}
                        options={[
                            { value: 'regenerate_missing', label: t('regenMissing', 'Nur fehlende neu erzeugen') },
                            { value: 'delete_only', label: t('deleteOnly', 'Nur löschen') },
                            { value: 'rebuild_all', label: t('rebuildAll', 'Alles neu aufbauen (löschen + erzeugen)') },
                        ]}
                        onChange={setMaintenanceMode}
                    />
                    <AppDropdown
                        className="input"
                        value={maintenanceScopeKind}
                        options={[
                            { value: 'all', label: t('scopeAllLibraries', 'Alle Bibliotheken') },
                            { value: 'library', label: t('scopeOneLibrary', 'Eine Bibliothek') },
                        ]}
                        onChange={setMaintenanceScopeKind}
                    />
                    <AppDropdown
                        className="input"
                        value={maintenanceLibraryId}
                        options={[
                            { value: '', label: t('selectLibrary', 'Bibliothek wählen') },
                            ...libraries.map((lib) => ({ value: String(lib.id || ''), label: String(lib.name || lib.path || lib.id || '') })),
                        ]}
                        onChange={setMaintenanceLibraryId}
                        disabled={maintenanceScopeKind !== 'library' || maintenanceBusy}
                    />
                </div>
                <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                        <input
                            type="checkbox"
                            checked={!!maintenanceTypes.thumbnails}
                            onChange={(e) => setMaintenanceTypes((prev) => ({ ...prev, thumbnails: e.target.checked }))}
                            disabled={maintenanceBusy}
                        />
                        Thumbnails
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                        <input
                            type="checkbox"
                            checked={!!maintenanceTypes.previews}
                            onChange={(e) => setMaintenanceTypes((prev) => ({ ...prev, previews: e.target.checked }))}
                            disabled={maintenanceBusy}
                        />
                        Previews
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem' }}>
                        <input
                            type="checkbox"
                            checked={!!maintenanceTypes.heatmaps}
                            onChange={(e) => setMaintenanceTypes((prev) => ({ ...prev, heatmaps: e.target.checked }))}
                            disabled={maintenanceBusy}
                        />
                        Heatmaps
                    </label>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                        className="btn btn-primary"
                        onClick={handleArtifactMaintenance}
                        disabled={maintenanceBusy || (maintenanceScopeKind === 'library' && !maintenanceLibraryId)}
                    >
                        {maintenanceBusy ? t('running', 'Läuft...') : t('runMaintenance', 'Ausführen')}
                    </button>
                </div>
            </div>

            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '14px', marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                    <div style={{ fontWeight: 600 }}>{t('thumbControlTitle', 'Thumbnail-Generierung')}</div>
                    <span
                        style={{
                            fontSize: '0.72rem',
                            borderRadius: '999px',
                            padding: '3px 8px',
                            border: '1px solid var(--border-subtle)',
                            color: 'var(--text-secondary)',
                            background: 'var(--bg-tertiary)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.4px',
                        }}
                    >
                        {thumbControl.mode || 'running'}
                    </span>
                </div>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                    <button className={thumbControl.mode === 'running' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => handleThumbControl('start')}>
                        {t('start', 'Starten')}
                    </button>
                    <button className={thumbControl.mode === 'paused' ? 'btn btn-primary' : 'btn btn-secondary'} onClick={() => handleThumbControl('pause')}>
                        {t('pause', 'Pausieren')}
                    </button>
                    <button className={thumbControl.mode === 'stopped' ? 'btn btn-danger' : 'btn btn-secondary'} onClick={() => handleThumbControl('stop')}>
                        {t('stop', 'Stoppen')}
                    </button>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <span>Queue: {thumbControl.queueSize || 0}</span>
                    <span>Active: {thumbControl.running || 0}</span>
                </div>
            </div>
        </div>
    );
}

export default Dashboard;

















