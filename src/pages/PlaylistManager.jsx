import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import AppDropdown from '../components/AppDropdown';
import useDialogHotkeys from '../hooks/useDialogHotkeys';
import { useI18n } from '../i18n';

function formatDuration(totalSec) {
    const n = Math.max(0, Math.floor(Number(totalSec || 0)));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}m`;
}

function formatDate(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '-';
    try { return new Date(n).toLocaleString(); } catch { return '-'; }
}

function PlaylistManager({ onOpenPlaylists }) {
    const { t } = useI18n();
    const [activeTab, setActiveTab] = useState('manage');
    const [loading, setLoading] = useState(true);
    const [busyAction, setBusyAction] = useState('');
    const [playlists, setPlaylists] = useState([]);
    const [historyItems, setHistoryItems] = useState([]);
    const [search, setSearch] = useState('');
    const [sortBy, setSortBy] = useState('manual');
    const [order, setOrder] = useState('asc');
    const [selectedIds, setSelectedIds] = useState([]);
    const [mergeTargetId, setMergeTargetId] = useState('');
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [renameDialog, setRenameDialog] = useState(null);
    const [createDialog, setCreateDialog] = useState(null);
    const [copyDialog, setCopyDialog] = useState(null);
    const [dragPlaylistId, setDragPlaylistId] = useState('');
    const [toast, setToast] = useState(null);
    const playlistRowRefs = useRef(new Map());
    const playlistOrderIdsRef = useRef([]);
    const playlistHoldTimerRef = useRef(null);
    const playlistDragStateRef = useRef(null);

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 2600);
    };

    const loadHistory = async () => {
        try {
            const res = await fetch('/api/playlists/history?limit=80');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to load history');
            setHistoryItems(Array.isArray(data?.items) ? data.items : []);
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
            setHistoryItems([]);
        }
    };

    const loadPlaylists = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/playlists/manager');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to load playlists');
            const next = Array.isArray(data?.playlists) ? data.playlists : [];
            setPlaylists(next);
            if (!mergeTargetId && next.length > 0) setMergeTargetId(String(next[0].id || ''));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
            setPlaylists([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadPlaylists();
        loadHistory();
    }, []);

    const visiblePlaylists = useMemo(() => {
        const query = String(search || '').trim().toLowerCase();
        const sorted = [...playlists]
            .filter((pl) => !query || String(pl?.name || '').toLowerCase().includes(query))
            .sort((a, b) => {
                const dir = order === 'desc' ? -1 : 1;
                if (sortBy === 'manual') return (Number(a?.sortIndex || 0) - Number(b?.sortIndex || 0)) * dir;
                if (sortBy === 'count') return (Number(a?.itemCount || 0) - Number(b?.itemCount || 0)) * dir;
                if (sortBy === 'duration') return (Number(a?.totalDurationSec || 0) - Number(b?.totalDurationSec || 0)) * dir;
                if (sortBy === 'updated') return (Number(a?.updatedAt || 0) - Number(b?.updatedAt || 0)) * dir;
                return String(a?.name || '').localeCompare(String(b?.name || '')) * dir;
            });
        return sorted;
    }, [playlists, search, sortBy, order]);

    useEffect(() => {
        playlistOrderIdsRef.current = [...playlists]
            .sort((a, b) => Number(a?.sortIndex || 0) - Number(b?.sortIndex || 0))
            .map((pl) => String(pl.id || ''))
            .filter(Boolean);
    }, [playlists]);

    useEffect(() => {
        setSelectedIds((prev) => prev.filter((id) => playlists.some((pl) => String(pl.id) === String(id))));
        if (mergeTargetId && !playlists.some((pl) => String(pl.id) === String(mergeTargetId))) setMergeTargetId('');
    }, [playlists, mergeTargetId]);

    const mergeSourceIds = useMemo(() => (
        selectedIds.filter((id) => String(id) !== String(mergeTargetId))
    ), [selectedIds, mergeTargetId]);

    const toggleSelected = (playlistId) => {
        const id = String(playlistId || '');
        setSelectedIds((prev) => (
            prev.includes(id)
                ? prev.filter((next) => next !== id)
                : [...prev, id]
        ));
    };

    const refreshAfterMutate = async (nextPlaylists = null) => {
        if (Array.isArray(nextPlaylists)) setPlaylists(nextPlaylists);
        else await loadPlaylists();
        await loadHistory();
        window.dispatchEvent(new Event('playlists-changed'));
    };

    const renamePlaylist = async (playlistId, name) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        setBusyAction(`rename:${playlistId}`);
        try {
            const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Rename failed');
            await refreshAfterMutate();
            showToast(t('saved', 'Saved'));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const deletePlaylist = async (playlistId) => {
        setBusyAction(`delete:${playlistId}`);
        try {
            const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Delete failed');
            await refreshAfterMutate();
            setSelectedIds((prev) => prev.filter((id) => id !== String(playlistId)));
            if (String(mergeTargetId) === String(playlistId)) setMergeTargetId('');
            showToast(t('deleted', 'Deleted'));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const createPlaylist = async (name) => {
        const trimmed = String(name || '').trim();
        if (!trimmed) return;
        setBusyAction('create');
        try {
            const res = await fetch('/api/playlists', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Create failed');
            await refreshAfterMutate();
            const createdId = String(data?.playlist?.id || '');
            if (createdId) {
                setSelectedIds((prev) => [...new Set([...prev, createdId])]);
            }
            showToast(t('created', 'Created'));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const copyPlaylist = async (sourceId, name) => {
        const sourcePlaylistId = String(sourceId || '').trim();
        const trimmed = String(name || '').trim();
        if (!sourcePlaylistId || !trimmed) return;
        setBusyAction(`copy:${sourcePlaylistId}`);
        try {
            const sourceRes = await fetch(`/api/playlists/${encodeURIComponent(sourcePlaylistId)}/videos`);
            const sourceData = await sourceRes.json().catch(() => ({}));
            if (!sourceRes.ok) throw new Error(sourceData?.error || 'Load source playlist failed');
            const sourceVideos = Array.isArray(sourceData?.videos) ? sourceData.videos : [];
            const videoPaths = sourceVideos
                .map((v) => String(v?.filePath || '').trim())
                .filter(Boolean);

            let createdPlaylistId = '';
            if (videoPaths.length === 0) {
                const createOnlyRes = await fetch('/api/playlists', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: trimmed }),
                });
                const createOnlyData = await createOnlyRes.json().catch(() => ({}));
                if (!createOnlyRes.ok) throw new Error(createOnlyData?.error || 'Copy failed');
                createdPlaylistId = String(createOnlyData?.playlist?.id || '');
            } else {
                const createRes = await fetch('/api/playlists/add', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        playlistName: trimmed,
                        videoPaths,
                    }),
                });
                const createData = await createRes.json().catch(() => ({}));
                if (!createRes.ok) throw new Error(createData?.error || 'Copy failed');
                createdPlaylistId = String(createData?.playlist?.id || '');
            }
            await refreshAfterMutate();
            const createdId = createdPlaylistId;
            if (createdId) {
                setSelectedIds((prev) => [...new Set([...prev, createdId])]);
            }
            showToast(t('copied', 'Copied'));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const mergePlaylists = async (deleteSources) => {
        if (!mergeTargetId || mergeSourceIds.length === 0) return;
        setBusyAction('merge');
        try {
            const res = await fetch('/api/playlists/manager/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    targetId: mergeTargetId,
                    sourceIds: mergeSourceIds,
                    deleteSources: deleteSources === true,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Merge failed');
            setSelectedIds([String(mergeTargetId)]);
            await refreshAfterMutate(Array.isArray(data?.playlists) ? data.playlists : null);
            showToast(`${t('done', 'Done')}: +${Number(data?.addedCount || 0)}`);
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const applyOrderIds = async (orderedIds) => {
        setBusyAction('order');
        try {
            const res = await fetch('/api/playlists/manager/order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Order update failed');
            await refreshAfterMutate(Array.isArray(data?.playlists) ? data.playlists : null);
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const setPlaylistOrderLocally = (orderedIds) => {
        const ids = Array.isArray(orderedIds) ? orderedIds.map((id) => String(id || '')).filter(Boolean) : [];
        if (!ids.length) return;
        playlistOrderIdsRef.current = ids;
        flushSync(() => {
            setPlaylists((prev) => {
                const source = Array.isArray(prev) ? prev : [];
                const byId = new Map(source.map((pl) => [String(pl.id || ''), pl]));
                const reordered = [];
                for (const id of ids) {
                    const hit = byId.get(id);
                    if (hit) reordered.push(hit);
                }
                for (const pl of source) {
                    const id = String(pl?.id || '');
                    if (!id || ids.includes(id)) continue;
                    reordered.push(pl);
                }
                return reordered.map((pl, idx) => ({ ...pl, sortIndex: idx }));
            });
        });
    };

    const reanchorDraggingRow = (state, el) => {
        if (!state || !el) return;
        const pointerX = Number(state.pointerX || state.startX || 0);
        const pointerY = Number(state.pointerY || state.startY || 0);
        const prevTransition = el.style.transition;
        const prevTransform = el.style.transform;
        el.style.transition = 'none';
        el.style.transform = 'none';
        const rect = el.getBoundingClientRect();
        el.style.transform = prevTransform;
        el.style.transition = prevTransition;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = pointerX - pointerOffsetX;
        const desiredTop = pointerY - pointerOffsetY;
        state.originLeft = rect.left;
        state.originTop = rect.top;
        state.currentTx = desiredLeft - rect.left;
        state.currentTy = desiredTop - rect.top;
        state.currentTilt = Number(state.currentTilt || 0);
        el.style.transformOrigin = `${pointerOffsetX}px ${pointerOffsetY}px`;
        el.style.transform = `translate3d(${state.currentTx}px, ${state.currentTy}px, 0) rotate(${state.currentTilt}deg)`;
    };

    const applyDraggingTransform = (state, el, clientX, clientY, immediate = false) => {
        if (!state || !el) return;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = Number(clientX || 0) - pointerOffsetX;
        const desiredTop = Number(clientY || 0) - pointerOffsetY;
        const targetTx = desiredLeft - Number(state.originLeft || 0);
        const targetTy = desiredTop - Number(state.originTop || 0);
        const nextTx = Number(state.currentTx || 0) + (targetTx - Number(state.currentTx || 0)) * (immediate ? 1 : 0.9);
        const nextTy = Number(state.currentTy || 0) + (targetTy - Number(state.currentTy || 0)) * (immediate ? 1 : 0.9);
        const vx = Number(clientX || 0) - (state.lastX ?? Number(clientX || 0));
        const targetTilt = Math.max(-1.3, Math.min(1.3, vx * 0.05));
        const nextTilt = Number(state.currentTilt || 0) + (targetTilt - Number(state.currentTilt || 0)) * (immediate ? 1 : 0.45);
        state.currentTx = Math.abs(nextTx) < 0.15 ? 0 : nextTx;
        state.currentTy = Math.abs(nextTy) < 0.15 ? 0 : nextTy;
        state.currentTilt = Math.abs(nextTilt) < 0.04 ? 0 : nextTilt;
        state.lastX = Number(clientX || 0);
        el.style.transform = `translate3d(${state.currentTx}px, ${state.currentTy}px, 0) rotate(${state.currentTilt}deg)`;
    };

    const animatePlaylistReorder = (nextOrderIds, activeDragId = '') => {
        const nextIds = Array.isArray(nextOrderIds) ? nextOrderIds.map((id) => String(id || '')).filter(Boolean) : [];
        if (!nextIds.length) return;
        const activeId = String(activeDragId || '');
        const dragState = playlistDragStateRef.current;

        const firstRects = new Map();
        for (const id of nextIds) {
            const el = playlistRowRefs.current.get(id);
            if (!el) continue;
            firstRects.set(id, el.getBoundingClientRect());
        }

        setPlaylistOrderLocally(nextIds);

        if (activeId && dragState && String(dragState.playlistId || '') === activeId) {
            const activeElAfter = playlistRowRefs.current.get(activeId);
            if (activeElAfter) {
                activeElAfter.style.pointerEvents = 'none';
                activeElAfter.style.zIndex = '40';
                activeElAfter.style.transition = 'none';
                activeElAfter.style.willChange = 'transform';
                activeElAfter.style.transformOrigin = `${Number(dragState.pointerOffsetX || 0)}px ${Number(dragState.pointerOffsetY || 0)}px`;
                dragState.dragEl = activeElAfter;
                reanchorDraggingRow(dragState, activeElAfter);
            }
        }

        const toAnimate = [];
        for (const id of nextIds) {
            if (id === activeId) continue;
            const el = playlistRowRefs.current.get(id);
            const first = firstRects.get(id);
            if (!el || !first) continue;
            const last = el.getBoundingClientRect();
            const dx = first.left - last.left;
            const dy = first.top - last.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
            toAnimate.push({ el, dx, dy });
        }

        if (!toAnimate.length) return;
        for (const { el, dx, dy } of toAnimate) {
            el.style.willChange = 'transform';
            el.style.transition = 'none';
            el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        }
        requestAnimationFrame(() => {
            for (const { el } of toAnimate) {
                el.style.transition = 'transform 520ms cubic-bezier(0.16, 1, 0.3, 1)';
                el.style.transform = 'translate3d(0, 0, 0)';
                const cleanup = () => {
                    el.style.transition = '';
                    el.style.transform = '';
                    el.style.willChange = '';
                    el.removeEventListener('transitionend', cleanup);
                };
                el.addEventListener('transitionend', cleanup);
                window.setTimeout(cleanup, 680);
            }
        });
    };

    const buildManualReorder = (dragId, targetId, before) => {
        const baseOrder = [...playlists]
            .sort((a, b) => Number(a?.sortIndex || 0) - Number(b?.sortIndex || 0))
            .map((pl) => String(pl.id || ''))
            .filter(Boolean);
        if (!baseOrder.includes(dragId) || !baseOrder.includes(targetId)) return null;
        const rest = baseOrder.filter((id) => id !== dragId);
        const targetIndex = rest.indexOf(targetId);
        if (targetIndex < 0) return null;
        const insertIndex = before ? targetIndex : targetIndex + 1;
        rest.splice(insertIndex, 0, dragId);
        return rest;
    };

    const undoHistoryEntry = async (historyId) => {
        const id = String(historyId || '').trim();
        if (!id) return;
        setBusyAction(`undo:${id}`);
        try {
            const res = await fetch(`/api/playlists/history/${encodeURIComponent(id)}/undo`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Undo failed');
            await refreshAfterMutate(Array.isArray(data?.playlists) ? data.playlists : null);
            showToast(t('done', 'Done'));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const historyActionLabel = (action) => {
        const a = String(action || '').toLowerCase();
        if (a === 'rename') return t('playlistHistoryRename', 'Renamed');
        if (a === 'bulk-rename') return t('playlistHistoryBulkRename', 'Bulk renamed');
        if (a === 'delete') return t('playlistHistoryDelete', 'Deleted');
        if (a === 'bulk-delete') return t('playlistHistoryBulkDelete', 'Bulk deleted');
        if (a === 'merge') return t('playlistHistoryMerge', 'Merged');
        if (a === 'order') return t('playlistHistoryOrder', 'Order changed');
        return a || t('unknown', 'Unknown');
    };

    const historySummary = (entry) => {
        const payload = entry?.payload || {};
        const action = String(entry?.action || '').toLowerCase();
        if (action === 'merge') {
            const targetId = String(payload?.targetId || '');
            const target = playlists.find((pl) => String(pl.id) === targetId);
            return `${t('targetPlaylist', 'Target playlist')}: ${target?.name || targetId || '-'}`;
        }
        if (action === 'rename' || action === 'bulk-rename') {
            const count = Array.isArray(payload?.changes) ? payload.changes.length : 0;
            return `${count} ${t('playlists', 'Playlists')}`;
        }
        if (action === 'delete' || action === 'bulk-delete') {
            const count = Array.isArray(payload?.snapshots) ? payload.snapshots.length : 0;
            return `${count} ${t('playlists', 'Playlists')}`;
        }
        if (action === 'order') {
            const count = Array.isArray(payload?.appliedOrderIds) ? payload.appliedOrderIds.length : 0;
            return `${count} ${t('playlists', 'Playlists')}`;
        }
        return '-';
    };

    useDialogHotkeys(Boolean(confirmDialog), {
        onCancel: () => setConfirmDialog(null),
        onConfirm: () => confirmDialog?.onConfirm?.(),
    });

    useDialogHotkeys(Boolean(renameDialog), {
        onCancel: () => setRenameDialog(null),
        onConfirm: () => {
            if (!renameDialog?.id) return;
            const nextName = String(renameDialog?.name || '').trim();
            if (!nextName) return;
            renamePlaylist(renameDialog.id, nextName);
            setRenameDialog(null);
        },
    });

    useDialogHotkeys(Boolean(createDialog), {
        onCancel: () => setCreateDialog(null),
        onConfirm: () => {
            const nextName = String(createDialog?.name || '').trim();
            if (!nextName || busyAction === 'create') return;
            createPlaylist(nextName);
            setCreateDialog(null);
        },
        canConfirm: !!String(createDialog?.name || '').trim() && busyAction !== 'create',
    });

    useDialogHotkeys(Boolean(copyDialog), {
        onCancel: () => setCopyDialog(null),
        onConfirm: () => {
            const sourceId = String(copyDialog?.sourceId || '').trim();
            const nextName = String(copyDialog?.name || '').trim();
            if (!sourceId || !nextName || busyAction === `copy:${sourceId}`) return;
            copyPlaylist(sourceId, nextName);
            setCopyDialog(null);
        },
        canConfirm: !!String(copyDialog?.sourceId || '').trim() && !!String(copyDialog?.name || '').trim(),
    });

    const cleanupDragRowStyles = (state) => {
        const dragId = String(state?.playlistId || '');
        const mappedEl = dragId ? playlistRowRefs.current.get(dragId) : null;
        if (state?.dragEl) {
            state.dragEl.style.pointerEvents = '';
            state.dragEl.style.zIndex = '';
            state.dragEl.style.transform = '';
            state.dragEl.style.transition = '';
            state.dragEl.style.willChange = '';
            state.dragEl.style.transformOrigin = '';
        }
        if (mappedEl && mappedEl !== state?.dragEl) {
            mappedEl.style.pointerEvents = '';
            mappedEl.style.zIndex = '';
            mappedEl.style.transform = '';
            mappedEl.style.transition = '';
            mappedEl.style.willChange = '';
            mappedEl.style.transformOrigin = '';
        }
    };

    const onPlaylistMouseMove = (e) => {
        const state = playlistDragStateRef.current;
        if (!state) return;
        state.pointerX = e.clientX;
        state.pointerY = e.clientY;

        if (!state.dragging) {
            const dx = Math.abs(e.clientX - state.startX);
            const dy = Math.abs(e.clientY - state.startY);
            if (dx > 8 || dy > 8) {
                if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
                playlistHoldTimerRef.current = null;
                playlistDragStateRef.current = null;
                window.removeEventListener('mousemove', onPlaylistMouseMove);
                window.removeEventListener('mouseup', onPlaylistMouseUp);
            }
            return;
        }

        e.preventDefault();
        const draggingId = String(state.playlistId || '');
        if (!draggingId) return;

        const mappedEl = playlistRowRefs.current.get(draggingId);
        if (mappedEl && state.dragEl !== mappedEl) {
            cleanupDragRowStyles(state);
            state.dragEl = mappedEl;
            mappedEl.style.pointerEvents = 'none';
            mappedEl.style.zIndex = '40';
            mappedEl.style.transition = 'none';
            mappedEl.style.willChange = 'transform';
            mappedEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            reanchorDraggingRow(state, mappedEl);
        }
        const draggingEl = state.dragEl || mappedEl;
        if (draggingEl) applyDraggingTransform(state, draggingEl, state.pointerX, state.pointerY);

        const now = Date.now();
        if (now - Number(state.lastSwapTs || 0) < 130) return;
        const visibleIds = visiblePlaylists.map((pl) => String(pl.id || '')).filter(Boolean);
        if (visibleIds.length < 2 || !visibleIds.includes(draggingId)) return;

        const others = visibleIds.filter((id) => id !== draggingId);
        if (!others.length) return;

        let targetId = others[others.length - 1];
        let before = false;
        for (let i = 0; i < others.length; i++) {
            const el = playlistRowRefs.current.get(String(others[i]));
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const mid = r.top + (r.height / 2);
            if (e.clientY < mid) {
                targetId = others[i];
                before = true;
                break;
            }
            targetId = others[i];
            before = false;
        }

        const nextManual = buildManualReorder(draggingId, targetId, before);
        if (!nextManual || !nextManual.length) return;
        const currentManual = [...playlistOrderIdsRef.current];
        let changed = currentManual.length !== nextManual.length;
        if (!changed) {
            for (let i = 0; i < nextManual.length; i++) {
                if (nextManual[i] !== currentManual[i]) { changed = true; break; }
            }
        }
        if (!changed) return;

        const movedSinceSwap = Math.abs(e.clientY - Number(state.lastSwapY ?? state.startY ?? e.clientY));
        if (movedSinceSwap < 14) return;

        state.didSwap = true;
        state.lastSwapTs = now;
        state.lastSwapY = e.clientY;
        animatePlaylistReorder(nextManual, draggingId);
    };

    const onPlaylistMouseUp = () => {
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistHoldTimerRef.current = null;
        const state = playlistDragStateRef.current;
        playlistDragStateRef.current = null;
        window.removeEventListener('mousemove', onPlaylistMouseMove);
        window.removeEventListener('mouseup', onPlaylistMouseUp);
        document.body.style.userSelect = '';
        cleanupDragRowStyles(state);
        if (!state?.dragging) return;
        setDragPlaylistId('');
        if (state.didSwap) applyOrderIds(playlistOrderIdsRef.current);
    };

    const cancelPlaylistHoldIfPending = () => {
        const state = playlistDragStateRef.current;
        if (state?.dragging) return;
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistHoldTimerRef.current = null;
        playlistDragStateRef.current = null;
        document.body.style.userSelect = '';
    };

    const onPlaylistMouseDown = (e, playlistId) => {
        if (e.button !== 0) return;
        const interactive = e.target?.closest?.('button,input,select,textarea,a,label,.app-dropdown,.app-dropdown-control');
        if (interactive) return;
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        playlistDragStateRef.current = {
            playlistId: String(playlistId || ''),
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            didSwap: false,
            lastSwapTs: 0,
            lastSwapY: e.clientY,
        };
        window.addEventListener('mouseup', cancelPlaylistHoldIfPending, { once: true });
        playlistHoldTimerRef.current = setTimeout(() => {
            const state = playlistDragStateRef.current;
            if (!state || String(state.playlistId) !== String(playlistId)) return;
            state.dragging = true;
            state.lastX = state.startX;
            setDragPlaylistId(String(playlistId));
            document.body.style.userSelect = 'none';
            const dragEl = playlistRowRefs.current.get(String(playlistId));
            if (dragEl) {
                const rect = dragEl.getBoundingClientRect();
                state.dragEl = dragEl;
                state.pointerOffsetX = state.startX - rect.left;
                state.pointerOffsetY = state.startY - rect.top;
                state.originLeft = rect.left;
                state.originTop = rect.top;
                state.currentTx = 0;
                state.currentTy = 0;
                dragEl.style.pointerEvents = 'none';
                dragEl.style.zIndex = '40';
                dragEl.style.transition = 'none';
                dragEl.style.willChange = 'transform';
                dragEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            }
            window.addEventListener('mousemove', onPlaylistMouseMove);
            window.addEventListener('mouseup', onPlaylistMouseUp);
        }, 260);
    };

    useEffect(() => () => {
        if (playlistHoldTimerRef.current) clearTimeout(playlistHoldTimerRef.current);
        window.removeEventListener('mousemove', onPlaylistMouseMove);
        window.removeEventListener('mouseup', onPlaylistMouseUp);
    }, []);

    const canDrag = sortBy === 'manual' && order === 'asc' && !loading && busyAction !== 'order';

    return (
        <div className="settings-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t('playlistManagerTitle', 'Playlist Manager')}</h1>
                    <p className="page-subtitle">{t('playlistManagerSubtitle', 'Manage playlists: totals, rename, merge and remove')}</p>
                </div>
            </div>

            <div className="funscript-manager-tabbar-wrap">
                <div className="funscript-manager-tabs" role="tablist" aria-label={t('playlistManagerTabsAria', 'Playlist manager tabs')}>
                    <button type="button" className={`funscript-manager-tab ${activeTab === 'manage' ? 'active' : ''}`} onClick={() => setActiveTab('manage')} role="tab" aria-selected={activeTab === 'manage'}>
                        {t('manage', 'Manage')}
                    </button>
                    <button type="button" className={`funscript-manager-tab ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')} role="tab" aria-selected={activeTab === 'history'}>
                        {t('history', 'History')}
                    </button>
                </div>
            </div>

            {activeTab === 'manage' && (
                <>
                    <div className="settings-section funscript-manager-toolbar playlist-manager-toolbar">
                        <div className="settings-input-row">
                            <div className="settings-search-wrap">
                                <input type="text" placeholder={t('searchPlaylistsPlaceholder', 'Search playlists...')} value={search} onChange={(e) => setSearch(e.target.value)} />
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
                        </div>
                        <AppDropdown
                            className="tag-manager-select"
                            value={sortBy}
                            usePortal={true}
                            portalOffset={0}
                            onChange={(val) => setSortBy(val || 'manual')}
                            options={[
                                { value: 'manual', label: t('orderLabel', 'Order') },
                                { value: 'name', label: t('nameLabel', 'Name') },
                                { value: 'count', label: t('videos', 'Videos') },
                                { value: 'duration', label: t('duration', 'Duration') },
                                { value: 'updated', label: t('updatedAt', 'Updated') },
                            ]}
                        />
                        <AppDropdown className="tag-manager-select" value={order} usePortal={true} portalOffset={0} onChange={(val) => setOrder(val || 'asc')} options={[{ value: 'asc', label: t('sortAscending', 'Ascending') }, { value: 'desc', label: t('sortDescending', 'Descending') }]} />
                        <div className="playlist-manager-toolbar-actions">
                            <button className="btn btn-secondary" onClick={() => { loadPlaylists(); loadHistory(); }} disabled={loading || busyAction === 'merge'}>{t('refresh', 'Refresh')}</button>
                            <button className="btn btn-primary" onClick={() => setCreateDialog({ name: '' })} disabled={busyAction === 'create'}>{t('createPlaylist', 'Create playlist')}</button>
                        </div>
                    </div>

                    <div className="settings-section playlist-manager-merge">
                        <div className="settings-section-subtitle">{t('merge', 'Merge')}</div>
                        <div className="playlist-manager-merge-row">
                            <div className="playlist-manager-merge-text">{t('playlistManagerMergeHint', 'Select source playlists, choose a target, then merge.')}</div>
                            <AppDropdown className="tag-manager-select" value={mergeTargetId} usePortal={true} portalOffset={0} onChange={(val) => setMergeTargetId(String(val || ''))} options={playlists.map((pl) => ({ value: String(pl.id), label: String(pl.name || '') }))} placeholder={t('targetPlaylist', 'Target playlist')} />
                            <button className="btn btn-primary" disabled={busyAction === 'merge' || !mergeTargetId || mergeSourceIds.length === 0} onClick={() => setConfirmDialog({ title: t('playlistManagerMergeConfirm', 'Merge playlists?'), message: `${mergeSourceIds.length} ${t('playlists', 'Playlists')} -> ${playlists.find((pl) => String(pl.id) === String(mergeTargetId))?.name || '-'}`, confirmLabel: t('merge', 'Merge'), danger: false, onConfirm: async () => { setConfirmDialog(null); await mergePlaylists(false); } })}>{busyAction === 'merge' ? t('saving', 'Saving...') : t('merge', 'Merge')}</button>
                            <button className="btn btn-danger tag-manager-remove-btn" disabled={busyAction === 'merge' || !mergeTargetId || mergeSourceIds.length === 0} onClick={() => setConfirmDialog({ title: t('playlistManagerMergeDeleteConfirm', 'Merge and remove sources?'), message: t('playlistManagerMergeDeleteHint', 'Source playlists will be deleted after merge.'), confirmLabel: t('merge', 'Merge'), danger: true, onConfirm: async () => { setConfirmDialog(null); await mergePlaylists(true); } })}>{t('playlistManagerMergeDelete', 'Merge + remove')}</button>
                        </div>
                    </div>

                    <div className={`settings-section tag-manager-list funscript-manager-list playlist-manager-list list-mode ${dragPlaylistId ? 'is-reordering' : ''}`}>
                        {loading ? (
                            <div className="tag-empty">{t('loadingLoad', 'Loading...')}</div>
                        ) : visiblePlaylists.length === 0 ? (
                            <div className="tag-empty">{t('noPlaylistsYet', 'No playlists yet')}</div>
                        ) : (
                            visiblePlaylists.map((pl) => {
                                const id = String(pl.id || '');
                                const checked = selectedIds.includes(id);
                                return (
                                    <div
                                        key={id}
                                        ref={(node) => {
                                            if (!node) {
                                                playlistRowRefs.current.delete(id);
                                                return;
                                            }
                                            playlistRowRefs.current.set(id, node);
                                        }}
                                        className={`tag-manager-item funscript-manager-item list-row ${dragPlaylistId === id ? 'playlist-row-dragging' : ''} ${canDrag ? 'playlist-row-draggable' : ''}`}
                                        onMouseDown={(e) => {
                                            if (!canDrag) return;
                                            onPlaylistMouseDown(e, id);
                                        }}
                                    >
                                        <label className="tag-manager-check">
                                            <input type="checkbox" checked={checked} onChange={() => toggleSelected(id)} />
                                            <span />
                                        </label>
                                        <div className="tag-manager-main">
                                            <div className="tag-manager-name">{pl.name}</div>
                                            <div className="tag-manager-counts">
                                                <span>{Number(pl.itemCount || 0)} {Number(pl.itemCount || 0) === 1 ? t('video', 'Video') : t('videos', 'Videos')}</span>
                                                <span>{t('duration', 'Duration')}: {formatDuration(pl.totalDurationSec)}</span>
                                                <span>{new Date(Number(pl.updatedAt || pl.createdAt || Date.now())).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        <div className="tag-manager-actions playlist-row-actions">
                                            <button className="btn btn-secondary" onClick={() => onOpenPlaylists?.(id)}>{t('open', 'Open')}</button>
                                            <button className="btn btn-secondary" disabled={busyAction === `rename:${id}`} onClick={() => setRenameDialog({ id, name: String(pl.name || '') })}>{t('rename', 'Rename')}</button>
                                            <button className="btn btn-secondary" disabled={busyAction === `copy:${id}`} onClick={() => setCopyDialog({ sourceId: id, sourceName: String(pl.name || ''), name: `${String(pl.name || '').trim()} ${t('copySuffix', '(copy)')}`.trim() })}>{t('copy', 'Copy')}</button>
                                            <button className="btn btn-danger tag-manager-remove-btn" disabled={busyAction === `delete:${id}`} onClick={() => setConfirmDialog({ title: t('deletePlaylistTitle', 'Delete playlist'), message: `${t('deletePlaylistConfirm', 'Delete playlist?')}\n${pl.name}`, confirmLabel: t('delete', 'Delete'), danger: true, onConfirm: async () => { setConfirmDialog(null); await deletePlaylist(id); } })}>{t('delete', 'Delete')}</button>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </>
            )}

            {activeTab === 'history' && (
                <div className="settings-section funscript-history-section funscript-tab-panel">
                    <div className="settings-section-subtitle">{t('playlistHistoryTitle', 'Recent changes')}</div>
                    <div className="funscript-history-list custom-scrollbar">
                        {historyItems.length === 0 ? (
                            <div className="tag-empty">{t('playlistHistoryEmpty', 'No recent changes')}</div>
                        ) : historyItems.map((entry) => (
                            <div className="funscript-history-item" key={entry.id}>
                                <div className="funscript-history-main">
                                    <span className="funscript-history-action">{historyActionLabel(entry.action)}</span>
                                    <span className="funscript-history-video">{historySummary(entry)}</span>
                                </div>
                                <div className="tag-manager-actions" style={{ gridTemplateColumns: 'auto auto', minWidth: 0 }}>
                                    <span className="funscript-history-time">{formatDate(entry.createdAt)}</span>
                                    <button className="btn btn-secondary" disabled={Number(entry?.undoneAt || 0) > 0 || busyAction === `undo:${entry.id}`} onClick={() => undoHistoryEntry(entry.id)}>
                                        {Number(entry?.undoneAt || 0) > 0 ? t('undone', 'Undone') : t('undo', 'Undo')}
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {confirmDialog && (
                <div className="modal-overlay" onClick={() => setConfirmDialog(null)}>
                    <div className="modal tag-manager-confirm-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{confirmDialog.title}</h2>
                            <button className="modal-close" onClick={() => setConfirmDialog(null)} title={t('close', 'Close')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p className="tag-manager-confirm-text" style={{ whiteSpace: 'pre-line' }}>{confirmDialog.message}</p>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setConfirmDialog(null)}>{t('cancel', 'Cancel')}</button>
                            <button className={`btn ${confirmDialog.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => confirmDialog.onConfirm?.()}>{confirmDialog.confirmLabel}</button>
                        </div>
                    </div>
                </div>
            )}

            {createDialog && (
                <div className="modal-overlay" onClick={() => setCreateDialog(null)}>
                    <div className="modal tag-manager-confirm-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('createPlaylist', 'Create playlist')}</h2>
                            <button className="modal-close" onClick={() => setCreateDialog(null)} title={t('close', 'Close')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="settings-input-row">
                                <input type="text" value={String(createDialog?.name || '')} onChange={(e) => setCreateDialog((prev) => ({ ...(prev || {}), name: e.target.value }))} placeholder={t('playlistNamePlaceholder', 'Playlist name')} autoFocus />
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setCreateDialog(null)}>{t('cancel', 'Cancel')}</button>
                            <button className="btn btn-primary" onClick={() => {
                                const nextName = String(createDialog?.name || '').trim();
                                if (!nextName) return;
                                createPlaylist(nextName);
                                setCreateDialog(null);
                            }} disabled={!String(createDialog?.name || '').trim() || busyAction === 'create'}>
                                {t('create', 'Create')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {copyDialog && (
                <div className="modal-overlay" onClick={() => setCopyDialog(null)}>
                    <div className="modal tag-manager-confirm-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('copyPlaylist', 'Copy playlist')}</h2>
                            <button className="modal-close" onClick={() => setCopyDialog(null)} title={t('close', 'Close')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p className="tag-manager-confirm-text" style={{ marginBottom: 12 }}>
                                {t('sourcePlaylist', 'Source playlist')}: {String(copyDialog?.sourceName || '-')}
                            </p>
                            <div className="settings-input-row">
                                <input type="text" value={String(copyDialog?.name || '')} onChange={(e) => setCopyDialog((prev) => ({ ...(prev || {}), name: e.target.value }))} placeholder={t('playlistNamePlaceholder', 'Playlist name')} autoFocus />
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setCopyDialog(null)}>{t('cancel', 'Cancel')}</button>
                            <button className="btn btn-primary" onClick={() => {
                                const sourceId = String(copyDialog?.sourceId || '').trim();
                                const nextName = String(copyDialog?.name || '').trim();
                                if (!sourceId || !nextName) return;
                                copyPlaylist(sourceId, nextName);
                                setCopyDialog(null);
                            }} disabled={!String(copyDialog?.sourceId || '').trim() || !String(copyDialog?.name || '').trim() || busyAction === `copy:${String(copyDialog?.sourceId || '')}` }>
                                {t('copy', 'Copy')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {renameDialog && (
                <div className="modal-overlay" onClick={() => setRenameDialog(null)}>
                    <div className="modal tag-manager-confirm-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('renameTitle', 'Rename')}</h2>
                            <button className="modal-close" onClick={() => setRenameDialog(null)} title={t('close', 'Close')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="settings-input-row">
                                <input type="text" value={String(renameDialog?.name || '')} onChange={(e) => setRenameDialog((prev) => ({ ...(prev || {}), name: e.target.value }))} placeholder={t('renamePlaceholder', 'New name...')} autoFocus />
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setRenameDialog(null)}>{t('cancel', 'Cancel')}</button>
                            <button className="btn btn-primary" onClick={() => {
                                const nextName = String(renameDialog?.name || '').trim();
                                if (!nextName || !renameDialog?.id) return;
                                renamePlaylist(renameDialog.id, nextName);
                                setRenameDialog(null);
                            }} disabled={!String(renameDialog?.name || '').trim() || busyAction === `rename:${String(renameDialog?.id || '')}`}>
                                {t('rename', 'Rename')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default PlaylistManager;
