const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectImage: () => ipcRenderer.invoke('select-image'),
    selectFunscript: () => ipcRenderer.invoke('select-funscript'),
    selectExecutable: () => ipcRenderer.invoke('select-executable'),
    openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
    openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
    openVideo: (filePath) => ipcRenderer.invoke('open-video', filePath),
    openWithPlayer: (payload) => ipcRenderer.invoke('open-with-player', payload),
    openPlayerWindow: (payload) => ipcRenderer.invoke('open-player-window', payload),
    getPlayerLaunchContext: (payload) => ipcRenderer.invoke('get-player-launch-context', payload),
    windowMinimize: () => ipcRenderer.invoke('window-minimize'),
    windowToggleMaximize: () => ipcRenderer.invoke('window-toggle-maximize'),
    windowClose: () => ipcRenderer.invoke('window-close'),
    windowIsMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    hideMainWindowForPlayback: () => ipcRenderer.invoke('hide-main-window-for-playback'),
    getSystemFonts: () => ipcRenderer.invoke('get-system-fonts'),
    installSystemFont: () => ipcRenderer.invoke('install-system-font'),
    setTitlebarTheme: (theme) => ipcRenderer.invoke('set-titlebar-theme', theme),
    setServerAddress: (address) => ipcRenderer.invoke('set-server-address', address),
    rendererReady: () => ipcRenderer.send('renderer-ready'),
    emitDeviceSyncEvent: (payload) => ipcRenderer.send('relay-device-sync-event', payload),
    onDeviceSyncEvent: (callback) => {
        const handler = (_event, payload) => callback(payload || {});
        ipcRenderer.on('device-sync-event', handler);
        return () => ipcRenderer.removeListener('device-sync-event', handler);
    },
    onWindowMaximizedChange: (callback) => {
        const handler = (_event, isMaximized) => callback(!!isMaximized);
        ipcRenderer.on('window-maximized-changed', handler);
        return () => ipcRenderer.removeListener('window-maximized-changed', handler);
    },

    // MPV Player API
    mpvLoadFile: (filePath, options) => ipcRenderer.invoke('mpv-load-file', filePath, options),
    mpvCommand: (...args) => ipcRenderer.invoke('mpv-command', ...args),
    mpvGetProperty: (name) => ipcRenderer.invoke('mpv-get-property', name),
    mpvSetProperty: (name, value) => ipcRenderer.invoke('mpv-set-property', name, value),
    mpvTogglePause: () => ipcRenderer.invoke('mpv-toggle-pause'),
    mpvSeek: (timeSeconds) => ipcRenderer.invoke('mpv-seek', timeSeconds),
    mpvSetVolume: (vol) => ipcRenderer.invoke('mpv-set-volume', vol),
    mpvGetTracks: () => ipcRenderer.invoke('mpv-get-tracks'),
    mpvSetAudioTrack: (id) => ipcRenderer.invoke('mpv-set-audio-track', id),
    mpvSetSubtitleTrack: (id) => ipcRenderer.invoke('mpv-set-subtitle-track', id),
    mpvStop: () => ipcRenderer.invoke('mpv-stop'),
    mpvScriptMessage: (...args) => ipcRenderer.invoke('mpv-script-message', ...args),
    onMpvEvent: (callback) => {
        const handler = (_event, data) => callback(data);
        ipcRenderer.on('mpv-event', handler);
        return () => ipcRenderer.removeListener('mpv-event', handler);
    },
});
