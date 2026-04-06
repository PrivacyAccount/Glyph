import React, { useMemo, useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useI18n } from '../i18n';
import { setContinueWatchingEnabled } from '../services/watchProgress';
import AppDropdown from '../components/AppDropdown';
import useDialogHotkeys from '../hooks/useDialogHotkeys';
import { DEFAULT_HOTKEYS, eventToBinding, hotkeyId, hotkeyToLabel, normalizeHotkeys } from '../services/hotkeys';

const THEME_PRESETS = [
    { nameKey: 'themePresetPurple', nameFallback: 'Lila (Standard)', accent: '#a855f7', secondary: '#6366f1' },
    { nameKey: 'themePresetBlue', nameFallback: 'Blau', accent: '#3b82f6', secondary: '#2563eb' },
    { nameKey: 'themePresetCyan', nameFallback: 'Cyan', accent: '#06b6d4', secondary: '#0891b2' },
    { nameKey: 'themePresetGreen', nameFallback: 'Gruen', accent: '#22c55e', secondary: '#16a34a' },
    { nameKey: 'themePresetOrange', nameFallback: 'Orange', accent: '#f59e0b', secondary: '#d97706' },
    { nameKey: 'themePresetPink', nameFallback: 'Rosa', accent: '#ec4899', secondary: '#db2777' },
    { nameKey: 'themePresetRed', nameFallback: 'Rot', accent: '#ef4444', secondary: '#dc2626' },
    { nameKey: 'themePresetTurquoise', nameFallback: 'Tuerkis', accent: '#14b8a6', secondary: '#0d9488' },
];
const STANDARD_SUBTITLE_FONTS = [
    'Arial',
    'Helvetica',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Segoe UI',
    'Georgia',
    'Times New Roman',
    'Courier New',
];
const DEFAULT_SUBTITLE_STYLES = {
    fontSize: '24px',
    color: '#ffffff',
    background: 'rgba(0,0,0,0.5)',
    fontFamily: 'Arial',
    marginBottom: 20,
    outlineWidth: 2,
    outlineColor: '#000000',
};
const ABOUT_PROFILE_IMAGE_PATH = 'about/looneyicon.png';

