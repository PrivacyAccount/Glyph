/**
 * mpvController.js — Controls mpv via JSON IPC over Windows named pipe.
 *
 * Spawns mpv.exe from vendor/mpv/ with --wid=<HWND> to embed video rendering
 * into the Electron BrowserWindow. All commands are sent via the named pipe
 * \\.\pipe\glyph-mpv-ipc using mpv's JSON IPC protocol.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

function getIpcEndpoint() {
    if (process.platform === 'win32') return '\\\\.\\pipe\\glyph-mpv-ipc';
    return path.join(os.tmpdir(), 'glyph-mpv-ipc.sock');
}

class MpvController {
    constructor() {
        this.process = null;
        this.socket = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.eventCallback = null;
        this._buffer = '';
        this._destroyed = false;
        this._playlistTempPath = null;
        this.ipcEndpoint = getIpcEndpoint();
    }

    _resolveSystemBinary(name) {
        const bin = String(name || '').trim();
        if (!bin) return null;
        const isWin = process.platform === 'win32';
        const cmd = isWin ? 'where' : 'which';
        try {
            const probe = spawnSync(cmd, [bin], { stdio: 'pipe', encoding: 'utf8' });
            const out = String(probe?.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            if (probe && probe.status === 0 && out.length > 0) {
                return out[0];
            }
        } catch { }
        if (process.platform === 'darwin') {
            const candidates = [
                `/opt/homebrew/bin/${bin}`,
                `/usr/local/bin/${bin}`,
                `/opt/local/bin/${bin}`,
            ];
            for (const p of candidates) {
                try {
                    if (fs.existsSync(p)) return p;
                } catch { }
            }
        }
        return null;
    }

    _getAssetsDir() {
        const candidates = [
            // Development
            path.join(__dirname, '..', 'vendor', 'mpv'),
            // Packaged
            path.join(process.resourcesPath || '', 'vendor', 'mpv'),
        ];
        for (const p of candidates) {
            try {
                if (fs.existsSync(p)) return p;
            } catch { }
        }
        return null;
    }

    /**
     * Resolve the path to the bundled mpv.exe
     */
    _getEmbedWindowId(mainWindow) {
        try {
            if (!mainWindow || mainWindow.isDestroyed()) return null;
            const hwnd = mainWindow.getNativeWindowHandle();
            if (!hwnd || hwnd.length < 4) return null;
            return String(hwnd.readUInt32LE(0));
        } catch {
            return null;
        }
    }

    _getMpvPath() {
        // On macOS prefer system mpv (brew-installed) to avoid incompatibilities
        // with CI-copied binaries and missing runtime deps on user machines.
        if (process.platform === 'darwin') {
            const systemMpv = this._resolveSystemBinary('mpv');
            if (systemMpv) return systemMpv;
        }

        const assetsDir = this._getAssetsDir();
        const isWin = process.platform === 'win32';
        const bundledName = isWin ? 'mpv.exe' : 'mpv';

        if (assetsDir) {
            const bundledPath = path.join(assetsDir, bundledName);
            if (fs.existsSync(bundledPath)) return bundledPath;
        }

        // Fallback: system PATH
        const systemMpv = this._resolveSystemBinary('mpv');
        if (systemMpv) return systemMpv;
        return null;
    }

    /**
     * Start mpv and sync its window over the given Electron BrowserWindow.
     * @param {BrowserWindow} mainWindow - The Electron window to overlay
     * @param {string} filePath - Path to the video file to play
     * @param {object} [options] - Optional settings
     */
    async start(mainWindow, filePath, options = {}) {
        if (this.process) {
            await this.destroy();
        }
        this._destroyed = false;
        this.mainWindow = mainWindow;

        const mpvPath = this._getMpvPath();
        if (!mpvPath) {
            throw new Error('MPV binary not found. Install mpv or bundle it under vendor/mpv.');
        }
        const assetsDir = this._getAssetsDir();
        const thumbfastEnabled = options?.thumbfastEnabled !== false;

        // Get initial content bounds to set geometry
        const bounds = mainWindow.getBounds();

        const args = [
            '--no-config',
            '--osc=no',
            '--osd-level=1',
            '--cursor-autohide=1000',
            '--input-cursor=yes',
            '--keep-open=yes',
            '--idle=no',
            '--force-window=immediate',
            `--input-ipc-server=${this.ipcEndpoint}`,
            '--vo=gpu',
            '--gpu-context=auto',
            // macOS: disable hwdec to avoid black-screen regressions on some setups
            // (especially when MPV comes from Homebrew and app is unsigned/notarization-pending).
            process.platform === 'darwin' ? '--hwdec=no' : '--hwdec=auto-safe',
            '--hr-seek=yes',
            '--border=no',
            '--title-bar=no',
            '--ontop=no',
            `--geometry=${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`
        ];

        // On Unix sockets, remove stale endpoint from prior crashes.
        if (process.platform !== 'win32') {
            try {
                if (fs.existsSync(this.ipcEndpoint)) fs.unlinkSync(this.ipcEndpoint);
            } catch { }
        }

        if (assetsDir) {
            const modernxScript = path.join(assetsDir, 'scripts', 'modernx.lua');
            const vrScript = path.join(assetsDir, 'scripts', 'vr360.lua');
            const thumbfastScript = path.join(assetsDir, 'scripts', 'thumbfast.lua');
            const fontsDir = path.join(assetsDir, 'fonts');

            if (fs.existsSync(modernxScript)) args.push(`--script=${modernxScript}`);
            if (fs.existsSync(vrScript)) args.push(`--script=${vrScript}`);
            if (fs.existsSync(fontsDir)) {
                args.push(`--osd-fonts-dir=${fontsDir}`);
                args.push(`--sub-fonts-dir=${fontsDir}`);
            }
            if (thumbfastEnabled && fs.existsSync(thumbfastScript)) {
                args.push(`--script=${thumbfastScript}`);
            }
        }
        if (options?.autoFullscreen === true) {
            args.push('--fullscreen=yes');
        }

        // Use top-level frameless mpv window aligned to app bounds (stable on Windows).


        // Key bindings and mouse clicks
        args.push(
            '--input-default-bindings=yes'
        );

        // Subtitle Styles
        if (options.subtitleStyles) {
            const styles = options.subtitleStyles;
            const normalizedBackground = String(styles.background || '').trim().toLowerCase();
            const toAssColor = (hex, alphaHex = '00') => {
                const value = String(hex || '').trim();
                if (!/^#[0-9a-fA-F]{6}$/.test(value)) return null;
                const r = value.slice(1, 3).toUpperCase();
                const g = value.slice(3, 5).toUpperCase();
                const b = value.slice(5, 7).toUpperCase();
                return `&H${alphaHex}${b}${g}${r}&`; // ASS: AABBGGRR
            };
            const assParts = [];

            if (styles.color) {
                args.push(`--sub-color=${styles.color}`);
                const primary = toAssColor(styles.color, '00');
                if (primary) assParts.push(`PrimaryColour=${primary}`);
            }
            if (styles.fontSize) {
                args.push(`--sub-font-size=${parseInt(styles.fontSize, 10)}`);
            }
            if (styles.fontFamily) {
                args.push(`--sub-font=${styles.fontFamily}`);
            }
            if (styles.outlineWidth !== undefined) {
                const outline = Math.max(0, Number(styles.outlineWidth) || 0);
                assParts.push(`Outline=${outline}`);
                args.push(`--sub-border-size=${outline}`);
            }
            if (styles.outlineColor) {
                const outlineColor = toAssColor(styles.outlineColor, '00');
                if (outlineColor) assParts.push(`OutlineColour=${outlineColor}`);
                args.push(`--sub-border-color=${styles.outlineColor}`);
            }

            if (normalizedBackground === 'transparent') {
                args.push('--sub-border-style=outline-and-shadow');
                args.push('--sub-back-color=#00000000');
            } else if (normalizedBackground === 'rgba(0,0,0,0.8)') {
                args.push('--sub-border-style=background-box');
                args.push('--sub-back-color=#FF000000');
            } else {
                args.push('--sub-border-style=background-box');
                args.push('--sub-back-color=#80000000');
            }

            assParts.push('Shadow=0');
            if (assParts.length > 0) {
                args.push(`--sub-ass-force-style=${assParts.join(',')}`);
            }

            if (styles.marginBottom !== undefined) {
                // Map the 0-150px UI range to MPV's sub-pos percentage (100 = bottom, 50 = middle)
                const mb = parseInt(styles.marginBottom, 10) || 20;
                const pos = Math.max(0, Math.min(100, Math.round(100 - (mb / 3))));
                args.push(`--sub-pos=${pos}`);
            }
        }

        // Strip track ASS styling so subtitle options apply consistently.
        args.push('--sub-ass-override=strip');

        // Volume
        if (typeof options.volume === 'number') {
            args.push(`--volume=${Math.round(options.volume * 100)}`);
        }

        // Resume/start position (seconds) to avoid race conditions with post-load seek.
        if (typeof options.startSeconds === 'number' && Number.isFinite(options.startSeconds) && options.startSeconds > 0) {
            args.push(`--start=${Math.max(0, options.startSeconds)}`);
        }

        const playlistFiles = Array.isArray(options.playlistFiles)
            ? options.playlistFiles.filter((p) => typeof p === 'string' && p.trim().length > 0)
            : [];
        if (playlistFiles.length > 1) {
            let startIndex = Number.isInteger(options.playlistStartIndex) ? options.playlistStartIndex : 0;
            if (startIndex < 0) startIndex = 0;
            if (startIndex >= playlistFiles.length) startIndex = playlistFiles.length - 1;
            try {
                const tempName = `glyph-mpv-playlist-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.m3u8`;
                const tempPath = path.join(os.tmpdir(), tempName);
                fs.writeFileSync(tempPath, playlistFiles.join('\n'), 'utf8');
                this._playlistTempPath = tempPath;
                args.push(`--playlist=${tempPath}`);
                args.push(`--playlist-start=${startIndex}`);
            } catch (err) {
                console.warn('[mpv] Failed to write temp playlist file, falling back to single file:', err?.message || err);
                args.push(filePath);
            }
        } else {
            // Add the single file path
            args.push(filePath);
        }

        console.log(`[mpv] Starting (platform=${process.platform}, source=${mpvPath === 'mpv' ? 'system' : 'bundled'}): ${mpvPath} ${args.join(' ')}`);

        this.process = spawn(mpvPath, args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: (() => {
                const currentPath = String(process.env.PATH || '');
                const mpvDir = path.dirname(mpvPath);
                const sep = process.platform === 'win32' ? ';' : ':';
                return {
                    ...process.env,
                    PATH: currentPath
                        .split(sep)
                        .map((p) => String(p || '').trim())
                        .filter(Boolean)
                        .some((p) => p.toLowerCase() === mpvDir.toLowerCase())
                        ? currentPath
                        : `${mpvDir}${sep}${currentPath}`,
                };
            })(),
        });

        this.process.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.log(`[mpv stdout] ${msg}`);
        });

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.error(`[mpv stderr] ${msg}`);
        });

        this.process.on('exit', (code, signal) => {
            console.log(`[mpv] Process exited (code=${code}, signal=${signal || 'none'})`);
            this._cleanup();
            if (this.eventCallback && !this._destroyed) {
                this.eventCallback({ event: 'eof', reason: 'process-exit' });
            }
        });

        this.process.on('error', (err) => {
            console.error('[mpv] Process error:', err);
            this._cleanup();
        });

        // Wait for the IPC pipe to become available
        await this._connectPipe();

        // Observe properties for real-time updates
        await this._observeProperties();

        // Apply VR mode (optional)
        try {
            const vr = options && typeof options.vr === 'object' ? options.vr : null;
            if (vr && vr.enabled) {
                const projection = String(vr.projection || '360');
                const stereo = String(vr.stereoMode || 'mono');
                const fov = Number(vr.fov);
                await this.scriptMessage('vr-set-enabled', '1');
                await this.scriptMessage('vr-set-mode', projection, stereo);
                if (Number.isFinite(fov)) await this.scriptMessage('vr-set-fov', String(fov));
            }
        } catch (err) {
            console.warn('[mpv] Failed to initialize VR mode:', err?.message || err);
        }

        // No separate overlay window tracking needed when embedded via --wid.
    }
    /**
     * Connect to mpv's named pipe IPC server with retry logic.

     */
    async _connectPipe(maxRetries = 30, retryDelayMs = 200) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this._tryConnect();
                console.log('[mpv] IPC pipe connected');
                return;
            } catch {
                if (this._destroyed || !this.process) return;
                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        }
        console.error('[mpv] Failed to connect to IPC pipe after retries');
        throw new Error('Failed to connect to mpv IPC pipe');
    }

    _tryConnect() {
        return new Promise((resolve, reject) => {
            const socket = process.platform === 'win32'
                ? net.connect(this.ipcEndpoint)
                : net.connect({ path: this.ipcEndpoint });
            socket.on('connect', () => {
                this.socket = socket;
                this._buffer = '';

                socket.on('data', (data) => this._handleData(data));
                socket.on('error', (err) => {
                    if (!this._destroyed) console.error('[mpv] IPC error:', err.message);
                });
                socket.on('close', () => {
                    this.socket = null;
                });

                resolve();
            });
            socket.on('error', (err) => {
                socket.destroy();
                reject(err);
            });
        });
    }

    /**
     * Handle incoming data from mpv IPC pipe (line-delimited JSON).
     */
    _handleData(data) {
        this._buffer += data.toString('utf8');
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const msg = JSON.parse(trimmed);

                // Response to a command
                if (msg.request_id !== undefined && this.pendingRequests.has(msg.request_id)) {
                    const { resolve, reject } = this.pendingRequests.get(msg.request_id);
                    this.pendingRequests.delete(msg.request_id);
                    if (msg.error && msg.error !== 'success') {
                        reject(new Error(msg.error));
                    } else {
                        resolve(msg.data);
                    }
                }

                // Event (property change, playback events, etc.)
                if (msg.event && this.eventCallback) {
                    this.eventCallback(msg);
                }
            } catch (err) {
                // Ignore malformed JSON
            }
        }
    }

    /**
     * Send a command to mpv via IPC and return a promise for the response.
     */
    _sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                reject(new Error('IPC not connected'));
                return;
            }

            const id = ++this.requestId;
            const payload = JSON.stringify({ command, request_id: id }) + '\n';

            this.pendingRequests.set(id, { resolve, reject });

            // Timeout after 5 seconds
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('IPC command timeout'));
                }
            }, 5000);

            const origResolve = resolve;
            const origReject = reject;
            this.pendingRequests.set(id, {
                resolve: (val) => { clearTimeout(timeout); origResolve(val); },
                reject: (err) => { clearTimeout(timeout); origReject(err); },
            });

            this.socket.write(payload);
        });
    }

    /**
     * Observe mpv properties for real-time updates.
     */
    async _observeProperties() {
        const props = ['time-pos', 'duration', 'pause', 'eof-reached', 'track-list', 'path'];
        for (let i = 0; i < props.length; i++) {
            try {
                await this._sendCommand(['observe_property', i + 1, props[i]]);
            } catch (err) {
                console.warn(`[mpv] Failed to observe ${props[i]}:`, err.message);
            }
        }
    }

    // ─── Public API ───

    /**
     * Send a generic mpv command.
     */
    async command(name, ...args) {
        return this._sendCommand([name, ...args]);
    }

    /**
     * Send a script-message to a Lua script.
     */
    async scriptMessage(...args) {
        return this._sendCommand(['script-message', ...args]);
    }

    /**
     * Get a property value from mpv.
     */
    async getProperty(name) {
        return this._sendCommand(['get_property', name]);
    }

    /**
     * Set a property value on mpv.
     */
    async setProperty(name, value) {
        return this._sendCommand(['set_property', name, value]);
    }

    /**
     * Load a file into mpv (replace current).
     */
    async loadFile(filePath) {
        return this._sendCommand(['loadfile', filePath, 'replace']);
    }

    /**
     * Toggle pause/play.
     */
    async togglePause() {
        return this._sendCommand(['cycle', 'pause']);
    }

    /**
     * Seek to an absolute time position (seconds).
     */
    async seek(timeSeconds) {
        return this._sendCommand(['seek', timeSeconds, 'absolute']);
    }

    /**
     * Set volume (0.0 - 1.0 scale, mapped to 0-100 for mpv).
     */
    async setVolume(vol) {
        return this.setProperty('volume', Math.round(vol * 100));
    }

    /**
     * Get the track list from mpv.
     * Returns an array of track objects with type, id, title, lang, etc.
     */
    async getTracks() {
        const trackList = await this.getProperty('track-list');
        if (!Array.isArray(trackList)) return { audio: [], sub: [] };

        const audio = trackList
            .filter(t => t.type === 'audio')
            .map(t => ({
                id: t.id,
                title: t.title || `Track ${t.id}`,
                language: t.lang || 'Unknown',
                codec: t.codec || '',
                isDefault: !!t.default,
                isSelected: !!t.selected,
            }));

        const sub = trackList
            .filter(t => t.type === 'sub')
            .map(t => ({
                id: t.id,
                title: t.title || `Track ${t.id}`,
                language: t.lang || 'Unknown',
                codec: t.codec || '',
                isDefault: !!t.default,
                isSelected: !!t.selected,
            }));

        return { audio, sub };
    }

    /**
     * Set the active audio track by mpv track ID.
     */
    async setAudioTrack(id) {
        return this.setProperty('aid', id);
    }

    /**
     * Set the active subtitle track by mpv track ID (false = off).
     */
    async setSubtitleTrack(id) {
        return this.setProperty('sid', id);
    }

    /**
     * Set playback event callback.
     */
    onEvent(callback) {
        this.eventCallback = callback;
    }

    /**
     * Check if mpv process is running.
     */
    isRunning() {
        return !!(this.process && !this.process.killed);
    }

    /**
     * Internal cleanup.
     */
    _cleanup() {
        if (this.mainWindow && this._boundsListener && !this.mainWindow.isDestroyed()) {
            this.mainWindow.off('resize', this._boundsListener);
            this.mainWindow.off('move', this._boundsListener);
        }
        this._boundsListener = null;
        this.mainWindow = null;

        if (this.socket) {
            try { this.socket.destroy(); } catch { }
            this.socket = null;
        }
        this.pendingRequests.forEach(({ reject }) => {
            try { reject(new Error('mpv destroyed')); } catch { }
        });
        this.pendingRequests.clear();
        if (this._playlistTempPath) {
            try { fs.unlinkSync(this._playlistTempPath); } catch { }
            this._playlistTempPath = null;
        }
        if (process.platform !== 'win32') {
            try {
                if (this.ipcEndpoint && fs.existsSync(this.ipcEndpoint)) fs.unlinkSync(this.ipcEndpoint);
            } catch { }
        }
        this.process = null;
    }

    /**
     * Stop playback and destroy the mpv process.
     */
    async destroy() {
        this._destroyed = true;
        const proc = this.process;

        if (this.socket && !this.socket.destroyed) {
            try {
                await this._sendCommand(['quit']).catch(() => { });
            } catch { }
        }

        if (proc && !proc.killed) {
            const waitForExit = (timeoutMs) => new Promise((resolve) => {
                let finished = false;
                const done = () => {
                    if (finished) return;
                    finished = true;
                    try { clearTimeout(timer); } catch { }
                    resolve();
                };
                const timer = setTimeout(done, timeoutMs);
                try { proc.once('exit', done); } catch { done(); }
            });

            // Give mpv a short chance to exit cleanly after quit IPC.
            await waitForExit(400);

            if (!proc.killed && proc.exitCode === null) {
                try { proc.kill('SIGTERM'); } catch { }
                await waitForExit(900);
            }

            if (!proc.killed && proc.exitCode === null) {
                try { proc.kill('SIGKILL'); } catch { }
                await waitForExit(600);
            }
        }

        this._cleanup();
    }
}

module.exports = MpvController;







