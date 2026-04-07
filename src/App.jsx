import React, { Suspense, lazy, useState, useEffect } from 'react';
import { HashRouter as Router, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import GlyphMark from './components/GlyphMark';
import { useI18n } from './i18n';
import { rememberPlaybackVideo } from './services/watchProgress';
import { eventMatchesHotkey, getHotkeys } from './services/hotkeys';

const HomePage = lazy(() => import('./pages/HomePage'));
const Library = lazy(() => import('./pages/Library'));
const SeriesDetail = lazy(() => import('./pages/SeriesDetail'));
const Settings = lazy(() => import('./pages/Settings'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const TagManager = lazy(() => import('./pages/TagManager'));
const FunscriptManager = lazy(() => import('./pages/FunscriptManager'));
const PlaylistManager = lazy(() => import('./pages/PlaylistManager'));
const Playlists = lazy(() => import('./pages/Playlists'));
const VideoPlayer = lazy(() => import('./components/VideoPlayer'));
const DevicePanel = lazy(() => import('./components/DevicePanel'));
function AppContent() {
    const [libraries, setLibraries] = useState([]);
    const [playlists, setPlaylists] = useState([]);
    const [initialPlaylistId, setInitialPlaylistId] = useState(null);
    const [activeLibrary, setActiveLibrary] = useState(null);
    const [seriesFolder, setSeriesFolder] = useState(null); // {path, name}
    const [isWindowMaximized, setIsWindowMaximized] = useState(false);
    const [isBootstrapping, setIsBootstrapping] = useState(true);
    const [devicePanelOpen, setDevicePanelOpen] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();
    const { t, setLanguage } = useI18n();

    useEffect(() => {
        let cancelled = false;
        (async () => {
            await Promise.allSettled([
                fetchLibraries(),
                fetchPlaylists(),
                loadThemeAndLanguage(),
            ]);
            if (!cancelled) setIsBootstrapping(false);
        })();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        if (!window.electronAPI) return;
        window.electronAPI.windowIsMaximized?.().then((v) => setIsWindowMaximized(!!v)).catch(() => { });
        const unsubscribe = window.electronAPI.onWindowMaximizedChange?.((v) => setIsWindowMaximized(!!v));
        return () => { if (typeof unsubscribe === 'function') unsubscribe(); };
    }, []);

    useEffect(() => {
        const handlePlaylistsChanged = () => fetchPlaylists();
        window.addEventListener('playlists-changed', handlePlaylistsChanged);
        return () => window.removeEventListener('playlists-changed', handlePlaylistsChanged);
    }, []);

    useEffect(() => {
        if (isBootstrapping) return;
        window.electronAPI?.rendererReady?.();
    }, [isBootstrapping]);

    useEffect(() => {
        setLibraries((prev) => (Array.isArray(prev) ? prev.map((lib) => (
            String(lib?.id || '') === '__all_videos__'
                ? { ...lib, name: t('allVideos', 'All Videos') }
                : lib
        )) : prev));
    }, [t]);

    const fetchLibraries = async () => {
        try {
            const res = await fetch('/api/libraries');
            const data = await res.json();
            const libs = (Array.isArray(data) ? data : []).map((lib) => (
                String(lib?.id || '') === '__all_videos__'
                    ? { ...lib, name: t('allVideos', 'All Videos') }
                    : lib
            ));
            setLibraries(libs);
        } catch (err) {
            console.error('Failed to fetch libraries:', err);
        }
    };

    const fetchPlaylists = async () => {
        try {
            const res = await fetch('/api/playlists');
            const data = await res.json();
            setPlaylists(Array.isArray(data) ? data : []);
        } catch {
            setPlaylists([]);
        }
    };

    const applyTheme = (theme) => {
        if (!theme) return;
        const root = document.documentElement;
        const mode = theme.mode === 'modern' ? 'modern' : 'default';
        root.setAttribute('data-theme-mode', mode);

        const modernPalette = ['silver', 'starlight', 'sky', 'lavender', 'copper'].includes(theme.modernPalette)
            ? theme.modernPalette
            : 'silver';
        if (mode === 'modern') root.setAttribute('data-modern-palette', modernPalette);
        else root.removeAttribute('data-modern-palette');

        window.electronAPI?.setTitlebarTheme?.({
            mode,
            modernPalette,
        }).catch(() => { });

        const radiusProfile = ['sharp', 'balanced', 'soft'].includes(theme.radiusProfile)
            ? theme.radiusProfile
            : 'balanced';
        root.setAttribute('data-radius-profile', radiusProfile);

        const glassIntensityRaw = Number(theme.glassIntensity);
        const patternIntensityRaw = Number(theme.patternIntensity ?? theme.noiseIntensity);
        const glassIntensity = Number.isFinite(glassIntensityRaw) ? Math.max(0, Math.min(100, glassIntensityRaw)) : 70;
        const patternIntensity = Number.isFinite(patternIntensityRaw) ? Math.max(0, Math.min(100, patternIntensityRaw)) : 28;
        const patternType = 'paper';

        const customVars = [
            '--accent-primary',
            '--accent-secondary',
            '--accent-gradient',
            '--accent-glow',
            '--border-accent',
            '--shadow-glow',
            '--bg-primary',
            '--bg-card',
            '--modern-glass-intensity',
            '--modern-noise-intensity',
            '--modern-pattern-intensity',
        ];

        customVars.forEach((key) => root.style.removeProperty(key));

        root.style.setProperty('--modern-glass-intensity', String(glassIntensity / 100));
        root.style.setProperty('--modern-noise-intensity', String(patternIntensity / 100));
        root.style.setProperty('--modern-pattern-intensity', String(patternIntensity / 100));
        if (mode === 'modern') root.setAttribute('data-modern-pattern', patternType);
        else root.removeAttribute('data-modern-pattern');

        // Custom color overrides are only supported in Default mode.
        if (mode !== 'default') return;

        if (theme.accentPrimary) {
            root.style.setProperty('--accent-primary', theme.accentPrimary);
            root.style.setProperty('--accent-glow', theme.accentPrimary + '40');
            root.style.setProperty('--border-accent', theme.accentPrimary + '4d');
        }
        if (theme.accentSecondary) {
            root.style.setProperty('--accent-secondary', theme.accentSecondary);
        }
        if (theme.accentPrimary && theme.accentSecondary) {
            root.style.setProperty('--accent-gradient', `linear-gradient(135deg, ${theme.accentPrimary}, ${theme.accentSecondary})`);
            root.style.setProperty('--shadow-glow', `0 0 24px ${theme.accentPrimary}1f`);
        }
        if (theme.bgPrimary) {
            root.style.setProperty('--bg-primary', theme.bgPrimary);
        }
        if (theme.bgCard) {
            root.style.setProperty('--bg-card', theme.bgCard);
        }
    };

    const loadThemeAndLanguage = async () => {
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            if (data.theme) applyTheme(data.theme);
            if (data.language) setLanguage(data.language);
        } catch { }
    };


    const handleLibrarySelect = (lib, options = {}) => {
        const nextLibrary = {
            ...lib,
            initialSort: options.initialSort || null,
            initialSeriesSort: options.initialSeriesSort || null,
            initialVideoTab: options.initialVideoTab || null,
            initialSearch: options.initialSearch || '',
            initialFocusVideoId: options.initialFocusVideoId || '',
            initialPerformer: options.initialPerformer || null,
        };
        setActiveLibrary(nextLibrary);
        setSeriesFolder(null);
        navigate('/library');
    };
    const handleSeriesSelect = (folder, options = {}) => {
        const nextFolder = {
            ...folder,
            openImagesOnLoad: Boolean(options?.openImagesOnLoad ?? folder?.openImagesOnLoad),
        };
        setSeriesFolder(nextFolder);
        navigate('/series');
    };

    const handleBack = () => {
        setActiveLibrary(null);
        setSeriesFolder(null);
        navigate('/');
    };

    const handleBackToLibrary = () => {
        setSeriesFolder(null);
        navigate('/library');
    };

    const handleOpenPlaylists = (playlistId = null) => {
        setActiveLibrary(null);
        setSeriesFolder(null);
        setInitialPlaylistId(playlistId || null);
        navigate('/playlists');
    };

    const handleOpenFunscriptManager = (payload = null) => {
        navigate('/funscripts', { state: payload || undefined });
    };

    const handleOpenVideoInLibrary = (payload = {}) => {
        const videoId = String(payload?.videoId || '').trim();
        const libraryId = String(payload?.libraryId || '').trim();
        if (!videoId || !libraryId) return;
        const targetLibrary = libraries.find((lib) => String(lib?.id || '') === libraryId);
        if (!targetLibrary) return;
        handleLibrarySelect(targetLibrary, {
            initialVideoTab: targetLibrary?.type === 'series' ? 'all' : null,
            initialSearch: String(payload?.title || '').trim(),
            initialFocusVideoId: videoId,
        });
    };

    const handleOpenPerformerInLibrary = (payload = {}) => {
        const libraryId = String(payload?.libraryId || '').trim();
        const performerId = String(payload?.performer?.id || payload?.performerId || '').trim();
        const performerName = String(payload?.performer?.name || payload?.performerName || '').trim();
        if (!libraryId || (!performerId && !performerName)) return;
        const targetLibrary = libraries.find((lib) => String(lib?.id || '') === libraryId);
        if (!targetLibrary) return;
        handleLibrarySelect(targetLibrary, {
            initialVideoTab: 'performers',
            initialPerformer: {
                id: performerId,
                name: performerName,
            },
        });
    };

    const handleWindowMinimize = () => {
        window.electronAPI?.windowMinimize?.();
    };

    const handleWindowToggleMaximize = () => {
        window.electronAPI?.windowToggleMaximize?.();
    };

    const handleWindowClose = () => {
        window.electronAPI?.windowClose?.();
    };

    const handlePlay = async (video, options = {}) => {
        if (!video || !video.id) return;
        rememberPlaybackVideo(video);
        const libraryType = String(video?.libraryType || video?._libraryType || '').toLowerCase() || 'videos';
        let playerType = 'internal';
        let separatePlayerWindow = false;
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            if (typeof data?.playerType === 'string') playerType = data.playerType;
            const rawLocal = localStorage.getItem('glyph_settings') || '{}';
            const local = JSON.parse(rawLocal);
            separatePlayerWindow = local?.separatePlayerWindow === true;
        } catch {
            const rawSettings = localStorage.getItem('glyph_settings') || '{}';
            const local = JSON.parse(rawSettings);
            if (typeof local?.playerType === 'string') playerType = local.playerType;
            separatePlayerWindow = local?.separatePlayerWindow === true;
        }

        if (playerType === 'external') {
            if (!window.electronAPI?.openVideo) {
                console.error('External player selected but electronAPI.openVideo is unavailable.');
                return;
            }
            const videoPath = video?.filePath || video?.path || null;
            if (!videoPath) {
                console.error('External player: missing video path on item:', video);
                return;
            }
            try {
                const result = await window.electronAPI.openVideo(videoPath);
                if (result && typeof result === 'object' && result.ok === false) {
                    console.error('External player failed:', result.error);
                }
            } catch (err) {
                console.error('External player threw an error:', err);
            }
            return;
        }

        const resumeFromSec = Number(options?.resumeFromSec || 0);
        const startSeconds = Number.isFinite(resumeFromSec) && resumeFromSec > 0
            ? Math.max(1, Math.floor(resumeFromSec))
            : 0;
        const queueVideos = Array.isArray(options?.queueVideos)
            ? options.queueVideos
                .map((entry) => ({
                    id: entry?.id,
                    title: entry?.title || entry?.name || '',
                    filePath: entry?.filePath || entry?.path || '',
                    libraryType: String(entry?.libraryType || entry?._libraryType || '').toLowerCase() || 'videos',
                    libraryId: String(entry?.libraryId || ''),
                    isVr: !!entry?.isVr,
                    vrProjection: String(entry?.vrProjection || 'unknown'),
                    vrStereoMode: String(entry?.vrStereoMode || 'mono'),
                }))
                .filter((entry) => !!entry.id && !!entry.filePath)
            : null;
        const suffix = startSeconds > 0 ? `?t=${startSeconds}` : '';
        const isVrPlayback = libraryType === 'vr';

        if (playerType === 'internal' && separatePlayerWindow && window.electronAPI?.openPlayerWindow) {
            try {
                await window.electronAPI.openPlayerWindow({
                    videoId: video.id,
                    startSeconds,
                    ...(queueVideos && queueVideos.length > 1 ? { queueVideos } : {}),
                });
                return;
            } catch (err) {
                console.error('Failed to open separate player window, falling back to in-app playback:', err);
            }
        }

        navigate(`/play/${video.id}${suffix}`, {
            state: {
                ...(startSeconds > 0 ? { resumeFromSec: startSeconds } : {}),
                ...(queueVideos && queueVideos.length > 1 ? { queueVideos } : {}),
                ...(isVrPlayback ? {
                    isVrPlayback: true,
                    vrProjection: String(video?.vrProjection || 'unknown'),
                    vrStereoMode: String(video?.vrStereoMode || 'mono'),
                    libraryType,
                } : {}),
            },
        });
    };

    // Home Page
    const isHome = location.pathname === '/' || location.pathname === '';
    const isSettings = location.pathname === '/settings';
    const isTagManager = location.pathname === '/tags';
    const isFunscriptManager = location.pathname === '/funscripts';
    const isPlaylistManager = location.pathname === '/playlist-manager';
    const isConfigPage = isSettings || isTagManager || isFunscriptManager || isPlaylistManager;
    const isPlaying = location.pathname.startsWith('/play/');
    const isPlayerWindow = (() => {
        try {
            return new URLSearchParams(location.search || '').get('playerWindow') === '1';
        } catch {
            return false;
        }
    })();

    useEffect(() => {
        const onKeyDown = (e) => {
            if (e.defaultPrevented) return;
            const target = e.target;
            const isTyping = !!target && (
                target.tagName === 'INPUT'
                || target.tagName === 'TEXTAREA'
                || target.tagName === 'SELECT'
                || target.isContentEditable
            );
            if (isTyping) return;

            const hotkeys = getHotkeys();

            if (eventMatchesHotkey(e, hotkeys.goHome)) {
                e.preventDefault();
                setActiveLibrary(null);
                setSeriesFolder(null);
                navigate('/');
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.goPlaylists)) {
                e.preventDefault();
                handleOpenPlaylists();
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.goBack)) {
                e.preventDefault();
                if (location.pathname === '/series') handleBackToLibrary();
                else handleBack();
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.toggleDevicePanel)) {
                e.preventDefault();
                if (!isPlaying) setDevicePanelOpen((v) => !v);
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.openSettings)) {
                e.preventDefault();
                navigate('/settings');
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.openDashboard)) {
                e.preventDefault();
                navigate('/dashboard');
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.openTagManager)) {
                e.preventDefault();
                navigate('/tags');
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.openFunscriptManager)) {
                e.preventDefault();
                navigate('/funscripts');
                return;
            }
            if (eventMatchesHotkey(e, hotkeys.openPlaylistManager)) {
                e.preventDefault();
                navigate('/playlist-manager');
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [activeLibrary, libraries, isPlaying, location.pathname, navigate]);

    return (
        <div className="app">
            <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
                <defs>
                    <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%">
                        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.012" numOctaves="1" seed="73" result="noise" />
                        <feGaussianBlur in="noise" stdDeviation="0.65" result="blurred" />
                        <feDisplacementMap in="SourceGraphic" in2="blurred" scale="9" xChannelSelector="R" yChannelSelector="G" />
                    </filter>
                </defs>
            </svg>
            {/* Top Navbar - Hide when playing video */}
            {!isPlaying && (
                <header className="top-navbar">
                    <div className="navbar-left">
                        <button className="nav-brand-btn" onClick={handleBack}>
                            <GlyphMark className="nav-logo" title="Glyph" />
                            <span className="nav-title">Glyph</span>
                        </button>
                    </div>

                    <div className="navbar-center">
                        {activeLibrary && !isConfigPage && (
                            <div className="nav-breadcrumb">
                                <button className="nav-crumb" onClick={handleBack}>{t('navHome', 'Home')}</button>
                                <span className="nav-crumb-sep">&rsaquo;</span>
                                {seriesFolder ? (
                                    <>
                                        <button className="nav-crumb" onClick={handleBackToLibrary}>{activeLibrary.name}</button>
                                        <span className="nav-crumb-sep">&rsaquo;</span>
                                        <span className="nav-crumb-active">{seriesFolder.name}</span>
                                    </>
                                ) : (
                                    <span className="nav-crumb-active">{activeLibrary.name}</span>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="navbar-right">
                        <button
                            className={`navbar-settings-btn ${location.pathname === '/dashboard' ? 'active' : ''}`}
                            onClick={() => navigate('/dashboard')}
                            title={t('navDashboard', 'Server Dashboard')}
                            style={{ marginRight: '8px' }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                            </svg>
                        </button>
                        <button
                            className={`navbar-settings-btn navbar-device-btn ${devicePanelOpen ? 'active' : ''}`}
                            onClick={() => setDevicePanelOpen((v) => !v)}
                            title={t('devicePanel', 'Geräte')}
                            style={{ marginRight: '8px' }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="7" y="4" width="10" height="16" rx="2" />
                                <line x1="12" y1="17" x2="12" y2="17.01" strokeWidth="3" strokeLinecap="round" />
                                <path d="M4 9c-1-1-1-3 0-4" />
                                <path d="M20 9c1-1 1-3 0-4" />
                            </svg>
                        </button>
                        <button
                            className={`navbar-settings-btn ${isTagManager ? 'active' : ''}`}
                            onClick={() => navigate('/tags')}
                            title={t('tagManagerTitle', 'Tag-Manager')}
                            style={{ marginRight: '8px' }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82z" />
                                <line x1="7" y1="7" x2="7.01" y2="7" />
                            </svg>
                        </button>
                        <button
                            className={`navbar-settings-btn ${isFunscriptManager ? 'active' : ''}`}
                            onClick={() => navigate('/funscripts')}
                            title={t('funscriptManagerTitle', 'Funscript Manager')}
                            style={{ marginRight: '8px' }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 12c1.5 0 1.5-6 3-6s1.5 12 3 12 1.5-8 3-8 1.5 8 3 8 1.5-4 3-4 1.5 2 3 2" />
                                <rect x="2.5" y="4" width="19" height="16" rx="3" />
                            </svg>
                        </button>
                        <button
                            className={`navbar-settings-btn ${isPlaylistManager ? 'active' : ''}`}
                            onClick={() => navigate('/playlist-manager')}
                            title={t('playlistManagerTitle', 'Playlist Manager')}
                            style={{ marginRight: '8px' }}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M4 6h16" />
                                <path d="M4 12h10" />
                                <path d="M4 18h10" />
                                <path d="m17 15 3 3-3 3" />
                                <path d="M20 18h-6" />
                            </svg>
                        </button>
                        <button
                            className={`navbar-settings-btn ${isSettings ? 'active' : ''}`}
                            onClick={() => navigate('/settings')}
                            title={t('navSettings', 'Einstellungen')}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>

                    <div className="window-controls">
                        <button className="window-control-btn" onClick={handleWindowMinimize} title="Minimize">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /></svg>
                        </button>
                        <button className="window-control-btn" onClick={handleWindowToggleMaximize} title={isWindowMaximized ? 'Restore' : 'Maximize'}>
                            {isWindowMaximized ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <rect x="7" y="7" width="10" height="10" />
                                    <path d="M7 10H4V20H14V17" />
                                </svg>
                            ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="6" width="12" height="12" /></svg>
                            )}
                        </button>
                        <button className="window-control-btn close" onClick={handleWindowClose} title="Close">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>
                        </button>
                    </div>
                </header>
            )}

            {/* Main Area */}
            <div className="app-body">
                <Suspense fallback={<div className="route-loading">Loading...</div>}>
                    <Routes>
                        <Route
                            path="/"
                            element={
                                <HomePage
                                    libraries={libraries}
                                    playlists={playlists}
                                    onSelect={handleLibrarySelect}
                                    onPlay={handlePlay}
                                    onOpenPlaylists={handleOpenPlaylists}
                                    onLibrariesReordered={fetchLibraries}
                                    onOpenFunscriptManager={handleOpenFunscriptManager}
                                    onOpenPerformer={handleOpenPerformerInLibrary}
                                />
                            }
                        />
                        <Route
                            path="/library"
                            element={
                                <Library
                                    library={activeLibrary}
                                    onLibraryUpdate={fetchLibraries}
                                    onBack={handleBack}
                                    onPlay={handlePlay}
                                    onSeriesSelect={handleSeriesSelect}
                                    onOpenFunscriptManager={handleOpenFunscriptManager}
                                />
                            }
                        />
                        <Route
                            path="/series"
                            element={
                                seriesFolder ? (
                                    <SeriesDetail
                                        folderPath={seriesFolder.path}
                                        folderName={seriesFolder.name}
                                        openImagesOnLoad={!!seriesFolder.openImagesOnLoad}
                                        onBack={handleBackToLibrary}
                                        onPlay={handlePlay}
                                        onOpenFunscriptManager={handleOpenFunscriptManager}
                                    />
                                ) : null
                            }
                        />
                        <Route
                            path="/settings"
                            element={<Settings onLibraryUpdate={fetchLibraries} onThemeChange={applyTheme} onLanguageChange={setLanguage} />}
                        />
                        <Route
                            path="/dashboard"
                            element={<Dashboard />}
                        />
                        <Route
                            path="/tags"
                            element={<TagManager />}
                        />
                        <Route
                            path="/funscripts"
                            element={<FunscriptManager onOpenVideoInLibrary={handleOpenVideoInLibrary} />}
                        />
                        <Route
                            path="/playlist-manager"
                            element={<PlaylistManager onOpenPlaylists={handleOpenPlaylists} />}
                        />
                        <Route
                            path="/playlists"
                            element={<Playlists onPlay={handlePlay} onBackHome={handleBack} onOpenPlaylistManager={() => navigate('/playlist-manager')} initialPlaylistId={initialPlaylistId} onOpenFunscriptManager={handleOpenFunscriptManager} onOpenPerformer={handleOpenPerformerInLibrary} />}
                        />
                        <Route
                            path="/play/:id"
                            element={<VideoPlayer onBack={() => {
                                if (isPlayerWindow) {
                                    window.close();
                                    return;
                                }
                                navigate(-1);
                            }} />}
                        />
                    </Routes>
                </Suspense>
            </div>
            <Suspense fallback={null}>
                <DevicePanel
                    open={devicePanelOpen}
                    onClose={() => setDevicePanelOpen(false)}
                />
            </Suspense>
        </div>
    );
}

/* Home Page */
function App() {
    return (
        <Router>
            <AppContent />
        </Router>
    );
}

export default App;