function Settings({ onLibraryUpdate, onThemeChange, onLanguageChange }) {
    const { language, setLanguage, t } = useI18n();
    const [settings, setSettings] = useState({
        libraries: [],
        tmdbApiKey: '',
        stashdbApiKey: '',
        theme: {},
        language: 'en',
        watchFolders: true,
        continueWatching: true,
        showTimelineGraph: false,
        separatePlayerWindow: false,
        playerAutoFullscreen: false,
        thumbfastEnabled: true,
        showPerformerChips: true,
        includeAllLibrary: false,
        backupSchedule: 'none',
        hotkeys: DEFAULT_HOTKEYS,
    });
    const [heresphereInfo, setHeresphereInfo] = useState(null);
    const [scanning, setScanning] = useState(false);
    const [toast, setToast] = useState(null);
    const [newLibName, setNewLibName] = useState('');
    const [newLibType, setNewLibType] = useState('videos');
    const [removeLibraryDialog, setRemoveLibraryDialog] = useState(null);
    const [removeLibraryDeleteGenerated, setRemoveLibraryDeleteGenerated] = useState(false);
    const [activePanel, setActivePanel] = useState('language');
    const [activePlaybackSubpanel, setActivePlaybackSubpanel] = useState('general');
    const [activeStorageSubpanel, setActiveStorageSubpanel] = useState('backup');
    const [backupEntries, setBackupEntries] = useState([]);
    const [backupDir, setBackupDir] = useState('');
    const [serverDataDir, setServerDataDir] = useState('');
    const [pendingServerDataDir, setPendingServerDataDir] = useState('');
    const [dataDirBusy, setDataDirBusy] = useState(false);
    const [backupLoading, setBackupLoading] = useState(false);
    const [backupBusy, setBackupBusy] = useState('');
    const [backupConfirmDialog, setBackupConfirmDialog] = useState(null);
    const [showAllHeresphereUrls, setShowAllHeresphereUrls] = useState(false);
    const [systemFonts, setSystemFonts] = useState(STANDARD_SUBTITLE_FONTS);
    const [appVersion, setAppVersion] = useState('');
    const [draggingSettingsLibraryId, setDraggingSettingsLibraryId] = useState('');
    const [capturingHotkeyAction, setCapturingHotkeyAction] = useState('');
    const libraryRowRefs = useRef(new Map());
    const settingsLibraryOrderIdsRef = useRef([]);
    const settingsLibrariesRef = useRef([]);
    const libraryHoldTimerRef = useRef(null);
    const libraryDragStateRef = useRef(null);

    useEffect(() => {
        fetchSettings();
        if (window.electronAPI?.getSystemFonts) {
            window.electronAPI.getSystemFonts().then((fonts) => {
                if (Array.isArray(fonts) && fonts.length > 0) setSystemFonts(fonts);
            }).catch(() => { });
        }
        if (window.electronAPI?.getAppVersion) {
            window.electronAPI.getAppVersion().then((v) => {
                const safe = String(v || '').trim();
                if (safe) setAppVersion(safe);
            }).catch(() => { });
        }
    }, []);

    useEffect(() => {
        if (activePanel === 'playback') loadHeresphereInfo();
    }, [activePanel]);

    useEffect(() => {
        if (activePanel === 'backup') loadBackups();
    }, [activePanel]);

    useEffect(() => {
        settingsLibraryOrderIdsRef.current = (Array.isArray(settings?.libraries) ? settings.libraries : [])
            .map((lib) => String(lib?.id || ''))
            .filter(Boolean);
        settingsLibrariesRef.current = Array.isArray(settings?.libraries) ? settings.libraries : [];
    }, [settings?.libraries]);


    const panels = useMemo(() => ([
        { id: 'language', label: t('languageTitle', 'Sprache') },
        { id: 'appearance', label: t('displayThemeTitle', 'Darstellung / Theme') },
        { id: 'libraries', label: t('librariesTitle', 'Bibliotheken') },
        { id: 'metadata', label: t('metadataPanelTitle', 'Metadaten') },
        { id: 'playback', label: t('playbackTitle', 'Wiedergabe') },
        { id: 'hotkeys', label: t('hotkeysTitle', 'Hotkeys') },
        { id: 'browsing', label: t('browsingTitle', 'Browsing / Vorschau') },
        { id: 'backup', label: t('storageTitle', 'Storage') },
        { id: 'about', label: t('aboutTitle', 'About') },
    ]), [t]);
    const playbackSubpanels = useMemo(() => ([
        { id: 'general', label: t('playbackGeneralTitle', 'General') },
        { id: 'vr', label: t('playbackVrTitle', 'VR') },
        { id: 'player', label: t('playbackPlayerTitle', 'Player') },
    ]), [t]);
    const storageSubpanels = useMemo(() => ([
        { id: 'backup', label: t('backupSectionTitle', 'Backup') },
        { id: 'server', label: t('serverStorageSectionTitle', 'Server Storage') },
    ]), [t]);

    const renderPanelIcon = (id) => {
        if (id === 'language') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></svg>;
        if (id === 'appearance') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>;
        if (id === 'libraries') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>;
        if (id === 'metadata') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>;
        if (id === 'playback') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3" /></svg>;
        if (id === 'hotkeys') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="8.5" cy="12" r="3.5" /><path d="M12 12h9M17 12v3M20 12v2" /></svg>;
        if (id === 'browsing') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="2.5" /></svg>;
        if (id === 'backup') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>;
        if (id === 'about') return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.6 4.5-5.4 8-5.4s6.5 1.8 8 5.4" /></svg>;
        return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18M3 12h18" /><circle cx="12" cy="12" r="9" /></svg>;
    };

    const loadBackups = async () => {
        setBackupLoading(true);
        try {
            const res = await fetch('/api/system/backups');
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Backup list failed');
            setBackupEntries(Array.isArray(data?.backups) ? data.backups : []);
            setBackupDir(String(data?.backupDir || ''));
            setServerDataDir(String(data?.dataDir || ''));
            setPendingServerDataDir(String(data?.dataDir || ''));
        } catch (err) {
            showToast(`${t('errorPrefix', 'Fehler: ')}${err.message || ''}`, 'error');
            setBackupEntries([]);
            setBackupDir('');
            setServerDataDir('');
            setPendingServerDataDir('');
        } finally {
            setBackupLoading(false);
        }
    };

    const chooseServerDataDir = async () => {
        if (!window.electronAPI?.selectFolder) {
            showToast(t('openFolderUnavailable', 'Open folder is only available in the desktop app'), 'error');
            return;
        }
        const picked = await window.electronAPI.selectFolder().catch(() => '');
        if (!picked) return;
        setPendingServerDataDir(String(picked || ''));
    };

    const applyServerDataDir = async () => {
        const target = String(pendingServerDataDir || '').trim();
        if (!target || target === String(serverDataDir || '').trim()) return;
        setDataDirBusy(true);
        try {
            const res = await fetch('/api/system/data-dir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dataDir: target, migrateExisting: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Data directory update failed');
            const next = String(data?.dataDir || target);
            setServerDataDir(next);
            setPendingServerDataDir(next);
            showToast(t('dataDirSavedRestart', 'Data directory saved. Restart the server to apply changes.'), 'success');
        } catch (err) {
            showToast(`${t('errorPrefix', 'Error: ')}${err.message || ''}`, 'error');
        } finally {
            setDataDirBusy(false);
        }
    };

    const createBackup = async () => {
        setBackupBusy('create');
        try {
            const res = await fetch('/api/system/backups/create', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Create backup failed');
            showToast(t('backupCreated', 'Backup erstellt'), 'success');
            await loadBackups();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Fehler: ')}${err.message || ''}`, 'error');
        } finally {
            setBackupBusy('');
        }
    };

    const restoreBackup = async (fileName) => {
        const safeFile = String(fileName || '').trim();
        if (!safeFile) return;
        setBackupBusy(`restore:${safeFile}`);
        try {
            const res = await fetch('/api/system/backups/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: safeFile }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Restore backup failed');
            showToast(t('backupRestored', 'Backup wiederhergestellt'), 'success');
            window.dispatchEvent(new Event('playlists-changed'));
            if (onLibraryUpdate) onLibraryUpdate();
            await fetchSettings();
            await loadBackups();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Fehler: ')}${err.message || ''}`, 'error');
        } finally {
            setBackupBusy('');
        }
    };

    const deleteBackup = async (fileName) => {
        const safeFile = String(fileName || '').trim();
        if (!safeFile) return;
        setBackupBusy(`delete:${safeFile}`);
        try {
            const res = await fetch(`/api/system/backups/${encodeURIComponent(safeFile)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Delete backup failed');
            showToast(t('deleted', 'GelÃ¶scht'), 'success');
            await loadBackups();
        } catch (err) {
            showToast(`${t('errorPrefix', 'Fehler: ')}${err.message || ''}`, 'error');
        } finally {
            setBackupBusy('');
        }
    };

    const fetchSettings = async () => {
        try {
            const res = await fetch('/api/settings');
            const data = await res.json();
            const localRaw = localStorage.getItem('glyph_settings') || '{}';
            let local = {};
            try { local = JSON.parse(localRaw); } catch { local = {}; }
            const hasThumbfastMigration = local.__thumbfastDefaultV1Applied === true;
            if (!hasThumbfastMigration) {
                local = {
                    ...local,
                    thumbfastEnabled: true,
                    showTimelineGraph: false,
                    __thumbfastDefaultV1Applied: true,
                };
                try {
                    localStorage.setItem('glyph_settings', JSON.stringify(local));
                } catch { }
            }

            const merged = {
                ...data,
                playerType: data.playerType ?? local.playerType ?? 'internal',
                forceTranscode: typeof data.forceTranscode === 'boolean'
                    ? data.forceTranscode
                    : (typeof local.forceTranscode === 'boolean' ? local.forceTranscode : false),
                continueWatching: typeof local.continueWatching === 'boolean'
                    ? local.continueWatching
                    : true,
                showThumbnailHeatmap: typeof local.showThumbnailHeatmap === 'boolean'
                    ? local.showThumbnailHeatmap
                    : true,
                hoverPreviewEnabled: typeof local.hoverPreviewEnabled === 'boolean'
                    ? local.hoverPreviewEnabled
                    : false,
                showPerformerChips: typeof local.showPerformerChips === 'boolean'
                    ? local.showPerformerChips
                    : true,
                thumbfastEnabled: typeof local.thumbfastEnabled === 'boolean'
                    ? local.thumbfastEnabled
                    : true,
                hotkeys: normalizeHotkeys(local.hotkeys || data.hotkeys || {}),
                showTimelineGraph: typeof local.showTimelineGraph === 'boolean'
                    ? local.showTimelineGraph
                    : false,
                separatePlayerWindow: typeof local.separatePlayerWindow === 'boolean'
                    ? local.separatePlayerWindow
                    : false,
                playerAutoFullscreen: typeof local.playerAutoFullscreen === 'boolean'
                    ? local.playerAutoFullscreen
                    : false,
                subtitleStyles: {
                    ...DEFAULT_SUBTITLE_STYLES,
                    ...(data.subtitleStyles || {}),
                    ...(local.subtitleStyles || {}),
                },
                includeAllLibrary: data?.includeAllLibrary === true,
            };

            setSettings(merged);
        } catch (err) {
            console.error('Failed to load settings:', err);
            showToast(t('settingsLoadError', 'Einstellungen konnten nicht geladen werden'), 'error');
        }
    };

    const handleAddLibrary = async () => {
        let folderPath = '';
        if (!window.electronAPI?.selectFolder) {
            showToast(t('settingsFolderPickerUnavailable', 'Ordnerauswahl ist nicht verfuegbar'), 'error');
            return;
        }
        try {
            folderPath = await window.electronAPI.selectFolder();
        } catch (err) {
            console.error('Folder dialog error:', err);
            showToast(t('errorPrefix', 'Fehler: ') + t('settingsFolderPickerError', 'Ordnerauswahl fehlgeschlagen'), 'error');
            return;
        }
        if (!folderPath) return;

        const name = newLibName.trim() || folderPath.split(/[\\/]/).pop() || t('settingsDefaultLibrary', 'Bibliothek');
        try {
            const res = await fetch('/api/libraries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, path: folderPath, type: newLibType }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || t('settingsServerError', 'Server-Fehler'));
            }
            await fetchSettings();
            if (onLibraryUpdate) onLibraryUpdate();
            setNewLibName('');
            showToast(`"${name}" ${t('addedSuffix', 'hinzugefuegt')}`, 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        }
    };

    const handleRemoveLibrary = async (id, name, deleteGenerated = false) => {
        try {
            const qs = deleteGenerated ? '?cleanupGenerated=1' : '';
            await fetch(`/api/libraries/${id}${qs}`, { method: 'DELETE' });
            await fetchSettings();
            if (onLibraryUpdate) onLibraryUpdate();
            const suffix = deleteGenerated
                ? t('removedWithGeneratedSuffix', 'entfernt (inkl. generierter Dateien)')
                : t('removedSuffix', 'entfernt');
            showToast(`"${name}" ${suffix}`, 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        }
    };

    const openRemoveLibraryDialog = (lib) => {
        if (!lib?.id) return;
        setRemoveLibraryDialog({ id: lib.id, name: lib.name || '' });
        setRemoveLibraryDeleteGenerated(false);
    };

    const closeRemoveLibraryDialog = () => {
        setRemoveLibraryDialog(null);
        setRemoveLibraryDeleteGenerated(false);
    };

    const confirmRemoveLibrary = async () => {
        if (!removeLibraryDialog?.id) return;
        await handleRemoveLibrary(removeLibraryDialog.id, removeLibraryDialog.name, removeLibraryDeleteGenerated);
        closeRemoveLibraryDialog();
    };

    useDialogHotkeys({
        open: !!removeLibraryDialog,
        onCancel: closeRemoveLibraryDialog,
        onConfirm: confirmRemoveLibrary,
        canConfirm: !!removeLibraryDialog?.id,
        allowEnterInInputs: false,
    });

    const handleSave = async (updates) => {
        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            const updated = await res.json();
            setSettings(prev => ({
                ...prev,
                ...updated,
                hotkeys: normalizeHotkeys(updated.hotkeys ?? prev.hotkeys ?? {}),
                playerType: updated.playerType ?? prev.playerType ?? 'internal',
                forceTranscode: typeof updated.forceTranscode === 'boolean'
                    ? updated.forceTranscode
                    : (typeof prev.forceTranscode === 'boolean' ? prev.forceTranscode : false),
                subtitleStyles: {
                    ...DEFAULT_SUBTITLE_STYLES,
                    ...(updated.subtitleStyles || {}),
                    ...(prev.subtitleStyles || {}),
                    ...(updates.subtitleStyles || {}),
                },
            }));
            try {
                const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                localStorage.setItem('glyph_settings', JSON.stringify({
                    ...currentLocal,
                    hotkeys: normalizeHotkeys(updated.hotkeys ?? updates.hotkeys ?? currentLocal.hotkeys ?? settings.hotkeys ?? {}),
                }));
            } catch { }
            showToast(t('saved', 'Gespeichert'), 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };

    const handleScan = async () => {
        setScanning(true);
        try {
            const res = await fetch('/api/scan', { method: 'POST' });
            const data = await res.json();
            if (onLibraryUpdate) onLibraryUpdate();
            showToast(`${data.count} ${t('videosFound', 'Videos gefunden')}`, 'success');
        } catch (err) {
            showToast(t('scanFailed', 'Scan fehlgeschlagen'), 'error');
        } finally {
            setScanning(false);
        }
    };

    const loadHeresphereInfo = async () => {
        try {
            const res = await fetch('/api/heresphere/info');
            if (!res.ok) throw new Error('failed');
            const data = await res.json();
            setHeresphereInfo(data || null);
        } catch {
            setHeresphereInfo(null);
        }
    };


    const copyText = async (value) => {
        const text = String(value || '').trim();
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            showToast(t('copied', 'Kopiert'), 'success');
        } catch {
            const input = document.createElement('input');
            input.value = text;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showToast(t('copied', 'Kopiert'), 'success');
        }
    };

    const handleThemePreset = (preset) => {
        const theme = {
            ...(settings.theme || {}),
            accentPrimary: preset.accent,
            accentSecondary: preset.secondary,
        };
        handleSave({ theme });
        if (onThemeChange) onThemeChange(theme);
    };

    const handleCustomColor = (key, value) => {
        const theme = { ...(settings.theme || {}), [key]: value };
        setSettings(prev => ({ ...prev, theme }));
        if (onThemeChange) onThemeChange(theme);
    };

    const handleSaveTheme = () => {
        handleSave({ theme: settings.theme || {} });
    };


    const handleModernStyleChange = async (key, value) => {
        let normalized = value;
        if (key === 'glassIntensity' || key === 'patternIntensity') {
            const n = Number(value);
            normalized = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
        }
        if (key === 'radiusProfile') {
            normalized = ['sharp', 'balanced', 'soft'].includes(value) ? value : 'balanced';
        }
        if (key === 'patternType') {
            normalized = ['none', 'dots', 'lines', 'mesh', 'paper'].includes(value) ? value : 'dots';
        }

        const nextTheme = { ...(settings.theme || {}), [key]: normalized };
        setSettings(prev => ({ ...prev, theme: nextTheme }));
        if (onThemeChange) onThemeChange(nextTheme);
        await handleSave({ theme: nextTheme });
    };
    const handleThemeModeChange = async (mode) => {
        const selectedMode = mode === 'modern' ? 'modern' : 'default';
        const nextTheme = { ...(settings.theme || {}), mode: selectedMode };
        setSettings(prev => ({ ...prev, theme: nextTheme }));
        if (onThemeChange) onThemeChange(nextTheme);
        await handleSave({ theme: nextTheme });
    };

    const handleLanguageChange = async (nextLanguage) => {
        const allowed = new Set(['de', 'en', 'es', 'ja', 'ru', 'ko']);
        const lang = allowed.has(nextLanguage) ? nextLanguage : 'en';
        setSettings(prev => ({ ...prev, language: lang }));
        setLanguage(lang);
        if (onLanguageChange) onLanguageChange(lang);
        await handleSave({ language: lang });
    };


    const handleLibraryRecentAddedChange = async (libraryId, enabled) => {
        const nextLibraries = (settings.libraries || []).map((lib) => (
            lib.id === libraryId ? { ...lib, showRecentAdded: !!enabled } : lib
        ));
        setSettings(prev => ({ ...prev, libraries: nextLibraries }));
        await handleSave({ libraries: nextLibraries });
        if (onLibraryUpdate) onLibraryUpdate();
    };

    const handleLibraryTrackContinueChange = async (libraryId, enabled) => {
        const nextLibraries = (settings.libraries || []).map((lib) => (
            lib.id === libraryId ? { ...lib, trackContinueWatching: !!enabled } : lib
        ));
        setSettings(prev => ({ ...prev, libraries: nextLibraries }));
        await handleSave({ libraries: nextLibraries });
        if (onLibraryUpdate) onLibraryUpdate();
    };

    const showToast = (message, type) => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    };

    const applySettingsLibraryTransform = (state, el, clientX, clientY, immediate = false) => {
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

    const reanchorSettingsLibraryElement = (state, el) => {
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
        applySettingsLibraryTransform(state, el, pointerX, pointerY, true);
    };

    const animateSettingsLibraryReorder = (nextOrderIds, activeDragId = '') => {
        const ids = Array.isArray(nextOrderIds) ? nextOrderIds.map((id) => String(id || '')).filter(Boolean) : [];
        if (!ids.length) return;
        const activeId = String(activeDragId || '');
        const dragState = libraryDragStateRef.current;

        const firstRects = new Map();
        for (const id of ids) {
            const el = libraryRowRefs.current.get(id);
            if (!el) continue;
            firstRects.set(id, el.getBoundingClientRect());
        }

        settingsLibraryOrderIdsRef.current = ids;

        flushSync(() => {
            setSettings((prev) => {
                const libs = Array.isArray(prev?.libraries) ? prev.libraries : [];
                const byId = new Map(libs.map((lib) => [String(lib.id || ''), lib]));
                const ordered = [];
                for (const id of ids) {
                    const hit = byId.get(id);
                    if (hit) ordered.push(hit);
                }
                for (const lib of libs) {
                    const id = String(lib?.id || '');
                    if (!id || ids.includes(id)) continue;
                    ordered.push(lib);
                }
                settingsLibrariesRef.current = ordered;
                return { ...prev, libraries: ordered };
            });
        });

        if (activeId && dragState && String(dragState.libraryId || '') === activeId) {
            const activeElAfter = libraryRowRefs.current.get(activeId);
            if (activeElAfter) {
                activeElAfter.style.pointerEvents = 'none';
                activeElAfter.style.zIndex = '40';
                activeElAfter.style.transition = 'none';
                activeElAfter.style.willChange = 'transform';
                activeElAfter.style.transformOrigin = `${Number(dragState.pointerOffsetX || 0)}px ${Number(dragState.pointerOffsetY || 0)}px`;
                dragState.dragEl = activeElAfter;
                reanchorSettingsLibraryElement(dragState, activeElAfter);
            }
        }

        const toAnimate = [];
        for (const id of ids) {
            if (id === activeId) continue;
            const el = libraryRowRefs.current.get(id);
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

    const persistSettingsLibraryOrder = async (orderedIdsRaw) => {
        const orderedIds = Array.isArray(orderedIdsRaw)
            ? orderedIdsRaw.map((id) => String(id || '')).filter(Boolean)
            : [...settingsLibraryOrderIdsRef.current];
        const source = Array.isArray(settingsLibrariesRef.current) ? settingsLibrariesRef.current : [];
        const byId = new Map(source.map((lib) => [String(lib?.id || ''), lib]));
        const nextLibraries = [];
        for (const id of orderedIds) {
            const hit = byId.get(id);
            if (hit) nextLibraries.push(hit);
        }
        for (const lib of source) {
            const id = String(lib?.id || '');
            if (!id || orderedIds.includes(id)) continue;
            nextLibraries.push(lib);
        }
        await handleSave({ libraries: nextLibraries });
        if (onLibraryUpdate) onLibraryUpdate();
    };

    const onSettingsLibraryMouseMove = (e) => {
        const state = libraryDragStateRef.current;
        if (!state) return;
        state.pointerX = e.clientX;
        state.pointerY = e.clientY;

        if (!state.dragging) {
            const dx = Math.abs(e.clientX - state.startX);
            const dy = Math.abs(e.clientY - state.startY);
            if (dx > 8 || dy > 8) {
                if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
                libraryHoldTimerRef.current = null;
                libraryDragStateRef.current = null;
                window.removeEventListener('mousemove', onSettingsLibraryMouseMove);
                window.removeEventListener('mouseup', onSettingsLibraryMouseUp);
            }
            return;
        }

        e.preventDefault();
        const draggingId = String(state.libraryId || '');
        if (!draggingId) return;

        const mappedEl = libraryRowRefs.current.get(draggingId);
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
            reanchorSettingsLibraryElement(state, mappedEl);
        }

        const draggingEl = state.dragEl || mappedEl;
        if (draggingEl) applySettingsLibraryTransform(state, draggingEl, state.pointerX, state.pointerY);

        const now = Date.now();
        if (now - Number(state.lastSwapTs || 0) < 130) return;
        const current = Array.isArray(settingsLibraryOrderIdsRef.current) ? [...settingsLibraryOrderIdsRef.current] : [];
        if (current.length < 2 || !current.includes(draggingId)) return;
        const others = current.filter((id) => id !== draggingId);

        let targetId = others[others.length - 1];
        let before = false;
        for (let i = 0; i < others.length; i++) {
            const el = libraryRowRefs.current.get(String(others[i]));
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

        const rest = current.filter((id) => id !== draggingId);
        const targetIndex = rest.indexOf(targetId);
        if (targetIndex < 0) return;
        const insertIndex = before ? targetIndex : targetIndex + 1;
        const next = [...rest];
        next.splice(insertIndex, 0, draggingId);
        let changed = next.length !== current.length;
        if (!changed) {
            for (let i = 0; i < next.length; i++) {
                if (next[i] !== current[i]) { changed = true; break; }
            }
        }
        if (!changed) return;

        const movedSinceSwap = Math.abs(e.clientY - Number(state.lastSwapY ?? state.startY ?? e.clientY));
        if (movedSinceSwap < 14) return;

        state.didSwap = true;
        state.lastSwapTs = now;
        state.lastSwapY = e.clientY;
        animateSettingsLibraryReorder(next, draggingId);
    };

    const onSettingsLibraryMouseUp = () => {
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryHoldTimerRef.current = null;
        const state = libraryDragStateRef.current;
        libraryDragStateRef.current = null;
        window.removeEventListener('mousemove', onSettingsLibraryMouseMove);
        window.removeEventListener('mouseup', onSettingsLibraryMouseUp);
        document.body.style.userSelect = '';
        const dragId = String(state?.libraryId || '');
        const mappedEl = dragId ? libraryRowRefs.current.get(dragId) : null;
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
        setDraggingSettingsLibraryId('');
        if (state.didSwap) {
            persistSettingsLibraryOrder(settingsLibraryOrderIdsRef.current);
        }
    };

    const cancelSettingsLibraryHoldIfPending = () => {
        const state = libraryDragStateRef.current;
        if (state?.dragging) return;
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryHoldTimerRef.current = null;
        libraryDragStateRef.current = null;
        document.body.style.userSelect = '';
    };

    const onSettingsLibraryMouseDown = (e, libraryId) => {
        if (e.button !== 0) return;
        const interactive = e.target?.closest?.('button,input,select,textarea,a,label,.settings-switch');
        if (interactive) return;
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        libraryDragStateRef.current = {
            libraryId: String(libraryId || ''),
            startX: e.clientX,
            startY: e.clientY,
            dragging: false,
            didSwap: false,
            lastSwapTs: 0,
            lastSwapY: e.clientY,
        };
        window.addEventListener('mouseup', cancelSettingsLibraryHoldIfPending, { once: true });
        libraryHoldTimerRef.current = setTimeout(() => {
            const state = libraryDragStateRef.current;
            if (!state || String(state.libraryId) !== String(libraryId)) return;
            state.dragging = true;
            state.lastX = state.startX;
            setDraggingSettingsLibraryId(String(libraryId));
            document.body.style.userSelect = 'none';
            const dragEl = libraryRowRefs.current.get(String(libraryId));
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
            window.addEventListener('mousemove', onSettingsLibraryMouseMove);
            window.addEventListener('mouseup', onSettingsLibraryMouseUp);
        }, 140);
    };

    useEffect(() => () => {
        if (libraryHoldTimerRef.current) clearTimeout(libraryHoldTimerRef.current);
        window.removeEventListener('mousemove', onSettingsLibraryMouseMove);
        window.removeEventListener('mouseup', onSettingsLibraryMouseUp);
    }, []);

    const theme = settings.theme || {};
    const subtitleStyles = settings.subtitleStyles || {};
    const hotkeys = normalizeHotkeys(settings.hotkeys || {});
    const hotkeyActions = useMemo(() => ([
        { id: 'goHome', category: 'navigation', label: t('hotkeyGoHome', 'Go to Home') },
        { id: 'goPlaylists', category: 'navigation', label: t('hotkeyGoPlaylists', 'Go to Playlists') },
        { id: 'goBack', category: 'navigation', label: t('hotkeyGoBack', 'Back') },
        { id: 'toggleDevicePanel', category: 'ui', label: t('hotkeyToggleDevicePanel', 'Toggle Device Panel') },
        { id: 'openSettings', category: 'ui', label: t('hotkeyOpenSettings', 'Open Settings') },
        { id: 'openDashboard', category: 'manager', label: t('hotkeyOpenDashboard', 'Open Dashboard') },
        { id: 'openTagManager', category: 'manager', label: t('hotkeyOpenTagManager', 'Open Tag Manager') },
        { id: 'openFunscriptManager', category: 'manager', label: t('hotkeyOpenFunscriptManager', 'Open Funscript Manager') },
        { id: 'openPlaylistManager', category: 'manager', label: t('hotkeyOpenPlaylistManager', 'Open Playlist Manager') },
    ]), [t]);

    const hotkeyConflicts = useMemo(() => {
        const byCombo = new Map();
        for (const action of hotkeyActions) {
            const binding = hotkeys[action.id];
            const key = hotkeyId(binding);
            if (!key) continue;
            const list = byCombo.get(key) || [];
            list.push(action.id);
            byCombo.set(key, list);
        }
        const conflicts = new Set();
        for (const [, ids] of byCombo) {
            if (ids.length < 2) continue;
            ids.forEach((id) => conflicts.add(id));
        }
        return conflicts;
    }, [hotkeyActions, hotkeys]);

    const saveHotkeys = async (nextHotkeys) => {
        const normalized = normalizeHotkeys(nextHotkeys);
        setSettings((prev) => ({ ...prev, hotkeys: normalized }));
        try {
            const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, hotkeys: normalized }));
        } catch { }
        await handleSave({ hotkeys: normalized });
    };

    const resetAllHotkeys = async () => {
        await saveHotkeys(DEFAULT_HOTKEYS);
    };

    const resetHotkeyAction = async (actionId) => {
        const next = { ...hotkeys, [actionId]: DEFAULT_HOTKEYS[actionId] || null };
        await saveHotkeys(next);
    };
    const updateSubtitleStyles = (patch) => {
        const nextStyles = { ...subtitleStyles, ...patch };
        setSettings({ ...settings, subtitleStyles: nextStyles });
        handleSave({ subtitleStyles: nextStyles });
        try {
            const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
            localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, subtitleStyles: nextStyles }));
        } catch { }
    };

    useEffect(() => {
        if (!capturingHotkeyAction) return undefined;
        const onKeyDown = async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (event.key === 'Escape') {
                setCapturingHotkeyAction('');
                return;
            }
            const binding = eventToBinding(event);
            if (!binding) return;
            const prevBinding = hotkeys[capturingHotkeyAction] || {};
            const next = { ...hotkeys, [capturingHotkeyAction]: { ...binding, enabled: prevBinding.enabled === false ? false : true } };
            setCapturingHotkeyAction('');
            await saveHotkeys(next);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [capturingHotkeyAction, hotkeys]);

    const renderPanel = () => {
        if (activePanel === 'language') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('languageTitle', 'Sprache')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('languageHint', 'Aendere die Anzeigesprache des Systems.')}
                    </p>
                    <div className="settings-input-row">
                        <AppDropdown
                            value={settings.language || language || 'en'}
                            onChange={handleLanguageChange}
                            className="settings-playback-select"
                            options={[
                                { value: 'de', label: t('languageGerman', 'Deutsch') },
                                { value: 'en', label: t('languageEnglish', 'Englisch') },
                                { value: 'es', label: t('languageSpanish', 'Spanisch') },
                                { value: 'ja', label: t('languageJapanese', 'Japanisch') },
                                { value: 'ru', label: t('languageRussian', 'Russian') },
                                { value: 'ko', label: t('languageKorean', 'Korean') },
                            ]}
                        />
                    </div>
                </div>
            );
        }

        if (activePanel === 'appearance') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('displayThemeTitle', 'Darstellung / Theme')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('displayThemeHint', 'Waehle ein voreingestelltes Farbschema oder passe die Farben individuell an.')}
                    </p>
                    <div className="settings-input-row" style={{ marginBottom: '12px' }}>
                        <AppDropdown
                            value={(theme.mode === 'modern' ? 'modern' : 'default')}
                            onChange={handleThemeModeChange}
                            className="settings-playback-select"
                            options={[
                                { value: 'default', label: t('themeModeDefault', 'Default') },
                                { value: 'modern', label: t('themeModeModern', 'Modern') },
                            ]}
                        />
                    </div>

                    {theme.mode === 'modern' ? (
                        <div className="theme-custom modern-style-panel" style={{ marginTop: '16px' }}>

                            <div className="modern-style-grid">
                                <label className="modern-style-row">
                                    <span>{t('glassIntensity', 'Glass Intensity')} ({Number.isFinite(Number(theme.glassIntensity)) ? Number(theme.glassIntensity) : 70}%)</span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        value={Number.isFinite(Number(theme.glassIntensity)) ? Number(theme.glassIntensity) : 70}
                                        onChange={(e) => handleModernStyleChange('glassIntensity', e.target.value)}
                                    />
                                </label>
                                <label className="modern-style-row">
                                    <span>{t('patternIntensity', 'Pattern Intensity')} ({Number.isFinite(Number(theme.patternIntensity)) ? Number(theme.patternIntensity) : (Number.isFinite(Number(theme.noiseIntensity)) ? Number(theme.noiseIntensity) : 28)}%)</span>
                                    <input
                                        type="range"
                                        min="0"
                                        max="100"
                                        value={Number.isFinite(Number(theme.patternIntensity)) ? Number(theme.patternIntensity) : (Number.isFinite(Number(theme.noiseIntensity)) ? Number(theme.noiseIntensity) : 28)}
                                        onChange={(e) => handleModernStyleChange('patternIntensity', e.target.value)}
                                    />
                                </label>

                                <label className="modern-style-row">
                                    <span>{t('cornerProfile', 'Corner Radius Profile')}</span>
                                    <AppDropdown
                                        value={['sharp', 'balanced', 'soft'].includes(theme.radiusProfile) ? theme.radiusProfile : 'balanced'}
                                        onChange={(val) => handleModernStyleChange('radiusProfile', val)}
                                        className="modern-style-select"
                                        options={[
                                            { value: 'sharp', label: t('radiusSharp', 'Sharp') },
                                            { value: 'balanced', label: t('radiusBalancedDefault', 'Balanced (Default)') },
                                            { value: 'soft', label: t('radiusSoft', 'Soft') },
                                        ]}
                                    />
                                </label>

                                <label className="modern-style-row">
                                    <span>{t('modernPalette', 'Background Palette')}</span>
                                    <div className="modern-palette-grid" role="radiogroup" aria-label={t('modernPalette', 'Background Palette')}>
                                        {[
                                            { key: 'silver', label: t('paletteSilver', 'Silver') },
                                            { key: 'starlight', label: t('paletteStarlight', 'Starlight') },
                                            { key: 'sky', label: t('paletteSky', 'Sky Blue') },
                                            { key: 'lavender', label: t('paletteLavender', 'Lavender') },
                                            { key: 'copper', label: t('paletteCopper', 'Light Copper') },
                                        ].map((opt) => {
                                            const current = ['silver', 'starlight', 'sky', 'lavender', 'copper'].includes(theme.modernPalette) ? theme.modernPalette : 'silver';
                                            const active = current === opt.key;
                                            return (
                                                <button
                                                    key={opt.key}
                                                    type="button"
                                                    className={`modern-palette-btn ${active ? 'active' : ''}`}
                                                    aria-checked={active}
                                                    role="radio"
                                                    title={opt.label}
                                                    onClick={() => handleModernStyleChange('modernPalette', opt.key)}
                                                >
                                                    <span className={`modern-palette-swatch ${opt.key}`} />
                                                    <span className="modern-palette-label">{opt.label}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </label>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="theme-preset-grid">
                                {THEME_PRESETS.map(preset => (
                                    <button
                                        key={preset.nameKey}
                                        className={`theme-preset-btn ${theme.accentPrimary === preset.accent ? 'active' : ''}`}
                                        onClick={() => handleThemePreset(preset)}
                                        title={t(preset.nameKey, preset.nameFallback)}
                                    >
                                        <span className="theme-preset-swatch" style={{ background: `linear-gradient(135deg, ${preset.accent}, ${preset.secondary})` }} />
                                        <span className="theme-preset-label">{t(preset.nameKey, preset.nameFallback)}</span>
                                    </button>
                                ))}
                            </div>

                            <div className="theme-custom" style={{ marginTop: '16px' }}>
                                <div className="settings-section-subtitle">{t('customColors', 'Individuelle Farben')}</div>
                                <div className="theme-color-row">
                                    <label>
                                        <span>{t('accentColor', 'Akzentfarbe')}</span>
                                        <div className="theme-color-input">
                                            <input type="color" value={theme.accentPrimary || '#a855f7'} onChange={e => handleCustomColor('accentPrimary', e.target.value)} />
                                            <span className="color-hex">{theme.accentPrimary || '#a855f7'}</span>
                                        </div>
                                    </label>
                                    <label>
                                        <span>{t('secondaryColor', 'Sekundaerfarbe')}</span>
                                        <div className="theme-color-input">
                                            <input type="color" value={theme.accentSecondary || '#6366f1'} onChange={e => handleCustomColor('accentSecondary', e.target.value)} />
                                            <span className="color-hex">{theme.accentSecondary || '#6366f1'}</span>
                                        </div>
                                    </label>
                                    <label>
                                        <span>{t('backgroundColor', 'Hintergrund')}</span>
                                        <div className="theme-color-input">
                                            <input type="color" value={theme.bgPrimary || '#101018'} onChange={e => handleCustomColor('bgPrimary', e.target.value)} />
                                            <span className="color-hex">{theme.bgPrimary || '#101018'}</span>
                                        </div>
                                    </label>
                                    <label>
                                        <span>{t('cardsColor', 'Karten')}</span>
                                        <div className="theme-color-input">
                                            <input type="color" value={theme.bgCard || '#16161f'} onChange={e => handleCustomColor('bgCard', e.target.value)} />
                                            <span className="color-hex">{theme.bgCard || '#16161f'}</span>
                                        </div>
                                    </label>
                                </div>
                                <button className="btn btn-secondary" onClick={handleSaveTheme} style={{ marginTop: '12px' }}>
                                    {t('saveTheme', 'Theme speichern')}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            );
        }

        if (activePanel === 'libraries') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('librariesTitle', 'Bibliotheken')}</div>
                    <div style={{ marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid var(--border-subtle)' }}>
                        <div className="settings-input-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                                <div style={{ color: 'var(--text-primary)', fontSize: '14px', fontWeight: 500 }}>
                                    {t('includeAllLibraryToggle', 'Add virtual "All videos" library')}
                                </div>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginTop: 2 }}>
                                    {t('includeAllLibraryHint', 'Creates one extra library with videos from all configured libraries.')}
                                </div>
                            </div>
                            <label className="settings-switch" aria-label={t('includeAllLibraryToggle', 'Add virtual "All videos" library')}>
                                <input
                                    type="checkbox"
                                    checked={settings.includeAllLibrary === true}
                                    onChange={(e) => {
                                        const next = e.target.checked;
                                        setSettings((prev) => ({ ...prev, includeAllLibrary: next }));
                                        handleSave({ includeAllLibrary: next });
                                        if (onLibraryUpdate) onLibraryUpdate();
                                    }}
                                />
                                <span className="settings-switch-track">
                                    <span className="settings-switch-thumb" />
                                </span>
                            </label>
                        </div>
                    </div>

                    {settings.libraries?.length > 0 && (
                        <div className={`folder-list ${draggingSettingsLibraryId ? 'is-reordering' : ''}`}>
                            {settings.libraries.map(lib => (
                                <div
                                    key={lib.id}
                                    ref={(el) => {
                                        const key = String(lib.id || '');
                                        if (!key) return;
                                        if (el) libraryRowRefs.current.set(key, el);
                                        else libraryRowRefs.current.delete(key);
                                    }}
                                    className={`folder-item ${draggingSettingsLibraryId === String(lib.id) ? 'is-dragging' : ''}`}
                                    onMouseDown={(e) => onSettingsLibraryMouseDown(e, lib.id)}
                                    onMouseUp={cancelSettingsLibraryHoldIfPending}
                                    onMouseLeave={cancelSettingsLibraryHoldIfPending}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                                            <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-primary)' }}>{lib.name}</span>
                                            <span className={`lib-type-badge ${lib.type}`}>
                                                {lib.type === 'series'
                                                    ? t('seriesLabel', 'Serien')
                                                    : lib.type === 'vr'
                                                        ? t('vrLabel', 'VR')
                                                        : t('videosLabel', 'Videos')}
                                            </span>
                                        </div>
                                        <span className="folder-path">{lib.path}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('showRecentAddedToggle', 'Neu hinzugefuegt auf Startseite')}</span>
                                            <label className="settings-switch" title={t('showRecentAddedToggleHint', 'Zeigt diese Bibliothek auf der Startseite unter Recently Added an.')}>
                                                <input
                                                    type="checkbox"
                                                    checked={lib.showRecentAdded !== false}
                                                    onChange={(e) => handleLibraryRecentAddedChange(lib.id, e.target.checked)}
                                                />
                                                <span className="settings-switch-track">
                                                    <span className="settings-switch-thumb" />
                                                </span>
                                            </label>
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{t('trackContinueWatchingToggle', 'In Weiterschauen tracken')}</span>
                                            <label className="settings-switch" title={t('trackContinueWatchingToggleHint', 'Speichert den Fortschritt dieser Bibliothek fÃ¼r Weiterschauen.')}>
                                                <input
                                                    type="checkbox"
                                                    checked={lib.trackContinueWatching !== false}
                                                    onChange={(e) => handleLibraryTrackContinueChange(lib.id, e.target.checked)}
                                                />
                                                <span className="settings-switch-track">
                                                    <span className="settings-switch-thumb" />
                                                </span>
                                            </label>
                                        </div>
                                        <button className="btn btn-danger" onClick={() => openRemoveLibraryDialog(lib)} style={{ padding: '6px 12px', fontSize: '12px', flexShrink: 0 }}>
                                            {t('remove', 'Entfernen')}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="add-library-form">
                        <input type="text" className="add-library-name" value={newLibName} onChange={(e) => setNewLibName(e.target.value)} placeholder={t('addLibraryNamePlaceholder', 'Name (optional)')} />
                        <AppDropdown
                            className="add-library-type-select"
                            value={newLibType}
                            onChange={setNewLibType}
                            options={[
                                { value: 'videos', label: t('videosLabel', 'Videos') },
                                { value: 'series', label: t('seriesLabel', 'Serien') },
                                { value: 'vr', label: t('vrLabel', 'VR') },
                            ]}
                        />
                        <div className="add-library-buttons">
                            <button className="btn btn-primary" onClick={() => handleAddLibrary()}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                                    <line x1="12" y1="5" x2="12" y2="19" />
                                    <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                {t('chooseFolder', 'Ordner waehlen')}
                            </button>
                        </div>
                    </div>

                    <div style={{ marginTop: '12px' }}>
                        <button className="btn btn-secondary" onClick={handleScan} disabled={scanning}>
                            {scanning ? t('scanning', 'Scanne...') : t('scanAllLibraries', 'Alle Bibliotheken scannen')}
                        </button>
                    </div>

                    <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-subtle)', paddingTop: '12px' }}>
                        <div className="settings-section-subtitle">{t('watchFoldersTitle', 'Watchfolder-Modus')}</div>
                        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '10px' }}>
                            {t('watchFoldersHint', 'Neue oder geloeschte Dateien werden automatisch erkannt und die Bibliothek wird neu eingelesen.')}
                        </p>
                        <div className="settings-input-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ color: 'var(--text-primary)', fontSize: '14px' }}>
                                {t('watchFoldersEnabled', 'Automatische Ueberwachung aktiv')}
                            </span>
                            <label className="settings-switch" aria-label={t('watchFoldersEnabled', 'Automatische Ueberwachung aktiv')}>
                                <input
                                    type="checkbox"
                                    checked={settings.watchFolders !== false}
                                    onChange={(e) => handleWatchFoldersChange(e.target.checked)}
                                />
                                <span className="settings-switch-track">
                                    <span className="settings-switch-thumb" />
                                </span>
                            </label>
                        </div>
                    </div>
                </div>
            );
        }

        if (activePanel === 'metadata') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('metadataPanelTitle', 'Metadaten')}</div>
                    <div className="settings-section-title" style={{ marginTop: 18 }}>{t('tmdbKeyTitle', 'TheMovieDB API Key')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('tmdbHint', 'Fuer Metadaten und Poster. Kostenlos auf')}{' '}
                        <span style={{ color: 'var(--accent-primary)' }}>themoviedb.org/settings/api</span>
                    </p>
                    <div className="settings-input-row">
                        <input
                            type="text"
                            value={settings.tmdbApiKey || ''}
                            onChange={e => setSettings({ ...settings, tmdbApiKey: e.target.value })}
                            placeholder={t('apiKeyPlaceholder', 'API Key eingeben...')}
                        />
                        <button className="btn btn-secondary" onClick={() => handleSave({ tmdbApiKey: settings.tmdbApiKey })}>
                            {t('saveLabel', 'Speichern')}
                        </button>
                    </div>

                    <div className="settings-section-title" style={{ marginTop: 18 }}>{t('tpdbKeyTitle', 'ThePornDB API Key')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('tpdbHint', 'Used for scene/JAV/movie and performer metadata in video libraries.')}
                    </p>
                    <div className="settings-input-row">
                        <input
                            type="text"
                            value={settings.tpdbApiKey || ''}
                            onChange={e => setSettings({ ...settings, tpdbApiKey: e.target.value })}
                            placeholder={t('apiKeyPlaceholder', 'API Key eingeben...')}
                        />
                        <button className="btn btn-secondary" onClick={() => handleSave({ tpdbApiKey: settings.tpdbApiKey })}>
                            {t('saveLabel', 'Speichern')}
                        </button>
                    </div>

                    <div className="settings-section-title" style={{ marginTop: 18 }}>{t('stashdbKeyTitle', 'StashDB API Key')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('stashdbHint', 'Primary provider for video metadata fetch (StashDB -> ThePornDB fallback).')}
                    </p>
                    <div className="settings-input-row">
                        <input
                            type="text"
                            value={settings.stashdbApiKey || ''}
                            onChange={e => setSettings({ ...settings, stashdbApiKey: e.target.value })}
                            placeholder={t('apiKeyPlaceholder', 'API Key eingeben...')}
                        />
                        <button className="btn btn-secondary" onClick={() => handleSave({ stashdbApiKey: settings.stashdbApiKey })}>
                            {t('saveLabel', 'Speichern')}
                        </button>
                    </div>
                </div>
            );
        }

        if (activePanel === 'playback') {
            const isInternalPlayer = settings.playerType !== 'external';
            const showPlaybackGeneral = activePlaybackSubpanel === 'general';
            const showPlaybackVr = activePlaybackSubpanel === 'vr';
            const showPlaybackPlayer = activePlaybackSubpanel === 'player';

            return (
                <div className="settings-section settings-playback-section">
                    <div className="settings-section-title">{t('playbackTitle', 'Wiedergabe')}</div>
                    <div>
                        {showPlaybackGeneral && (
                            <>
                                <div className="settings-section-subtitle settings-playback-subtitle" style={{ marginTop: '12px' }}>
                                    {t('playbackGeneralTitle', 'General')}
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', marginTop: '12px', marginLeft: '14px' }}>
                        <div>
                            <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('continueWatchingToggle', 'Weiterschauen aktivieren')}</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{t('continueWatchingToggleHint', 'Merkt die letzte Position und zeigt Videos auf der Startseite unter Weiterschauen an.')}</div>
                        </div>
                        <label className="settings-switch">
                            <input
                                type="checkbox"
                                checked={settings.continueWatching !== false}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setSettings({ ...settings, continueWatching: val });
                                    const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                    localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, continueWatching: val }));
                                    setContinueWatchingEnabled(val);
                                }}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                            </div>

                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', marginLeft: '14px' }}>
                        <div>
                            <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>
                                {t('separatePlayerWindowToggle', 'Open player in separate window')}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                {t('separatePlayerWindowDesc', 'Keeps library visible while playback runs in its own window.')}
                            </div>
                        </div>
                        <label className="settings-switch">
                            <input
                                type="checkbox"
                                checked={settings.separatePlayerWindow === true}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setSettings({ ...settings, separatePlayerWindow: val });
                                    const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                    localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, separatePlayerWindow: val }));
                                    window.dispatchEvent(new Event('glyph-settings-changed'));
                                }}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                                </div>
                            </>
                        )}

                        {showPlaybackVr && (
                            <>
                                <div className="settings-section-subtitle settings-playback-subtitle" style={{ marginTop: '8px' }}>{t('playbackVrTitle', 'VR')}</div>
                                {(() => {
                                    const localhostFeed = (heresphereInfo?.localhostUrl || 'http://localhost:4000/api/heresphere/')
                                        .replace('/api/heresphere/', '/heresphere');
                                    const lanFeeds = (heresphereInfo?.lanUrls || [])
                                        .map((u) => String(u || '').replace('/api/heresphere/', '/heresphere'))
                                        .filter(Boolean);
                                    const primaryFeed = lanFeeds[0] || localhostFeed;
                                    return (
                                        <>
                                            <div className="settings-section-subtitle" style={{ marginTop: '8px', marginLeft: '14px' }}>{t('heresphereFeedTitle', 'HereSphere Feed (nur VR)')}</div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', marginLeft: '14px' }}>
                                                {t('heresphereFeedHint', 'Fuege diese URL in HereSphere als Web-Quelle hinzu. Der Feed enthaelt nur Bibliotheken vom Typ VR.')}
                                            </div>
                                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px', marginLeft: '14px' }}>
                                                {t('herespherePrimaryUrlLabel', 'Empfohlene URL (LAN):')}
                                            </div>
                                            <div className="settings-input-row" style={{ marginLeft: '14px', marginBottom: '8px' }}>
                                                <input type="text" value={primaryFeed} readOnly />
                                                <button className="btn btn-secondary" onClick={() => copyText(primaryFeed)}>
                                                    {t('copy', 'Kopieren')}
                                                </button>
                                            </div>

                                            <div style={{ marginLeft: '14px', marginBottom: '18px' }}>
                                                <button className="btn btn-secondary" onClick={() => setShowAllHeresphereUrls((v) => !v)}>
                                                    {showAllHeresphereUrls ? t('hideAdvancedUrls', 'Weitere URLs ausblenden') : t('showAdvancedUrls', 'Weitere URLs anzeigen')}
                                                </button>
                                            </div>

                                            {showAllHeresphereUrls && (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '18px', marginLeft: '14px' }}>
                                                    <div className="settings-input-row">
                                                        <input type="text" value={localhostFeed} readOnly />
                                                        <button className="btn btn-secondary" onClick={() => copyText(localhostFeed)}>
                                                            {t('copy', 'Kopieren')}
                                                        </button>
                                                    </div>
                                                    {lanFeeds.map((url) => (
                                                        <div className="settings-input-row" key={url}>
                                                            <input type="text" value={url} readOnly />
                                                            <button className="btn btn-secondary" onClick={() => copyText(url)}>
                                                                {t('copy', 'Kopieren')}
                                                            </button>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </>
                                    );
                                })()}
                            </>
                        )}

                        {showPlaybackPlayer && (
                            <>
                                <div className="settings-section-subtitle settings-playback-subtitle" style={{ marginTop: '8px' }}>{t('playbackPlayerTitle', 'Player')}</div>
                            <label style={{ display: 'block', marginBottom: '24px', marginTop: '12px', marginLeft: '14px' }}>
                        <span style={{ display: 'block', marginBottom: '6px', fontSize: '14px', color: 'var(--text-primary)' }}>{t('playerType', 'Player Typ')}</span>
                        <AppDropdown
                            value={settings.playerType || 'internal'}
                            onChange={(nextVal) => {
                                setSettings({ ...settings, playerType: nextVal });
                                handleSave({ playerType: nextVal });
                                const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, playerType: nextVal }));
                            }}
                            className="settings-playback-select settings-playback-select-main"
                            options={[
                                { value: 'internal', label: t('playerInternal', 'Nativer MPV Player (Heatmap, Subtitles)') },
                                { value: 'external', label: t('playerExternal', 'Externer System-Player (z.B. MPC-HC, VLC)') },
                            ]}
                        />
                            </label>

                            {isInternalPlayer && (
                        <div style={{ marginTop: '16px', marginLeft: '14px' }}>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                                {t('modernxThemeHint', 'Internes MPV-Theme (modernx):')}{' '}
                                <a
                                    href="https://github.com/cyl0/ModernX"
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                                >
                                    {t('modernxThemeLinkLabel', 'Zum GitHub-Repository')}
                                </a>
                            </div>
                            {/* Heatmap Toggle */}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                                <div>
                                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('heatmapToggle', 'Funscript Heatmap in Seekbar')}</div>
                                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{t('heatmapDesc', 'Zeigt Intensitaetsfarben in der Fortschrittsleiste')}</div>
                                </div>
                                <label className="settings-switch">
                                    <input
                                        type="checkbox"
                                        checked={settings.showHeatmap !== false}
                                        onChange={(e) => {
                                            const val = e.target.checked;
                                            const nextTimeline = val ? settings.showTimelineGraph === true : false;
                                            setSettings({ ...settings, showHeatmap: val, showTimelineGraph: nextTimeline });
                                            handleSave({ showHeatmap: val, showTimelineGraph: nextTimeline });
                                            const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                            localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, showHeatmap: val, showTimelineGraph: nextTimeline }));
                                        }}
                                    />
                                    <span className="settings-switch-track">
                                        <span className="settings-switch-thumb" />
                                    </span>
                                </label>
                            </div>
                            {settings.showHeatmap !== false && (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                                    <div>
                                        <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('timelineGraphToggle', 'Timeline Hover-Zoom')}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                            {settings.thumbfastEnabled === false
                                                ? t('timelineGraphDesc', 'Zeigt beim Hover auf der Seekbar einen gezoomten Linien-Ausschnitt des Funscripts')
                                                : t('timelineGraphDisabledByThumbnails', 'Wird deaktiviert, solange Seekbar Hover-Thumbnails aktiv sind.')}
                                        </div>
                                    </div>
                                    <label className="settings-switch">
                                        <input
                                            type="checkbox"
                                            checked={settings.showTimelineGraph === true}
                                            disabled={settings.thumbfastEnabled !== false}
                                            onChange={(e) => {
                                                const val = e.target.checked;
                                                setSettings({ ...settings, showTimelineGraph: val });
                                                handleSave({ showTimelineGraph: val });
                                                const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                                localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, showTimelineGraph: val }));
                                            }}
                                        />
                                        <span className="settings-switch-track">
                                            <span className="settings-switch-thumb" />
                                        </span>
                                    </label>
                                </div>
                            )}
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                                <div>
                                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>
                                        {t('playerSeekbarThumbnailToggle', 'Seekbar Hover Thumbnails')}
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                        {t('playerSeekbarThumbnailDesc', 'Shows frame thumbnails while hovering the player seekbar.')}
                                    </div>
                                </div>
                                <label className="settings-switch">
                                    <input
                                        type="checkbox"
                                        checked={settings.thumbfastEnabled !== false}
                                        onChange={(e) => {
                                            const val = e.target.checked;
                                            const nextTimeline = val ? false : settings.showTimelineGraph;
                                            setSettings({ ...settings, thumbfastEnabled: val, showTimelineGraph: nextTimeline });
                                            try {
                                                const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                                localStorage.setItem('glyph_settings', JSON.stringify({
                                                    ...currentLocal,
                                                    thumbfastEnabled: val,
                                                    showTimelineGraph: nextTimeline
                                                }));
                                            } catch { }
                                            handleSave({ thumbfastEnabled: val, showTimelineGraph: nextTimeline });
                                            window.dispatchEvent(new Event('glyph-settings-changed'));
                                        }}
                                    />
                                    <span className="settings-switch-track">
                                        <span className="settings-switch-thumb" />
                                    </span>
                                </label>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                                <div>
                                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>
                                        {t('playerAutoFullscreenToggle', 'Auto fullscreen')}
                                    </div>
                                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                                        {t('playerAutoFullscreenDesc', 'Starts the internal MPV player directly in fullscreen mode.')}
                                    </div>
                                </div>
                                <label className="settings-switch">
                                    <input
                                        type="checkbox"
                                        checked={settings.playerAutoFullscreen === true}
                                        onChange={(e) => {
                                            const val = e.target.checked;
                                            setSettings({ ...settings, playerAutoFullscreen: val });
                                            try {
                                                const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                                localStorage.setItem('glyph_settings', JSON.stringify({
                                                    ...currentLocal,
                                                    playerAutoFullscreen: val,
                                                }));
                                            } catch { }
                                            handleSave({ playerAutoFullscreen: val });
                                            window.dispatchEvent(new Event('glyph-settings-changed'));
                                        }}
                                    />
                                    <span className="settings-switch-track">
                                        <span className="settings-switch-thumb" />
                                    </span>
                                </label>
                            </div>
                            <div className="settings-section-subtitle" style={{ marginTop: '16px' }}>{t('subtitleSettings', 'UNTERTITEL / SUBTITLES')}</div>
                            <div className="theme-color-row" style={{ marginTop: '12px', display: 'grid', gap: '14px' }}>
                                <label style={{ maxWidth: '640px' }}>
                                    <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subFontFamily', 'Schriftart')}</span>
                                    <AppDropdown
                                        value={subtitleStyles?.fontFamily || systemFonts[0] || 'Arial'}
                                        onChange={(val) => updateSubtitleStyles({ fontFamily: val })}
                                        className="settings-playback-select settings-playback-font-select"
                                        options={systemFonts.map((font) => ({ value: font, label: font }))}
                                    />
                                </label>
                                <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                                    <label>
                                    <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subFontSize', 'Schriftgroesse')}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
                                        <input
                                            type="range"
                                            min="12"
                                            max="64"
                                            value={Math.max(12, Math.min(64, Number.parseInt(subtitleStyles?.fontSize || '24', 10) || 24))}
                                            onChange={(e) => {
                                                const px = Math.max(12, Math.min(64, Number(e.target.value)));
                                                updateSubtitleStyles({ fontSize: `${px}px` });
                                            }}
                                            className="settings-playback-range"
                                        />
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                                            {Math.max(12, Math.min(64, Number.parseInt(subtitleStyles?.fontSize || '24', 10) || 24))}px
                                        </span>
                                    </div>
                                </label>
                                <label>
                                    <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subOutlineWidth', 'Konturstarke')}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
                                        <input
                                            type="range"
                                            min="0"
                                            max="6"
                                            value={Math.max(0, Math.min(6, Number(subtitleStyles?.outlineWidth ?? 2)))}
                                            onChange={(e) => {
                                                const px = Math.max(0, Math.min(6, Number(e.target.value)));
                                                updateSubtitleStyles({ outlineWidth: px });
                                            }}
                                            className="settings-playback-range"
                                        />
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                                            {Math.max(0, Math.min(6, Number(subtitleStyles?.outlineWidth ?? 2)))}px
                                        </span>
                                    </div>
                                </label>
                                <label>
                                    <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subPositionY', 'Position (Unten Offset)')}</span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0' }}>
                                        <input
                                            type="range"
                                            min="0"
                                            max="150"
                                            value={Math.max(0, Math.min(150, Number(subtitleStyles?.marginBottom ?? 20)))}
                                            onChange={(e) => {
                                                updateSubtitleStyles({ marginBottom: Math.max(0, Math.min(150, Number(e.target.value))) });
                                            }}
                                            className="settings-playback-range"
                                        />
                                        <span style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{Math.max(0, Math.min(150, Number(subtitleStyles?.marginBottom ?? 20)))}px</span>
                                    </div>
                                </label>
                                </div>

                                <div style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                                    <label>
                                        <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subColor', 'Textfarbe')}</span>
                                        <div className="theme-color-input" style={{ width: '140px' }}>
                                            <input
                                                type="color"
                                                value={subtitleStyles?.color || '#ffffff'}
                                                onChange={(e) => updateSubtitleStyles({ color: e.target.value })}
                                            />
                                            <span className="color-hex">{subtitleStyles?.color || '#ffffff'}</span>
                                        </div>
                                    </label>
                                    <label>
                                        <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subOutlineColor', 'Konturfarbe')}</span>
                                        <div className="theme-color-input" style={{ width: '140px' }}>
                                            <input
                                                type="color"
                                                value={subtitleStyles?.outlineColor || '#000000'}
                                                onChange={(e) => updateSubtitleStyles({ outlineColor: e.target.value })}
                                            />
                                            <span className="color-hex">{subtitleStyles?.outlineColor || '#000000'}</span>
                                        </div>
                                    </label>
                                    <label>
                                        <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: 'var(--text-secondary)' }}>{t('subBackground', 'Hintergrund')}</span>
                                        <AppDropdown
                                            value={subtitleStyles?.background || 'rgba(0,0,0,0.5)'}
                                            onChange={(val) => updateSubtitleStyles({ background: val })}
                                            className="settings-playback-select"
                                            options={[
                                                { value: 'transparent', label: t('bgTransparent', 'Transparent') },
                                                { value: 'rgba(0,0,0,0.5)', label: t('bgSemiDark', 'Halbtransparent') },
                                                { value: 'rgba(0,0,0,0.8)', label: t('bgDark', 'Dunkel') },
                                            ]}
                                        />
                                    </label>
                                </div>
                            </div>
                            <div className="settings-playback-preview">
                                <div className="settings-playback-preview-label">{t('subPreview', 'Live Vorschau')}</div>
                                <div className="settings-playback-preview-stage">
                                    <div
                                        className="settings-playback-preview-cue"
                                        style={{
                                            fontSize: subtitleStyles?.fontSize || '24px',
                                            color: subtitleStyles?.color || '#ffffff',
                                            background: subtitleStyles?.background || 'rgba(0,0,0,0.5)',
                                            fontFamily: subtitleStyles?.fontFamily || 'inherit',
                                            textShadow: (() => {
                                                const w = Math.max(0, Math.min(6, Number(subtitleStyles?.outlineWidth ?? 2)));
                                                if (w <= 0) return 'none';
                                                const c = subtitleStyles?.outlineColor || '#000000';
                                                const shadows = [];
                                                for (let r = 1; r <= w; r += 1) {
                                                    const step = r <= 2 ? 24 : 16;
                                                    for (let a = 0; a < 360; a += step) {
                                                        const rad = (a * Math.PI) / 180;
                                                        const x = Math.round(Math.cos(rad) * r * 100) / 100;
                                                        const y = Math.round(Math.sin(rad) * r * 100) / 100;
                                                        shadows.push(`${x}px ${y}px 0 ${c}`);
                                                    }
                                                }
                                                return shadows.join(', ');
                                            })(),
                                            transform: 'translate(-50%, 0)',
                                        }}
                                    >
                                        {t('subPreviewText', 'Dies ist eine Subtitle-Vorschau')}
                                    </div>
                                </div>
                            </div>
                        </div>
                            )}
                            </>
                        )}
                    </div>
                </div>
            );
        }

        if (activePanel === 'hotkeys') {
            const navigationActions = hotkeyActions.filter((a) => a.category === 'navigation');
            const uiActions = hotkeyActions.filter((a) => a.category === 'ui');
            const managerActions = hotkeyActions.filter((a) => a.category === 'manager');
            const renderActionRow = (action) => {
                const binding = hotkeys[action.id];
                const isCapturing = capturingHotkeyAction === action.id;
                const hasConflict = hotkeyConflicts.has(action.id);
                return (
                    <div key={action.id} className={`settings-hotkey-row ${hasConflict ? 'has-conflict' : ''}`}>
                        <div className="settings-hotkey-main">
                            <div className="settings-hotkey-name">{action.label}</div>
                            {hasConflict && (
                                <div className="settings-hotkey-hint">{t('hotkeyConflict', 'Conflict: same shortcut used multiple times')}</div>
                            )}
                        </div>
                        <div className="settings-hotkey-actions">
                            <label className="settings-switch" title={t('hotkeyEnabled', 'Enable this hotkey')}>
                                <input
                                    type="checkbox"
                                    checked={binding?.enabled !== false}
                                    onChange={async (e) => {
                                        const enabled = e.target.checked;
                                        const next = { ...hotkeys, [action.id]: { ...(binding || {}), enabled } };
                                        await saveHotkeys(next);
                                    }}
                                />
                                <span className="settings-switch-track">
                                    <span className="settings-switch-thumb" />
                                </span>
                            </label>
                            <button
                                type="button"
                                className={`btn btn-secondary settings-hotkey-binding ${isCapturing ? 'is-capturing' : ''}`}
                                onClick={() => setCapturingHotkeyAction(isCapturing ? '' : action.id)}
                                disabled={binding?.enabled === false}
                            >
                                {isCapturing ? t('hotkeyPressNow', 'Press shortcut...') : hotkeyToLabel(binding)}
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={() => resetHotkeyAction(action.id)}>
                                {t('reset', 'Reset')}
                            </button>
                        </div>
                    </div>
                );
            };

            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('hotkeysTitle', 'Hotkeys')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('hotkeysHint', 'Set keyboard shortcuts for player and script controls.')}
                    </p>
                    <div className="settings-section-subtitle">{t('hotkeyCategoryNavigation', 'Navigation')}</div>
                    <div className="settings-hotkey-list">
                        {navigationActions.map(renderActionRow)}
                    </div>
                    <div className="settings-section-subtitle" style={{ marginTop: '14px' }}>{t('hotkeyCategoryUi', 'UI')}</div>
                    <div className="settings-hotkey-list">
                        {uiActions.map(renderActionRow)}
                    </div>
                    <div className="settings-section-subtitle" style={{ marginTop: '14px' }}>{t('hotkeyCategoryManager', 'Managers')}</div>
                    <div className="settings-hotkey-list">
                        {managerActions.map(renderActionRow)}
                    </div>
                    <div className="settings-section-subtitle" style={{ marginTop: '14px' }}>{t('hotkeyCategorySelection', 'Selection')}</div>
                    <div className="settings-hotkey-list">
                        <div className="settings-hotkey-row">
                            <div className="settings-hotkey-main">
                                <div className="settings-hotkey-name">{t('hotkeySelectAllVisible', 'Select/Deselect all visible items')}</div>
                            </div>
                            <div className="settings-hotkey-actions">
                                <button type="button" className="btn btn-secondary settings-hotkey-binding" disabled>
                                    {t('hotkeySelectAllVisibleBinding', 'Ctrl/Cmd + A')}
                                </button>
                            </div>
                        </div>
                        <div className="settings-hotkey-row">
                            <div className="settings-hotkey-main">
                                <div className="settings-hotkey-name">{t('hotkeyClearSelection', 'Clear current selection')}</div>
                            </div>
                            <div className="settings-hotkey-actions">
                                <button type="button" className="btn btn-secondary settings-hotkey-binding" disabled>
                                    {t('hotkeyClearSelectionBinding', 'Esc')}
                                </button>
                            </div>
                        </div>
                        <div className="settings-hotkey-row">
                            <div className="settings-hotkey-main">
                                <div className="settings-hotkey-name">{t('hotkeyRangeSelect', 'Range select from last anchor')}</div>
                            </div>
                            <div className="settings-hotkey-actions">
                                <button type="button" className="btn btn-secondary settings-hotkey-binding" disabled>
                                    {t('hotkeyRangeSelectBinding', 'Shift + Click')}
                                </button>
                            </div>
                        </div>
                    </div>
                    <div style={{ marginTop: '14px' }}>
                        <button type="button" className="btn btn-secondary" onClick={resetAllHotkeys}>
                            {t('hotkeyResetAll', 'Reset all to defaults')}
                        </button>
                    </div>
                </div>
            );
        }

        if (activePanel === 'browsing') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('browsingTitle', 'Browsing / Vorschau')}</div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px', marginBottom: '10px' }}>
                        <div>
                            <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('thumbnailHeatmapDetailToggle', 'Show heatmap on thumbnails')}</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{t('thumbnailHeatmapDetailDesc', 'Displays the detailed funscript heatmap under video thumbnails in the browser')}</div>
                        </div>
                        <label className="settings-switch">
                            <input
                                type="checkbox"
                                checked={settings.showThumbnailHeatmap !== false}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setSettings({ ...settings, showThumbnailHeatmap: val });
                                    const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                    localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, showThumbnailHeatmap: val }));
                                    window.dispatchEvent(new Event('glyph-settings-changed'));
                                }}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                        <div>
                            <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('hoverPreviewToggle', 'Thumbnail Hover-Preview')}</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{t('hoverPreviewDesc', 'Zeigt beim Hover eine kurze Video-Vorschau (wird bei Bedarf erzeugt)')}</div>
                        </div>
                        <label className="settings-switch">
                            <input
                                type="checkbox"
                                checked={settings.hoverPreviewEnabled === true}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setSettings({ ...settings, hoverPreviewEnabled: val });
                                    try {
                                        const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                        localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, hoverPreviewEnabled: val }));
                                    } catch { }
                                    window.dispatchEvent(new CustomEvent('glyph-settings-changed', {
                                        detail: { hoverPreviewEnabled: val },
                                    }));
                                }}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px', marginBottom: '4px' }}>
                        <div>
                            <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 500 }}>{t('showPerformerChipsToggle', 'Show performers on video cards')}</div>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{t('showPerformerChipsDesc', 'Displays fetched performer names as chips on video thumbnails/cards')}</div>
                        </div>
                        <label className="settings-switch">
                            <input
                                type="checkbox"
                                checked={settings.showPerformerChips !== false}
                                onChange={(e) => {
                                    const val = e.target.checked;
                                    setSettings({ ...settings, showPerformerChips: val });
                                    try {
                                        const currentLocal = JSON.parse(localStorage.getItem('glyph_settings') || '{}');
                                        localStorage.setItem('glyph_settings', JSON.stringify({ ...currentLocal, showPerformerChips: val }));
                                    } catch { }
                                    window.dispatchEvent(new Event('glyph-settings-changed'));
                                }}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                    </div>

                    <div style={{ marginTop: 28 }}>
                        <div className="settings-section-title">{t('sidebarConfigTitle', 'Sidebar Filter Groups')}</div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 12 }}>
                            {t('sidebarConfigDesc', 'Choose which filter groups are shown in the library sidebar.')}
                        </div>
                        {[
                            { key: 'favorites', label: t('favorites', 'Favoriten') },
                            { key: 'funscript', label: 'Funscript / Multi-Axis' },
                            { key: 'audio', label: t('audioTracks', 'Audio') },
                            { key: 'format', label: t('format', 'Format') },
                            { key: 'vrProjection', label: t('vrProjection', 'VR Projektion') },
                            { key: 'vrStereo', label: t('vrStereo', 'VR Stereo') },
                            { key: 'tags', label: t('tagsTitle', 'Tags') },
                        ].map(group => {
                            const sidebarCfg = (() => { try { return { favorites: true, funscript: true, audio: true, format: true, vrProjection: true, vrStereo: true, tags: true, ...JSON.parse(localStorage.getItem('glyph_sidebar_config') || '{}') }; } catch { return { favorites: true, funscript: true, audio: true, format: true, vrProjection: true, vrStereo: true, tags: true }; } })();
                            const checked = sidebarCfg[group.key] !== false;
                            return (
                                <div key={group.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                    <span style={{ fontSize: '14px', color: 'var(--text-primary)' }}>{group.label}</span>
                                    <label className="settings-switch">
                                        <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={(e) => {
                                                const val = e.target.checked;
                                                const current = (() => { try { return { favorites: true, funscript: true, audio: true, format: true, vrProjection: true, vrStereo: true, tags: true, ...JSON.parse(localStorage.getItem('glyph_sidebar_config') || '{}') }; } catch { return { favorites: true, funscript: true, audio: true, format: true, vrProjection: true, vrStereo: true, tags: true }; } })();
                                                current[group.key] = val;
                                                localStorage.setItem('glyph_sidebar_config', JSON.stringify(current));
                                                window.dispatchEvent(new Event('glyph-sidebar-config-changed'));
                                                setSettings(s => ({ ...s })); // force re-render
                                            }}
                                        />
                                        <span className="settings-switch-track">
                                            <span className="settings-switch-thumb" />
                                        </span>
                                    </label>
                                </div>
                            );
                        })}
                    </div>

                </div>
            );
        }

        if (activePanel === 'about') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('aboutTitle', 'About')}</div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '10px' }}>
                        {t('aboutCreatedBy', 'Created by Looney.')}
                    </p>
                    <div style={{ marginBottom: '12px' }}>
                        <img
                            src={ABOUT_PROFILE_IMAGE_PATH}
                            alt="Looney profile"
                            style={{
                                width: '84px',
                                height: '84px',
                                borderRadius: '9999px',
                                objectFit: 'cover',
                                border: '2px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle) 65%)',
                                boxShadow: '0 8px 20px rgba(0,0,0,0.12)',
                                background: 'var(--bg-card)',
                            }}
                        />
                    </div>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '10px' }}>
                        {t('version', 'Version')}: {appVersion || 'dev'}
                    </p>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '12px' }}>
                        {t('aboutSupportText', 'The software is free. If you want to support my work, you can support my Funscript work on Patreon.')}
                    </p>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
                        {t('aboutLegalNotice', 'No redistribution, rebranding, or republishing of modified versions without explicit permission.')}
                    </p>
                    <div className="settings-input-row">
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={async () => {
                                const url = 'https://www.patreon.com/c/LooneyScripts';
                                const ok = await window.electronAPI?.openExternalUrl?.(url).catch(() => false);
                                if (!ok) window.open(url, '_blank', 'noopener,noreferrer');
                            }}
                        >
                            {t('aboutPatreonLabel', 'Open Patreon')}
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={async () => {
                                const url = 'https://discuss.eroscripts.com/u/looney/summary';
                                const ok = await window.electronAPI?.openExternalUrl?.(url).catch(() => false);
                                if (!ok) window.open(url, '_blank', 'noopener,noreferrer');
                            }}
                        >
                            {t('aboutEroscriptsLabel', 'Open EroScripts')}
                        </button>
                    </div>
                </div>
            );
        }

        if (activePanel === 'backup') {
            return (
                <div className="settings-section">
                    <div className="settings-section-title">{t('storageTitle', 'Storage')}</div>
                    {activeStorageSubpanel === 'backup' && (
                        <>
                            <div className="settings-section-subtitle" style={{ marginBottom: '8px' }}>{t('backupSectionTitle', 'Backup')}</div>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '8px' }}>
                                {t('backupHint', 'Sichert und stellt die komplette Datenbank (Tags, Playlists, Zuordnungen, Verlauf) wieder her.')}
                            </p>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '8px' }}>
                                {t('backupPathWarning', 'Hinweis: Dateipfade (z.B. Laufwerke/Ordner) sollten auf dem Zielsystem gleich sein, sonst werden Medien als fehlend angezeigt.')}
                            </p>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
                                {t('backupMissingMediaInfo', 'Fehlende Medien-Eintraege bleiben erhalten und koennen nach Pfadkorrektur/Scan wieder aufgeloest werden.')}
                            </p>
                            <div className="settings-input-row" style={{ marginBottom: '10px', alignItems: 'center' }}>
                                <div style={{ minWidth: 160, color: 'var(--text-secondary)', fontSize: '12px' }}>
                                    {t('autoBackupSchedule', 'Automatisches Backup')}
                                </div>
                                <AppDropdown
                                    className="settings-playback-select"
                                    value={String(settings.backupSchedule || 'none')}
                                    onChange={(val) => {
                                        const next = String(val || 'none');
                                        setSettings((prev) => ({ ...prev, backupSchedule: next }));
                                        handleSave({ backupSchedule: next });
                                    }}
                                    options={[
                                        { value: 'none', label: t('backupScheduleNone', 'Keins') },
                                        { value: 'daily', label: t('backupScheduleDaily', 'Taeglich') },
                                        { value: 'weekly', label: t('backupScheduleWeekly', 'Woechentlich') },
                                        { value: 'monthly', label: t('backupScheduleMonthly', 'Monatlich') },
                                    ]}
                                />
                            </div>
                            <div className="settings-input-row" style={{ marginBottom: '10px', alignItems: 'center' }}>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: 4 }}>
                                        {t('backupPathLabel', 'Backup path')}
                                    </div>
                                    <div title={backupDir} style={{ color: 'var(--text-primary)', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {backupDir || '-'}
                                    </div>
                                </div>
                                <button
                                    className="btn btn-secondary"
                                    disabled={!backupDir}
                                    onClick={async () => {
                                        if (!window.electronAPI?.openPath) {
                                            showToast(t('openFolderUnavailable', 'Ordner oeffnen ist nur in der Desktop-App verfuegbar'), 'error');
                                            return;
                                        }
                                        const ok = await window.electronAPI.openPath(backupDir).catch(() => false);
                                        if (!ok) showToast(t('openFolderFailed', 'Ordner konnte nicht geoeffnet werden'), 'error');
                                    }}
                                >
                                    {t('openBackupFolder', 'Ordner oeffnen')}
                                </button>
                            </div>
                            <div className="settings-input-row" style={{ marginBottom: '10px' }}>
                                <button className="btn btn-primary" onClick={createBackup} disabled={backupBusy === 'create'}>
                                    {backupBusy === 'create' ? t('saving', 'Speichere...') : t('createBackup', 'Backup erstellen')}
                                </button>
                                <button className="btn btn-secondary" onClick={loadBackups} disabled={backupLoading || !!backupBusy}>
                                    {t('refresh', 'Aktualisieren')}
                                </button>
                            </div>
                            <div className="settings-hotkey-list">
                                {backupLoading ? (
                                    <div className="tag-empty">{t('loadingLoad', 'Lade...')}</div>
                                ) : backupEntries.length === 0 ? (
                                    <div className="tag-empty">{t('noBackupsYet', 'Noch keine Backups')}</div>
                                ) : backupEntries.map((entry) => {
                                    const fileName = String(entry?.fileName || '');
                                    const busyRestore = backupBusy === `restore:${fileName}`;
                                    const busyDelete = backupBusy === `delete:${fileName}`;
                                    const sizeMb = (Number(entry?.size || 0) / (1024 * 1024)).toFixed(2);
                                    return (
                                        <div key={fileName} className="settings-hotkey-row">
                                            <div className="settings-hotkey-main">
                                                <div className="settings-hotkey-name">{fileName}</div>
                                                <div className="settings-hotkey-hint">{sizeMb} MB | {new Date(Number(entry?.modifiedAt || 0)).toLocaleString()}</div>
                                            </div>
                                            <div className="settings-hotkey-actions">
                                                <button
                                                    className="btn btn-secondary"
                                                    disabled={!!backupBusy}
                                                    onClick={() => setBackupConfirmDialog({
                                                        type: 'restore',
                                                        fileName,
                                                        title: t('restoreBackup', 'Backup wiederherstellen'),
                                                        message: t('restoreBackupConfirm', 'Backup wirklich wiederherstellen? Vorher wird automatisch ein Sicherheits-Backup erstellt.'),
                                                        confirmLabel: t('restore', 'Wiederherstellen'),
                                                        danger: false,
                                                    })}
                                                >
                                                    {busyRestore ? t('saving', 'Speichere...') : t('restore', 'Wiederherstellen')}
                                                </button>
                                                <button
                                                    className="btn btn-danger"
                                                    disabled={!!backupBusy}
                                                    onClick={() => setBackupConfirmDialog({
                                                        type: 'delete',
                                                        fileName,
                                                        title: t('delete', 'Loeschen'),
                                                        message: `${t('deleteBackupConfirm', 'Backup loeschen?')}\n${fileName}`,
                                                        confirmLabel: t('delete', 'Loeschen'),
                                                        danger: true,
                                                    })}
                                                >
                                                    {busyDelete ? t('saving', 'Speichere...') : t('delete', 'Loeschen')}
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                    {activeStorageSubpanel === 'server' && (
                        <>
                            <div className="settings-section-subtitle" style={{ marginBottom: '8px' }}>{t('serverStorageSectionTitle', 'Server Storage')}</div>
                            <div className="settings-input-row" style={{ marginBottom: '8px', alignItems: 'center' }}>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: 4 }}>
                                        {t('serverDataPathLabel', 'Server data path')}
                                    </div>
                                    <div title={serverDataDir || '-'} style={{ color: 'var(--text-primary)', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {serverDataDir || '-'}
                                    </div>
                                </div>
                            </div>
                            <div className="settings-input-row" style={{ marginBottom: '10px', alignItems: 'center' }}>
                                <input
                                    type="text"
                                    className="settings-input"
                                    value={pendingServerDataDir}
                                    onChange={(e) => setPendingServerDataDir(e.target.value)}
                                    placeholder={t('serverDataPathPlaceholder', 'Select server data folder...')}
                                />
                                <button className="btn btn-secondary" onClick={chooseServerDataDir} disabled={dataDirBusy}>
                                    {t('chooseFolder', 'Choose folder')}
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={applyServerDataDir}
                                    disabled={dataDirBusy || !pendingServerDataDir.trim() || pendingServerDataDir.trim() === String(serverDataDir || '').trim()}
                                >
                                    {dataDirBusy ? t('saving', 'Speichere...') : t('apply', 'Apply')}
                                </button>
                            </div>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
                                {t('serverDataPathHint', 'All generated files (thumbnails, previews, posters, backups, database) are stored here. Changes require a server restart.')}
                            </p>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '12px', marginBottom: '12px' }}>
                                {t('serverDataPathMoveHint', 'On apply, Glyph copies existing server data to the new folder and keeps the old folder unchanged. If media paths differ on another system, entries can appear as missing until paths/scan are corrected.')}
                            </p>
                        </>
                    )}
                </div>
            );
        }

        return null;

    };

    return (
        <div className="settings-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t('settingsTitle', 'Einstellungen')}</h1>
                    <p className="page-subtitle">{t('settingsSubtitle', 'Bibliotheken, Metadaten und Darstellung konfigurieren')}</p>
                </div>
            </div>

            <div className="settings-shell">
                <aside className="settings-nav">
                    {panels.map(panel => (
                        <React.Fragment key={panel.id}>
                            <button
                                className={`settings-nav-item ${activePanel === panel.id ? 'active' : ''}`}
                                onClick={() => {
                                    setActivePanel(panel.id);
                                    if (panel.id === 'playback' && !activePlaybackSubpanel) {
                                        setActivePlaybackSubpanel('general');
                                    }
                                    if (panel.id === 'backup' && !activeStorageSubpanel) {
                                        setActiveStorageSubpanel('backup');
                                    }
                                }}
                            >
                                <span className="settings-nav-icon">{renderPanelIcon(panel.id)}</span>
                                {panel.label}
                            </button>
                            {panel.id === 'playback' && activePanel === 'playback' && (
                                <div className="settings-nav-sublist">
                                    {playbackSubpanels.map((sub) => (
                                        <button
                                            key={sub.id}
                                            className={`settings-nav-subitem ${activePlaybackSubpanel === sub.id ? 'active' : ''}`}
                                            onClick={() => {
                                                setActivePanel('playback');
                                                setActivePlaybackSubpanel(sub.id);
                                            }}
                                        >
                                            {sub.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {panel.id === 'backup' && activePanel === 'backup' && (
                                <div className="settings-nav-sublist">
                                    {storageSubpanels.map((sub) => (
                                        <button
                                            key={sub.id}
                                            className={`settings-nav-subitem ${activeStorageSubpanel === sub.id ? 'active' : ''}`}
                                            onClick={() => {
                                                setActivePanel('backup');
                                                setActiveStorageSubpanel(sub.id);
                                            }}
                                        >
                                            {sub.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </React.Fragment>
                    ))}
                </aside>
                <div className="settings-content">
                    {renderPanel()}
                </div>
            </div>

            {removeLibraryDialog && (
                <div className="modal-overlay" onClick={closeRemoveLibraryDialog}>
                    <div className="modal playlist-manage-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{t('removeLibraryTitle', 'Bibliothek entfernen')}</h2>
                            <button className="modal-close" onClick={closeRemoveLibraryDialog} aria-label={t('close', 'SchlieÃŸen')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '13px' }}>
                                {t('removeLibraryConfirm', 'MÃ¶chtest du diese Bibliothek wirklich entfernen?')}
                            </p>
                            <p style={{ margin: '8px 0 0', color: 'var(--text-primary)', fontSize: '13px', fontWeight: 600 }}>
                                {removeLibraryDialog.name}
                            </p>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '14px', gap: '12px' }}>
                                <span style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                                    {t('removeLibraryDeleteGenerated', 'Auch generierte Dateien lÃ¶schen (Thumbnails, Previews, Poster)')}
                                </span>
                                <label className="settings-switch" title={t('removeLibraryDeleteGenerated', 'Auch generierte Dateien lÃ¶schen (Thumbnails, Previews, Poster)')}>
                                    <input
                                        type="checkbox"
                                        checked={removeLibraryDeleteGenerated}
                                        onChange={(e) => setRemoveLibraryDeleteGenerated(e.target.checked)}
                                    />
                                    <span className="settings-switch-track">
                                        <span className="settings-switch-thumb" />
                                    </span>
                                </label>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={closeRemoveLibraryDialog}>
                                {t('cancel', 'Abbrechen')}
                            </button>
                            <button className="btn btn-danger" onClick={confirmRemoveLibrary}>
                                {t('remove', 'Entfernen')}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {backupConfirmDialog && (
                <div className="modal-overlay" onClick={() => setBackupConfirmDialog(null)}>
                    <div className="modal playlist-manage-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{backupConfirmDialog.title}</h2>
                            <button className="modal-close" onClick={() => setBackupConfirmDialog(null)} aria-label={t('close', 'SchlieÃŸen')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '13px', whiteSpace: 'pre-line' }}>
                                {backupConfirmDialog.message}
                            </p>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setBackupConfirmDialog(null)}>
                                {t('cancel', 'Abbrechen')}
                            </button>
                            <button
                                className={`btn ${backupConfirmDialog.danger ? 'btn-danger' : 'btn-primary'}`}
                                onClick={async () => {
                                    const payload = backupConfirmDialog;
                                    setBackupConfirmDialog(null);
                                    if (payload.type === 'restore') await restoreBackup(payload.fileName);
                                    if (payload.type === 'delete') await deleteBackup(payload.fileName);
                                }}
                            >
                                {backupConfirmDialog.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default Settings;











































