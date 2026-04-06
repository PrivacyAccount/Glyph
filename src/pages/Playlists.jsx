import React, { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import VideoCard from '../components/VideoCard';
import ContextMenu from '../components/ContextMenu';
import TagDialog from '../components/TagDialog';
import PlaylistManageDialog from '../components/PlaylistManageDialog';
import PropertiesDialog from '../components/PropertiesDialog';
import ThumbnailTimestampDialog from '../components/ThumbnailTimestampDialog';
import { useI18n } from '../i18n';
import useSelectionHotkeys from '../hooks/useSelectionHotkeys';

const playlistIcon = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <line x1="5" y1="7" x2="19" y2="7" />
        <line x1="5" y1="12" x2="19" y2="12" />
        <line x1="5" y1="17" x2="14" y2="17" />
        <path d="M17 16l2 2 4-4" />
    </svg>
);

function Playlists({ onPlay, onBackHome, onOpenPlaylistManager, initialPlaylistId = null, onOpenFunscriptManager, onOpenPerformer }) {
    const { t } = useI18n();
    const [playlists, setPlaylists] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activePlaylist, setActivePlaylist] = useState(null);
    const [videos, setVideos] = useState([]);
    const [search, setSearch] = useState('');
    const [filters, setFilters] = useState({ sort: 'playlist', sortOrder: 'asc', funscript: 'all', tag: '' });
    const [selectedKeys, setSelectedKeys] = useState([]);
    const [contextMenu, setContextMenu] = useState(null);
    const [tagDialog, setTagDialog] = useState(null);
    const [batchTagDialog, setBatchTagDialog] = useState(null);
    const [toast, setToast] = useState(null);
    const [toastClosing, setToastClosing] = useState(false);
    const [playlistManageDialog, setPlaylistManageDialog] = useState(null);
    const [propertiesVideo, setPropertiesVideo] = useState(null);
    const [thumbTimestampDialogVideo, setThumbTimestampDialogVideo] = useState(null);
    const [playlistPreviewById, setPlaylistPreviewById] = useState({});
    const [playlistPreviewErrorById, setPlaylistPreviewErrorById] = useState({});
    const [playlistPosterById, setPlaylistPosterById] = useState({});
    const [tagCategoryMap, setTagCategoryMap] = useState({});
    const [viewMode, setViewMode] = useState('grid');
    const [durationById, setDurationById] = useState({});
    const [durationSortResolving, setDurationSortResolving] = useState(false);
    const [durationRetryTick, setDurationRetryTick] = useState(0);
    const [draggingKey, setDraggingKey] = useState('');
    const durationLoadingRef = useRef(new Set());
    const selectionAnchorRef = useRef('');
    const initialPlaylistHandledRef = useRef(null);
    const toastTimerRef = useRef(null);
    const toastCloseTimerRef = useRef(null);
    const videoCardRefs = useRef(new Map());
    const videoOrderKeysRef = useRef([]);
    const videoHoldTimerRef = useRef(null);
    const videoDragStateRef = useRef(null);
    const suppressVideoClickRef = useRef(false);
    

    const dismissToast = (delayMs = 0) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
        const run = () => {
            setToastClosing(true);
            toastCloseTimerRef.current = setTimeout(() => {
                setToast(null);
                setToastClosing(false);
            }, 220);
        };
        if (delayMs > 0) toastTimerRef.current = setTimeout(run, delayMs);
        else run();
    };

    const showToast = (message, type = 'success', action = null) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
        setToastClosing(false);
        setToast({ message, type, action });
        dismissToast(action ? 6000 : 3000);
    };


    useEffect(() => {
        try {
            const rawMap = localStorage.getItem('playlistPosterById');
            const parsed = rawMap ? JSON.parse(rawMap) : {};
            setPlaylistPosterById(parsed && typeof parsed === 'object' ? parsed : {});
        } catch {
            setPlaylistPosterById({});
        }
    }, []);

    const persistPlaylistPosterMap = (nextMap) => {
        setPlaylistPosterById(nextMap);
        try {
            localStorage.setItem('playlistPosterById', JSON.stringify(nextMap));
            window.dispatchEvent(new Event('playlist-posters-changed'));
        } catch { }
    };

    const pickImage = () => {
        return new Promise(resolve => {
            if (window.electronAPI?.selectImage) {
                window.electronAPI.selectImage().then(r => resolve(r ? r.base64 : null)).catch(() => resolve(null));
                return;
            }
            resolve(null);
        });
    };
    const fetchPlaylists = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/playlists');
            const data = await res.json();
            setPlaylists(Array.isArray(data) ? data : []);
        } catch {
            setPlaylists([]);
        } finally {
            setLoading(false);
        }
    };

    const fetchPlaylistVideos = async (playlist) => {
        if (!playlist?.id) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/playlists/${playlist.id}/videos`);
            const data = await res.json();
            setActivePlaylist(data?.playlist || playlist);
            setVideos(Array.isArray(data?.videos) ? data.videos : []);
            setSelectedKeys([]);
            setSearch('');
            setFilters({ sort: 'playlist', sortOrder: 'asc', funscript: 'all', tag: '' });
            setViewMode('grid');
            setDurationById({});
            setDurationSortResolving(false);
            setDurationRetryTick(0);
            durationLoadingRef.current.clear();
            selectionAnchorRef.current = '';
        } catch {
            setVideos([]);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchPlaylists();
        const onChanged = () => {
            fetchPlaylists();
            if (activePlaylist?.id) fetchPlaylistVideos(activePlaylist);
        };
        window.addEventListener('playlists-changed', onChanged);
        return () => window.removeEventListener('playlists-changed', onChanged);
    }, [activePlaylist?.id]);

    useEffect(() => {
        return () => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
            if (toastCloseTimerRef.current) clearTimeout(toastCloseTimerRef.current);
            if (videoHoldTimerRef.current) clearTimeout(videoHoldTimerRef.current);
            window.removeEventListener('mousemove', onVideoMouseMove);
            window.removeEventListener('mouseup', onVideoMouseUp);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const fetchTagCategories = () => {
            fetch('/api/tags/categories')
                .then(res => (res.ok ? res.json() : null))
                .then((data) => {
                    if (cancelled) return;
                    setTagCategoryMap(data?.map && typeof data.map === 'object' ? data.map : {});
                })
                .catch(() => {
                    if (!cancelled) setTagCategoryMap({});
                });
        };
        fetchTagCategories();
        const onCategoryChanged = () => fetchTagCategories();
        window.addEventListener('tag-categories-changed', onCategoryChanged);
        return () => {
            cancelled = true;
            window.removeEventListener('tag-categories-changed', onCategoryChanged);
        };
    }, []);
    useEffect(() => {
        if (!initialPlaylistId || !Array.isArray(playlists) || playlists.length === 0) return;
        if (initialPlaylistHandledRef.current === String(initialPlaylistId)) return;
        const target = playlists.find(pl => String(pl?.id) === String(initialPlaylistId));
        if (!target) return;
        initialPlaylistHandledRef.current = String(initialPlaylistId);
        fetchPlaylistVideos(target);
    }, [initialPlaylistId, playlists]);
    useEffect(() => {
        let cancelled = false;
        if (!Array.isArray(playlists) || playlists.length === 0) {
            setPlaylistPreviewById({});
            setPlaylistPreviewErrorById({});
            return;
        }

        (async () => {
            const rows = await Promise.all((playlists || []).slice(0, 20).map(async (pl) => {
                try {
                    const res = await fetch(`/api/playlists/${pl.id}/videos`);
                    if (!res.ok) return [pl.id, null];
                    const data = await res.json();
                    const firstVideo = Array.isArray(data?.videos) && data.videos.length > 0 ? data.videos[0] : null;
                    return [pl.id, firstVideo];
                } catch {
                    return [pl.id, null];
                }
            }));
            if (!cancelled) {
                setPlaylistPreviewById(Object.fromEntries(rows));
                setPlaylistPreviewErrorById({});
            }
        })();

        return () => { cancelled = true; };
    }, [playlists]);

    const availableTags = useMemo(() => {
        return [...new Set((videos || []).flatMap(v => (v.tags || []).map(tag => String(tag))))].sort((a, b) => a.localeCompare(b));
    }, [videos]);

    const tagCounts = useMemo(() => {
        const counts = {};
        for (const video of videos || []) {
            const uniqueTags = [...new Set((video.tags || []).map(tag => String(tag)))];
            for (const tag of uniqueTags) counts[tag] = (counts[tag] || 0) + 1;
        }
        return counts;
    }, [videos]);
    const groupedAvailableTags = useMemo(() => {
        const byCategory = new Map();
        for (const tag of availableTags) {
            const category = String(tagCategoryMap?.[String(tag).toLowerCase()]?.category || '').trim();
            const key = category || '__uncategorized__';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(tag);
        }
        const groups = [...byCategory.entries()].map(([key, tags]) => ({
            key,
            label: key === '__uncategorized__' ? t('uncategorized', 'Uncategorized') : key,
            tags: [...tags].sort((a, b) => a.localeCompare(b)),
        }));
        groups.sort((a, b) => {
            if (a.key === '__uncategorized__') return 1;
            if (b.key === '__uncategorized__') return -1;
            return a.label.localeCompare(b.label);
        });
        return groups;
    }, [availableTags, tagCategoryMap, t]);

    const funscriptCounts = useMemo(() => {
        const all = (videos || []).length;
        const yes = (videos || []).filter(v => !!v.hasFunscript).length;
        return { all, yes, no: Math.max(0, all - yes) };
    }, [videos]);

    const filteredVideos = useMemo(() => {
        const q = search.trim().toLowerCase();
        let next = [...videos];

        if (q) next = next.filter(v => String(v?.title || '').toLowerCase().includes(q));
        if (filters.funscript === 'yes') next = next.filter(v => !!v.hasFunscript);
        if (filters.funscript === 'no') next = next.filter(v => !v.hasFunscript);
        if (filters.tag) {
            const wanted = String(filters.tag).toLowerCase();
            next = next.filter(v => (v.tags || []).some(tag => String(tag).toLowerCase() === wanted));
        }

        const getDuration = (video) => {
            const fromVideo = Number(video?.durationSec || 0);
            if (fromVideo > 0) return fromVideo;
            const mapped = Number(durationById?.[String(video?.id || '')] || 0);
            return mapped > 0 ? mapped : null;
        };
        const sortOrder = (filters.sortOrder || 'desc') === 'asc' ? 'asc' : 'desc';
        const direction = sortOrder === 'asc' ? 1 : -1;

        if (filters.sort === 'playlist') {
            // Keep server-provided playlist order.
        } else if (filters.sort === 'name') next.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')) * direction);
        else if (filters.sort === 'size') next.sort((a, b) => (Number(a.size || 0) - Number(b.size || 0)) * direction);
        else if (filters.sort === 'duration') {
            next.sort((a, b) => {
                const da = getDuration(a);
                const db = getDuration(b);
                const aKnown = Number.isFinite(da) && da > 0;
                const bKnown = Number.isFinite(db) && db > 0;
                if (aKnown && bKnown) return (da - db) * direction;
                if (aKnown) return -1;
                if (bKnown) return 1;
                return String(a?.title || '').localeCompare(String(b?.title || '')) * direction;
            });
        }
        else next.sort((a, b) => (Number(a.modifiedAt || 0) - Number(b.modifiedAt || 0)) * direction);

        return next;
    }, [videos, search, filters, durationById]);
    useEffect(() => {
        if (filters.sort !== 'duration') {
            setDurationSortResolving(false);
            return;
        }
        const missing = videos
            .filter((v) => {
                const id = String(v?.id || '');
                if (!id) return false;
                if (Number(v?.durationSec || 0) > 0) return false;
                if (Number(durationById[id] || 0) > 0) return false;
                if (durationLoadingRef.current.has(id)) return false;
                return true;
            });
        if (missing.length === 0) {
            setDurationSortResolving(false);
            return;
        }
        let cancelled = false;
        setDurationSortResolving(true);
        const run = async () => {
            const ids = missing.map((v) => String(v.id)).filter(Boolean);
            ids.forEach((id) => durationLoadingRef.current.add(id));
            const queue = [...missing];
            const updates = {};
            const workers = Array.from({ length: Math.min(10, queue.length) }, async () => {
                while (!cancelled && queue.length > 0) {
                    const next = queue.shift();
                    if (!next?.id) continue;
                    try {
                        const res = await fetch(`/api/videos/${next.id}/details`);
                        if (!res.ok) continue;
                        const data = await res.json();
                        const sec = Math.max(0, Number(data?.duration || 0));
                        if (sec > 0) updates[String(next.id)] = sec;
                    } catch { }
                }
            });
            await Promise.allSettled(workers);
            ids.forEach((id) => durationLoadingRef.current.delete(id));
            if (!cancelled && Object.keys(updates).length > 0) {
                setDurationById((prev) => ({ ...prev, ...updates }));
            }
            if (!cancelled && missing.length > Object.keys(updates).length) {
                setTimeout(() => {
                    if (!cancelled) setDurationRetryTick((v) => v + 1);
                }, 1200);
            }
            if (!cancelled) setDurationSortResolving(false);
        };
        run();
        return () => {
            cancelled = true;
            setDurationSortResolving(false);
        };
    }, [filters.sort, videos, durationById, durationRetryTick]);

    const selectedVideos = useMemo(() => {
        const keySet = new Set(selectedKeys);
        return filteredVideos.filter(v => keySet.has(v.filePath || v.id));
    }, [filteredVideos, selectedKeys]);
    const selectedCount = selectedKeys.length;

    const playFromPlaylistQueue = (video, options = {}) => {
        onPlay(video, { ...options, queueVideos: filteredVideos });
    };

    const openPerformerFromVideoCard = (video, performer) => {
        if (typeof onOpenPerformer !== 'function') return;
        const libraryId = String(video?.libraryId || video?.library_id || '').trim();
        const performerId = String(performer?.id || '').trim();
        const performerName = String(performer?.name || '').trim();
        if (!libraryId || (!performerId && !performerName)) return;
        onOpenPerformer({
            libraryId,
            performer: { id: performerId, name: performerName },
        });
    };

    const buildShuffledQueue = (items) => {
        const arr = Array.isArray(items) ? [...items] : [];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };

    const toggleSelection = (video, e = null) => {
        const key = video?.filePath || video?.id;
        if (!key) return;
        const ordered = filteredVideos.map(v => v.filePath || v.id).filter(Boolean);
        const hasRange = !!(e?.shiftKey && selectionAnchorRef.current && ordered.includes(selectionAnchorRef.current) && ordered.includes(key));
        if (hasRange) {
            const a = ordered.indexOf(selectionAnchorRef.current);
            const b = ordered.indexOf(key);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedKeys(prev => [...new Set([...prev, ...range])]);
            return;
        }
        selectionAnchorRef.current = key;
        setSelectedKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
    };

    const selectFromContextMenu = (video) => {
        const key = video?.filePath || video?.id;
        if (!key) return;
        selectionAnchorRef.current = key;
        setSelectedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    };

    const toggleAllVisible = () => {
        const keys = filteredVideos.map(v => v.filePath || v.id).filter(Boolean);
        const allSelected = keys.length > 0 && keys.every(k => selectedKeys.includes(k));
        if (allSelected) setSelectedKeys(prev => prev.filter(k => !keys.includes(k)));
        else setSelectedKeys(prev => [...new Set([...prev, ...keys])]);
    };

    const canReorderPlaylist = !!(
        activePlaylist?.id &&
        !loading &&
        selectedCount === 0 &&
        String(filters.sort || '') === 'playlist' &&
        String(filters.sortOrder || 'asc') === 'asc' &&
        String(filters.funscript || 'all') === 'all' &&
        !String(filters.tag || '').trim() &&
        !String(search || '').trim()
    );

    useEffect(() => {
        videoOrderKeysRef.current = (Array.isArray(videos) ? videos : [])
            .map((v) => String(v?.filePath || v?.id || ''))
            .filter(Boolean);
    }, [videos]);

    const setVideoOrderLocally = (orderedKeys) => {
        const keys = Array.isArray(orderedKeys) ? orderedKeys.map((k) => String(k || '')).filter(Boolean) : [];
        if (!keys.length) return;
        videoOrderKeysRef.current = keys;
        flushSync(() => {
            setVideos((prev) => {
                const source = Array.isArray(prev) ? prev : [];
                const byKey = new Map(source.map((v) => [String(v?.filePath || v?.id || ''), v]));
                const reordered = [];
                for (const k of keys) {
                    const hit = byKey.get(k);
                    if (hit) reordered.push(hit);
                }
                for (const v of source) {
                    const key = String(v?.filePath || v?.id || '');
                    if (!key || keys.includes(key)) continue;
                    reordered.push(v);
                }
                return reordered;
            });
        });
    };

    const applyVideoDraggingTransform = (state, el, clientX, clientY, immediate = false) => {
        if (!state || !el) return;
        const pointerOffsetX = Number.isFinite(Number(state.pointerOffsetX)) ? Number(state.pointerOffsetX) : 0;
        const pointerOffsetY = Number.isFinite(Number(state.pointerOffsetY)) ? Number(state.pointerOffsetY) : 0;
        const desiredLeft = Number(clientX || 0) - pointerOffsetX;
        const desiredTop = Number(clientY || 0) - pointerOffsetY;
        const targetTx = desiredLeft - Number(state.originLeft || 0);
        const rawTy = desiredTop - Number(state.originTop || 0);
        const maxVerticalDrag = 0;
        const targetTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, rawTy));
        const k = immediate ? 1 : 1;
        const nextTx = Number(state.currentTx || 0) + (targetTx - Number(state.currentTx || 0)) * k;
        const nextTy = Number(state.currentTy || 0) + (targetTy - Number(state.currentTy || 0)) * k;
        const smoothDx = Math.abs(nextTx) < 0.2 ? 0 : nextTx;
        const smoothDy = Math.abs(nextTy) < 0.2 ? 0 : nextTy;
        const vx = Number(clientX || 0) - (state.lastX ?? Number(clientX || 0));
        const targetTilt = Math.max(-1.8, Math.min(1.8, vx * 0.08));
        const nextTilt = Number(state.currentTilt || 0) + (targetTilt - Number(state.currentTilt || 0)) * (immediate ? 1 : 0.5);
        const smoothTilt = Math.abs(nextTilt) < 0.05 ? 0 : nextTilt;
        el.style.transform = `translate3d(${smoothDx}px, ${smoothDy}px, 0) rotate(${smoothTilt}deg)`;
        state.currentTx = smoothDx;
        state.currentTy = smoothDy;
        state.currentTilt = smoothTilt;
        state.lastX = Number(clientX || 0);
    };

    const reanchorDraggingVideoElement = (state, el) => {
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
        const maxVerticalDrag = 0;
        state.currentTy = Math.max(-maxVerticalDrag, Math.min(maxVerticalDrag, desiredTop - rect.top));
        state.currentTilt = Number(state.currentTilt || 0);
        el.style.transformOrigin = `${pointerOffsetX}px ${pointerOffsetY}px`;
        el.style.transform = `translate3d(${state.currentTx}px, ${state.currentTy}px, 0) rotate(${state.currentTilt}deg)`;
        applyVideoDraggingTransform(state, el, pointerX, pointerY, true);
    };

    const animateVideoReorder = (nextOrderKeys, activeDragKey = '') => {
        const nextKeys = Array.isArray(nextOrderKeys) ? nextOrderKeys.map((k) => String(k || '')).filter(Boolean) : [];
        if (!nextKeys.length) return;
        const activeKey = String(activeDragKey || '');
        const dragState = videoDragStateRef.current;

        const firstRects = new Map();
        for (const key of nextKeys) {
            const el = videoCardRefs.current.get(key);
            if (!el) continue;
            firstRects.set(key, el.getBoundingClientRect());
        }

        setVideoOrderLocally(nextKeys);
        if (activeKey && dragState && String(dragState.videoKey || '') === activeKey) {
            const activeElAfter = videoCardRefs.current.get(activeKey);
            if (activeElAfter) {
                activeElAfter.style.pointerEvents = 'none';
                activeElAfter.style.zIndex = '40';
                activeElAfter.style.transition = 'none';
                activeElAfter.style.willChange = 'transform';
                activeElAfter.style.transformOrigin = `${Number(dragState.pointerOffsetX || 0)}px ${Number(dragState.pointerOffsetY || 0)}px`;
                dragState.dragEl = activeElAfter;
                reanchorDraggingVideoElement(dragState, activeElAfter);
            }
        }

        const toAnimate = [];
        for (const key of nextKeys) {
            if (key === activeKey) continue;
            const el = videoCardRefs.current.get(key);
            const first = firstRects.get(key);
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

    const persistPlaylistOrder = async (orderedKeys) => {
        if (!activePlaylist?.id) return;
        const keys = Array.isArray(orderedKeys) ? orderedKeys.map((k) => String(k || '')).filter(Boolean) : [];
        if (!keys.length) return;
        const byKey = new Map((Array.isArray(videos) ? videos : []).map((v) => [String(v?.filePath || v?.id || ''), v]));
        const videoPaths = keys
            .map((k) => String(byKey.get(k)?.filePath || '').trim())
            .filter(Boolean);
        if (!videoPaths.length) return;
        const res = await fetch(`/api/playlists/${activePlaylist.id}/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoPaths }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success !== true) {
            throw new Error(data?.error || t('unknown', 'Unbekannt'));
        }
    };

    const onVideoMouseMove = (e) => {
        const state = videoDragStateRef.current;
        if (!state) return;
        state.pointerX = e.clientX;
        state.pointerY = e.clientY;

        if (!state.dragging) {
            const dx = Math.abs(e.clientX - state.startX);
            const dy = Math.abs(e.clientY - state.startY);
            if (dx > 8 || dy > 8) {
                if (videoHoldTimerRef.current) clearTimeout(videoHoldTimerRef.current);
                videoHoldTimerRef.current = null;
                videoDragStateRef.current = null;
                window.removeEventListener('mousemove', onVideoMouseMove);
                window.removeEventListener('mouseup', onVideoMouseUp);
            }
            return;
        }

        e.preventDefault();
        const draggingId = String(state.videoKey || '');
        if (!draggingId) return;

        const mappedEl = videoCardRefs.current.get(draggingId);
        if (mappedEl && state.dragEl !== mappedEl) {
            if (state.dragEl) {
                state.dragEl.style.pointerEvents = '';
                state.dragEl.style.zIndex = '';
                state.dragEl.style.transition = '';
                state.dragEl.style.willChange = '';
                state.dragEl.style.transform = '';
                state.dragEl.style.transformOrigin = '';
            }
            state.dragEl = mappedEl;
            mappedEl.style.pointerEvents = 'none';
            mappedEl.style.zIndex = '40';
            mappedEl.style.transition = 'none';
            mappedEl.style.willChange = 'transform';
            mappedEl.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
            reanchorDraggingVideoElement(state, mappedEl);
        }

        const draggingEl = state.dragEl || mappedEl;
        if (draggingEl) applyVideoDraggingTransform(state, draggingEl, state.pointerX, state.pointerY);

        const now = Date.now();
        if (now - Number(state.lastSwapTs || 0) < 180) return;
        const current = Array.isArray(videoOrderKeysRef.current) ? [...videoOrderKeysRef.current] : [];
        if (current.length < 2) return;
        if (!current.includes(draggingId)) return;

        const others = current.filter((id) => id !== draggingId);
        let insertIndex = others.length;
        for (let i = 0; i < others.length; i++) {
            const el = videoCardRefs.current.get(String(others[i]));
            if (!el) continue;
            const r = el.getBoundingClientRect();
            const mid = r.left + (r.width / 2);
            if (e.clientX < mid) {
                insertIndex = i;
                break;
            }
        }

        const next = [...others];
        next.splice(insertIndex, 0, draggingId);
        let changed = false;
        for (let i = 0; i < next.length; i++) {
            if (next[i] !== current[i]) { changed = true; break; }
        }
        if (!changed) return;

        const movedSinceSwap = Math.abs(e.clientX - Number(state.lastSwapX ?? state.startX ?? e.clientX));
        if (movedSinceSwap < 28) return;

        state.didSwap = true;
        state.lastSwapTs = now;
        state.lastSwapX = e.clientX;
        animateVideoReorder(next, draggingId);
        const el = videoCardRefs.current.get(String(state.videoKey || '')) || state.dragEl;
        if (el) {
            state.dragEl = el;
            el.style.pointerEvents = 'none';
            el.style.zIndex = '40';
            el.style.transition = 'none';
            el.style.willChange = 'transform';
            el.style.transformOrigin = `${Number(state.pointerOffsetX || 0)}px ${Number(state.pointerOffsetY || 0)}px`;
        }
    };

    const onVideoMouseUp = () => {
        if (videoHoldTimerRef.current) clearTimeout(videoHoldTimerRef.current);
        videoHoldTimerRef.current = null;
        const state = videoDragStateRef.current;
        videoDragStateRef.current = null;
        window.removeEventListener('mousemove', onVideoMouseMove);
        window.removeEventListener('mouseup', onVideoMouseUp);
        document.body.style.userSelect = '';
        const dragId = String(state?.videoKey || '');
        const mappedEl = dragId ? videoCardRefs.current.get(dragId) : null;
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
        if (!state?.dragging) return;
        setDraggingKey('');
        if (state.didSwap) {
            suppressVideoClickRef.current = true;
            const prevKeys = Array.isArray(state.initialOrder) ? [...state.initialOrder] : [];
            persistPlaylistOrder(videoOrderKeysRef.current).catch((err) => {
                if (prevKeys.length) setVideoOrderLocally(prevKeys);
                showToast(t('errorPrefix', 'Fehler: ') + (err?.message || ''), 'error');
            });
        }
    };

    const cancelVideoHoldIfPending = () => {
        const state = videoDragStateRef.current;
        if (state?.dragging) return;
        if (videoHoldTimerRef.current) clearTimeout(videoHoldTimerRef.current);
        videoHoldTimerRef.current = null;
        videoDragStateRef.current = null;
        document.body.style.userSelect = '';
    };

    const onVideoMouseDown = (e, videoKey) => {
        if (e.button !== 0 || !canReorderPlaylist || !videoKey) return;
        if (videoHoldTimerRef.current) clearTimeout(videoHoldTimerRef.current);
        suppressVideoClickRef.current = false;
        videoDragStateRef.current = {
            videoKey: String(videoKey || ''),
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            didSwap: false,
            lastSwapTs: 0,
            lastSwapX: e.clientX,
            initialOrder: [...videoOrderKeysRef.current],
        };
        window.addEventListener('mouseup', cancelVideoHoldIfPending, { once: true });
        videoHoldTimerRef.current = setTimeout(() => {
            const state = videoDragStateRef.current;
            if (!state || String(state.videoKey) !== String(videoKey)) return;
            state.dragging = true;
            state.lastX = state.startX;
            setDraggingKey(String(videoKey));
            document.body.style.userSelect = 'none';
            const dragEl = videoCardRefs.current.get(String(videoKey));
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
            window.addEventListener('mousemove', onVideoMouseMove);
            window.addEventListener('mouseup', onVideoMouseUp);
        }, 280);
    };

    const removeFromPlaylist = async (videosToRemove) => {
        if (!activePlaylist?.id) return;
        const playlistId = String(activePlaylist.id);
        const playlistSnapshot = activePlaylist;
        const removedVideos = (Array.isArray(videosToRemove) ? videosToRemove : []).filter((v) => !!v?.filePath);
        const videoPaths = [...new Set(removedVideos.map(v => v.filePath).filter(Boolean))];
        if (videoPaths.length === 0) return;
        try {
            const res = await fetch(`/api/playlists/${playlistId}/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoPaths }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }
            const removedSet = new Set(videoPaths);
            setVideos(prev => prev.filter(v => !removedSet.has(v.filePath)));
            setSelectedKeys(prev => prev.filter(k => !removedSet.has(k)));
            showToast(
                `${videoPaths.length} ${t('removedFromPlaylist', 'aus Playlist entfernt')}`,
                'success',
                {
                    label: t('undo', 'Undo'),
                    onClick: async () => {
                        try {
                            const restoreRes = await fetch('/api/playlists/add', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    playlistId,
                                    videoPaths,
                                }),
                            });
                            const restoreData = await restoreRes.json().catch(() => ({}));
                            if (!restoreRes.ok) throw new Error(restoreData?.error || t('unknown', 'Unbekannt'));
                            await fetchPlaylistVideos(playlistSnapshot);
                            showToast(t('undone', 'Undone'), 'success');
                            window.dispatchEvent(new Event('playlists-changed'));
                        } catch (undoErr) {
                            showToast(t('errorPrefix', 'Fehler: ') + (undoErr.message || ''), 'error');
                        }
                    },
                }
            );
            window.dispatchEvent(new Event('playlists-changed'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handleEditVideoTags = (video) => {
        setTagDialog({
            videoId: video.id,
            videoPath: video.filePath || null,
            title: `${t('editTags', 'Tags bearbeiten')}: ${video.title}`,
            tags: video.tags || [],
        });
    };

    const handleSaveTags = async (tags) => {
        if (!tagDialog) return;
        try {
            const res = await fetch(`/api/tags/video/${tagDialog.videoId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags, videoPath: tagDialog.videoPath || null }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }
            setVideos(prev => prev.map(v => (
                (v.filePath && tagDialog.videoPath && v.filePath === tagDialog.videoPath)
                    ? { ...v, tags: Array.isArray(tags) ? tags : [] }
                    : v
            )));
            setTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const openBatchTagDialog = () => {
        if (selectedVideos.length === 0) return;
        const common = (selectedVideos[0]?.tags || []).filter(tag =>
            selectedVideos.every(v => (v.tags || []).some(tg => String(tg).toLowerCase() === String(tag).toLowerCase()))
        );
        setBatchTagDialog({
            title: `${t('batchTags', 'Batch-Tags')}: ${selectedVideos.length} ${t('videos', 'Videos')}`,
            tags: common,
        });
    };

    const handleSaveBatchTags = async (tags) => {
        try {
            await Promise.all(selectedVideos.map(async (video) => {
                const res = await fetch(`/api/tags/video/${video.id}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags, videoPath: video.filePath || null }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            }));

            const selectedSet = new Set(selectedKeys);
            setVideos(prev => prev.map(v => {
                const key = v.filePath || v.id;
                return selectedSet.has(key) ? { ...v, tags: Array.isArray(tags) ? tags : [] } : v;
            }));

            setBatchTagDialog(null);
            setSelectedKeys([]);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handleVideoContextMenu = (e, video) => {
        e.preventDefault();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                {
                    label: t('play', 'Abspielen'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
                    onClick: () => playFromPlaylistQueue(video),
                },
                {
                    label: t('select', 'Auswählen'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 11 12 14 20 6" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
                    onClick: () => selectFromContextMenu(video),
                },
                {
                    label: t('editTags', 'Tags bearbeiten'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                    onClick: () => handleEditVideoTags(video),
                },
                {
                    label: t('manageScript', 'Script verwalten'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" /><rect x="2.5" y="4" width="19" height="16" rx="3" /></svg>,
                    onClick: () => onOpenFunscriptManager?.({
                        videoId: video?.id,
                        libraryId: video?.libraryId || video?.library_id || null,
                        title: video?.title || video?.fileName || '',
                    }),
                },
                {
                    label: t('addToPlaylist', 'Zur Playlist hinzufügen'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h10" /><path d="m17 15 3 3-3 3" /><path d="M20 18h-6" /></svg>,
                    onClick: () => openPlaylistDialogForVideos([video], `${t('addToPlaylist', 'Zur Playlist hinzufügen')}: ${video.title}`),
                },
                {
                    label: t('removeFromPlaylist', 'Aus Playlist entfernen'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
                    onClick: () => removeFromPlaylist([video]),
                },
                {
                    label: t('regenerateThumbnailShort', 'Regenerate thumbnail'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="14" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /><path d="M12 19v2" /><path d="M8 21h8" /></svg>,
                    onClick: () => setThumbTimestampDialogVideo(video),
                },
                {
                    label: t('properties', 'Eigenschaften'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>,
                    onClick: () => setPropertiesVideo(video),
                },
            ],
        });
    };



    const handleUploadPlaylistPoster = async (playlist) => {
        if (!playlist?.id) return;
        const imageData = await pickImage();
        if (!imageData) return;
        const nextMap = { ...playlistPosterById, [playlist.id]: imageData };
        persistPlaylistPosterMap(nextMap);
        showToast(t('posterUpdated', 'Poster aktualisiert!'));
    };
    const renamePlaylist = (playlist) => {
        const currentName = String(playlist?.name || '').trim();
        if (!playlist?.id || !currentName) return;
        setPlaylistManageDialog({ mode: 'rename', playlist });
    };

    const deletePlaylist = (playlist) => {
        const name = String(playlist?.name || '').trim();
        if (!playlist?.id || !name) return;
        setPlaylistManageDialog({ mode: 'delete', playlist });
    };

    const handleConfirmPlaylistManage = async (payload = {}) => {
        const dialog = playlistManageDialog;
        const playlist = dialog?.playlist;
        if (!playlist?.id) return;

        try {
            if (dialog.mode === 'rename') {
                const nextName = String(payload?.name || '').trim();
                if (!nextName || nextName === String(playlist.name || '').trim()) {
                    setPlaylistManageDialog(null);
                    return;
                }
                const res = await fetch(`/api/playlists/${playlist.id}/rename`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: nextName }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
                const data = await res.json().catch(() => ({}));
                const updated = data?.playlist || { ...playlist, name: nextName };
                setPlaylists(prev => prev.map(pl => (pl.id === playlist.id ? { ...pl, name: updated.name } : pl)));
                if (activePlaylist?.id === playlist.id) setActivePlaylist(prev => ({ ...(prev || {}), name: updated.name }));
                showToast(t('saved', 'Gespeichert'));
            } else {
                const res = await fetch(`/api/playlists/${playlist.id}`, { method: 'DELETE' });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
                setPlaylists(prev => prev.filter(pl => pl.id !== playlist.id));
                if (activePlaylist?.id === playlist.id) {
                    setActivePlaylist(null);
                    setVideos([]);
                    setSelectedKeys([]);
                }
                showToast(t('deleted', 'Gelöscht'));
            }

            setPlaylistManageDialog(null);
            window.dispatchEvent(new Event('playlists-changed'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handlePlaylistCardContextMenu = (e, playlist) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
                {
                    label: t('changePoster', 'Change poster/thumbnail'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                    onClick: () => handleUploadPlaylistPoster(playlist),
                },
                {
                    label: t('rename', 'Rename'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>,
                    onClick: () => renamePlaylist(playlist),
                },
                {
                    label: t('delete', 'Delete'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>,
                    onClick: () => deletePlaylist(playlist),
                },
            ],
        });
    };
    const playRandom = () => {
        if (filteredVideos.length === 0) return;
        const shuffled = buildShuffledQueue(filteredVideos);
        const first = shuffled[0];
        if (first) onPlay(first, { queueVideos: shuffled });
    };

    const selectionHotkeysEnabled = !contextMenu && !tagDialog && !batchTagDialog && !playlistManageDialog && !propertiesVideo;
    useSelectionHotkeys({
        enabled: selectionHotkeysEnabled,
        onSelectAll: () => toggleAllVisible(),
        onClearSelection: () => {
            setSelectedKeys([]);
            selectionAnchorRef.current = '';
        },
    });

    if (loading && !activePlaylist) {
        return <div className="loading-spinner"><div className="spinner" /></div>;
    }

    if (!activePlaylist) {
        if (playlists.length === 0) {
            return (
                <div className="home-page playlists-empty-page">
                    <div className="playlists-empty-wrap">
                        <div className="empty-state playlists-empty-state">
                            <div className="empty-state-icon">{playlistIcon}</div>
                            <h2>{t('noPlaylistsYet', 'Noch keine Playlists')}</h2>
                            <p>{t('createPlaylistHint', 'Füge Videos per Rechtsklick oder Mehrfachauswahl zu einer Playlist hinzu.')} {t('createPlaylistHintManager', 'Das geht auch im Playlist Manager.')}</p>
                            <button className="btn btn-secondary" onClick={() => onOpenPlaylistManager?.()}>{t('playlistManagerTitle', 'Playlist Manager')}</button>
                        </div>
                    </div>
                </div>
            );
        }
        return (
            <div className="home-page">
                <div className="home-section">
                    <h2 className="home-section-title">{t('playlists', 'Playlists')}</h2>
                    <div className="playlist-card-grid">
                        {playlists.map(pl => {
                            const previewVideo = playlistPreviewById?.[pl.id] || null;
                            const customPoster = playlistPosterById?.[pl.id] || '';
                            return (
                                <button key={pl.id} className="playlist-card" onClick={() => fetchPlaylistVideos(pl)} onContextMenu={(e) => handlePlaylistCardContextMenu(e, pl)}>
                                    <div className="playlist-card-thumb">
                                        {customPoster ? (
                                            <img
                                                src={customPoster}
                                                alt={pl.name}
                                                loading="lazy"
                                                decoding="async"
                                                draggable={false}
                                                onError={() => { const next = { ...playlistPosterById }; delete next[pl.id]; persistPlaylistPosterMap(next); }}
                                            />
                                        ) : previewVideo?.id && !playlistPreviewErrorById?.[pl.id] ? (
                                            <img
                                                src={`/api/videos/${previewVideo.id}/thumbnail`}
                                                alt={pl.name}
                                                loading="lazy"
                                                decoding="async"
                                                draggable={false}
                                                onError={() => setPlaylistPreviewErrorById(prev => ({ ...prev, [pl.id]: true }))}
                                            />
                                        ) : (
                                            <div className="playlist-card-icon">{playlistIcon}</div>
                                        )}
                                    </div>
                                    <div className="playlist-card-info">
                                        <div className="playlist-card-name">{pl.name}</div>
                                        <div className="playlist-card-meta">{pl.itemCount} {pl.itemCount === 1 ? t('video', 'Video') : t('videos', 'Videos')}</div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="library-layout">
            <aside className="sidebar playlist-sidebar">
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('sorting', 'Sortierung')}</h3>
                    <div className="sidebar-options">
                        <button className={`sidebar-option ${filters.sort === 'playlist' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sort: 'playlist', sortOrder: 'asc' }))}>
                            {t('playlistOrder', 'Playlist order')}
                        </button>
                        <button className={`sidebar-option ${filters.sort === 'date' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sort: 'date' }))}>
                            {t('newestFirst', 'Erstellungsdatum')}
                        </button>
                        <button className={`sidebar-option ${filters.sort === 'name' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sort: 'name' }))}>
                            {t('nameAZ', 'Name A-Z')}
                        </button>
                        <button className={`sidebar-option ${filters.sort === 'size' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sort: 'size' }))}>
                            {t('size', 'Größe')}
                        </button>
                        <button className={`sidebar-option ${filters.sort === 'duration' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sort: 'duration' }))}>
                            {t('duration', 'Dauer')}
                        </button>
                    </div>
                </div>
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('orderLabel', 'Order')}</h3>
                    <div className="sidebar-options">
                        <button className={`sidebar-option ${(filters.sortOrder || 'desc') === 'asc' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sortOrder: 'asc' }))}>
                            {t('sortAscending', 'Ascending')}
                        </button>
                        <button className={`sidebar-option ${(filters.sortOrder || 'desc') === 'desc' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, sortOrder: 'desc' }))}>
                            {t('sortDescending', 'Descending')}
                        </button>
                    </div>
                </div>
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('withFunscript', 'Mit Funscript')}</h3>
                    <div className="sidebar-options">
                        <button className={`sidebar-option ${filters.funscript === 'all' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, funscript: 'all' }))}>
                            {t('all', 'Alle')}<span className="sidebar-count">{funscriptCounts.all}</span>
                        </button>
                        <button className={`sidebar-option ${filters.funscript === 'yes' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, funscript: 'yes' }))}>
                            {t('withFunscript', 'Mit Funscript')}<span className="sidebar-count">{funscriptCounts.yes}</span>
                        </button>
                        <button className={`sidebar-option ${filters.funscript === 'no' ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, funscript: 'no' }))}>
                            {t('withoutFunscript', 'Ohne Funscript')}<span className="sidebar-count">{funscriptCounts.no}</span>
                        </button>
                    </div>
                </div>
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('tagsTitle', 'Tags')}</h3>
                    <div className="sidebar-options">
                        <button className={`sidebar-option ${!filters.tag ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, tag: '' }))}>
                            {t('allTags', 'Alle Tags')}
                        </button>
                        {groupedAvailableTags.map(group => (
                            <React.Fragment key={group.key}>
                                <div className="sidebar-heading" style={{ marginTop: 8, marginBottom: 4 }}>{group.label}</div>
                                {group.tags.map(tag => (
                                    <button key={tag} className={`sidebar-option ${filters.tag === tag ? 'active' : ''}`} onClick={() => setFilters(prev => ({ ...prev, tag }))}>
                                        #{tag}<span className="sidebar-count">{tagCounts[tag] || 0}</span>
                                    </button>
                                ))}
                            </React.Fragment>
                        ))}
                    </div>
                </div>
            </aside>
            <div className="library-main">
                <div className="library-header playlist-header">
                    <div className="library-header-left">
                        <h2 className="library-heading">{activePlaylist.name}</h2>
                        <span className="library-result-count">{filteredVideos.length} {filteredVideos.length === 1 ? t('video', 'Video') : t('videos', 'Videos')}</span>
                    </div>
                </div>
                <div className="library-search-sticky playlist-search-sticky">
                    <div className="search-bar playlist-search-bar">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <path d="m21 21-4.35-4.35" />
                        </svg>
                        <input type="text" placeholder={t('searchPlaceholder', 'Suchen...')} value={search} onChange={(e) => setSearch(e.target.value)} />
                        {search ? (
                            <button
                                type="button"
                                className="search-clear-btn"
                                onClick={() => setSearch('')}
                                aria-label={t('clearSearch', 'Clear search')}
                                title={t('clearSearch', 'Clear search')}
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                </div>
                <div className="library-tabs playlist-controls-row">
                    <div className="library-view-controls">
                        <button
                            className={`library-view-btn icon-only ${viewMode === 'grid' ? 'active' : ''}`}
                            onClick={() => setViewMode('grid')}
                            title={t('gridView', 'Grid')}
                            aria-label={t('gridView', 'Grid')}
                        >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                                <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                            </svg>
                        </button>
                        <button
                            className={`library-view-btn icon-only list-icon ${viewMode === 'list' ? 'active' : ''}`}
                            onClick={() => setViewMode('list')}
                            title={t('listView', 'Liste')}
                            aria-label={t('listView', 'Liste')}
                        >
                            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                                <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
                                <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
                            </svg>
                        </button>
                        {filteredVideos.length > 0 && selectedCount === 0 && (
                            <button
                                className="btn-shuffle-icon"
                                onClick={playRandom}
                                title={t('randomVideo', 'Zufälliges Video abspielen')}
                                style={{
                                    background: 'transparent', border: 'none', cursor: 'pointer',
                                    padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: 'var(--accent-primary)',
                                    opacity: 0.8, transition: 'opacity 0.2s'
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                                onMouseLeave={(e) => e.currentTarget.style.opacity = '0.8'}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                                    <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
                                </svg>
                            </button>
                        )}
                        <button className="btn btn-secondary playlist-back-btn" onClick={() => setActivePlaylist(null)}>
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="m15 18-6-6 6-6" /></svg>
                            {t('back', 'Zurück')}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="loading-spinner"><div className="spinner" /></div>
                ) : filteredVideos.length === 0 ? (
                    <div className="empty-state">
                        <h2>{t('noVideos', 'Keine Videos')}</h2>
                        <p>{search ? t('noVideosFilters', 'Keine Videos mit diesen Filtern gefunden.') : t('playlistEmptyHint', 'Diese Playlist ist aktuell leer.')}</p>
                    </div>
                ) : (
                    <div className={`video-grid ${viewMode === 'list' ? 'list-mode' : ''}`}>
                        {filteredVideos.map(video => {
                            const itemKey = String(video?.filePath || video?.id || '');
                            const reorderEnabled = canReorderPlaylist && !!itemKey;
                            return (
                                <div
                                    key={itemKey}
                                    ref={(node) => {
                                        if (!node) {
                                            videoCardRefs.current.delete(itemKey);
                                            return;
                                        }
                                        videoCardRefs.current.set(itemKey, node);
                                    }}
                                    className={`playlist-reorder-item ${reorderEnabled ? 'reorder-enabled' : ''} ${draggingKey === itemKey ? 'is-dragging' : ''}`}
                                    onMouseDown={(e) => onVideoMouseDown(e, itemKey)}
                                    onClickCapture={(e) => {
                                        if (!suppressVideoClickRef.current) return;
                                        suppressVideoClickRef.current = false;
                                        e.preventDefault();
                                        e.stopPropagation();
                                    }}
                                >
                                    <VideoCard
                                        video={video}
                                        onPlay={playFromPlaylistQueue}
                                        onContextMenu={(e) => handleVideoContextMenu(e, video)}
                                        onPerformerClick={(performer) => openPerformerFromVideoCard(video, performer)}
                                        selected={selectedKeys.includes(video.filePath || video.id)}
                                        selectionMode={selectedCount > 0}
                                        onToggleSelect={toggleSelection}
                                        reserveHeatmapSpace
                                        viewMode={viewMode}
                                        showPerformers
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {selectedCount > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllVisible}>
                        {t('selectAll', 'Alle auswählen')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setSelectedKeys([])}>
                        {t('deselectAll', 'Alle abwählen')}
                    </button>
                    <span className="batch-floating-count">{selectedCount} {t('selected', 'ausgewählt')}</span>
                    <button className="btn btn-secondary" onClick={() => removeFromPlaylist(selectedVideos)}>
                        {t('removeFromPlaylist', 'Aus Playlist entfernen')}
                    </button>
                    <button className="btn btn-primary" onClick={openBatchTagDialog}>
                        {t('batchTags', 'Batch-Tags')}
                    </button>
                </div>
            )}

            {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
            {propertiesVideo && (
                <PropertiesDialog
                    video={propertiesVideo}
                    onClose={() => setPropertiesVideo(null)}
                />
            )}
            {thumbTimestampDialogVideo && (
                <ThumbnailTimestampDialog
                    video={thumbTimestampDialogVideo}
                    onClose={() => setThumbTimestampDialogVideo(null)}
                    onApplied={() => {
                        if (activePlaylist?.id) fetchPlaylistVideos(activePlaylist);
                        showToast(t('thumbnailRegenerated', 'Thumbnail regenerated!'));
                    }}
                />
            )}
            {tagDialog && (
                <TagDialog
                    title={tagDialog.title}
                    initialTags={tagDialog.tags}
                    suggestions={availableTags}
                    onSave={handleSaveTags}
                    onCancel={() => setTagDialog(null)}
                />
            )}
                        {playlistManageDialog && (
                <PlaylistManageDialog
                    mode={playlistManageDialog.mode}
                    playlistName={playlistManageDialog?.playlist?.name || ''}
                    onCancel={() => setPlaylistManageDialog(null)}
                    onConfirm={handleConfirmPlaylistManage}
                />
            )}
            {batchTagDialog && (
                <TagDialog
                    title={batchTagDialog.title}
                    initialTags={batchTagDialog.tags}
                    suggestions={availableTags}
                    onSave={handleSaveBatchTags}
                    onCancel={() => setBatchTagDialog(null)}
                />
            )}
            {toast && (
                <div className={`toast ${toast.type} ${toastClosing ? 'closing' : ''}`}>
                    <span>{toast.message}</span>
                    {toast.action?.label ? (
                        <button
                            type="button"
                            className="toast-action-btn"
                            onClick={() => {
                                const fn = toast.action?.onClick;
                                dismissToast(0);
                                if (typeof fn === 'function') fn();
                            }}
                        >
                            {toast.action.label}
                        </button>
                    ) : null}
                </div>
            )}
        </div>
    );
}

export default Playlists;













