import React, { useEffect, useMemo, useRef, useState } from 'react';
import AppDropdown from '../components/AppDropdown';
import { useI18n } from '../i18n';
import FunscriptHeatmap from '../components/FunscriptHeatmap';
import { useLocation, useNavigate } from 'react-router-dom';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function FunscriptManager({ onOpenVideoInLibrary }) {
    const { t } = useI18n();
    const location = useLocation();
    const navigate = useNavigate();
    const PAGE_SIZE = 100;
    const [activeTab, setActiveTab] = useState('manage');
    const [items, setItems] = useState([]);
    const [libraries, setLibraries] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [totalItems, setTotalItems] = useState(0);
    const [search, setSearch] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [libraryFilter, setLibraryFilter] = useState('');
    const [viewMode, setViewMode] = useState('list');
    const [busyAction, setBusyAction] = useState('');
    const [toast, setToast] = useState(null);
    const [manageVideoId, setManageVideoId] = useState('');
    const [historyItems, setHistoryItems] = useState([]);
    const [pendingManageVideoId, setPendingManageVideoId] = useState('');
    const [linkDraft, setLinkDraft] = useState({
        scriptPath: '',
        axis: 'main',
        label: '',
    });
    const [mappingPreviews, setMappingPreviews] = useState({});
    const sentinelRef = useRef(null);
    const loadRequestRef = useRef(0);

    const isRemote = useMemo(() => {
        try {
            const s = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            const addr = String(s?.serverAddress || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
            const host = (addr.split('/')[0].split(':')[0].replace(/^\[|\]$/g, '') || '').toLowerCase();
            return !!addr && host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== '';
        } catch { return false; }
    }, []);

    const [fsBrowserOpen, setFsBrowserOpen] = useState(false);
    const [fsBrowserPath, setFsBrowserPath] = useState('/');
    const [fsBrowserDirs, setFsBrowserDirs] = useState([]);
    const [fsBrowserFiles, setFsBrowserFiles] = useState([]);
    const [fsBrowserParent, setFsBrowserParent] = useState(null);
    const [fsBrowserLoading, setFsBrowserLoading] = useState(false);
    const [fsBrowserError, setFsBrowserError] = useState('');

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 2600);
    };

    const loadHistory = async () => {
        try {
            const hRes = await fetch('/api/funscripts/history?limit=20');
            const hData = await hRes.json().catch(() => ({}));
            if (hRes.ok) setHistoryItems(Array.isArray(hData?.items) ? hData.items : []);
        } catch {
            // Keep history optional for primary manager UX.
        }
    };

    const loadData = async ({ reset = false } = {}) => {
        const requestId = Date.now() + Math.random();
        loadRequestRef.current = requestId;
        if (reset) setLoading(true);
        else setLoadingMore(true);
        try {
            const offset = reset ? 0 : items.length;
            const params = new URLSearchParams();
            if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
            if (libraryFilter) params.set('libraryId', libraryFilter);
            if (searchQuery.trim()) params.set('search', searchQuery.trim());
            params.set('limit', String(PAGE_SIZE));
            params.set('offset', String(offset));
            const res = await fetch(`/api/funscripts/manager?${params.toString()}`);
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to load funscript manager');
            if (loadRequestRef.current !== requestId) return;
            const nextItems = Array.isArray(data?.items) ? data.items : [];
            setItems((prev) => {
                if (reset) return nextItems;
                if (!nextItems.length) return prev;
                const seen = new Set(prev.map((entry) => String(entry.videoId || '')));
                const merged = [...prev];
                for (const entry of nextItems) {
                    const key = String(entry?.videoId || '');
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    merged.push(entry);
                }
                return merged;
            });
            setLibraries(Array.isArray(data?.libraries) ? data.libraries : []);
            const total = Number(data?.total || 0);
            const explicitHasMore = data?.hasMore === true;
            const loadedCount = offset + nextItems.length;
            setTotalItems(total > 0 ? total : loadedCount);
            setHasMore(explicitHasMore || (total > 0 && loadedCount < total));
        } catch (err) {
            if (loadRequestRef.current !== requestId) return;
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            if (loadRequestRef.current === requestId) {
                setLoading(false);
                setLoadingMore(false);
            }
        }
    };

    useEffect(() => {
        loadHistory();
    }, []);

    useEffect(() => {
        const state = location?.state;
        if (!state || typeof state !== 'object') return;
        const incomingLibraryId = String(state.libraryId || '').trim();
        const incomingVideoId = String(state.videoId || '').trim();
        const incomingSearch = String(state.search || state.title || '').trim();
        if (!incomingLibraryId && !incomingVideoId && !incomingSearch) return;

        setActiveTab('manage');
        if (incomingLibraryId) setLibraryFilter(incomingLibraryId);
        if (incomingSearch) {
            setSearch(incomingSearch);
            setSearchQuery(incomingSearch);
        }
        if (incomingVideoId) setPendingManageVideoId(incomingVideoId);

        navigate(location.pathname, { replace: true, state: null });
    }, [location?.state]);

    useEffect(() => {
        const timer = setTimeout(() => {
            setSearchQuery(search.trim());
        }, 220);
        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        setItems([]);
        setHasMore(false);
        setTotalItems(0);
        loadData({ reset: true });
    }, [statusFilter, libraryFilter, searchQuery]);

    useEffect(() => {
        if (!pendingManageVideoId) return;
        const found = items.find((item) => String(item.videoId || '') === String(pendingManageVideoId));
        if (!found) return;
        setManageVideoId(found.videoId);
        setLinkDraft({ scriptPath: '', axis: 'main', label: '' });
        setPendingManageVideoId('');
    }, [items, pendingManageVideoId]);

    const activeItem = useMemo(() => (
        items.find((item) => String(item.videoId) === String(manageVideoId)) || null
    ), [items, manageVideoId]);

    useEffect(() => {
        if (activeTab !== 'manage') return;
        const node = sentinelRef.current;
        if (!node) return;
        const observer = new IntersectionObserver((entries) => {
            const first = entries?.[0];
            if (!first?.isIntersecting) return;
            if (loading || loadingMore || !hasMore) return;
            loadData({ reset: false });
        }, { root: null, rootMargin: '180px 0px' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [activeTab, hasMore, loading, loadingMore, items.length, statusFilter, libraryFilter, searchQuery]);

    useEffect(() => {
        let cancelled = false;
        const mappings = Array.isArray(activeItem?.mappings) ? activeItem.mappings : [];
        if (!mappings.length) {
            setMappingPreviews({});
            return () => { cancelled = true; };
        }
        const loadPreviews = async () => {
            const entries = await Promise.all(mappings.map(async (mapping) => {
                const id = String(mapping?.id || '');
                if (!id) return null;
                try {
                    const res = await fetch(`/api/funscripts/mapping/${encodeURIComponent(id)}/preview`);
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) return [id, { error: data?.error || 'Failed', loading: false }];
                    return [id, { ...data, loading: false }];
                } catch (err) {
                    return [id, { error: err.message || 'Failed', loading: false }];
                }
            }));
            if (cancelled) return;
            const next = {};
            for (const entry of entries) {
                if (!entry) continue;
                next[entry[0]] = entry[1];
            }
            setMappingPreviews(next);
        };
        const pending = {};
        for (const mapping of mappings) {
            const id = String(mapping?.id || '');
            if (!id) continue;
            pending[id] = { loading: true };
        }
        setMappingPreviews(pending);
        loadPreviews();
        return () => { cancelled = true; };
    }, [activeItem]);

    const formatDuration = (durationMs) => {
        const totalSec = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
        if (!totalSec) return '0:00';
        const sec = totalSec % 60;
        const min = Math.floor(totalSec / 60) % 60;
        const hrs = Math.floor(totalSec / 3600);
        if (hrs > 0) return `${hrs}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        return `${min}:${String(sec).padStart(2, '0')}`;
    };

    const fileNameFromPath = (rawPath) => {
        const value = String(rawPath || '').trim();
        if (!value) return '';
        const normalized = value.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : value;
    };

    const formatHistoryTime = (ts) => {
        const n = Number(ts || 0);
        if (!Number.isFinite(n) || n <= 0) return '-';
        try {
            return new Date(n).toLocaleString();
        } catch {
            return '-';
        }
    };

    const historyActionLabel = (action) => {
        const a = String(action || '').toLowerCase();
        if (a === 'link') return t('funscriptHistoryActionLink', 'Linked');
        if (a === 'unlink') return t('funscriptHistoryActionUnlink', 'Removed');
        if (a === 'set-default') return t('funscriptHistoryActionSetDefault', 'Set default');
        if (a === 'scan') return t('funscriptHistoryActionScan', 'Scan');
        return a || t('unknown', 'Unknown');
    };

    const getStatusLabel = (status) => {
        const normalized = String(status || 'missing').toLowerCase();
        if (normalized === 'linked') return t('funscriptStatusLinked', 'Linked');
        if (normalized === 'multi-axis') return t('funscriptStatusMultiAxis', 'Multi-axis');
        if (normalized === 'multiple') return t('funscriptStatusMultiple', 'Multiple');
        if (normalized === 'orphan') return t('funscriptStatusOrphan', 'Orphan');
        return t('funscriptStatusMissing', 'Missing');
    };

    const runScan = async () => {
        setBusyAction('scan');
        try {
            const res = await fetch('/api/funscripts/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ libraryId: libraryFilter || undefined }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Scan failed');
            showToast(`${data.linkedScripts || 0} ${t('funscriptManagerLinkedScripts', 'scripts linked')}`);
            await loadData({ reset: true });
            await loadHistory();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const setDefault = async (mappingId) => {
        setBusyAction(`default:${mappingId}`);
        try {
            const res = await fetch('/api/funscripts/default', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mappingId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to set default');
            showToast(t('saved', 'Saved'));
            await loadData({ reset: true });
            await loadHistory();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const unlink = async (mappingId) => {
        setBusyAction(`unlink:${mappingId}`);
        try {
            const res = await fetch('/api/funscripts/unlink', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mappingId }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to unlink');
            showToast(t('removed', 'Removed'));
            await loadData({ reset: true });
            await loadHistory();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const linkScript = async () => {
        if (!activeItem || !linkDraft.scriptPath.trim()) return;
        setBusyAction('link');
        try {
            const res = await fetch('/api/funscripts/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: activeItem.videoId,
                    scriptPath: linkDraft.scriptPath.trim(),
                    axis: linkDraft.axis,
                    label: linkDraft.label.trim(),
                    setDefault: true,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || 'Failed to link script');
            showToast(t('saved', 'Saved'));
            setLinkDraft((prev) => ({ ...prev, scriptPath: '', label: '' }));
            await loadData({ reset: true });
            await loadHistory();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const pickScriptFile = async () => {
        try {
            let selected = null;
            if (window.electronAPI?.selectFunscript) {
                selected = await window.electronAPI.selectFunscript();
            } else {
                selected = await new Promise((resolve) => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = '.funscript,application/json';
                    input.onchange = () => {
                        const file = input.files?.[0];
                        resolve(file?.name ? file.name : null);
                    };
                    input.click();
                });
            }
            if (!selected) return;
            setLinkDraft((prev) => ({ ...prev, scriptPath: String(selected) }));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        }
    };

    const loadFsBrowserDir = async (dirPath) => {
        setFsBrowserLoading(true);
        setFsBrowserError('');
        try {
            const res = await fetch(`/api/fs/list?path=${encodeURIComponent(dirPath || '/')}&showFiles=1&ext=funscript,json`);
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
            const data = await res.json();
            setFsBrowserPath(data.path);
            setFsBrowserDirs(data.dirs || []);
            setFsBrowserFiles(data.files || []);
            setFsBrowserParent(data.parent);
        } catch (err) {
            setFsBrowserError(err.message);
        } finally {
            setFsBrowserLoading(false);
        }
    };

    const handleUploadFunscript = async (file) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.funscript')) {
            showToast(t('onlyFunscriptAllowed', 'Only .funscript files allowed'), 'error');
            return;
        }
        setBusyAction('upload');
        try {
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsText(file);
            });
            JSON.parse(content);
            const targetDir = fsBrowserPath || '/';
            const res = await fetch('/api/funscripts/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: file.name, dir: targetDir, content }),
            });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
            const data = await res.json();
            setLinkDraft((prev) => ({ ...prev, scriptPath: data.path }));
            await loadFsBrowserDir(targetDir);
            showToast(`${t('uploaded', 'Uploaded')}: ${data.name}`, 'success');
        } catch (err) {
            showToast(`${t('uploadFailed', 'Upload failed')}: ${err.message}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    useDialogHotkeys({
        open: !!activeItem,
        onCancel: () => setManageVideoId(''),
        onConfirm: () => setManageVideoId(''),
        canConfirm: !!activeItem,
        allowEnterInInputs: false,
    });

    return (
        <div className="settings-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t('funscriptManagerTitle', 'Funscript Manager')}</h1>
                    <p className="page-subtitle">{t('funscriptManagerSubtitle', 'Manage script mappings per video, set defaults and rescan libraries')}</p>
                </div>
            </div>

            <div className="funscript-manager-tabbar-wrap">
                <div className="funscript-manager-tabs" role="tablist" aria-label={t('funscriptManagerTabsAria', 'Funscript manager tabs')}>
                    <button
                        type="button"
                        className={`funscript-manager-tab ${activeTab === 'manage' ? 'active' : ''}`}
                        onClick={() => setActiveTab('manage')}
                        role="tab"
                        aria-selected={activeTab === 'manage'}
                    >
                        {t('funscriptManagerTabManage', 'Manage')}
                    </button>
                    <button
                        type="button"
                        className={`funscript-manager-tab ${activeTab === 'history' ? 'active' : ''}`}
                        onClick={() => setActiveTab('history')}
                        role="tab"
                        aria-selected={activeTab === 'history'}
                    >
                        {t('funscriptManagerTabHistory', 'History')}
                    </button>
                </div>
            </div>

            {activeTab === 'manage' && (
                <div className="settings-section funscript-manager-toolbar funscript-tab-panel">
                <div className="settings-input-row">
                    <div className="settings-search-wrap">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={t('searchVideosPlaceholder', 'Search videos...')}
                        />
                        {search ? (
                            <button
                                type="button"
                                className="search-clear-btn compact"
                                onClick={() => setSearch('')}
                                aria-label={t('clearSearch', 'Clear search')}
                                title={t('clearSearch', 'Clear search')}
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                    <AppDropdown
                        className="tag-manager-select"
                        value={libraryFilter}
                        onChange={setLibraryFilter}
                        usePortal
                        portalOffset={0}
                        options={[
                            { value: '', label: t('allLibraries', 'All libraries') },
                            ...libraries.map((lib) => ({ value: String(lib.id || ''), label: String(lib.name || '') })),
                        ]}
                    />
                    <AppDropdown
                        className="tag-manager-select"
                        value={statusFilter}
                        onChange={setStatusFilter}
                        usePortal
                        portalOffset={0}
                        options={[
                            { value: 'all', label: t('all', 'All') },
                            { value: 'linked', label: t('funscriptStatusLinked', 'Linked') },
                            { value: 'multi-axis', label: t('funscriptStatusMultiAxis', 'Multi-axis') },
                            { value: 'multiple', label: t('funscriptStatusMultiple', 'Multiple') },
                            { value: 'missing', label: t('funscriptStatusMissing', 'Missing') },
                            { value: 'orphan', label: t('funscriptStatusOrphan', 'Orphan') },
                        ]}
                    />
                    <div className="library-view-controls" style={{ marginLeft: 0 }}>
                        <button
                            className={`library-view-btn icon-only ${viewMode === 'grid' ? 'active' : ''}`}
                            onClick={() => setViewMode('grid')}
                            title={t('gridView', 'Grid')}
                            aria-label={t('gridView', 'Grid')}
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <rect x="1.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                                <rect x="9.5" y="1.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                                <rect x="1.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                                <rect x="9.5" y="9.5" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
                            </svg>
                        </button>
                        <button
                            className={`library-view-btn icon-only list-icon ${viewMode === 'list' ? 'active' : ''}`}
                            onClick={() => setViewMode('list')}
                            title={t('listView', 'Liste')}
                            aria-label={t('listView', 'Liste')}
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                <line x1="4" y1="4" x2="12" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                <line x1="4" y1="12" x2="12" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                        </button>
                    </div>
                    <button className="btn btn-primary" onClick={runScan} disabled={busyAction === 'scan'}>
                        {busyAction === 'scan' ? t('loadingLoad', 'Loading...') : t('funscriptManagerScan', 'Scan')}
                    </button>
                </div>
            </div>
            )}

            {activeTab === 'history' && (
            <div className="settings-section funscript-history-section funscript-tab-panel">
                <div className="settings-section-subtitle">{t('funscriptHistoryTitle', 'Recent changes')}</div>
                <div className="funscript-history-list custom-scrollbar">
                    {historyItems.length === 0 ? (
                        <div className="tag-empty">{t('funscriptHistoryEmpty', 'No recent changes')}</div>
                    ) : historyItems.map((entry) => (
                        <div className="funscript-history-item" key={entry.id}>
                            <div className="funscript-history-main">
                                <span className="funscript-history-action">{historyActionLabel(entry.action)}</span>
                                <span className="funscript-history-video" title={entry.videoPath || ''}>
                                    {entry.videoTitle || '-'}
                                </span>
                                <span className="funscript-history-sep">•</span>
                                <span className="funscript-history-path" title={entry.scriptPath || ''}>
                                    {fileNameFromPath(entry.scriptPath) || '-'}
                                </span>
                                {entry.axis ? <span className="funscript-history-axis">{String(entry.axis).toUpperCase()}</span> : null}
                            </div>
                            <span className="funscript-history-time">{formatHistoryTime(entry.createdAt)}</span>
                        </div>
                    ))}
                </div>
            </div>
            )}

            {activeTab === 'manage' && (
            <div className={`settings-section tag-manager-list funscript-manager-list funscript-tab-panel ${viewMode === 'grid' ? 'grid-mode' : 'list-mode'}`}>
                {loading ? (
                    <div className="tag-empty">{t('loadingLoad', 'Loading...')}</div>
                ) : items.length === 0 ? (
                    <div className="tag-empty">{t('noResults', 'No results')}</div>
                ) : (
                    items.map((item) => (
                        <div className={`tag-manager-item funscript-manager-item ${viewMode === 'grid' ? 'grid-card' : 'list-row'}`} key={item.videoId}>
                            <div className="funscript-manager-thumb-wrap">
                                <img
                                    className="funscript-manager-thumb"
                                    src={`/api/videos/${encodeURIComponent(item.videoId)}/thumbnail?fast=1`}
                                    alt={item.title || 'thumbnail'}
                                    loading="lazy"
                                />
                            </div>
                            <div className="tag-manager-main">
                                <div className="tag-manager-name">{item.title || item.videoId}</div>
                                <div className="tag-manager-counts">
                                    <span className={`funscript-status-badge status-${item.status || 'missing'}`}>
                                        {getStatusLabel(item.status)}
                                    </span>
                                    <span>{t('funscriptMappings', 'Mappings')}: {Number(item.mappingCount || 0)}</span>
                                    <span>{item.filePath || ''}</span>
                                </div>
                            </div>
                            <div className="tag-manager-actions">
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => onOpenVideoInLibrary?.({
                                        videoId: item.videoId,
                                        libraryId: item.libraryId,
                                        title: item.title,
                                    })}
                                >
                                    {t('goToLibrary', 'Go to library')}
                                </button>
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => {
                                        setManageVideoId(item.videoId);
                                        setLinkDraft({ scriptPath: '', axis: 'main', label: '' });
                                    }}
                                >
                                    {t('manage', 'Manage')}
                                </button>
                            </div>
                        </div>
                    ))
                )}
                {!loading && items.length > 0 ? (
                    <div className="funscript-manager-pagination-info">
                        {items.length}/{Math.max(totalItems, items.length)}
                    </div>
                ) : null}
                {loadingMore ? <div className="tag-empty">{t('loadingLoad', 'Loading...')}</div> : null}
                {!loading && !loadingMore && !hasMore && items.length > 0 ? (
                    <div className="tag-empty">{t('done', 'Done')}</div>
                ) : null}
                <div ref={sentinelRef} className="funscript-manager-sentinel" aria-hidden="true" />
            </div>
            )}

            {activeItem && (
                <div className="modal-overlay" onClick={() => setManageVideoId('')}>
                    <div className="modal tag-modal funscript-manager-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('funscriptManagerManageFor', 'Manage scripts')}: {activeItem.title}</h2>
                            <button className="modal-close" onClick={() => setManageVideoId('')} title={t('close', 'Close')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body custom-scrollbar">
                            <div className="funscript-manager-linked">
                                {(activeItem.mappings || []).length === 0 ? (
                                    <div className="tag-empty">{t('funscriptManagerNoMappings', 'No mapped scripts yet')}</div>
                                ) : (
                                    (activeItem.mappings || []).map((mapping) => (
                                        <div className="funscript-mapping-row" key={mapping.id}>
                                            <div className="funscript-mapping-main">
                                                <div className="funscript-mapping-line">
                                                    <span className="funscript-mapping-axis">{String(mapping.axis || 'main').toUpperCase()}</span>
                                                    {!!mapping.label && <span>{mapping.label}</span>}
                                                    {mapping.isDefault ? <span className="funscript-default-pill">{t('default', 'Default')}</span> : null}
                                                    {!mapping.exists ? <span className="funscript-missing-pill">{t('missing', 'Missing')}</span> : null}
                                                </div>
                                                <div className="funscript-mapping-path" title={mapping.scriptPath}>
                                                    {fileNameFromPath(mapping.scriptPath)}
                                                </div>
                                                <div className="funscript-mapping-preview">
                                                    {mappingPreviews?.[mapping.id]?.loading ? (
                                                        <div className="tag-empty">{t('loadingLoad', 'Loading...')}</div>
                                                    ) : Array.isArray(mappingPreviews?.[mapping.id]?.actions) && mappingPreviews[mapping.id].actions.length >= 2 ? (
                                                        <>
                                                            <FunscriptHeatmap
                                                                actions={mappingPreviews[mapping.id].actions}
                                                                durationMs={Number(mappingPreviews[mapping.id]?.stats?.durationMs || 0)}
                                                                width={360}
                                                                height={8}
                                                                className="funscript-mapping-heatmap"
                                                            />
                                                            <div className="funscript-mapping-stats">
                                                                <span>{t('actionsLabel', 'Actions')}: {Number(mappingPreviews[mapping.id]?.stats?.count || 0)}</span>
                                                                <span>{t('duration', 'Duration')}: {formatDuration(mappingPreviews[mapping.id]?.stats?.durationMs || 0)}</span>
                                                                <span>{t('funscriptRange', 'Range')}: {Math.round(Number(mappingPreviews[mapping.id]?.stats?.minPos || 0))}-{Math.round(Number(mappingPreviews[mapping.id]?.stats?.maxPos || 0))}</span>
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <div className="tag-empty">{t('funscriptPreviewUnavailable', 'No preview data')}</div>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="funscript-mapping-actions">
                                                <button
                                                    className="btn btn-secondary"
                                                    onClick={() => setDefault(mapping.id)}
                                                    disabled={busyAction === `default:${mapping.id}` || mapping.isDefault}
                                                >
                                                    {t('setDefault', 'Set default')}
                                                </button>
                                                <button
                                                    className="btn btn-danger"
                                                    onClick={() => unlink(mapping.id)}
                                                    disabled={busyAction === `unlink:${mapping.id}`}
                                                >
                                                    {t('remove', 'Remove')}
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>

                            <div className="funscript-link-form">
                                <div className="playlist-dialog-label">{t('funscriptManagerAddScript', 'Script hinzufügen')}</div>
                                <div className="funscript-link-grid">
                                    <div className="funscript-link-block">
                                        <div className="funscript-link-block-label">{t('path', 'Path')}</div>
                                        {isRemote ? (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
                                                <div className="settings-input-row funscript-link-path-row">
                                                    <input
                                                        type="text"
                                                        className="add-library-name"
                                                        style={{ flex: 1 }}
                                                        value={linkDraft.scriptPath}
                                                        onChange={(e) => setLinkDraft((prev) => ({ ...prev, scriptPath: e.target.value }))}
                                                        onKeyDown={(e) => { if (e.key === 'Enter' && linkDraft.scriptPath.trim()) { const d = linkDraft.scriptPath.trim().replace(/[^/\\]*$/, '').replace(/[/\\]$/, '') || '/'; loadFsBrowserDir(d); setFsBrowserOpen(true); } }}
                                                        placeholder="/mnt/media/scripts/video.funscript"
                                                    />
                                                    <button
                                                        className="btn btn-secondary"
                                                        type="button"
                                                        style={{ whiteSpace: 'nowrap' }}
                                                        onClick={() => { if (!fsBrowserOpen) loadFsBrowserDir(fsBrowserPath || '/'); setFsBrowserOpen((v) => !v); }}
                                                    >{t('browse', 'Browse')}</button>
                                                    <label
                                                        className="btn btn-secondary"
                                                        style={{ whiteSpace: 'nowrap', cursor: busyAction === 'upload' ? 'wait' : 'pointer', opacity: busyAction === 'upload' ? 0.6 : 1 }}
                                                        title={`${t('uploadTo', 'Upload to')}: ${fsBrowserPath || '/'}`}
                                                    >
                                                        {busyAction === 'upload' ? '...' : t('upload', 'Upload')}
                                                        <input type="file" accept=".funscript" style={{ display: 'none' }} disabled={busyAction === 'upload'} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUploadFunscript(f); }} />
                                                    </label>
                                                </div>
                                                {fsBrowserOpen && (
                                                    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '6px', maxHeight: '180px', overflow: 'auto', background: 'var(--bg-card)' }}>
                                                        <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--border-subtle)', fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
                                                            {fsBrowserParent !== null && (
                                                                <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '14px', padding: '0 4px', lineHeight: 1 }}
                                                                    onClick={() => loadFsBrowserDir(fsBrowserParent)} title={t('goUp', 'Go up')}>↑</button>
                                                            )}
                                                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fsBrowserPath}</span>
                                                            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '12px', padding: '0 4px', lineHeight: 1 }}
                                                                onClick={() => setFsBrowserOpen(false)}>✕</button>
                                                        </div>
                                                        {fsBrowserLoading ? (
                                                            <div style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '12px' }}>{t('loading', 'Laden...')}</div>
                                                        ) : fsBrowserError ? (
                                                            <div style={{ padding: '8px 12px', color: '#ef4444', fontSize: '12px' }}>{fsBrowserError}</div>
                                                        ) : (
                                                            <>
                                                                {fsBrowserDirs.map((d) => (
                                                                    <div key={d.path} style={{ padding: '5px 12px', cursor: 'pointer', fontSize: '12px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '6px' }}
                                                                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))'}
                                                                        onMouseLeave={(e) => e.currentTarget.style.background = ''}
                                                                        onClick={() => loadFsBrowserDir(d.path)}>📁 {d.name}</div>
                                                                ))}
                                                                {fsBrowserFiles.length === 0 && fsBrowserDirs.length === 0 && (
                                                                    <div style={{ padding: '8px 12px', color: 'var(--text-secondary)', fontSize: '12px' }}>{t('noFunscriptsFound', 'No funscripts found')}</div>
                                                                )}
                                                                {fsBrowserFiles.map((f) => (
                                                                    <div key={f.path} style={{ padding: '5px 12px', cursor: 'pointer', fontSize: '12px', color: 'var(--accent-primary)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 500 }}
                                                                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))'}
                                                                        onMouseLeave={(e) => e.currentTarget.style.background = ''}
                                                                        onClick={() => { setLinkDraft((prev) => ({ ...prev, scriptPath: f.path })); setFsBrowserOpen(false); }}>📄 {f.name}</div>
                                                                ))}
                                                            </>
                                                        )}
                                                    </div>
                                                )}
                                                {fsBrowserPath && fsBrowserPath !== '/' && (
                                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                                        {t('uploadDestination', 'Upload destination')}: <code style={{ fontSize: '11px' }}>{fsBrowserPath}</code>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="settings-input-row funscript-link-path-row">
                                                <div className="funscript-picked-path" title={linkDraft.scriptPath || ''}>
                                                    {linkDraft.scriptPath || t('funscriptManagerNoFileSelected', 'No script selected')}
                                                </div>
                                                <button className="btn btn-secondary" type="button" onClick={pickScriptFile}>
                                                    {t('browse', 'Browse')}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="funscript-link-block">
                                        <div className="funscript-link-block-label">{t('funscriptManagerAddMapping', 'Add mapping')}</div>
                                        <div className="settings-input-row funscript-link-row">
                                            <AppDropdown
                                                className="tag-manager-select"
                                                value={linkDraft.axis}
                                                onChange={(val) => setLinkDraft((prev) => ({ ...prev, axis: val || 'main' }))}
                                                usePortal
                                                portalOffset={0}
                                                options={[
                                                    { value: 'main', label: t('axisMain', 'Main') },
                                                    { value: 'roll', label: t('axisRoll', 'Roll') },
                                                    { value: 'twist', label: t('axisTwist', 'Twist') },
                                                    { value: 'surge', label: t('axisSurge', 'Surge') },
                                                    { value: 'sway', label: t('axisSway', 'Sway') },
                                                    { value: 'pitch', label: t('axisPitch', 'Pitch') },
                                                ]}
                                            />
                                            <input
                                                type="text"
                                                value={linkDraft.label}
                                                onChange={(e) => setLinkDraft((prev) => ({ ...prev, label: e.target.value }))}
                                                placeholder={t('labelOptional', 'Label (optional)')}
                                            />
                                            <button className="btn btn-primary" onClick={linkScript} disabled={busyAction === 'link' || !linkDraft.scriptPath.trim()}>
                                                {busyAction === 'link' ? t('saving', 'Saving...') : t('add', 'Add')}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setManageVideoId('')}>
                                {t('close', 'Close')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default FunscriptManager;
