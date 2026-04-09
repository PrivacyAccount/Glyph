import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import Sidebar from '../components/Sidebar';
import PropertiesDialog from '../components/PropertiesDialog';
import VideoCard from '../components/VideoCard';
import ContextMenu from '../components/ContextMenu';
import TMDBDialog from '../components/TMDBDialog';
import BatchTMDBDialog from '../components/BatchTMDBDialog';
import TPDBDialog from '../components/TPDBDialog';
import RenameDialog from '../components/RenameDialog';
import FileBrowser from '../components/FileBrowser';
import TagDialog from '../components/TagDialog';
import PlaylistPickerDialog from '../components/PlaylistPickerDialog';
import AppDropdown from '../components/AppDropdown';
import ThumbnailTimestampDialog from '../components/ThumbnailTimestampDialog';
import { useI18n } from '../i18n';
import useSelectionHotkeys from '../hooks/useSelectionHotkeys';

class FileBrowserBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, message: '' };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, message: String(error?.message || 'Unknown error') };
    }
    componentDidCatch(error) {
        // eslint-disable-next-line no-console
        console.error('FileBrowser crashed:', error);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div className="error-message" style={{ marginTop: 16 }}>
                    Folder structure error: {this.state.message}
                </div>
            );
        }
        return this.props.children;
    }
}

function Library({ library, onLibraryUpdate, onBack, onPlay, onSeriesSelect, onOpenFunscriptManager }) {
    const { t, language } = useI18n();
    const [videos, setVideos] = useState([]);
    const [folders, setFolders] = useState([]);
    const [extensions, setExtensions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState({ sort: 'name', sortOrder: 'asc', favorite: '', funscript: '', extension: '', multiaxis: '', audio: '', vrProjection: '', vrStereoMode: '' });
    const [search, setSearch] = useState('');
    const [contextMenu, setContextMenu] = useState(null);
    const [tmdbDialog, setTmdbDialog] = useState(null);
    const [seriesImageDialog, setSeriesImageDialog] = useState(null);
    const [tpdbDialogVideo, setTpdbDialogVideo] = useState(null);
    const [batchTMDBOpen, setBatchTMDBOpen] = useState(false);
    const [renameDialog, setRenameDialog] = useState(null);
    const [tagDialog, setTagDialog] = useState(null);
    const [propertiesVideo, setPropertiesVideo] = useState(null);
    const [thumbTimestampDialogVideo, setThumbTimestampDialogVideo] = useState(null);
    const [toast, setToast] = useState(null);
    const [selectedFolderPaths, setSelectedFolderPaths] = useState([]);
    const [selectedVideoKeys, setSelectedVideoKeys] = useState([]);
    const [batchVideoTagDialog, setBatchVideoTagDialog] = useState(null);
    const [playlistDialog, setPlaylistDialog] = useState(null);
    const [vrMetaDialog, setVrMetaDialog] = useState(null);
    const [selectedTagFilters, setSelectedTagFilters] = useState([]);
    const [tagFilterMode, setTagFilterMode] = useState('or');
    const [tagSuggestions, setTagSuggestions] = useState([]);
    const [tagCategoryMap, setTagCategoryMap] = useState({});
    const [viewMode, setViewMode] = useState('grid');
    const [videoThumbSize, setVideoThumbSize] = useState(() => {
        const raw = Number(localStorage.getItem('glyph_video_thumb_size') || 240);
        return Number.isFinite(raw) ? Math.max(180, Math.min(360, raw)) : 240;
    });
    const [durationById, setDurationById] = useState({});
    const [durationSortResolving, setDurationSortResolving] = useState(false);
    const [durationRetryTick, setDurationRetryTick] = useState(0);
    const [posterVersionByFolderPath, setPosterVersionByFolderPath] = useState({});
    const [thumbnailVersionByVideoId, setThumbnailVersionByVideoId] = useState({});
    const [showPerformerChips, setShowPerformerChips] = useState(() => {
        try {
            const local = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            return typeof local.showPerformerChips === 'boolean' ? local.showPerformerChips : true;
        } catch {
            return true;
        }
    });
    const [performerFilter, setPerformerFilter] = useState(null);
    const [pendingPerformerOpen, setPendingPerformerOpen] = useState(null);
    const [performers, setPerformers] = useState([]);
    const [performersLoading, setPerformersLoading] = useState(false);
    const [performerDetail, setPerformerDetail] = useState(null);
    const [performerDetailLoading, setPerformerDetailLoading] = useState(false);
    const [performerImageDialog, setPerformerImageDialog] = useState(null);
    const [performerImageTab, setPerformerImageTab] = useState('stashdb');
    const [hideMalePerformers, setHideMalePerformers] = useState(true);
    const durationLoadingRef = useRef(new Set());
    const folderSelectionAnchorRef = useRef('');
    const videoSelectionAnchorRef = useRef('');
    const videoTabRef = useRef('all');

    // Series filter states
    const [seriesFilter, setSeriesFilter] = useState('all');
    const [seriesSort, setSeriesSort] = useState('name');
    const [activeLetter, setActiveLetter] = useState(null);

    // Video Library Tabs
    const [videoTab, setVideoTab] = useState(() => (
        library?.initialVideoTab || (library?.type === 'series' ? 'folders' : 'all')
    )); // 'all' | 'folders'
    const [folderBrowserVideos, setFolderBrowserVideos] = useState([]);

    const isSeriesLib = library?.type === 'series';
    const isVrLib = library?.type === 'vr';
    const isVideoLib = library?.type === 'videos';
    const isPerformerGridView = videoTab === 'performers' && isVideoLib && !isVrLib && !performerDetail;
    const hasPerformerData = useMemo(
        () => Array.isArray(videos) && videos.some((v) => Array.isArray(v?.performers) && v.performers.length > 0),
        [videos],
    );
    const isAllVideosVirtualLibrary = String(library?.id || '') === '__all_videos__' || library?.isVirtual === true;
    const emptyCenterStyle = {
        width: '100%',
        minHeight: 'clamp(320px, 52vh, 640px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
    };

    const abortControllerRef = useRef(null);

    useLayoutEffect(() => {
        setSearch(String(library?.initialSearch || ''));
        const initialSort = library?.initialSort || 'name';
        setFilters({
            sort: initialSort,
            sortOrder: initialSort === 'name' ? 'asc' : 'desc',
            favorite: '',
            funscript: '',
            extension: '',
            multiaxis: '',
            audio: '',
            vrProjection: '',
            vrStereoMode: '',
        });
        setActiveLetter(null);
        setSeriesFilter('all');
        setSeriesSort(library?.initialSeriesSort || 'name');
        setVideoTab(library?.initialVideoTab || (library?.type === 'series' ? 'folders' : 'all'));
        setViewMode('grid');
        setSelectedFolderPaths([]);
        setSelectedVideoKeys([]);
        setBatchVideoTagDialog(null);
        setBatchTMDBOpen(false);
        setSeriesImageDialog(null);
        setTpdbDialogVideo(null);
        setSelectedTagFilters([]);
        setTagFilterMode('or');
        setTagSuggestions([]);
        setDurationById({});
        setDurationSortResolving(false);
        setDurationRetryTick(0);
        durationLoadingRef.current.clear();
        folderSelectionAnchorRef.current = '';
        videoSelectionAnchorRef.current = '';
        setPerformers([]);
        setPerformerDetail(null);
        setPerformerImageDialog(null);
        setHideMalePerformers(true);
        setThumbnailVersionByVideoId({});
        setPerformerFilter(null);
        const initialPerformerId = String(library?.initialPerformer?.id || '').trim();
        const initialPerformerName = String(library?.initialPerformer?.name || '').trim();
        setPendingPerformerOpen((initialPerformerId || initialPerformerName)
            ? { id: initialPerformerId, name: initialPerformerName }
            : null);
    }, [library?.id]);

    useEffect(() => {
        if (isAllVideosVirtualLibrary && videoTab === 'folders') {
            setVideoTab('all');
        }
    }, [isAllVideosVirtualLibrary, videoTab]);

    useEffect(() => {
        if (videoTab === 'performers' && (!isVideoLib || isVrLib)) {
            setVideoTab('all');
        }
    }, [videoTab, isVideoLib, isVrLib]);

    useEffect(() => {
        setActiveLetter(null);
    }, [videoTab]);

    useEffect(() => {
        videoTabRef.current = videoTab;
    }, [videoTab]);

    useEffect(() => {
        // Leaving performers tab should always return to performer grid next time.
        if (videoTab !== 'performers') {
            setPerformerDetail(null);
            setPerformerDetailLoading(false);
        }
    }, [videoTab]);

    const isMalePerformer = useCallback((performer) => {
        const raw = String(performer?.gender || '').trim().toLowerCase();
        if (!raw) return false;
        const tokens = raw.split(/[^a-z]+/).filter(Boolean);
        return tokens.some((token) => token === 'male' || token === 'man' || token === 'm');
    }, []);

    const visiblePerformers = useMemo(() => {
        if (!Array.isArray(performers)) return [];
        if (!hideMalePerformers) return performers;
        return performers.filter((p) => !isMalePerformer(p));
    }, [performers, hideMalePerformers, isMalePerformer]);

    const performerSearchFiltered = useMemo(() => {
        const q = String(search || '').trim().toLowerCase();
        if (!q) return visiblePerformers;
        return visiblePerformers.filter((p) => String(p?.name || '').toLowerCase().includes(q));
    }, [visiblePerformers, search]);

    const filteredPerformers = useMemo(() => {
        if (!activeLetter) return performerSearchFiltered;
        return performerSearchFiltered.filter((p) => {
            const name = String(p?.name || '').toUpperCase();
            const first = name.charAt(0);
            if (activeLetter === '#') return /^[^A-Z]/.test(first);
            return first === activeLetter;
        });
    }, [performerSearchFiltered, activeLetter]);

    useEffect(() => {
        try {
            localStorage.setItem('glyph_video_thumb_size', String(videoThumbSize));
        } catch {
            // ignore
        }
    }, [videoThumbSize]);

    useEffect(() => {
        const syncFromLocal = () => {
            try {
                const local = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                setShowPerformerChips(typeof local.showPerformerChips === 'boolean' ? local.showPerformerChips : true);
            } catch {
                setShowPerformerChips(true);
            }
        };
        syncFromLocal();
        window.addEventListener('glyph-settings-changed', syncFromLocal);
        window.addEventListener('storage', syncFromLocal);
        return () => {
            window.removeEventListener('glyph-settings-changed', syncFromLocal);
            window.removeEventListener('storage', syncFromLocal);
        };
    }, []);

    const queryFilters = useMemo(() => ({
        favorite: filters.favorite,
        funscript: filters.funscript,
        multiaxis: filters.multiaxis,
        audio: filters.audio,
        extension: filters.extension,
        vrProjection: filters.vrProjection,
        vrStereoMode: filters.vrStereoMode,
        sort: filters.sort === 'duration' ? 'duration' : '',
        sortOrder: (filters.sortOrder || 'asc') === 'desc' ? 'desc' : 'asc',
    }), [
        filters.favorite,
        filters.funscript,
        filters.multiaxis,
        filters.audio,
        filters.extension,
        filters.vrProjection,
        filters.vrStereoMode,
        filters.sort,
        filters.sortOrder,
    ]);

    const fetchContent = useCallback(async () => {
        if (!library) { setLoading(false); return; }

        // Cancel previous request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const signal = controller.signal;

        setLoading(true);
        try {
            if (isSeriesLib) {
                // Always fetch folders for sidebar stats
                const resFolders = await fetch(`/api/libraries/${library.id}/folders`, { signal });
                const folderList = await resFolders.json();
                setFolders(folderList);
                setPosterVersionByFolderPath(() => {
                    const next = {};
                    for (const folder of (Array.isArray(folderList) ? folderList : [])) {
                        const key = normalizeFolderPathKey(folder?.path || '');
                        if (!key) continue;
                        next[key] = Number(folder?.posterVersion || 0);
                    }
                    return next;
                });

                if (videoTab === 'all') {
                    const params = new URLSearchParams();
                    if (search) params.set('search', search);
                    if (queryFilters.favorite) params.set('favorite', queryFilters.favorite);
                    if (queryFilters.funscript) params.set('funscript', queryFilters.funscript);
                    if (queryFilters.multiaxis) params.set('multiaxis', queryFilters.multiaxis);
                    if (queryFilters.audio) params.set('audio', queryFilters.audio);
                    if (queryFilters.extension) params.set('extension', queryFilters.extension);
                    if (queryFilters.sort) params.set('sort', queryFilters.sort);
                    if (queryFilters.sort) params.set('order', queryFilters.sortOrder);
                    const resVideos = await fetch(`/api/libraries/${library.id}/videos?${params}`, { signal });
                    setVideos(await resVideos.json());
                } else {
                    setVideos([]);
                }
            } else {
                // Folder structure uses its own browser endpoint. Avoid forcing
                // a potentially heavy flat videos fetch here, which can cause UI stalls.
                if (videoTab === 'folders') {
                    setFolders([]);
                    setVideos([]);
                } else {
                    const params = new URLSearchParams();
                    if (search) params.set('search', search);
                    if (queryFilters.favorite) params.set('favorite', queryFilters.favorite);
                    if (queryFilters.funscript) params.set('funscript', queryFilters.funscript);
                    if (queryFilters.multiaxis) params.set('multiaxis', queryFilters.multiaxis);
                    if (queryFilters.audio) params.set('audio', queryFilters.audio);
                    if (queryFilters.extension) params.set('extension', queryFilters.extension);
                    if (isVrLib && queryFilters.vrProjection) params.set('vrProjection', queryFilters.vrProjection);
                    if (isVrLib && queryFilters.vrStereoMode) params.set('vrStereoMode', queryFilters.vrStereoMode);
                    if (queryFilters.sort) params.set('sort', queryFilters.sort);
                    if (queryFilters.sort) params.set('order', queryFilters.sortOrder);
                    const res = await fetch(`/api/libraries/${library.id}/videos?${params}`, { signal });
                    setVideos(await res.json());
                    setFolders([]);
                }
            }
            const extRes = await fetch(`/api/libraries/${library.id}/extensions`, { signal });
            setExtensions(await extRes.json());
        } catch (err) {
            if (err.name === 'AbortError') return;
            console.error('Failed to fetch:', err);
        } finally {
            if (!signal.aborted) {
                setLoading(false);
            }
        }
    }, [library, queryFilters, search, isSeriesLib, isVrLib, videoTab]);

    useEffect(() => {
        fetchContent();
        return () => {
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
        };
    }, [fetchContent]);

    useEffect(() => {
        if (!library?.id || !isVideoLib || isVrLib || videoTab !== 'performers') return;
        let cancelled = false;
        setPerformersLoading(true);
        fetch(`/api/libraries/${library.id}/performers`)
            .then((res) => res.json())
            .then((data) => {
                if (cancelled) return;
                const list = Array.isArray(data?.performers) ? data.performers : [];
                setPerformers(list);
            })
            .catch(() => {
                if (!cancelled) setPerformers([]);
            })
            .finally(() => {
                if (!cancelled) setPerformersLoading(false);
            });
        return () => { cancelled = true; };
    }, [library?.id, isVideoLib, isVrLib, videoTab]);

    useEffect(() => {
        if (!library?.id) return;
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
        fetch(`/api/libraries/${library.id}/tags`)
            .then(res => (res.ok ? res.json() : []))
            .then((data) => {
                if (cancelled) return;
                setTagSuggestions(Array.isArray(data) ? data.map(tg => String(tg)).filter(Boolean) : []);
            })
            .catch(() => {
                if (!cancelled) setTagSuggestions([]);
            });
        fetchTagCategories();
        const onCategoryChanged = () => fetchTagCategories();
        window.addEventListener('tag-categories-changed', onCategoryChanged);
        return () => {
            cancelled = true;
            window.removeEventListener('tag-categories-changed', onCategoryChanged);
        };
    }, [library?.id, loading]);

    const toggleTagFilter = useCallback((tagName) => {
        const tag = String(tagName || '').trim();
        if (!tag) return;
        setSelectedTagFilters((prev) => (
            prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
        ));
    }, []);

    const clearTagFilters = useCallback(() => {
        setSelectedTagFilters([]);
    }, []);

    const tagsMatchBySelection = useCallback((rawTags = [], selected = [], mode = 'or') => {
        if (!Array.isArray(selected) || selected.length === 0) return true;
        const normalizedVideoTags = new Set((rawTags || []).map((tg) => String(tg).toLowerCase()));
        if (mode === 'and') {
            return selected.every((wanted) => normalizedVideoTags.has(String(wanted).toLowerCase()));
        }
        return selected.some((wanted) => normalizedVideoTags.has(String(wanted).toLowerCase()));
    }, []);

    const tagsMatchSelection = useCallback((rawTags = []) => {
        return tagsMatchBySelection(rawTags, selectedTagFilters, tagFilterMode || 'or');
    }, [selectedTagFilters, tagFilterMode, tagsMatchBySelection]);

    // Filtered & sorted folders
    const filteredFolders = useMemo(() => {
        let result = [...folders];
        if (search) {
            const q = search.toLowerCase();
            result = result.filter(f => f.name.toLowerCase().includes(q) || (f.metadata?.title || '').toLowerCase().includes(q));
        }
        if (seriesFilter === 'withMeta') result = result.filter(f => f.metadata);
        if (seriesFilter === 'withFs') result = result.filter(f => f.funscriptCount > 0);
        result = result.filter((f) => tagsMatchSelection(f.tags || []));
        if (activeLetter) {
            result = result.filter(f => {
                const name = (f.metadata?.title || f.name).toUpperCase();
                if (activeLetter === '#') return /^[^A-Z]/.test(name);
                return name.startsWith(activeLetter);
            });
        }
        if (seriesSort === 'name') result.sort((a, b) => (a.metadata?.title || a.name).localeCompare(b.metadata?.title || b.name));
        else if (seriesSort === 'date') {
            result.sort((a, b) => {
                const dateA = a.metadata?.releaseDate ? new Date(a.metadata.releaseDate).getTime() : 0;
                const dateB = b.metadata?.releaseDate ? new Date(b.metadata.releaseDate).getTime() : 0;
                return dateB - dateA;
            });
        }
        else if (seriesSort === 'count') result.sort((a, b) => b.videoCount - a.videoCount);
        return result;
    }, [folders, search, seriesFilter, seriesSort, activeLetter, tagsMatchSelection]);

    const applyVideoFiltersAndSort = useCallback((sourceVideos = []) => {
        let next = Array.isArray(sourceVideos) ? [...sourceVideos] : [];

        if (search) {
            const q = String(search).toLowerCase();
            next = next.filter((v) => {
                const title = String(v?.title || '').toLowerCase();
                const fileName = String(v?.fileName || '').toLowerCase();
                return title.includes(q) || fileName.includes(q);
            });
        }

        next = next.filter((v) => tagsMatchSelection(v.tags || []));

        if (performerFilter && (performerFilter.name || performerFilter.id)) {
            const wantedName = String(performerFilter.name || '').trim().toLowerCase();
            const wantedId = String(performerFilter.id || '').trim();
            next = next.filter((v) => {
                const list = Array.isArray(v?.performers) ? v.performers : [];
                return list.some((p) => {
                    const pId = typeof p === 'string' ? '' : String(p?.id || '').trim();
                    const pName = String(typeof p === 'string' ? p : (p?.name || '')).trim().toLowerCase();
                    if (wantedId && pId && wantedId === pId) return true;
                    return !!wantedName && pName === wantedName;
                });
            });
        }

        if (filters.favorite === 'yes') next = next.filter(v => !!v?.isFavorite);
        if (filters.funscript === 'yes') next = next.filter(v => !!v?.hasFunscript);
        if (filters.funscript === 'no') next = next.filter(v => !v?.hasFunscript);
        if (filters.multiaxis === 'yes') next = next.filter(v => !!v?.isMultiAxis);
        if (filters.audio === 'yes') next = next.filter(v => v?.hasAudio === true);
        if (filters.audio === 'no') next = next.filter(v => v?.hasAudio !== true);

        if (filters.extension) {
            const wanted = `.${String(filters.extension).toLowerCase()}`;
            next = next.filter(v => String(v?.extension || '').toLowerCase() === wanted);
        }

        if (isVrLib && filters.vrProjection) {
            const wantedProjection = String(filters.vrProjection || '').toLowerCase();
            next = next.filter(v => String(v?.vrProjection || '').toLowerCase() === wantedProjection);
        }
        if (isVrLib && filters.vrStereoMode) {
            const wantedStereo = String(filters.vrStereoMode || '').toLowerCase();
            next = next.filter(v => String(v?.vrStereoMode || '').toLowerCase() === wantedStereo);
        }

        const sortOrder = (filters.sortOrder || 'asc') === 'desc' ? 'desc' : 'asc';
        const direction = sortOrder === 'asc' ? 1 : -1;

        if (filters.sort === 'duration') {
            next.sort((a, b) => {
                const aDur = Number(durationById[String(a?.id || '')] || a?.durationSec || a?.duration || 0);
                const bDur = Number(durationById[String(b?.id || '')] || b?.durationSec || b?.duration || 0);
                return (aDur - bDur) * direction;
            });
        } else if (filters.sort === 'date') {
            next.sort((a, b) => (Number(a?.modifiedAt || 0) - Number(b?.modifiedAt || 0)) * direction);
        } else if (filters.sort === 'size') {
            next.sort((a, b) => (Number(a?.size || 0) - Number(b?.size || 0)) * direction);
        } else {
            next.sort((a, b) => String(a?.title || '').localeCompare(String(b?.title || '')) * direction);
        }
        return next;
    }, [
        search,
        tagsMatchSelection,
        performerFilter,
        filters.favorite,
        filters.funscript,
        filters.multiaxis,
        filters.audio,
        filters.extension,
        filters.vrProjection,
        filters.vrStereoMode,
        filters.sort,
        filters.sortOrder,
        durationById,
        isVrLib,
    ]);

    const filteredVideos = useMemo(() => applyVideoFiltersAndSort(videos), [videos, applyVideoFiltersAndSort]);
    const filteredPerformerVideos = useMemo(
        () => applyVideoFiltersAndSort(performerDetail?.videos || []),
        [performerDetail?.videos, applyVideoFiltersAndSort],
    );
    const handlePerformerChipClick = useCallback((performer) => {
        const name = String(performer?.name || '').trim();
        const id = String(performer?.id || '').trim();
        if (!name && !id) return;
        setPerformerFilter(null);
        setPerformerDetail(null);
        setPendingPerformerOpen({ id, name });
        if (videoTab !== 'performers') setVideoTab('performers');
    }, [videoTab]);

    const playFromFilteredQueue = (video, options = {}) => {
        onPlay(video, { ...options, queueVideos: filteredVideos });
    };

    useEffect(() => {
        if (videoTab !== 'all') return;
        setDurationSortResolving(false);
    }, [videoTab, filters.sort, durationById, durationRetryTick]);

    const buildShuffledQueue = (items) => {
        const arr = Array.isArray(items) ? [...items] : [];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    };

    const availableVideoTagStats = useMemo(() => {
        const map = new Map();
        videos.forEach(v => {
            const unique = new Set((v.tags || []).map(tg => String(tg)));
            unique.forEach(tag => map.set(tag, (map.get(tag) || 0) + 1));
        });
        return [...map.entries()]
            .map(([name, count]) => ({
                name,
                count,
                category: String(tagCategoryMap?.[String(name).toLowerCase()]?.category || ''),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [videos, tagCategoryMap]);

    const baseVideosForDynamicTagCounts = useMemo(() => {
        let next = Array.isArray(videos) ? [...videos] : [];
        if (search) {
            const q = String(search).toLowerCase();
            next = next.filter((v) => {
                const title = String(v?.title || '').toLowerCase();
                const fileName = String(v?.fileName || '').toLowerCase();
                return title.includes(q) || fileName.includes(q);
            });
        }
        if (performerFilter && (performerFilter.name || performerFilter.id)) {
            const wantedName = String(performerFilter.name || '').trim().toLowerCase();
            const wantedId = String(performerFilter.id || '').trim();
            next = next.filter((v) => {
                const list = Array.isArray(v?.performers) ? v.performers : [];
                return list.some((p) => {
                    const pId = typeof p === 'string' ? '' : String(p?.id || '').trim();
                    const pName = String(typeof p === 'string' ? p : (p?.name || '')).trim().toLowerCase();
                    if (wantedId && pId && wantedId === pId) return true;
                    return !!wantedName && pName === wantedName;
                });
            });
        }
        if (filters.favorite === 'yes') next = next.filter(v => !!v?.isFavorite);
        if (filters.funscript === 'yes') next = next.filter(v => !!v?.hasFunscript);
        if (filters.funscript === 'no') next = next.filter(v => !v?.hasFunscript);
        if (filters.multiaxis === 'yes') next = next.filter(v => !!v?.isMultiAxis);
        if (filters.audio === 'yes') next = next.filter(v => v?.hasAudio === true);
        if (filters.audio === 'no') next = next.filter(v => v?.hasAudio !== true);
        if (filters.extension) {
            const wanted = `.${String(filters.extension).toLowerCase()}`;
            next = next.filter(v => String(v?.extension || '').toLowerCase() === wanted);
        }
        if (isVrLib && filters.vrProjection) {
            const wantedProjection = String(filters.vrProjection || '').toLowerCase();
            next = next.filter(v => String(v?.vrProjection || '').toLowerCase() === wantedProjection);
        }
        if (isVrLib && filters.vrStereoMode) {
            const wantedStereo = String(filters.vrStereoMode || '').toLowerCase();
            next = next.filter(v => String(v?.vrStereoMode || '').toLowerCase() === wantedStereo);
        }
        return next;
    }, [
        videos,
        search,
        performerFilter,
        filters.favorite,
        filters.funscript,
        filters.multiaxis,
        filters.audio,
        filters.extension,
        filters.vrProjection,
        filters.vrStereoMode,
        isVrLib,
    ]);

    const sidebarVideoTagStats = useMemo(() => {
        const universe = (availableVideoTagStats.length > 0
            ? availableVideoTagStats.map((t) => t.name)
            : (tagSuggestions || []))
            .map((name) => String(name || '').trim())
            .filter(Boolean);
        const uniqueUniverse = [...new Set(universe)].sort((a, b) => a.localeCompare(b));
        const selected = Array.isArray(selectedTagFilters) ? selectedTagFilters : [];
        const mode = (tagFilterMode || 'or') === 'and' ? 'and' : 'or';
        return uniqueUniverse.map((name) => {
            const selectedAlready = selected.some((s) => String(s).toLowerCase() === name.toLowerCase());
            const simulated = selectedAlready ? selected : [...selected, name];
            const count = baseVideosForDynamicTagCounts.reduce((acc, v) => (
                tagsMatchBySelection(v?.tags || [], simulated, mode) ? acc + 1 : acc
            ), 0);
            return {
                name,
                count,
                category: String(tagCategoryMap?.[name.toLowerCase()]?.category || ''),
            };
        });
    }, [
        availableVideoTagStats,
        tagSuggestions,
        tagCategoryMap,
        selectedTagFilters,
        tagFilterMode,
        baseVideosForDynamicTagCounts,
        tagsMatchBySelection,
    ]);

    const folderBrowserTagStats = useMemo(() => {
        if (videoTab !== 'folders' || folderBrowserVideos.length === 0) return null;
        const tagNames = new Set();
        for (const v of folderBrowserVideos) {
            for (const tag of (v.tags || [])) tagNames.add(String(tag));
        }
        // Also include tags from the global universe so sidebar stays consistent
        for (const t of sidebarVideoTagStats) tagNames.add(t.name);
        const selected = Array.isArray(selectedTagFilters) ? selectedTagFilters : [];
        const mode = (tagFilterMode || 'or') === 'and' ? 'and' : 'or';
        return [...tagNames].sort((a, b) => a.localeCompare(b)).map(name => {
            const selectedAlready = selected.some(s => String(s).toLowerCase() === name.toLowerCase());
            const simulated = selectedAlready ? selected : [...selected, name];
            const count = folderBrowserVideos.reduce((acc, v) => (
                tagsMatchBySelection(v?.tags || [], simulated, mode) ? acc + 1 : acc
            ), 0);
            return {
                name,
                count,
                category: String(tagCategoryMap?.[name.toLowerCase()]?.category || ''),
            };
        });
    }, [videoTab, folderBrowserVideos, sidebarVideoTagStats, tagCategoryMap, selectedTagFilters, tagFilterMode, tagsMatchBySelection]);

    const availableFolderTagStats = useMemo(() => {
        const map = new Map();
        folders.forEach(f => {
            const unique = new Set((f.tags || []).map(tg => String(tg)));
            // Count tagged series folders, not episode count.
            unique.forEach(tag => map.set(tag, (map.get(tag) || 0) + 1));
        });
        return [...map.entries()]
            .map(([name, count]) => ({
                name,
                count,
                category: String(tagCategoryMap?.[String(name).toLowerCase()]?.category || ''),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [folders, tagCategoryMap]);
    const baseFoldersForDynamicTagCounts = useMemo(() => {
        let next = [...folders];
        if (search) {
            const q = search.toLowerCase();
            next = next.filter(f => f.name.toLowerCase().includes(q) || (f.metadata?.title || '').toLowerCase().includes(q));
        }
        if (seriesFilter === 'withMeta') next = next.filter(f => f.metadata);
        if (seriesFilter === 'withFs') next = next.filter(f => f.funscriptCount > 0);
        if (activeLetter) {
            next = next.filter(f => {
                const name = (f.metadata?.title || f.name).toUpperCase();
                if (activeLetter === '#') return /^[^A-Z]/.test(name);
                return name.startsWith(activeLetter);
            });
        }
        return next;
    }, [folders, search, seriesFilter, activeLetter]);

    const dynamicFolderTagStats = useMemo(() => {
        const selected = Array.isArray(selectedTagFilters) ? selectedTagFilters : [];
        const mode = (tagFilterMode || 'or') === 'and' ? 'and' : 'or';
        return availableFolderTagStats.map((entry) => {
            const selectedAlready = selected.some((s) => String(s).toLowerCase() === String(entry.name).toLowerCase());
            const simulated = selectedAlready ? selected : [...selected, entry.name];
            const count = baseFoldersForDynamicTagCounts.reduce((acc, f) => (
                tagsMatchBySelection(f?.tags || [], simulated, mode) ? acc + 1 : acc
            ), 0);
            return { ...entry, count };
        });
    }, [
        availableFolderTagStats,
        selectedTagFilters,
        tagFilterMode,
        baseFoldersForDynamicTagCounts,
        tagsMatchBySelection,
    ]);

    const groupedFolderTagStats = useMemo(() => {
        const byCategory = new Map();
        for (const entry of dynamicFolderTagStats) {
            const category = String(entry.category || '').trim();
            const key = category || '__uncategorized__';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(entry);
        }
        const groups = [...byCategory.entries()].map(([key, values]) => ({
            key,
            label: key === '__uncategorized__' ? t('uncategorized', 'Uncategorized') : key,
            tags: [...values].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        groups.sort((a, b) => {
            if (a.key === '__uncategorized__') return 1;
            if (b.key === '__uncategorized__') return -1;
            return a.label.localeCompare(b.label);
        });
        return groups;
    }, [dynamicFolderTagStats, t]);

    const allKnownTags = useMemo(() => {
        const set = new Set();
        tagSuggestions.forEach(tg => set.add(tg));
        availableVideoTagStats.forEach(tg => set.add(tg.name));
        availableFolderTagStats.forEach(tg => set.add(tg.name));
        return [...set].sort((a, b) => a.localeCompare(b));
    }, [tagSuggestions, availableVideoTagStats, availableFolderTagStats]);

    // Alphabet
    const alphabet = useMemo(() => {
        const letters = new Set();
        folders.forEach(f => {
            const name = (f.metadata?.title || f.name).toUpperCase();
            const first = name.charAt(0);
            if (/[A-Z]/.test(first)) letters.add(first);
            else letters.add('#');
        });
        const sorted = [...letters].sort();
        if (sorted[0] === '#') { sorted.shift(); sorted.push('#'); }
        return sorted;
    }, [folders]);

    const performerAlphabet = useMemo(() => {
        const letters = new Set();
        performerSearchFiltered.forEach((p) => {
            const name = String(p?.name || '').toUpperCase();
            const first = name.charAt(0);
            if (/[A-Z]/.test(first)) letters.add(first);
            else letters.add('#');
        });
        const sorted = [...letters].sort();
        if (sorted[0] === '#') { sorted.shift(); sorted.push('#'); }
        return sorted;
    }, [performerSearchFiltered]);

    // Stats
    const withMetaCount = folders.filter(f => f.metadata).length;
    const withFsCount = folders.filter(f => f.funscriptCount > 0).length;

    const handleFolderClick = (folder) => {
        const libKey = String(library?.id || '').trim();
        const currentTop = Number(libraryMainRef.current?.scrollTop || 0);
        if (libKey && Number.isFinite(currentTop)) {
            try { sessionStorage.setItem(`glyph_library_scroll_${libKey}`, String(Math.max(0, Math.floor(currentTop)))); } catch { }
        }
        if (onSeriesSelect) {
            onSeriesSelect({ path: folder.path, name: folder.metadata?.title || folder.name });
        }
    };

    const normalizeFolderPathKey = (value) => String(value || '')
        .trim()
        .replace(/[\\/]+/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();

    const bumpPosterVersion = (folderPath) => {
        const key = normalizeFolderPathKey(folderPath);
        if (!key) return;
        setPosterVersionByFolderPath((prev) => ({ ...prev, [key]: Date.now() }));
    };

    const applyFolderMetadataLocal = (folderPath, metadata) => {
        const key = normalizeFolderPathKey(folderPath);
        if (!key || !metadata || typeof metadata !== 'object') return;
        setFolders((prev) => prev.map((folder) => (
            normalizeFolderPathKey(folder?.path || '') === key
                ? {
                    ...folder,
                    hasPoster: folder.hasPoster || !!metadata?.posterPath || !!metadata?.posterDownloaded,
                    metadata: { ...(folder.metadata || {}), ...metadata },
                }
                : folder
        )));
        bumpPosterVersion(folderPath);
    };

    const getFolderPosterApiUrl = (folderPath) => (
        `/api/poster?path=${encodeURIComponent(folderPath)}&v=${encodeURIComponent(String(posterVersionByFolderPath[normalizeFolderPathKey(folderPath)] || 0))}`
    );

    const getFolderPosterTmdbUrl = (folder) => {
        const posterPath = String(folder?.metadata?.posterPath || '').trim();
        if (!posterPath) return '';
        return `https://image.tmdb.org/t/p/w500${posterPath}`;
    };

    const getFolderPosterSrc = (folder) => {
        // Always prefer local cached poster first.
        return getFolderPosterApiUrl(folder.path);
    };

    const handleLetterClick = (letter) => { setActiveLetter(letter === activeLetter ? null : letter); };

    const toggleFolderSelection = (folderPath, e = null) => {
        if (!folderPath) return;
        const ordered = filteredFolders.map((f) => f.path).filter(Boolean);
        const hasRange = !!(e?.shiftKey && folderSelectionAnchorRef.current && ordered.includes(folderSelectionAnchorRef.current) && ordered.includes(folderPath));
        if (hasRange) {
            const a = ordered.indexOf(folderSelectionAnchorRef.current);
            const b = ordered.indexOf(folderPath);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedFolderPaths((prev) => [...new Set([...prev, ...range])]);
            return;
        }
        folderSelectionAnchorRef.current = folderPath;
        setSelectedFolderPaths(prev => (
            prev.includes(folderPath)
                ? prev.filter(p => p !== folderPath)
                : [...prev, folderPath]
        ));
    };

    const toggleAllFilteredFolders = () => {
        const allFilteredPaths = filteredFolders.map(f => f.path);
        const allSelected = allFilteredPaths.length > 0 && allFilteredPaths.every(p => selectedFolderPaths.includes(p));
        if (allSelected) {
            setSelectedFolderPaths(prev => prev.filter(p => !allFilteredPaths.includes(p)));
        } else {
            setSelectedFolderPaths(prev => [...new Set([...prev, ...allFilteredPaths])]);
        }
    };

    const selectedFolders = useMemo(() => {
        const pathSet = new Set(selectedFolderPaths);
        return folders.filter(f => pathSet.has(f.path));
    }, [folders, selectedFolderPaths]);

    const videoSelectionKey = (video) => video.filePath || video.path || video.id;
    const selectedVideos = useMemo(() => {
        const keySet = new Set(selectedVideoKeys);
        return videos.filter(v => keySet.has(videoSelectionKey(v)));
    }, [videos, selectedVideoKeys]);

    const handleTMDBPoster = (folder) => { setTmdbDialog({ query: folder.name, type: 'tv', folderPath: folder.path }); };

    const handleOpenSeriesImageEditor = (folder) => {
        const folderPath = String(folder?.path || '').trim();
        const currentMeta = folder?.metadata && typeof folder.metadata === 'object' ? folder.metadata : {};
        const tmdbId = Number(currentMeta?.tmdbId || 0);
        if (!folderPath || !tmdbId) {
            showToast(t('tmdbMissingHint', 'Bitte zuerst TMDB-Metadaten setzen.'), 'error');
            return;
        }
        const type = String(currentMeta?.type || '').toLowerCase() === 'movie' ? 'movie' : 'series';
        setSeriesImageDialog({
            loading: true,
            saving: false,
            error: '',
            folderPath,
            folderName: folder?.metadata?.title || folder?.name || '',
            tmdbId,
            type,
            images: { posters: [], backdrops: [] },
            selectedPoster: currentMeta?.posterPath || null,
            selectedBackdrop: currentMeta?.backdropIsLocal ? null : (currentMeta?.backdropPath || null),
        });

        fetch('/api/tmdb/images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tmdbId, type }),
        })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data?.error || t('loadFailed', 'Laden fehlgeschlagen'));
                const posters = Array.isArray(data?.posters) ? data.posters : [];
                const backdrops = Array.isArray(data?.backdrops) ? data.backdrops : [];
                setSeriesImageDialog((prev) => prev ? ({
                    ...prev,
                    loading: false,
                    images: { posters, backdrops },
                    selectedPoster: prev.selectedPoster || posters[0]?.file_path || null,
                    selectedBackdrop: prev.selectedBackdrop || backdrops[0]?.file_path || null,
                }) : prev);
            })
            .catch((err) => {
                setSeriesImageDialog((prev) => prev ? ({
                    ...prev,
                    loading: false,
                    error: String(err?.message || t('loadFailed', 'Laden fehlgeschlagen')),
                }) : prev);
            });
    };

    const applySeriesImages = async () => {
        if (!seriesImageDialog) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/tmdb/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tmdbId: seriesImageDialog.tmdbId,
                    type: seriesImageDialog.type,
                    folderPath: seriesImageDialog.folderPath,
                    posterPath: seriesImageDialog.selectedPoster || undefined,
                    backdropPath: seriesImageDialog.selectedBackdrop || undefined,
                    titleOverride: seriesImageDialog.folderName || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('saveFailed', 'Speichern fehlgeschlagen'));
            applyFolderMetadataLocal(seriesImageDialog.folderPath, data?.metadata || {});
            if (onLibraryUpdate) onLibraryUpdate();
            setSeriesImageDialog(null);
            showToast(t('metadataSaved', 'Metadaten gespeichert!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('saveFailed', 'Speichern fehlgeschlagen')),
            } : prev);
        }
    };

    const pickImageData = async () => {
        if (window.electronAPI?.selectImage) {
            const result = await window.electronAPI.selectImage();
            return result?.base64 || null;
        }
        return await new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = () => {
                const file = input.files?.[0];
                if (!file) return resolve(null);
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(file);
            };
            input.click();
        });
    };

    const uploadSeriesPoster = async () => {
        if (!seriesImageDialog?.folderPath) return;
        const imageData = await pickImageData();
        if (!imageData) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/poster/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: seriesImageDialog.folderPath, imageData }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('uploadFailed', 'Upload fehlgeschlagen'));
            applyFolderMetadataLocal(seriesImageDialog.folderPath, { posterDownloaded: true });
            if (onLibraryUpdate) onLibraryUpdate();
            setSeriesImageDialog(null);
            showToast(t('posterUpdated', 'Poster aktualisiert!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('uploadFailed', 'Upload fehlgeschlagen')),
            } : prev);
        }
    };

    const uploadSeriesBackdrop = async () => {
        if (!seriesImageDialog?.folderPath) return;
        const imageData = await pickImageData();
        if (!imageData) return;
        setSeriesImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch('/api/backdrop/upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: seriesImageDialog.folderPath, imageData }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('uploadFailed', 'Upload fehlgeschlagen'));
            applyFolderMetadataLocal(seriesImageDialog.folderPath, {
                backdropIsLocal: true,
                backdropPath: null,
                backdropUpdatedAt: Number(data?.backdropUpdatedAt || Date.now()),
            });
            if (onLibraryUpdate) onLibraryUpdate();
            setSeriesImageDialog(null);
            showToast(t('backdropSet', 'Backdrop gesetzt!'));
        } catch (err) {
            setSeriesImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                error: String(err?.message || t('uploadFailed', 'Upload fehlgeschlagen')),
            } : prev);
        }
    };

    const handleOpenTpdbDialog = (video) => {
        if (!video?.id) return;
        setTpdbDialogVideo(video);
    };

    const handleTpdbApplied = (data, selectedResult) => {
        const vid = String(data?.videoId || tpdbDialogVideo?.id || '');
        if (!vid) return;
        const meta = data?.metadata || {};
        setThumbnailVersionByVideoId((prev) => ({ ...prev, [vid]: Date.now() }));
        setVideos((prev) => prev.map((v) => {
            if (String(v?.id || '') !== vid) return v;
            const mappedPerformers = Array.isArray(selectedResult?.performers)
                ? selectedResult.performers
                    .map((p) => ({ id: String(p?.id || ''), name: String(p?.name || ''), gender: String(p?.gender || '') }))
                    .filter((p) => p.id || p.name)
                : [];
            return {
                ...v,
                title: String(meta?.title || selectedResult?.title || v?.title || ''),
                tpdbItemType: String(meta?.itemType || selectedResult?.itemType || v?.tpdbItemType || ''),
                tpdbItemId: String(meta?.itemId || selectedResult?.id || v?.tpdbItemId || ''),
                performers: mappedPerformers.length > 0 ? mappedPerformers : (Array.isArray(v?.performers) ? v.performers : []),
                hasThumbnail: true,
            };
        }));
        const thumbUpdated = data?.thumbnailUpdated !== false;
        if (thumbUpdated) {
            showToast(t('metadataSaved', 'Metadata saved!'));
        } else {
            showToast(
                `${t('metadataSaved', 'Metadata saved!')} ${t('thumbnailUpdateFailed', 'Thumbnail update failed.')}${data?.thumbnailError ? ` (${data.thumbnailError})` : ''}`,
                'error',
            );
        }
        setTpdbDialogVideo(null);
        // Keep data source consistent for performers + refreshed metadata payload.
        fetchContent();
        if (videoTab === 'performers') {
            setPerformerDetail(null);
        }
    };

    const openPerformerDetail = useCallback(async (performerId) => {
        if (!library?.id || !performerId) return;
        setPerformerDetailLoading(true);
        try {
            const res = await fetch(`/api/libraries/${library.id}/performers/${encodeURIComponent(performerId)}?lang=${encodeURIComponent(String(language || 'en'))}`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Failed to load performer');
            if (videoTabRef.current !== 'performers') return;
            setPerformerDetail(data);
        } catch (err) {
            if (videoTabRef.current !== 'performers') return;
            setPerformerDetail(null);
            showToast(t('errorPrefix', 'Error: ') + (err?.message || ''), 'error');
        } finally {
            if (videoTabRef.current === 'performers') {
                setPerformerDetailLoading(false);
            }
        }
    }, [library?.id, language, t]);

    useEffect(() => {
        if (videoTab !== 'performers' || !pendingPerformerOpen) return;
        const performerId = String(pendingPerformerOpen?.id || '').trim();
        const performerName = String(pendingPerformerOpen?.name || '').trim();
        if (performerId) {
            openPerformerDetail(performerId);
            setPendingPerformerOpen(null);
            return;
        }
        if (performersLoading) return;
        if (!performerName) {
            setPendingPerformerOpen(null);
            return;
        }
        const lower = performerName.toLowerCase();
        const found = (Array.isArray(performers) ? performers : []).find((p) => String(p?.name || '').trim().toLowerCase() === lower);
        if (found?.id) {
            openPerformerDetail(found.id);
        } else {
            setSearch(performerName);
        }
        setPendingPerformerOpen(null);
    }, [videoTab, pendingPerformerOpen, performersLoading, performers, openPerformerDetail]);

    const openPerformerImageDialog = async (performer) => {
        const performerId = String(performer?.id || '').trim();
        if (!library?.id || !performerId) return;
        setPerformerImageTab('stashdb');
        setPerformerImageDialog({
            performerId,
            performerName: String(performer?.name || '').trim() || t('performer', 'Performer'),
            images: [],
            groups: { stashdb: [], tpdb: [], other: [] },
            selectedImageUrl: '',
            loading: true,
            saving: false,
            error: '',
        });
        try {
            const res = await fetch(`/api/tpdb/performers/${encodeURIComponent(performerId)}/images`);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('errorPrefix', 'Error: '));
            const images = Array.isArray(data?.images) ? data.images : [];
            const groups = (data?.groups && typeof data.groups === 'object')
                ? {
                    stashdb: Array.isArray(data.groups.stashdb) ? data.groups.stashdb : [],
                    tpdb: Array.isArray(data.groups.tpdb) ? data.groups.tpdb : [],
                    other: Array.isArray(data.groups.other) ? data.groups.other : [],
                }
                : {
                    stashdb: images.filter((img) => String(img?.source || '') === 'stashdb'),
                    tpdb: images.filter((img) => String(img?.source || '') === 'tpdb'),
                    other: images.filter((img) => !['stashdb', 'tpdb'].includes(String(img?.source || ''))),
                };
            setPerformerImageDialog((prev) => prev && prev.performerId === performerId ? {
                ...prev,
                images,
                groups,
                selectedImageUrl: String(data?.selectedImageUrl || ''),
                loading: false,
                error: images.length === 0 ? t('noPerformerImageCandidates', 'No performer images found from StashDB or ThePornDB.') : '',
            } : prev);
            if (Array.isArray(groups.stashdb) && groups.stashdb.length > 0) setPerformerImageTab('stashdb');
            else if (Array.isArray(groups.tpdb) && groups.tpdb.length > 0) setPerformerImageTab('tpdb');
            else if (Array.isArray(groups.other) && groups.other.length > 0) setPerformerImageTab('other');
        } catch (err) {
            setPerformerImageDialog((prev) => prev && prev.performerId === performerId ? {
                ...prev,
                loading: false,
                error: String(err?.message || t('loadFailed', 'Failed to load')),
            } : prev);
        }
    };

    const applyPerformerImage = async (imageUrl) => {
        const performerId = String(performerImageDialog?.performerId || '').trim();
        const nextUrl = String(imageUrl || '').trim();
        if (!performerId || !nextUrl) return;
        setPerformerImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch(`/api/tpdb/performers/${encodeURIComponent(performerId)}/image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl: nextUrl }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('saveFailed', 'Failed to save'));
            const bust = Date.now();
            const performerImage = `/api/tpdb/performers/${encodeURIComponent(performerId)}/image?v=${bust}`;
            setPerformers((prev) => prev.map((p) => String(p?.id || '') === performerId ? { ...p, imageUrl: performerImage } : p));
            setPerformerDetail((prev) => {
                if (!prev?.performer || String(prev.performer.id || '') !== performerId) return prev;
                return { ...prev, performer: { ...prev.performer, imageUrl: performerImage } };
            });
            setPerformerImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                selectedImageUrl: String(data?.selectedImageUrl || nextUrl),
                images: Array.isArray(prev.images)
                    ? prev.images.map((img) => ({ ...img, selected: String(img?.url || '') === String(data?.selectedImageUrl || nextUrl) }))
                    : prev.images,
                groups: prev.groups && typeof prev.groups === 'object'
                    ? Object.fromEntries(
                        Object.entries(prev.groups).map(([key, list]) => [
                            key,
                            Array.isArray(list)
                                ? list.map((img) => ({ ...img, selected: String(img?.url || '') === String(data?.selectedImageUrl || nextUrl) }))
                                : [],
                        ]),
                    )
                    : prev.groups,
            } : prev);
            showToast(t('posterUpdated', 'Poster updated!'));
            setPerformerImageDialog(null);
        } catch (err) {
            setPerformerImageDialog((prev) => prev ? { ...prev, saving: false, error: String(err?.message || t('saveFailed', 'Failed to save')) } : prev);
        }
    };

    const handleRename = (folder) => {
        const currentTitle = folder.metadata?.title || folder.name;
        setRenameDialog({ folderPath: folder.path, currentName: currentTitle });
    };

    const handleRenameConfirm = async (newTitle) => {
        if (!renameDialog) return;
        try {
            const res = await fetch('/api/metadata/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folderPath: renameDialog.folderPath, newTitle }),
            });
            if (!res.ok) throw new Error(t('errorPrefix', 'Fehler: '));
            fetchContent();
            if (onLibraryUpdate) onLibraryUpdate();
            showToast(t('nameChanged', 'Name ge\u00E4ndert!'));
        } catch { showToast(t('renameFailed', 'Fehler beim Umbenennen'), 'error'); }
        setRenameDialog(null);
    };

    const handleEditFolderTags = (folder) => {
        setTagDialog({
            targetType: 'folder',
            folderPath: folder.path,
            title: `${t('editTags', 'Tags bearbeiten')}: ${folder.metadata?.title || folder.name}`,
            tags: folder.tags || [],
            suggestions: allKnownTags,
        });
    };

    const handleEditVideoTags = (video) => {
        setTagDialog({
            targetType: 'video',
            videoId: video.id,
            videoPath: video.filePath || video.path || null,
            title: `${t('editTags', 'Tags bearbeiten')}: ${video.title}`,
            tags: video.tags || [],
            suggestions: allKnownTags,
        });
    };

    const handleEditVrMeta = async (video) => {
        if (!video?.id) return;
        try {
            const res = await fetch(`/api/videos/${video.id}/vr-meta`);
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }
            const data = await res.json();
            setVrMetaDialog({
                video,
                projection: String(data?.projection || 'unknown'),
                stereoMode: String(data?.stereoMode || 'mono'),
                detected: data?.detected || null,
                saving: false,
            });
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const saveVrMeta = async () => {
        if (!vrMetaDialog?.video?.id) return;
        try {
            setVrMetaDialog(prev => (prev ? { ...prev, saving: true } : prev));
            const res = await fetch(`/api/videos/${vrMetaDialog.video.id}/vr-meta`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projection: vrMetaDialog.projection,
                    stereoMode: vrMetaDialog.stereoMode,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || t('unknown', 'Unbekannt'));
            }
            await fetchContent();
            setVrMetaDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            setVrMetaDialog(prev => (prev ? { ...prev, saving: false } : prev));
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handleSaveTags = async (tags) => {
        if (!tagDialog) return;
        try {
            if (tagDialog.targetType === 'folder') {
                const res = await fetch('/api/tags/folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ folderPath: tagDialog.folderPath, tags }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            } else {
                const res = await fetch(`/api/tags/video/${tagDialog.videoId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tags, videoPath: tagDialog.videoPath || null }),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || t('unknown', 'Unbekannt'));
                }
            }

            await fetchContent();
            showToast(t('saved', 'Gespeichert'));
            setTagDialog(null);
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const getCurrentSelectableVideos = () => (
        (videoTab === 'performers' && performerDetail)
            ? filteredPerformerVideos
            : filteredVideos
    );

    const toggleVideoSelection = (video, e = null) => {
        const key = videoSelectionKey(video);
        if (!key) return;
        const ordered = getCurrentSelectableVideos().map(videoSelectionKey).filter(Boolean);
        const hasRange = !!(e?.shiftKey && videoSelectionAnchorRef.current && ordered.includes(videoSelectionAnchorRef.current) && ordered.includes(key));
        if (hasRange) {
            const a = ordered.indexOf(videoSelectionAnchorRef.current);
            const b = ordered.indexOf(key);
            const [from, to] = a <= b ? [a, b] : [b, a];
            const range = ordered.slice(from, to + 1);
            setSelectedVideoKeys((prev) => [...new Set([...prev, ...range])]);
            return;
        }
        videoSelectionAnchorRef.current = key;
        setSelectedVideoKeys(prev => (
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        ));
    };

    const uploadPerformerImage = async () => {
        const performerId = String(performerImageDialog?.performerId || '').trim();
        if (!performerId) return;
        let imageData = null;
        if (window.electronAPI?.selectImage) {
            const result = await window.electronAPI.selectImage();
            if (!result) return;
            imageData = result.base64;
        } else {
            imageData = await new Promise((resolve) => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = () => {
                    const file = input.files?.[0];
                    if (!file) return resolve(null);
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => resolve(null);
                    reader.readAsDataURL(file);
                };
                input.click();
            });
            if (!imageData) return;
        }

        setPerformerImageDialog((prev) => prev ? { ...prev, saving: true, error: '' } : prev);
        try {
            const res = await fetch(`/api/tpdb/performers/${encodeURIComponent(performerId)}/image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageData }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('saveFailed', 'Failed to save'));
            const bust = Date.now();
            const performerImage = `/api/tpdb/performers/${encodeURIComponent(performerId)}/image?v=${bust}`;
            setPerformers((prev) => prev.map((p) => String(p?.id || '') === performerId ? { ...p, imageUrl: performerImage } : p));
            setPerformerDetail((prev) => {
                if (!prev?.performer || String(prev.performer.id || '') !== performerId) return prev;
                return { ...prev, performer: { ...prev.performer, imageUrl: performerImage } };
            });
            setPerformerImageDialog((prev) => prev ? {
                ...prev,
                saving: false,
                selectedImageUrl: String(data?.selectedImageUrl || ''),
                images: Array.isArray(prev.images)
                    ? prev.images.map((img) => ({ ...img, selected: false }))
                    : prev.images,
                groups: prev.groups && typeof prev.groups === 'object'
                    ? Object.fromEntries(
                        Object.entries(prev.groups).map(([key, list]) => [
                            key,
                            Array.isArray(list)
                                ? list.map((img) => ({ ...img, selected: false }))
                                : [],
                        ]),
                    )
                    : prev.groups,
            } : prev);
            showToast(t('posterUpdated', 'Poster updated!'));
            setPerformerImageDialog(null);
        } catch (err) {
            setPerformerImageDialog((prev) => prev ? { ...prev, saving: false, error: String(err?.message || t('saveFailed', 'Failed to save')) } : prev);
        }
    };

    const selectVideoFromContextMenu = (video) => {
        const key = videoSelectionKey(video);
        if (!key) return;
        videoSelectionAnchorRef.current = key;
        setSelectedVideoKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));
    };

    const toggleAllFilteredVideos = () => {
        const keys = getCurrentSelectableVideos().map(videoSelectionKey).filter(Boolean);
        const allSelected = keys.length > 0 && keys.every(k => selectedVideoKeys.includes(k));
        if (allSelected) {
            setSelectedVideoKeys(prev => prev.filter(k => !keys.includes(k)));
        } else {
            setSelectedVideoKeys(prev => [...new Set([...prev, ...keys])]);
        }
    };

    const selectFolderFromContextMenu = (folderPath) => {
        if (!folderPath) return;
        folderSelectionAnchorRef.current = folderPath;
        setSelectedFolderPaths((prev) => (prev.includes(folderPath) ? prev : [...prev, folderPath]));
    };

    const openBatchVideoTags = () => {
        if (selectedVideos.length === 0) return;
        const common = (selectedVideos[0]?.tags || []).filter(tag =>
            selectedVideos.every(v => (v.tags || []).some(tg => String(tg).toLowerCase() === String(tag).toLowerCase()))
        );
        setBatchVideoTagDialog({
            title: `${t('batchTags', 'Batch-Tags')}: ${selectedVideos.length} ${t('videos', 'Videos')}`,
            tags: common,
        });
    };

    const handleSaveBatchVideoTags = async (tags) => {
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
            await fetchContent();
            setSelectedVideoKeys([]);
            setBatchVideoTagDialog(null);
            showToast(t('saved', 'Gespeichert'));
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const openPlaylistDialogForVideos = (videos, title) => {
        const normalized = Array.isArray(videos) ? videos.filter(v => !!(v?.filePath || v?.path)) : [];
        if (normalized.length === 0) return;
        setPlaylistDialog({
            title: title || `${t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}: ${normalized.length} ${t('videos', 'Videos')}`,
            videos: normalized,
        });
    };

    const handleApplyPlaylist = (data) => {
        const addedCount = Number(data?.addedCount || 0);
        const playlistName = data?.playlist?.name || t('playlists', 'Playlists');
        showToast(`${addedCount} ${t('addedToPlaylist', 'zur Playlist hinzugef\u00FCgt')}: ${playlistName}`);
        setPlaylistDialog(null);
    };

    const handleContextMenu = (e, item, type) => {
        e.preventDefault();
        const items = [];
        if (type === 'folder') {
            items.push({
                label: t('select', 'Ausw\u00E4hlen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 11 12 14 20 6" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
                onClick: () => selectFolderFromContextMenu(item.path),
            });
            items.push({
                label: t('renameTitle', 'Name \u00E4ndern'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>,
                onClick: () => handleRename(item),
            });
            items.push({
                label: t('searchTmdbMetadata', 'TMDB Metadaten suchen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>,
                onClick: () => handleTMDBPoster(item),
            });
            items.push({
                label: t('changePosterBackdrop', 'Poster/Backdrop ändern'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="6" y1="21" x2="18" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>,
                onClick: () => handleOpenSeriesImageEditor(item),
            });
            items.push({
                label: t('editTags', 'Tags bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                onClick: () => handleEditFolderTags(item),
            });
        }
        if (type === 'video') {
            items.push({
                label: t('play', 'Abspielen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
                onClick: () => playFromFilteredQueue(item),
            });
            items.push({
                label: t('select', 'Ausw\u00E4hlen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><polyline points="9 11 12 14 20 6" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
                onClick: () => selectVideoFromContextMenu(item),
            });
            items.push({
                label: t('editTags', 'Tags bearbeiten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" /></svg>,
                onClick: () => handleEditVideoTags(item),
            });
            if (isVideoLib && !isVrLib) {
                items.push({
                    label: t('fetchMetadata', 'Fetch metadata'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M21 21l-4.35-4.35" /><circle cx="10.5" cy="10.5" r="7.5" /><path d="M10.5 6.5v8" /><path d="M6.5 10.5h8" /></svg>,
                    onClick: () => handleOpenTpdbDialog(item),
                });
            }
            items.push({
                label: t('manageScript', 'Script verwalten'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" /><rect x="2.5" y="4" width="19" height="16" rx="3" /></svg>,
                onClick: () => onOpenFunscriptManager?.({
                    videoId: item?.id,
                    libraryId: library?.id,
                    title: item?.title || item?.fileName || '',
                }),
            });
            items.push({
                label: t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h10" /><path d="m17 15 3 3-3 3" /><path d="M20 18h-6" /></svg>,
                onClick: () => openPlaylistDialogForVideos([item], `${t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}: ${item.title}`),
            });
            if (isVrLib) {
                items.push({
                    label: t('editVrMeta', 'VR-Meta bearbeiten'),
                    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c3 3 3 15 0 18" /></svg>,
                    onClick: () => handleEditVrMeta(item),
                });
            }
            items.push({
                label: t('regenerateThumbnailShort', 'Regenerate thumbnail'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="14" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /><path d="M12 19v2" /><path d="M8 21h8" /></svg>,
                onClick: () => setThumbTimestampDialogVideo(item),
            });
            items.push({
                label: t('properties', 'Eigenschaften'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></svg>,
                onClick: () => setPropertiesVideo(item),
            });
        }
        if (type === 'performer') {
            if (!String(item?.id || '').trim()) return;
            items.push({
                label: t('choosePerformerPoster', 'Performer poster auswählen'),
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></svg>,
                onClick: () => openPerformerImageDialog(item),
            });
        }
        if (items.length > 0) setContextMenu({ x: e.clientX, y: e.clientY, items });
    };

    const showToast = (message, type = 'success') => { setToast({ message, type }); setTimeout(() => setToast(null), 3000); };

    // Infinite Scroll State
    const [visibleCount, setVisibleCount] = useState(50);
    const libraryMainRef = useRef(null);
    const pendingScrollRestoreRef = useRef(null);
    const [isRestoringScroll, setIsRestoringScroll] = useState(false);
    const restoreSettleRef = useRef({ lastMax: -1, stableTicks: 0 });
    const attachLibraryMainRef = useCallback((node) => {
        libraryMainRef.current = node;
        if (!node) return;
        const key = String(library?.id || '').trim();
        if (!key) return;
        const savedRaw = sessionStorage.getItem(`glyph_library_scroll_${key}`);
        const saved = Number(savedRaw);
        if (Number.isFinite(saved) && saved > 0) {
            const target = Math.max(0, Math.floor(saved));
            if (Math.abs(node.scrollTop - target) > 2) {
                node.scrollTop = target;
            }
        }
    }, [library?.id]);

    useEffect(() => {
        setVisibleCount(50);
    }, [filters, search, videoTab, selectedTagFilters, tagFilterMode]);

    useLayoutEffect(() => {
        setVisibleCount(50);
        restoreSettleRef.current = { lastMax: -1, stableTicks: 0 };
        const key = String(library?.id || '').trim();
        if (!key) {
            if (libraryMainRef.current) libraryMainRef.current.scrollTop = 0;
            setIsRestoringScroll(false);
            return;
        }
        const savedRaw = sessionStorage.getItem(`glyph_library_scroll_${key}`);
        const saved = Number(savedRaw);
        if (Number.isFinite(saved) && saved > 0) {
            pendingScrollRestoreRef.current = saved;
            setIsRestoringScroll(true);
            setVisibleCount(prev => Math.max(prev, 200));
            if (libraryMainRef.current) {
                const target = Math.max(0, Math.floor(saved));
                if (Math.abs(libraryMainRef.current.scrollTop - target) > 2) {
                    libraryMainRef.current.scrollTop = target;
                }
            }
            return;
        }
        setIsRestoringScroll(false);
        if (libraryMainRef.current) libraryMainRef.current.scrollTop = 0;
    }, [library?.id]);

    useLayoutEffect(() => {
        const pending = pendingScrollRestoreRef.current;
        if (!Number.isFinite(pending) || pending <= 0) return;
        if (!libraryMainRef.current) return;
        const key = String(library?.id || '').trim();
        const target = Math.max(0, Math.floor(pending));
        const el = libraryMainRef.current;
        const maxScrollableTop = Math.max(0, el.scrollHeight - el.clientHeight);
        const isFolderPosterView = isSeriesLib && videoTab === 'folders';
        const settle = restoreSettleRef.current;
        if (Math.abs(maxScrollableTop - settle.lastMax) <= 1) {
            settle.stableTicks += 1;
        } else {
            settle.lastMax = maxScrollableTop;
            settle.stableTicks = 0;
        }

        if (!isFolderPosterView && maxScrollableTop < target && visibleCount < filteredVideos.length) {
            setVisibleCount(prev => Math.min(prev + 200, filteredVideos.length));
            return;
        }
        const targetClamped = Math.min(target, maxScrollableTop);
        if (Math.abs(el.scrollTop - targetClamped) > 2) {
            el.scrollTop = targetClamped;
        }
        const reached = Math.abs(el.scrollTop - targetClamped) <= 2;
        let canDecideNow = false;
        if (isFolderPosterView) {
            canDecideNow = reached && (maxScrollableTop >= target || (!loading && settle.stableTicks >= 3));
        } else {
            const fullyExpanded = visibleCount >= filteredVideos.length;
            canDecideNow = reached && (maxScrollableTop >= target || (!loading && fullyExpanded && settle.stableTicks >= 2));
        }
        if (canDecideNow) {
            pendingScrollRestoreRef.current = null;
            setIsRestoringScroll(false);
            if (key) {
                try { sessionStorage.removeItem(`glyph_library_scroll_${key}`); } catch { }
            }
        }
    }, [loading, filteredFolders.length, filteredVideos.length, visibleCount, library?.id, isSeriesLib, videoTab]);

    const handleScroll = useCallback(() => {
        if (!libraryMainRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = libraryMainRef.current;
        if (scrollTop + clientHeight >= scrollHeight - 400) {
            setVisibleCount(prev => Math.min(prev + 50, filteredVideos.length));
        }
    }, [filteredVideos.length]);

    useEffect(() => {
        const el = libraryMainRef.current;
        if (el) el.addEventListener('scroll', handleScroll);
        return () => el && el.removeEventListener('scroll', handleScroll);
    }, [handleScroll]);

    const selectionHotkeysEnabled = !contextMenu && !tmdbDialog && !seriesImageDialog && !tpdbDialogVideo && !batchTMDBOpen && !renameDialog && !tagDialog && !batchVideoTagDialog && !playlistDialog && !vrMetaDialog && !propertiesVideo && !performerImageDialog;
    useSelectionHotkeys({
        enabled: selectionHotkeysEnabled,
        onSelectAll: () => {
            if (isSeriesLib && videoTab === 'folders') {
                toggleAllFilteredFolders();
                return;
            }
            if (videoTab === 'all') {
                toggleAllFilteredVideos();
                return;
            }
            if (videoTab === 'performers' && performerDetail) {
                toggleAllFilteredVideos();
            }
        },
        onClearSelection: () => {
            setSelectedFolderPaths([]);
            setSelectedVideoKeys([]);
            folderSelectionAnchorRef.current = '';
            videoSelectionAnchorRef.current = '';
        },
    });

    if (!library) { if (onBack) onBack(); return null; }

    return (
        <div className="library-layout">
            {/* Left Sidebar */}
            {isSeriesLib && videoTab === 'folders' ? (
                <aside className="sidebar series-sidebar">
                    <div className="sidebar-section">
                        <div className="sidebar-heading">{t('filter', 'Filter')}</div>
                        <div className="sidebar-options">
                            <label className={`sidebar-radio ${seriesFilter === 'all' ? 'active' : ''}`}>
                                <input type="radio" name="sf" checked={seriesFilter === 'all'} onChange={() => setSeriesFilter('all')} />
                                {t('allSeries', 'Alle Serien')}
                                <span className="sidebar-count">{folders.length}</span>
                            </label>
                            <label className={`sidebar-radio ${seriesFilter === 'withMeta' ? 'active' : ''}`}>
                                <input type="radio" name="sf" checked={seriesFilter === 'withMeta'} onChange={() => setSeriesFilter('withMeta')} />
                                {t('withMetadata', 'Mit Metadaten')}
                                <span className="sidebar-count">{withMetaCount}</span>
                            </label>
                            <label className={`sidebar-radio ${seriesFilter === 'withFs' ? 'active' : ''}`}>
                                <input type="radio" name="sf" checked={seriesFilter === 'withFs'} onChange={() => setSeriesFilter('withFs')} />
                                {t('withFunscript', 'Mit Funscript')}
                                <span className="sidebar-count">{withFsCount}</span>
                            </label>
                        </div>
                    </div>
                    <div className="sidebar-section">
                        <div className="sidebar-heading">{t('sorting', 'Sortierung')}</div>
                        <div className="sidebar-options">
                            <label className={`sidebar-radio ${seriesSort === 'name' ? 'active' : ''}`}>
                                <input type="radio" name="ss" checked={seriesSort === 'name'} onChange={() => setSeriesSort('name')} />
                                {t('nameLabel', 'Name')}
                            </label>
                            <label className={`sidebar-radio ${seriesSort === 'date' ? 'active' : ''}`}>
                                <input type="radio" name="ss" checked={seriesSort === 'date'} onChange={() => setSeriesSort('date')} />
                                {t('newestFirst', 'Erstellungsdatum')}
                            </label>
                            <label className={`sidebar-radio ${seriesSort === 'count' ? 'active' : ''}`}>
                                <input type="radio" name="ss" checked={seriesSort === 'count'} onChange={() => setSeriesSort('count')} />
                                {t('countVideos', 'Anzahl Videos')}
                            </label>
                        </div>
                    </div>
                    <div className="sidebar-section">
                        <div className="sidebar-heading-row">
                            <div className="sidebar-heading" style={{ marginBottom: 0 }}>{t('tagsTitle', 'Tags')}</div>
                            <div className="sidebar-tag-mode-toggle sidebar-tag-mode-inline">
                                <span className={`sidebar-tag-mode-label ${tagFilterMode === 'or' ? 'active' : ''}`}>OR</span>
                                <label className="settings-switch" title={tagFilterMode === 'and' ? 'AND' : 'OR'}>
                                    <input
                                        type="checkbox"
                                        checked={tagFilterMode === 'and'}
                                        onChange={(e) => setTagFilterMode(e.target.checked ? 'and' : 'or')}
                                    />
                                    <span className="settings-switch-track">
                                        <span className="settings-switch-thumb" />
                                    </span>
                                </label>
                                <span className={`sidebar-tag-mode-label ${tagFilterMode === 'and' ? 'active' : ''}`}>AND</span>
                            </div>
                        </div>
                        <div className="sidebar-options">
                            <label className={`sidebar-radio ${selectedTagFilters.length === 0 ? 'active' : ''}`}>
                                <input type="radio" name="stag" checked={selectedTagFilters.length === 0} onChange={clearTagFilters} />
                                {t('allTags', 'Alle Tags')}
                            </label>
                            {groupedFolderTagStats.map(group => (
                                <React.Fragment key={group.key}>
                                    <div className="sidebar-heading" style={{ marginTop: 8, marginBottom: 4 }}>{group.label}</div>
                                    {group.tags.map(tag => (
                                        <label
                                            key={tag.name}
                                            className={`sidebar-radio ${selectedTagFilters.includes(tag.name) ? 'active' : ''} ${(tag.count === 0 && !selectedTagFilters.includes(tag.name)) ? 'unavailable' : ''}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedTagFilters.includes(tag.name)}
                                                disabled={tag.count === 0 && !selectedTagFilters.includes(tag.name)}
                                                onChange={() => toggleTagFilter(tag.name)}
                                            />
                                            <span>#{tag.name}</span>
                                            <span className="sidebar-count">{tag.count}</span>
                                        </label>
                                    ))}
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                    {activeLetter && (
                        <div className="sidebar-section">
                            <div className="sidebar-heading">{t('letter', 'Buchstabe')}</div>
                            <div className="sidebar-active-filter">
                                <span>{activeLetter}</span>
                                <button className="sidebar-clear-btn" onClick={() => setActiveLetter(null)}>x</button>
                            </div>
                        </div>
                    )}
                </aside>
            ) : (
                !isPerformerGridView && (
                    <Sidebar
                        filters={filters}
                        onFilterChange={setFilters}
                        extensions={extensions}
                        tags={folderBrowserTagStats || sidebarVideoTagStats}
                        selectedTagFilters={selectedTagFilters}
                        onTagFilterToggle={toggleTagFilter}
                        onTagFilterClear={clearTagFilters}
                        tagFilterMode={tagFilterMode}
                        onTagFilterModeChange={setTagFilterMode}
                        isVrLibrary={isVrLib}
                    />
                )
            )}


            <div className={`library-main${isRestoringScroll ? ' restore-lock' : ''}`} ref={attachLibraryMainRef}>
                <div className="library-header">
                    <div className="library-header-left">
                        <h2 className="library-heading">{library.name}</h2>
                        {isSeriesLib && (
                            <span className="library-result-count">
                                {filteredFolders.length} {filteredFolders.length === 1 ? t('seriesOne', 'Serie') : t('series', 'Serien')}
                                {filteredFolders.length !== folders.length && ` ${t('of', 'von')} ${folders.length}`}
                            </span>
                        )}
                        {isVrLib && videoTab === 'all' && (
                            <span className="library-result-count">
                                {filteredVideos.length} {filteredVideos.length === 1 ? t('vrVideoOne', 'VR-Video') : t('vrVideos', 'VR-Videos')}
                                {filteredVideos.length !== videos.length && ` ${t('of', 'von')} ${videos.length}`}
                            </span>
                        )}
                        {!isSeriesLib && !isVrLib && videoTab === 'all' && (
                            <span className="library-result-count">
                                {filteredVideos.length} {filteredVideos.length === 1 ? t('video', 'Video') : t('videos', 'Videos')}
                                {filteredVideos.length !== videos.length && ` ${t('of', 'von')} ${videos.length}`}
                            </span>
                        )}
                    </div>
                </div>

                {/* Sticky Search Bar (title/count stay non-sticky) */}
                {(
                    <div className="library-search-sticky">
                        <div className="search-bar">
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
                )}

                {/* Tabs for Video Libraries */}
                {/* Tabs for Video Libraries */}
                <div className="library-tabs">
                    {isSeriesLib ? (
                        <>
                            <button className={`library-tab ${videoTab === 'folders' ? 'active' : ''}`} onClick={() => setVideoTab('folders')}>{t('allSeries', 'Serien')}</button>
                            <button className={`library-tab ${videoTab === 'all' ? 'active' : ''}`} onClick={() => setVideoTab('all')}>{t('allEpisodes', 'Alle Episoden')}</button>
                        </>
                    ) : (
                        <>
                            <button className={`library-tab ${videoTab === 'all' ? 'active' : ''}`} onClick={() => setVideoTab('all')}>{isVrLib ? t('vrVideos', 'VR-Videos') : t('allVideos', 'Alle Videos')}</button>
                            {!isAllVideosVirtualLibrary && (
                                <button className={`library-tab ${videoTab === 'folders' ? 'active' : ''}`} onClick={() => setVideoTab('folders')}>{t('folderStructure', 'Ordnerstruktur')}</button>
                            )}
                            {isVideoLib && !isVrLib && (hasPerformerData || videoTab === 'performers') && (
                                <button
                                    className={`library-tab ${videoTab === 'performers' ? 'active' : ''}`}
                                    onClick={() => setVideoTab('performers')}
                                >
                                    {t('performers', 'Performers')}
                                </button>
                            )}
                        </>
                    )}

                    {videoTab === 'all' && (
                        <div className="library-view-controls">
                            {viewMode === 'grid' && (
                                <div className="fb-size-slider" title={t('videoSize', 'Videogröße')}>
                                    <input
                                        type="range"
                                        min="180"
                                        max="360"
                                        step="10"
                                        value={videoThumbSize}
                                        onChange={(e) => setVideoThumbSize(Number(e.target.value))}
                                    />
                                </div>
                            )}
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
                            {filteredVideos.length > 0 && selectedVideoKeys.length === 0 && (
                                <button
                                    className="btn-shuffle-icon"
                                    onClick={() => {
                                        const shuffled = buildShuffledQueue(filteredVideos);
                                        const first = shuffled[0];
                                        if (first) onPlay(first, { queueVideos: shuffled });
                                    }}
                                    title={t('randomVideo', 'Zuf\u00E4lliges Video abspielen')}
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
                        </div>
                    )}
                </div>

                {performerFilter && (performerFilter.name || performerFilter.id) && (
                    <div className="library-active-performer-filter">
                        <span>
                            {t('filteredByPerformer', 'Filtered by performer')}: <strong>{performerFilter.name || performerFilter.id}</strong>
                        </span>
                        <button
                            type="button"
                            className="library-active-performer-clear"
                            onClick={() => setPerformerFilter(null)}
                        >
                            {t('clearPerformerFilter', 'Clear')}
                        </button>
                    </div>
                )}

                {(loading && videos.length === 0 && folders.length === 0 && videoTab !== 'folders') ? (
                    <div className="loading-spinner"><div className="spinner" /></div>
                ) : (
                    <>

                        {/* Series Grid */}
                        {isSeriesLib && videoTab === 'folders' && filteredFolders.length > 0 && (
                            <div className="folder-grid-centered series-grid">
                                {filteredFolders.map(folder => (
                                    <div
                                        key={folder.id}
                                        className="folder-card"
                                        onClick={(e) => {
                                            if (selectedFolderPaths.length > 0 || e.shiftKey || e.ctrlKey || e.metaKey) {
                                                toggleFolderSelection(folder.path, e);
                                                return;
                                            }
                                            handleFolderClick(folder);
                                        }}
                                        onContextMenu={(e) => handleContextMenu(e, folder, 'folder')}
                                    >
                                        <div
                                            className={`folder-select-corner ${selectedFolderPaths.includes(folder.path) ? 'selected' : ''} ${selectedFolderPaths.length > 0 ? 'selection-mode' : ''}`}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleFolderSelection(folder.path, e);
                                            }}
                                            onContextMenu={(e) => e.stopPropagation()}
                                        >
                                            <button
                                                type="button"
                                                className={`folder-select-checkbox ${selectedFolderPaths.includes(folder.path) ? 'checked' : ''}`}
                                                aria-label={selectedFolderPaths.includes(folder.path) ? t('removeSelection', 'Auswahl entfernen') : t('select', 'Ausw\u00E4hlen')}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleFolderSelection(folder.path, e);
                                                }}
                                            >
                                                <span className="folder-select-check" />
                                            </button>
                                        </div>
                                        <div className="folder-card-poster">
                                            {(folder.hasPoster || !!folder?.metadata?.posterPath) ? (
                                                <img
                                                    src={getFolderPosterSrc(folder)}
                                                    alt={folder.name}
                                                    loading="lazy"
                                                    onError={(e) => {
                                                        const tmdbFallback = getFolderPosterTmdbUrl(folder);
                                                        if (tmdbFallback && e.currentTarget.src !== tmdbFallback) {
                                                            e.currentTarget.src = tmdbFallback;
                                                        }
                                                    }}
                                                />
                                            ) : (
                                                <div className="folder-card-placeholder">
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
                                                    <span>{folder.name.substring(0, 2).toUpperCase()}</span>
                                                </div>
                                            )}
                                            <div className="folder-card-overlay">
                                                <span className="folder-card-count">{folder.videoCount} {t('videos', 'Videos')}</span>
                                            </div>
                                        </div>
                                        <div className="folder-card-info">
                                            <div className="folder-card-title" title={folder.metadata?.title || folder.name}>
                                                {folder.metadata?.title || folder.name}
                                            </div>
                                            {Array.isArray(folder.tags) && folder.tags.length > 0 && (
                                                <div className="item-tag-row">
                                                    {folder.tags.slice(0, 3).map(tag => (
                                                        <span key={tag} className="item-tag item-tag-clickable"
                                                            onClick={(e) => { e.stopPropagation(); toggleTagFilter(tag); }}
                                                        >{tag}</span>
                                                    ))}
                                                </div>
                                            )}
                                            {folder.metadata && (
                                                <div className="folder-card-meta">
                                                    {folder.metadata.releaseDate && <span>{folder.metadata.releaseDate.substring(0, 4)}</span>}
                                                    {folder.metadata.voteAverage && <span>Rating {folder.metadata.voteAverage.toFixed(1)}</span>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Video Views - Virtualized */}
                        {videoTab === 'all' && filteredVideos.length > 0 && (
                            <div
                                className={`video-grid ${viewMode === 'list' ? 'list-mode' : ''}`}
                                style={{ '--video-grid-min': `${videoThumbSize}px` }}
                            >
                                {filteredVideos.slice(0, visibleCount).map(video => (
                                    <VideoCard
                                        key={video.id}
                                        video={{ ...video, thumbVersion: Number(thumbnailVersionByVideoId[String(video.id || '')] || video?.thumbVersion || video?.modifiedAt || 0) }}
                                        onPlay={playFromFilteredQueue}
                                        onContextMenu={(e) => handleContextMenu(e, video, 'video')}
                                        selected={selectedVideoKeys.includes(videoSelectionKey(video))}
                                        selectionMode={selectedVideoKeys.length > 0}
                                        onToggleSelect={toggleVideoSelection}
                                        viewMode={viewMode}
                                        reserveHeatmapSpace
                                        showPerformers={showPerformerChips}
                                        onPerformerClick={handlePerformerChipClick}
                                        onTagClick={toggleTagFilter}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Folder Browser */}
                        {!isSeriesLib && videoTab === 'folders' && (
                            <FileBrowserBoundary>
                                <FileBrowser
                                    library={library}
                                    onPlay={playFromFilteredQueue}
                                    onOpenFunscriptManager={onOpenFunscriptManager}
                                    search={search}
                                    filters={filters}
                                    selectedTagFilters={selectedTagFilters}
                                    tagFilterMode={tagFilterMode}
                                    onTagClick={toggleTagFilter}
                                    onVideosChange={setFolderBrowserVideos}
                                />
                            </FileBrowserBoundary>
                        )}

                        {!isSeriesLib && videoTab === 'performers' && isVideoLib && !isVrLib && (
                            <div>
                                {performersLoading ? (
                                    <div className="loading-spinner"><div className="spinner" /></div>
                                ) : performerDetail ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                                        <div className="series-header" style={{ display: 'grid', gridTemplateColumns: '220px minmax(0,1fr)', gap: 24, alignItems: 'start' }}>
                                            <div
                                                className="series-poster-wrap"
                                                style={{ maxWidth: 220 }}
                                                onContextMenu={(e) => handleContextMenu(e, performerDetail?.performer || {}, 'performer')}
                                            >
                                                <button
                                                    type="button"
                                                    className="performer-detail-quickedit"
                                                    title={t('changePoster', 'Change poster/thumbnail')}
                                                    aria-label={t('changePoster', 'Change poster/thumbnail')}
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        e.stopPropagation();
                                                        openPerformerImageDialog(performerDetail?.performer || {});
                                                    }}
                                                >
                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                                                        <rect x="3" y="5" width="18" height="14" rx="2" />
                                                        <circle cx="9" cy="10" r="1.5" />
                                                        <path d="M7 16l4-4 3 3 2-2 2 3" />
                                                    </svg>
                                                </button>
                                                {performerDetail?.performer?.imageUrl ? (
                                                    <img src={performerDetail.performer.imageUrl} alt={performerDetail.performer.name || 'Performer'} className="series-poster performer-detail-poster" style={{ objectFit: 'cover' }} />
                                                ) : (
                                                    <div className="series-poster-placeholder">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                                            <circle cx="12" cy="7" r="4" />
                                                        </svg>
                                                    </div>
                                                )}
                                            </div>
                                            <div className="series-meta">
                                                <h1 className="series-title">{performerDetail?.performer?.name || t('performer', 'Performer')}</h1>
                                                <div className="performer-facts-list">
                                                    {(() => {
                                                        const p = performerDetail?.performer || {};
                                                        const facts = [];
                                                        const age = Number(p.age || 0);
                                                        if (age > 0) facts.push({ key: 'age', label: t('age', 'Age'), value: String(age), icon: 'person' });
                                                        if (p.birthdate) facts.push({ key: 'birthdate', label: t('birthdate', 'Birthdate'), value: String(p.birthdate), icon: 'calendar' });
                                                        if (p.birthplace) facts.push({ key: 'birthplace', label: t('birthplace', 'Birthplace'), value: String(p.birthplace), icon: 'pin' });
                                                        if (p.nationality) facts.push({ key: 'nationality', label: t('nationality', 'Nationality'), value: String(p.nationality), icon: 'globe' });
                                                        if (p.gender) facts.push({ key: 'gender', label: t('gender', 'Gender'), value: String(p.gender), icon: 'person' });
                                                        if (Number(p.careerStartYear || 0) > 0 || Number(p.careerEndYear || 0) > 0) {
                                                            const start = Number(p.careerStartYear || 0) > 0 ? String(p.careerStartYear) : '';
                                                            const end = Number(p.careerEndYear || 0) > 0 ? String(p.careerEndYear) : '';
                                                            const range = end ? `${start}–${end}` : `${start}–`;
                                                            const value = `${t('active', 'Active')} ${range}`.trim();
                                                            facts.push({ key: 'career', label: t('career', 'Career'), value, icon: 'briefcase' });
                                                        }
                                                        if (Number(p.heightCm || 0) > 0) facts.push({ key: 'height', label: t('height', 'Height'), value: `${p.heightCm} cm`, icon: 'height' });
                                                        if (p.measurements) facts.push({ key: 'measurements', label: t('measurements', 'Measurements'), value: String(p.measurements), icon: 'tape' });
                                                        if (p.breastType) facts.push({ key: 'breastType', label: t('breastType', 'Breast type'), value: String(p.breastType), icon: 'breasts' });
                                                        if (p.ethnicity) facts.push({ key: 'ethnicity', label: t('ethnicity', 'Ethnicity'), value: String(p.ethnicity), icon: 'globe2' });
                                                        if (p.eyeColor) facts.push({ key: 'eyeColor', label: t('eyeColor', 'Eye color'), value: String(p.eyeColor), icon: 'eye' });
                                                        if (p.hairColor) facts.push({ key: 'hairColor', label: t('hairColor', 'Hair color'), value: String(p.hairColor), icon: 'hair' });
                                                        if (p.tattoos) facts.push({ key: 'tattoos', label: t('tattoos', 'Tattoos'), value: String(p.tattoos), icon: 'needle' });
                                                        if (p.piercings) facts.push({ key: 'piercings', label: t('piercings', 'Piercings'), value: String(p.piercings), icon: 'ring' });
                                                        if (Array.isArray(p.aliases) && p.aliases.length > 0) facts.push({ key: 'aliases', label: t('aliases', 'Aliases'), value: p.aliases.join(', '), icon: 'list' });

                                                        const icon = (type) => {
                                                            if (type === 'calendar') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 11h18" /></svg>;
                                                            if (type === 'pin') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s7-5.33 7-11a7 7 0 1 0-14 0c0 5.67 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></svg>;
                                                            if (type === 'globe') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
                                                            if (type === 'briefcase') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></svg>;
                                                            if (type === 'height') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v18" /><path d="M8 6l4-3 4 3" /><path d="M8 18l4 3 4-3" /></svg>;
                                                            if (type === 'tape') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="6" width="20" height="12" rx="1" /><path d="M6 6v4M10 6v3M14 6v4M18 6v3" /></svg>;
                                                            if (type === 'bra') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11c0-3 2.5-5.5 5-5.5S12 8 12 11c0-3 1.5-5.5 4-5.5s5 2.5 5 5.5" /><path d="M3 11c0 2.5 1.5 4.5 3.5 5l2-2.5a3.5 3.5 0 0 0 3 2" /><path d="M21 11c0 2.5-1.5 4.5-3.5 5l-2-2.5a3.5 3.5 0 0 1-3 2" /></svg>;
                                                            if (type === 'waist') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 4c-1.5 3-2 5-2 8s.5 5 2 8" /><path d="M17 4c1.5 3 2 5 2 8s-.5 5-2 8" /><path d="M5 12h14" /></svg>;
                                                            if (type === 'hips') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4c-2 3-3 6-3 9 0 2 .5 4 2 6.5" /><path d="M16 4c2 3 3 6 3 9 0 2-.5 4-2 6.5" /><path d="M5 15h14" /></svg>;
                                                            if (type === 'eye') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>;
                                                            if (type === 'tag') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>;
                                                            if (type === 'breasts') return <svg viewBox="-20 -15 349 342" fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round"><path d="M8.96,151.93c2.65,28.23,7.22,53.55,21.55,78.31,68.76,118.87,245.86,82.01,266.16-51.78,12.04-79.38-34.43-103.55-59.73-165.47C234.68,7.49,230.87,2.39,239.03,0c5.26-.04,14.42,23.57,17.53,28.96,35.16,60.76,68.43,97.2,44.72,174.25C252.67,361.15,23.6,341.57,1.55,177.14c-.71-5.27-3.33-20.96.43-23.94l6.98-1.26Z" /><path d="M157.39,102.67c82.4-9.61,87.47,115.28,7.24,115.74-69.61.4-78.33-107.45-7.24-115.74ZM162.07,111.92c-63.13,5.02-56.72,100.91,7.26,95.59,62.41-5.19,52.8-100.36-7.26-95.59Z" /><path d="M178.89,176.04c-18.64,17.8-47.11-11.76-27.43-29.75,19.99-18.27,45.14,12.84,27.43,29.75ZM158.13,153.74c-8.82,8.36,2.86,22.36,12.88,15.19,10.8-7.73-3.27-24.29-12.88-15.19Z" /></svg>;
                                                            if (type === 'globe2') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3c2.2 2.5 3.5 5.5 3.5 9s-1.3 6.5-3.5 9c-2.2-2.5-3.5-5.5-3.5-9s1.3-6.5 3.5-9z" /></svg>;
                                                            if (type === 'hair') return <svg viewBox="-10 -10 203 209" fill="none" stroke="currentColor" strokeWidth="15" strokeLinecap="round" strokeLinejoin="round"><path d="M74.34,68c-3.36.69-6.46,2.06-9.5,3.62-22.94,11.83-36.52,36.95-32.39,62.74,1.16,7.26,7.64,17.64,1.32,22.8-8.91,7.27-15.35-7.68-18.96-14.18C-.18,115.9-4.83,89,5.71,59.14,17.46,25.87,53.46-8.59,90.56,9.85c5.8-3.84,7.45-8.8,15.05-9.56,38.25-3.82,69.87,30.69,76.11,66.06,2.9,16.42,1.8,43.53-2.24,59.73-4.27,17.13-17.13,23.59-13.13,44.41,1.03,5.34,6.96,16.26-2.87,17.83-14.82,2.37-25.52-12.57-26.69-25.88-.96-10.97,4.7-25.19.93-34.78-4.15-10.56-22.98-18.33-32.29-24.89-12.72-8.96-24.53-20.43-31.09-34.76Z" /></svg>;
                                                            if (type === 'needle') return <svg viewBox="-15 -15 237 237" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"><path d="M194.12.02c11.21-.56,17.95,14.72,7.87,22.48-7.01,5.39-10.7.52-14.79,2.38-4.07,1.85-12.6,14.22-17.26,17.27l6.11,6.16-33.91,33.87c-1.86,3.6,7.16,7.06,6.68,10.23-21.75,29.66-48.52,55.29-77.44,77.87l-8.15-6.74c-2.27-.4-3.92,3.94-6.23,4.59-2.86.81-5.94-.42-8.97.88-5.53,2.38-2.62,8.97-4.35,12.89-3.27,7.41-18.92,10.29-25.12,14.29-3.21,2.07-10.59,12.63-13.64,11.05L0,202.22c0-.87,10.44-9.78,12.11-12.49,3.45-5.57,4.63-13.77,8.8-19.52,3.04-4.19,24.6-22.89,24.6-24.63l-8.43-9.62c21.99-29.48,48.38-55.4,77.44-77.87l9.21,8.04,35.54-34.37,4.48,4.3c.93.82,1.5.49,2.45,0,1.05-.54,16.22-15.64,16.67-16.73.77-1.87-.91-5.25-.74-7.95.36-5.75,6.45-11.08,11.98-11.36ZM191.71,7.28c-6.78,2.04-2.59,13.38,4.09,11.58,8.17-2.2,6.12-14.65-4.09-11.58ZM158.38,40.38l-28.53,28.26c-1.65,3.57,5.15,11.1,8.7,8.67,9.34-6.42,19.33-21.72,28.88-29.01l-9.04-7.92ZM114.06,66.25l-8.16,6.67,28.88,27.71,6.79-8.01c-3.92-3.09-25.17-26.8-27.51-26.37ZM100.5,77.32c-1.89,2-7.86,5.68-6.4,8.52l28.4,28.31,7.98-7.98-29.98-28.85ZM87.04,89.68l-7,6.64c9.55,7.29,19.54,22.59,28.88,29.01,3.6,2.47,9.87-5.25,8.73-7.45-8.97-6.61-18.47-21.37-27.11-27.17-1.24-.83-1.79-1.48-3.5-1.03ZM75.71,100.65l-7.98,7.98c9.55,7.29,19.54,22.59,28.88,29.01,3.6,2.47,9.87-5.25,8.73-7.45l-29.63-29.54ZM63.56,114.26c-2.51,2.6-8.27,5.62-6.37,9.74.79,1.7,24.86,25.71,26.53,26.57,3.04,1.57,7.3-5.75,9.82-7.46l-29.98-28.85ZM51.12,127.72c-1.87,3.11-6.69,6.11-5.01,9.83.7,1.55,22.55,23.33,24.07,24.12l2.42-.02,7.4-6.21-28.88-27.71ZM19.69,189.29c4.12-2.94,18.17-5.87,18.36-11.61.06-1.76-1.57-3.57-.97-5.98.19-.78,6.9-7.85,7.77-8.34,4.46-2.52,9.3.66,12.46-3.61,1.58-3.07-5.89-7.44-7.46-9.84-11.1,12.46-26.97,21.78-30.16,39.38Z" /></svg>;
                                                            if (type === 'ring') return <svg viewBox="-10 -10 224 225" fill="none" stroke="currentColor" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round"><path d="M30.31,33.17l6,8.49c-9.86,9.72-18.34,24.85-21.69,38.29-15.81,63.53,35.9,122.51,101.07,113.07,71.96-10.42,102.51-98.69,52.65-151.37l6-8.49c.95-.21,1.29.07,2,.47,2.76,1.53,10.43,12.39,12.4,15.61,35.98,58.91,5.58,136.96-61.79,153.05C34.68,224.33-35.75,120.86,19.51,43.84c1.3-1.81,8.84-12.04,10.8-10.68Z" /><path fill="currentColor" d="M50.06.4c28.29-4.82,32.63,35.41,8.53,39.52C30.3,44.74,25.96,4.51,50.06.4Z" /><path fill="currentColor" d="M146.06.4c28.29-4.82,32.63,35.41,8.53,39.52-28.29,4.82-32.63-35.41-8.53-39.52Z" /></svg>;
                                                            if (type === 'list') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></svg>;
                                                            if (type === 'person') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="8" r="4" /><path d="M6 20v-1a6 6 0 0 1 12 0v1" /></svg>;
                                                            return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /></svg>;
                                                        };

                                                        return facts.map((fact) => (
                                                            <div key={fact.key} className={`performer-fact-row ${['tattoos', 'piercings', 'aliases'].includes(fact.key) ? 'performer-fact-row--full' : ''}`}>
                                                                <span className="performer-fact-icon">{icon(fact.icon)}</span>
                                                                <span className="performer-fact-label">{fact.label}</span>
                                                                <span className="performer-fact-value">{fact.value}</span>
                                                            </div>
                                                        ));
                                                    })()}
                                                </div>
                                                <div style={{ marginTop: 10 }}>
                                                    <button className="btn btn-secondary" onClick={() => setPerformerDetail(null)}>
                                                        {t('backToPerformers', 'Back to performers')}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="performer-detail-separator" aria-hidden="true" />
                                        {filteredPerformerVideos.length > 0 ? (
                                            <div
                                                className={`video-grid ${viewMode === 'list' ? 'list-mode' : ''}`}
                                                style={{ '--video-grid-min': `${videoThumbSize}px` }}
                                            >
                                                {filteredPerformerVideos.map((video) => (
                                                    <VideoCard
                                                        key={video.id}
                                                        video={{ ...video, thumbVersion: Number(thumbnailVersionByVideoId[String(video.id || '')] || video?.thumbVersion || video?.modifiedAt || 0) }}
                                                        onPlay={(v, opts = {}) => onPlay(v, { ...opts, queueVideos: filteredPerformerVideos })}
                                                        onContextMenu={(e) => handleContextMenu(e, video, 'video')}
                                                        selected={selectedVideoKeys.includes(videoSelectionKey(video))}
                                                        selectionMode={selectedVideoKeys.length > 0}
                                                        onToggleSelect={toggleVideoSelection}
                                                        viewMode={viewMode}
                                                        reserveHeatmapSpace
                                                        showPerformers={showPerformerChips}
                                                        onPerformerClick={handlePerformerChipClick}
                                                        onTagClick={toggleTagFilter}
                                                    />
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="empty-state library-empty-center" style={emptyCenterStyle}>
                                                <div className="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z" /></svg></div>
                                                <h2>{t('noVideos', 'No videos')}</h2>
                                                {(search || selectedTagFilters.length > 0 || performerFilter || filters.favorite || filters.funscript || filters.multiaxis || filters.audio || filters.extension || filters.vrProjection || filters.vrStereoMode) && (
                                                    <p>{t('noVideosFilters', 'Keine Videos mit diesen Filtern gefunden.')}</p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                ) : performers.length > 0 ? (
                                    <>
                                        <div className="performers-toolbar">
                                            <span className="performers-toolbar-label">{t('hideMalePerformers', 'Hide male performers')}</span>
                                            <label className="settings-switch" title={t('hideMalePerformers', 'Hide male performers')}>
                                                <input
                                                    type="checkbox"
                                                    checked={hideMalePerformers}
                                                    onChange={(e) => setHideMalePerformers(Boolean(e.target.checked))}
                                                />
                                                <span className="settings-switch-track">
                                                    <span className="settings-switch-thumb" />
                                                </span>
                                            </label>
                                        </div>
                                        {filteredPerformers.length > 0 ? (
                                            <div className="folder-grid-centered performer-grid">
                                                {filteredPerformers.map((p) => (
                                                    <div key={p.id} className="folder-card" onClick={() => openPerformerDetail(p.id)} onContextMenu={(e) => handleContextMenu(e, p, 'performer')}>
                                                        <div className="folder-card-poster">
                                                            {p?.imageUrl ? (
                                                                <img src={p.imageUrl} alt={p.name} loading="lazy" />
                                                            ) : (
                                                                <div className="folder-card-placeholder">
                                                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                                                                    <span>{String(p?.name || '').slice(0, 2).toUpperCase()}</span>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="folder-card-info">
                                                            <div className="folder-card-title" title={p.name}>{p.name}</div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <div className="empty-state library-empty-center" style={emptyCenterStyle}>
                                                <div className="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></div>
                                                <h2>{t('noPerformers', 'No performers yet')}</h2>
                                                <p>{t('noPerformersFilterHint', 'No performers match the current filter.')}</p>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="empty-state library-empty-center" style={emptyCenterStyle}>
                                        <div className="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg></div>
                                        <h2>{t('noPerformers', 'No performers yet')}</h2>
                                        <p>{t('noPerformersHint', 'Fetch metadata for videos to populate performer cards.')}</p>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Empty States */}
                        {isSeriesLib && filteredFolders.length === 0 && (
                            <div className="empty-state library-empty-center" style={emptyCenterStyle}>
                                <div className="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z" /></svg></div>
                                <h2>{t('noSeries', 'Keine Serien')}</h2>
                                <p>{t('noSeriesFilters', 'Keine Serien mit diesen Filtern gefunden.')}</p>
                            </div>
                        )}
                        {!isSeriesLib && videoTab === 'all' && filteredVideos.length === 0 && (
                            <div className="empty-state library-empty-center" style={emptyCenterStyle}>
                                <div className="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M15 10l4.553-2.276A1 1 0 0 1 21 8.618v6.764a1 1 0 0 1-1.447.894L15 14M5 18h8a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2z" /></svg></div>
                                <h2>{t('noVideos', 'Keine Videos')}</h2>
                                <p>{(search || selectedTagFilters.length > 0 || performerFilter || filters.favorite || filters.funscript || filters.multiaxis || filters.audio || filters.extension || filters.vrProjection || filters.vrStereoMode) ? t('noVideosFilters', 'Keine Videos mit diesen Filtern gefunden.') : t('noVideosFolder', 'Dieser Ordner enth\u00E4lt keine Videos.')}</p>
                            </div>
                        )}
                    </>
                )}
            </div>

            {isSeriesLib && videoTab === 'folders' && selectedFolderPaths.length > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllFilteredFolders}>
                        {t('selectAll', 'Alle ausw\u00E4hlen')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setSelectedFolderPaths([])}>
                        {t('deselectAll', 'Alle abw\u00E4hlen')}
                    </button>
                    <span className="batch-floating-count">{selectedFolderPaths.length} {t('selected', 'ausgew\u00E4hlt')}</span>
                    <button className="btn btn-primary" onClick={() => setBatchTMDBOpen(true)}>
                        {t('batchMetadata', 'Batch-Metadaten')}
                    </button>
                </div>
            )}

            {/* Alphabet Bar (right side), for series folders and performer grid.
               Keep it mounted during loading so layout width stays stable. */}
            {((isSeriesLib && videoTab === 'folders') || (!isSeriesLib && isVideoLib && !isVrLib && videoTab === 'performers' && !performerDetail)) && (
                <div className={`alphabet-bar${loading ? ' is-loading' : ''}`}>
                    {('ABCDEFGHIJKLMNOPQRSTUVWXYZ#').split('').map(letter => (
                        <button
                            key={letter}
                            className={`alphabet-letter ${activeLetter === letter ? 'active' : ''} ${((isSeriesLib && videoTab === 'folders') ? alphabet : performerAlphabet).includes(letter) ? '' : 'disabled'}`}
                            onClick={() => ((isSeriesLib && videoTab === 'folders') ? alphabet : performerAlphabet).includes(letter) && handleLetterClick(letter)}
                            disabled={!((isSeriesLib && videoTab === 'folders') ? alphabet : performerAlphabet).includes(letter)}
                        >
                            {letter}
                        </button>
                    ))}
                </div>
            )}



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
                    onApplied={(data) => {
                        const key = String(thumbTimestampDialogVideo?.id || '');
                        const nextVersion = Number(data?.thumbVersion || Date.now());
                        if (key) {
                            setThumbnailVersionByVideoId((prev) => ({ ...prev, [key]: nextVersion }));
                        }
                        fetchContent();
                        showToast(t('thumbnailRegenerated', 'Thumbnail regenerated!'));
                    }}
                />
            )}
            {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
            {tmdbDialog && (
                <TMDBDialog query={tmdbDialog.query} type={tmdbDialog.type} folderPath={tmdbDialog.folderPath}
                    onClose={() => setTmdbDialog(null)}
                    onApplied={(metadata) => {
                        applyFolderMetadataLocal(tmdbDialog.folderPath, metadata);
                        if (onLibraryUpdate) onLibraryUpdate();
                        showToast(t('metadataSaved', 'Metadaten gespeichert!'));
                    }} />
            )}
            {seriesImageDialog && (
                <div className="modal-overlay" onClick={() => !seriesImageDialog.saving && setSeriesImageDialog(null)}>
                    <div className="modal tmdb-modal series-images-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('changePosterBackdrop', 'Poster/Backdrop ändern')}</h2>
                            <button
                                className="modal-close"
                                onClick={() => !seriesImageDialog.saving && setSeriesImageDialog(null)}
                                disabled={seriesImageDialog.saving}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="modal-body custom-scrollbar">
                            {seriesImageDialog.loading ? (
                                <div className="loading-spinner"><div className="spinner" /></div>
                            ) : (
                                <div className="tmdb-images-step">
                                    {seriesImageDialog.error ? (
                                        <div className="tmdb-error">{seriesImageDialog.error}</div>
                                    ) : null}
                                    <div className="tmdb-images-section">
                                        <h3>{t('selectPoster', 'Poster auswählen')} ({seriesImageDialog.images.posters.length})</h3>
                                        <div className="tmdb-image-grid posters">
                                            {seriesImageDialog.images.posters.map((img) => (
                                                <button
                                                    key={img.file_path}
                                                    type="button"
                                                    className={`tmdb-image-card poster ${seriesImageDialog.selectedPoster === img.file_path ? 'selected' : ''}`}
                                                    onClick={() => setSeriesImageDialog((prev) => prev ? { ...prev, selectedPoster: img.file_path } : prev)}
                                                >
                                                    <img src={`https://image.tmdb.org/t/p/w185${img.file_path}`} alt="" loading="lazy" />
                                                </button>
                                            ))}
                                            {seriesImageDialog.images.posters.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noPosterAvailablePlural', 'Keine Poster verfügbar')}</p>}
                                        </div>
                                    </div>
                                    <div className="tmdb-images-section">
                                        <h3>{t('selectBackdrop', 'Backdrop auswählen')} ({seriesImageDialog.images.backdrops.length})</h3>
                                        <div className="tmdb-image-grid backdrops">
                                            {seriesImageDialog.images.backdrops.map((img) => (
                                                <button
                                                    key={img.file_path}
                                                    type="button"
                                                    className={`tmdb-image-card backdrop ${seriesImageDialog.selectedBackdrop === img.file_path ? 'selected' : ''}`}
                                                    onClick={() => setSeriesImageDialog((prev) => prev ? { ...prev, selectedBackdrop: img.file_path } : prev)}
                                                >
                                                    <img src={`https://image.tmdb.org/t/p/w300${img.file_path}`} alt="" loading="lazy" />
                                                </button>
                                            ))}
                                            {seriesImageDialog.images.backdrops.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noBackdropAvailablePlural', 'Keine Backdrops verfügbar')}</p>}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="modal-footer series-images-footer">
                            <div className="series-images-footer-left">
                                <button className="btn btn-secondary" onClick={uploadSeriesBackdrop} disabled={seriesImageDialog.saving || seriesImageDialog.loading}>
                                    {t('uploadBackdrop', 'Backdrop hochladen')}
                                </button>
                                <button className="btn btn-secondary" onClick={uploadSeriesPoster} disabled={seriesImageDialog.saving || seriesImageDialog.loading}>
                                    {t('uploadPoster', 'Poster hochladen')}
                                </button>
                            </div>
                            <div className="series-images-footer-right">
                                <button className="btn btn-secondary" onClick={() => setSeriesImageDialog(null)} disabled={seriesImageDialog.saving}>
                                    {t('cancel', 'Abbrechen')}
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={applySeriesImages}
                                    disabled={seriesImageDialog.saving || seriesImageDialog.loading || (!seriesImageDialog.selectedPoster && !seriesImageDialog.selectedBackdrop)}
                                >
                                    {seriesImageDialog.saving ? t('saving', 'Speichere...') : t('apply', 'Anwenden')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {tpdbDialogVideo && (
                <TPDBDialog
                    video={tpdbDialogVideo}
                    onClose={() => setTpdbDialogVideo(null)}
                    onApplied={handleTpdbApplied}
                />
            )}
            {performerImageDialog && (
                <div className="modal-overlay" onClick={() => !performerImageDialog.saving && setPerformerImageDialog(null)}>
                    <div className="modal playlist-modal tpdb-performer-images-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">
                                {t('performerImageSelectionTitle', 'Performer image selection')}: {performerImageDialog.performerName}
                            </h2>
                            <button
                                className="modal-close"
                                onClick={() => !performerImageDialog.saving && setPerformerImageDialog(null)}
                                disabled={performerImageDialog.saving}
                            >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            {performerImageDialog.loading ? (
                                <div className="loading-spinner"><div className="spinner" /></div>
                            ) : (
                                <>
                                    {performerImageDialog.error ? (
                                        <div className="tmdb-error" style={{ marginBottom: 12 }}>{performerImageDialog.error}</div>
                                    ) : null}
                                    {Array.isArray(performerImageDialog.images) && performerImageDialog.images.length > 0 ? (
                                        (() => {
                                            const grouped = performerImageDialog?.groups && typeof performerImageDialog.groups === 'object'
                                                ? performerImageDialog.groups
                                                : { stashdb: [], tpdb: [], other: [] };
                                            const tpdbWithOther = [
                                                ...(Array.isArray(grouped.tpdb) ? grouped.tpdb : []),
                                                ...(Array.isArray(grouped.other) ? grouped.other : []),
                                            ];
                                            const tabs = [
                                                { key: 'stashdb', label: t('stashdbLabel', 'StashDB') },
                                                { key: 'tpdb', label: t('tpdbLabel', 'ThePornDB') },
                                            ];
                                            const availableTabs = tabs.filter((tab) => {
                                                if (tab.key === 'tpdb') return tpdbWithOther.length > 0;
                                                return Array.isArray(grouped[tab.key]) && grouped[tab.key].length > 0;
                                            });
                                            const activeTab = availableTabs.some((tab) => tab.key === performerImageTab)
                                                ? performerImageTab
                                                : (availableTabs[0]?.key || 'stashdb');
                                            const sectionImages = activeTab === 'tpdb'
                                                ? tpdbWithOther
                                                : (Array.isArray(grouped[activeTab]) ? grouped[activeTab] : []);
                                            return (
                                                <div className="tpdb-performer-image-sections">
                                                    {availableTabs.length > 1 ? (
                                                        <div className="tpdb-performer-image-tabs">
                                                            {availableTabs.map((tab) => (
                                                                <button
                                                                    key={tab.key}
                                                                    type="button"
                                                                    className={`tpdb-performer-image-tab ${activeTab === tab.key ? 'active' : ''}`}
                                                                    onClick={() => setPerformerImageTab(tab.key)}
                                                                    disabled={performerImageDialog.saving}
                                                                >
                                                                    {tab.label}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    ) : null}
                                                    <div className="tpdb-performer-images-grid">
                                                        {[...sectionImages]
                                                            .sort((a, b) => Number(!!b?.selected) - Number(!!a?.selected))
                                                            .map((img) => {
                                                                const url = String(img?.url || '');
                                                                if (!url) return null;
                                                                const selected = String(performerImageDialog.selectedImageUrl || '') === url || !!img?.selected;
                                                                return (
                                                                    <button
                                                                        key={url}
                                                                        type="button"
                                                                        className={`tpdb-performer-image-card ${selected ? 'selected' : ''}`}
                                                                        onClick={() => applyPerformerImage(url)}
                                                                        disabled={performerImageDialog.saving}
                                                                    >
                                                                        <div className="tpdb-performer-image-wrap">
                                                                            <img src={url} alt={performerImageDialog.performerName} loading="lazy" />
                                                                        </div>
                                                                    </button>
                                                                );
                                                            })}
                                                    </div>
                                                </div>
                                            );
                                        })()
                                    ) : (
                                        <div className="playlist-dialog-empty">
                                            {t('noPerformerImageCandidates', 'No performer images found from StashDB or ThePornDB.')}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        <div className="modal-footer tpdb-performer-images-footer">
                            <button
                                className="btn btn-secondary"
                                onClick={uploadPerformerImage}
                                disabled={performerImageDialog.saving || performerImageDialog.loading}
                            >
                                {t('uploadCustomPoster', 'Upload custom poster')}
                            </button>
                            <button className="btn btn-secondary" onClick={() => setPerformerImageDialog(null)} disabled={performerImageDialog.saving}>
                                {t('close', 'Close')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {batchTMDBOpen && (
                <BatchTMDBDialog
                    folders={selectedFolders}
                    onClose={() => setBatchTMDBOpen(false)}
                    onApplied={(data) => {
                        const results = Array.isArray(data?.results) ? data.results : [];
                        results.forEach((row) => {
                            if (row?.success && row?.folderPath && row?.metadata) {
                                applyFolderMetadataLocal(row.folderPath, row.metadata);
                            }
                        });
                        if (onLibraryUpdate) onLibraryUpdate();
                        setSelectedFolderPaths([]);
                        showToast(`${t('batchDone', 'Batch fertig')}: ${data.successCount || 0} ${t('successfully', 'erfolgreich')}, ${data.failedCount || 0} ${t('failed', 'fehlgeschlagen')}`);
                    }}
                />
            )}
            {renameDialog && (
                <RenameDialog
                    currentName={renameDialog.currentName}
                    onConfirm={handleRenameConfirm}
                    onCancel={() => setRenameDialog(null)}
                />
            )}

            {(videoTab === 'all' || (videoTab === 'performers' && !!performerDetail)) && selectedVideoKeys.length > 0 && (
                <div className="batch-floating-bar">
                    <button className="btn btn-secondary" onClick={toggleAllFilteredVideos}>
                        {t('selectAll', 'Alle ausw\u00E4hlen')}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setSelectedVideoKeys([])}>
                        {t('deselectAll', 'Alle abw\u00E4hlen')}
                    </button>
                    <span className="batch-floating-count">{selectedVideoKeys.length} {t('selected', 'ausgew\u00E4hlt')}</span>
                    <button className="btn btn-secondary" onClick={() => openPlaylistDialogForVideos(selectedVideos)}>
                        {t('addToPlaylist', 'Zur Playlist hinzuf\u00FCgen')}
                    </button>
                    <button className="btn btn-primary" onClick={openBatchVideoTags}>
                        {t('batchTags', 'Batch-Tags')}
                    </button>
                </div>
            )}
            {tagDialog && (
                <TagDialog
                    title={tagDialog.title}
                    initialTags={tagDialog.tags}
                    suggestions={tagDialog.suggestions || allKnownTags}
                    onSave={handleSaveTags}
                    onCancel={() => setTagDialog(null)}
                />
            )}
            {playlistDialog && (
                <PlaylistPickerDialog
                    title={playlistDialog.title}
                    videos={playlistDialog.videos}
                    onApplied={handleApplyPlaylist}
                    onCancel={() => setPlaylistDialog(null)}
                />
            )}
            {batchVideoTagDialog && (
                <TagDialog
                    title={batchVideoTagDialog.title}
                    initialTags={batchVideoTagDialog.tags}
                    suggestions={allKnownTags}
                    onSave={handleSaveBatchVideoTags}
                    onCancel={() => setBatchVideoTagDialog(null)}
                />
            )}
            {vrMetaDialog && (
                <div className="modal-overlay" onClick={() => !vrMetaDialog.saving && setVrMetaDialog(null)}>
                    <div className="modal playlist-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('editVrMeta', 'VR-Meta bearbeiten')}</h2>
                            <button className="modal-close" onClick={() => !vrMetaDialog.saving && setVrMetaDialog(null)}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <div className="playlist-dialog-section">
                                <div className="playlist-dialog-label">{t('video', 'Video')}</div>
                                <div className="playlist-dialog-hint">{vrMetaDialog.video?.title || vrMetaDialog.video?.fileName || ''}</div>
                            </div>
                            <div className="playlist-dialog-section">
                                <label className="playlist-dialog-label" htmlFor="vr-projection">{t('vrProjection', 'VR Projektion')}</label>
                                <div className="playlist-dialog-select-row">
                                    <AppDropdown
                                        className="playlist-dialog-select"
                                        value={vrMetaDialog.projection}
                                        disabled={vrMetaDialog.saving}
                                        options={[
                                            { value: 'unknown', label: t('unknown', 'Unbekannt') },
                                            { value: '180', label: '180' },
                                            { value: '360', label: '360' },
                                        ]}
                                        onChange={(val) => setVrMetaDialog(prev => prev ? { ...prev, projection: val } : prev)}
                                    />
                                </div>
                            </div>
                            <div className="playlist-dialog-section">
                                <label className="playlist-dialog-label" htmlFor="vr-stereo">{t('vrStereo', 'VR Stereo')}</label>
                                <div className="playlist-dialog-select-row">
                                    <AppDropdown
                                        className="playlist-dialog-select"
                                        value={vrMetaDialog.stereoMode}
                                        disabled={vrMetaDialog.saving}
                                        options={[
                                            { value: 'mono', label: 'Mono' },
                                            { value: 'sbs', label: 'SBS' },
                                            { value: 'ou', label: 'OU' },
                                        ]}
                                        onChange={(val) => setVrMetaDialog(prev => prev ? { ...prev, stereoMode: val } : prev)}
                                    />
                                </div>
                            </div>
                            {vrMetaDialog.detected && (
                                <div className="playlist-dialog-hint">
                                    {t('detected', 'Erkannt')}: {vrMetaDialog.detected.projection}/{String(vrMetaDialog.detected.stereoMode || '').toUpperCase()}
                                </div>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setVrMetaDialog(null)} disabled={vrMetaDialog.saving}>
                                {t('cancel', 'Abbrechen')}
                            </button>
                            <button className="btn btn-primary" onClick={saveVrMeta} disabled={vrMetaDialog.saving}>
                                {vrMetaDialog.saving ? t('saving', 'Speichern...') : t('save', 'Speichern')}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default Library;









