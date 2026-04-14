const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const MpvController = require('./mpvController');

let mpv = new MpvController();
let glyphWindowIcon = null;
const embedServerDefault = '0';
const SHOULD_EMBED_SERVER = String(process.env.GLYPH_EMBED_SERVER || embedServerDefault).trim() !== '0';

function resolveGlyphWindowIcon() {
    const candidates = [
        app.isPackaged ? path.join(app.getAppPath(), 'src', 'assets', 'icons', 'glyph.ico') : null,
        path.join(__dirname, '..', 'src', 'assets', 'icons', 'glyph.ico'),
        path.join(__dirname, '..', 'src', 'assets', 'icons', 'glyph-mark.svg'),
        path.join(__dirname, 'assets', 'glyph-icon.png'),
        path.join(__dirname, 'assets', 'glyph-icon.ico'),
    ];
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const img = nativeImage.createFromPath(p);
            if (img && !img.isEmpty()) return img;
        } catch { }
    }
    return null;
}

// Only start the Express server if not already running externally
// (when launched via npm start, the server is started separately)
let embeddedServerProcess = null;

function spawnEmbeddedServer() {
    if (embeddedServerProcess) return;
    const serverEntry = path.join(__dirname, '..', 'server', 'server.js');
    const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
    console.log('Starting embedded Express server as child process...');
    embeddedServerProcess = spawn(nodeCmd, [serverEntry], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    embeddedServerProcess.stdout.on('data', (chunk) => {
        const msg = String(chunk || '').trim();
        if (msg) console.log(`[server] ${msg}`);
    });
    embeddedServerProcess.stderr.on('data', (chunk) => {
        const msg = String(chunk || '').trim();
        if (msg) console.error(`[server] ${msg}`);
    });
    embeddedServerProcess.on('exit', (code, signal) => {
        console.log(`Embedded server exited (code=${code}, signal=${signal || 'none'})`);
        embeddedServerProcess = null;
    });
    embeddedServerProcess.on('error', (err) => {
        console.error('Failed to start embedded server process:', err);
        embeddedServerProcess = null;
    });
}

const startServer = () => {
    if (!SHOULD_EMBED_SERVER) {
        console.log('Embedded server disabled (GLYPH_EMBED_SERVER=0). Expecting external server on :4000');
        return;
    }
    try {
        const http = require('http');
        const req = http.get('http://localhost:4000/api/settings', (res) => {
            console.log('Server already running on port 4000');
        });
        req.on('error', () => {
            spawnEmbeddedServer();
        });
        req.setTimeout(1000, () => {
            req.destroy();
            spawnEmbeddedServer();
        });
    } catch {
        spawnEmbeddedServer();
    }
};

// startServer(); // Will be called after splash screen

let mainWindow;
let splashWindow;
let mpvHostWindow = null;
let playerWindow = null;
let rendererBaseUrl = '';
let mpvClientWindow = null;
let playerLaunchContext = null;
let playerWindowCurrentVideoId = null;
let mpvLoadingFile = false;
let currentApiBase = 'http://localhost:4000';

function getServerAddressPath() {
    return path.join(app.getPath('userData'), 'server-address.json');
}

function loadServerAddress() {
    try {
        const data = JSON.parse(fs.readFileSync(getServerAddressPath(), 'utf8'));
        if (typeof data.address === 'string' && data.address.trim()) {
            return data.address.trim();
        }
    } catch { }
    return 'localhost:4000';
}

function saveServerAddress(address) {
    try {
        fs.writeFileSync(getServerAddressPath(), JSON.stringify({ address }), 'utf8');
    } catch (err) {
        console.error('Failed to save server address:', err);
    }
}
let mpvSessionId = 0;
let suppressNextMpvStopUntil = 0;

function restoreMainWindowAfterPlayback() {
    // No playback side-overlay mode anymore; keep this as safe no-op hook.
}

function syncMpvHostBounds() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mpvHostWindow || mpvHostWindow.isDestroyed()) return;
    const bounds = mainWindow.getContentBounds();
    mpvHostWindow.setBounds(bounds);
}

function ensureMpvHostWindow() {
    if (mpvHostWindow && !mpvHostWindow.isDestroyed()) return mpvHostWindow;
    if (!mainWindow || mainWindow.isDestroyed()) return null;

    const bounds = mainWindow.getContentBounds();
    mpvHostWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        parent: mainWindow,
        frame: false,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: '#000000',
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
        ...(glyphWindowIcon ? { icon: glyphWindowIcon } : {}),
    });
    if (glyphWindowIcon && process.platform === 'win32') {
        try { mpvHostWindow.setIcon(glyphWindowIcon); } catch { }
    }

    try { mpvHostWindow.loadURL('about:blank'); } catch { }
    mpvHostWindow.on('closed', () => { mpvHostWindow = null; });
    return mpvHostWindow;
}

function destroyMpvHostWindow() {
    if (!mpvHostWindow || mpvHostWindow.isDestroyed()) {
        mpvHostWindow = null;
        return;
    }
    try { mpvHostWindow.close(); } catch { }
    if (mpvHostWindow && !mpvHostWindow.isDestroyed()) {
        try { mpvHostWindow.destroy(); } catch { }
    }
    mpvHostWindow = null;
}

function normalizeThemeMode(mode) {
    return mode === 'modern' ? 'modern' : 'default';
}

function normalizeModernPalette(palette) {
    const valid = new Set(['silver', 'starlight', 'sky', 'lavender', 'copper']);
    return valid.has(palette) ? palette : 'silver';
}

function getServerDataCandidates() {
    try {
        if (process.platform === 'win32') {
            const appDataRoot = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
            return [
                path.join(appDataRoot, 'GlyphServer', 'data'),
                path.join(appDataRoot, 'Glyph Server', 'data'),
            ];
        }
    } catch { }
    return [path.join(__dirname, '..', 'server', 'data')];
}

const SUPPORTED_SPLASH_LANGS = new Set(['de', 'en', 'es', 'ja', 'ru', 'ko']);

function normalizeSplashLanguage(lang) {
    const raw = String(lang || '').toLowerCase();
    const base = raw.split(/[-_]/)[0];
    return SUPPORTED_SPLASH_LANGS.has(base) ? base : 'en';
}

function getSystemSplashLanguage() {
    try {
        return normalizeSplashLanguage(app.getLocale() || 'en');
    } catch {
        return 'en';
    }
}

function getInitialSplashLanguage() {
    let detected = getSystemSplashLanguage();
    const serverDataCandidates = getServerDataCandidates();
    try {
        const { DatabaseSync } = require('node:sqlite');
        for (const dirPath of serverDataCandidates) {
            const dbPath = path.join(dirPath, 'app.db');
            if (!fs.existsSync(dbPath)) continue;
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare(`SELECT language FROM settings WHERE id = 1`).get();
            try { db.close(); } catch { }
            if (row?.language) {
                detected = normalizeSplashLanguage(row.language);
            }
            break;
        }
    } catch { }
    return detected;
}

const SPLASH_TEXT = {
    de: {
        initializing: 'Initialisiere...',
        waitingDevServer: 'Warte auf Entwicklungsserver...',
        startingServer: 'Starte Server...',
        connectingExternalServer: 'Verbinde mit externem Server...',
        waitingServer: 'Warte auf Server-Antwort...',
        serverUnavailableExit: 'Server nicht erreichbar. Client wird beendet...',
        serverUnavailableOpenSettings: 'Server nicht erreichbar. Öffne Einstellungen...',
        checkingLibrary: 'Prüfe Bibliothek...',
        scanningLibrary: (s) => `Scanne Bibliothek... ${s}s`,
        loadingUi: 'Lade Oberfläche...',
        loadErrorRetry: 'Fehler beim Laden. Versuche erneut...',
        waitingUi: 'Warte auf Oberfläche...',
        uiSlow: 'Oberfläche antwortet langsam...',
        ready: 'Bereit!',
    },
    en: {
        initializing: 'Initializing...',
        waitingDevServer: 'Waiting for dev server...',
        startingServer: 'Starting server...',
        connectingExternalServer: 'Connecting to external server...',
        waitingServer: 'Waiting for server response...',
        serverUnavailableExit: 'Server unreachable. Closing client...',
        serverUnavailableOpenSettings: 'Server unreachable. Opening settings...',
        checkingLibrary: 'Checking library...',
        scanningLibrary: (s) => `Scanning library... ${s}s`,
        loadingUi: 'Loading interface...',
        loadErrorRetry: 'Load error. Retrying...',
        waitingUi: 'Waiting for interface...',
        uiSlow: 'Interface is responding slowly...',
        ready: 'Ready!',
    },
    es: {
        initializing: 'Inicializando...',
        waitingDevServer: 'Esperando al servidor de desarrollo...',
        startingServer: 'Iniciando servidor...',
        connectingExternalServer: 'Conectando con servidor externo...',
        waitingServer: 'Esperando respuesta del servidor...',
        serverUnavailableExit: 'Servidor no disponible. Cerrando cliente...',
        serverUnavailableOpenSettings: 'Servidor no disponible. Abriendo ajustes...',
        checkingLibrary: 'Comprobando biblioteca...',
        scanningLibrary: (s) => `Escaneando biblioteca... ${s}s`,
        loadingUi: 'Cargando interfaz...',
        loadErrorRetry: 'Error de carga. Reintentando...',
        waitingUi: 'Esperando interfaz...',
        uiSlow: 'La interfaz responde lentamente...',
        ready: 'Listo',
    },
    ja: {
        initializing: '初期化中...',
        waitingDevServer: '開発サーバーを待機中...',
        startingServer: 'サーバーを起動中...',
        connectingExternalServer: '外部サーバーに接続中...',
        waitingServer: 'サーバー応答を待機中...',
        serverUnavailableExit: 'サーバーに接続できません。クライアントを終了します...',
        serverUnavailableOpenSettings: 'サーバーに接続できません。設定を開きます...',
        checkingLibrary: 'ライブラリを確認中...',
        scanningLibrary: (s) => `ライブラリをスキャン中... ${s}s`,
        loadingUi: 'UIを読み込み中...',
        loadErrorRetry: '読み込みエラー。再試行中...',
        waitingUi: 'UIの応答を待機中...',
        uiSlow: 'UIの応答が遅いです...',
        ready: '準備完了',
    },
    ru: {
        initializing: 'Инициализация...',
        waitingDevServer: 'Ожидание dev-сервера...',
        startingServer: 'Запуск сервера...',
        connectingExternalServer: 'Подключение к внешнему серверу...',
        waitingServer: 'Ожидание ответа сервера...',
        serverUnavailableExit: 'Сервер недоступен. Клиент закрывается...',
        serverUnavailableOpenSettings: 'Сервер недоступен. Открытие настроек...',
        checkingLibrary: 'Проверка библиотеки...',
        scanningLibrary: (s) => `Сканирование библиотеки... ${s}с`,
        loadingUi: 'Загрузка интерфейса...',
        loadErrorRetry: 'Ошибка загрузки. Повторная попытка...',
        waitingUi: 'Ожидание интерфейса...',
        uiSlow: 'Интерфейс отвечает медленно...',
        ready: 'Готово',
    },
    ko: {
        initializing: '초기화 중...',
        waitingDevServer: '개발 서버 대기 중...',
        startingServer: '서버 시작 중...',
        connectingExternalServer: '외부 서버에 연결 중...',
        waitingServer: '서버 응답 대기 중...',
        serverUnavailableExit: '서버에 연결할 수 없습니다. 클라이언트를 종료합니다...',
        serverUnavailableOpenSettings: '서버에 연결할 수 없습니다. 설정을 엽니다...',
        checkingLibrary: '라이브러리 확인 중...',
        scanningLibrary: (s) => `라이브러리 스캔 중... ${s}초`,
        loadingUi: '인터페이스 로딩 중...',
        loadErrorRetry: '로드 오류. 다시 시도 중...',
        waitingUi: '인터페이스 대기 중...',
        uiSlow: '인터페이스 응답이 느립니다...',
        ready: '준비 완료',
    },
};

function getSplashText(lang) {
    return SPLASH_TEXT[normalizeSplashLanguage(lang)] || SPLASH_TEXT.en;
}

function getElectronThemeCachePath() {
    try {
        return path.join(app.getPath('userData'), 'theme-mode.json');
    } catch {
        return null;
    }
}

function persistThemeMode(themeLike) {
    const cachePath = getElectronThemeCachePath();
    if (!cachePath) return;
    try {
        const mode = normalizeThemeMode(typeof themeLike === 'string' ? themeLike : themeLike?.mode);
        const modernPalette = normalizeModernPalette(
            typeof themeLike === 'object' && themeLike ? themeLike.modernPalette : undefined
        );
        fs.writeFileSync(cachePath, JSON.stringify({ mode, modernPalette }), 'utf8');
    } catch { }
}

function readPersistedTheme() {
    const cachePath = getElectronThemeCachePath();
    if (!cachePath || !fs.existsSync(cachePath)) return null;
    try {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return {
            mode: normalizeThemeMode(cached?.mode),
            modernPalette: normalizeModernPalette(cached?.modernPalette),
        };
    } catch {
        return null;
    }
}

function getInitialSplashTheme() {
    let detected = readPersistedTheme() || { mode: 'default', modernPalette: 'silver' };

    const serverDataCandidates = getServerDataCandidates();

    try {
        for (const dirPath of serverDataCandidates) {
            const cachePath = path.join(dirPath, 'theme-cache.json');
            if (!fs.existsSync(cachePath)) continue;
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            const cacheTheme = {
                mode: normalizeThemeMode(cached?.mode),
                modernPalette: normalizeModernPalette(cached?.modernPalette),
            };
            if (cacheTheme.mode === 'modern') return cacheTheme;
            detected = cacheTheme;
            break;
        }
    } catch { }

    try {
        const { DatabaseSync } = require('node:sqlite');
        for (const dirPath of serverDataCandidates) {
            const dbPath = path.join(dirPath, 'app.db');
            if (!fs.existsSync(dbPath)) continue;
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare(`SELECT theme_json AS themeJson FROM settings WHERE id = 1`).get();
            try { db.close(); } catch { }
            if (row?.themeJson) {
                const theme = JSON.parse(row.themeJson);
                const dbTheme = {
                    mode: normalizeThemeMode(theme?.mode),
                    modernPalette: normalizeModernPalette(theme?.modernPalette),
                };
                if (dbTheme.mode === 'modern') return dbTheme;
                detected = dbTheme;
            }
            break;
        }
    } catch { }

    return {
        mode: normalizeThemeMode(detected?.mode),
        modernPalette: normalizeModernPalette(detected?.modernPalette),
    };
}

function getModernSplashBg(palette) {
    const p = normalizeModernPalette(palette);
    if (p === 'starlight') return '#eef4de';
    if (p === 'sky') return '#e8f0fb';
    if (p === 'lavender') return '#f0eaf7';
    if (p === 'copper') return '#f5e8de';
    return '#eef2f6';
}

function createSplashWindow(themeMode = 'default', modernPalette = 'silver', splashLanguage = 'en') {
    const isModern = themeMode === 'modern';
    const text = getSplashText(splashLanguage);
    splashWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        alwaysOnTop: true,
        transparent: false,
        backgroundColor: isModern ? getModernSplashBg(modernPalette) : '#121212',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false // Needed for simple ipcRenderer in splash
        },
        ...(glyphWindowIcon ? { icon: glyphWindowIcon } : {}),
    });
    splashWindow.loadFile(path.join(__dirname, 'splash.html'), {
        query: {
            theme: isModern ? 'modern' : 'default',
            palette: normalizeModernPalette(modernPalette),
            lang: normalizeSplashLanguage(splashLanguage),
            status: text.initializing,
        },
    });
    splashWindow.center();
}

function createWindow() {
    glyphWindowIcon = resolveGlyphWindowIcon();
    // 1. Show Splash
    const initialTheme = getInitialSplashTheme();
    const initialSplashLanguage = getInitialSplashLanguage();
    createSplashWindow(initialTheme.mode, initialTheme.modernPalette, initialSplashLanguage);

    // 2. Prepare Main Window (Hidden)
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#101018',
        show: false, // Hide initially
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
        ...(glyphWindowIcon ? { icon: glyphWindowIcon } : {}),
    });
    if (glyphWindowIcon && process.platform === 'win32') {
        try { mainWindow.setIcon(glyphWindowIcon); } catch { }
    }

    mainWindow.on('maximize', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        syncMpvHostBounds();
        mainWindow.webContents.send('window-maximized-changed', true);
    });
    mainWindow.on('unmaximize', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        syncMpvHostBounds();
        mainWindow.webContents.send('window-maximized-changed', false);
    });
    mainWindow.on('move', () => syncMpvHostBounds());
    mainWindow.on('resize', () => syncMpvHostBounds());
    const isDev = process.argv.includes('--dev') || !app.isPackaged;
    const startUrl = isDev ? 'http://localhost:5173' : `file://${path.join(__dirname, '..', 'dist', 'index.html')}`;
    rendererBaseUrl = startUrl;
    const savedAddr = loadServerAddress();
    currentApiBase = `http://${savedAddr}`;
    const apiPrefix = `${currentApiBase}/api/`;

    // In packaged mode we load file:// UI, so "/api/..." would otherwise resolve to file:///api/...
    // Redirect those requests to the external Glyph Server.
    if (!isDev) {
        try {
            const ses = mainWindow.webContents.session;
            ses.webRequest.onBeforeRequest((details, callback) => {
                const requestUrl = String(details?.url || '');
                try {
                    const parsed = new URL(requestUrl);
                    if (parsed.protocol === 'file:') {
                        let p = String(parsed.pathname || '');
                        // Windows file URLs can look like /C:/api/... for absolute /api paths.
                        p = p.replace(/^\/[A-Za-z]:/, '');
                        let normalizedPath = null;
                        if (p.startsWith('/api/') || p.startsWith('api/')) {
                            normalizedPath = p.startsWith('/') ? p : `/${p}`;
                        } else if (parsed.hostname === 'api') {
                            // Handles file://api/settings style resolutions.
                            normalizedPath = `/api${p.startsWith('/') ? p : `/${p}`}`;
                        }
                        if (normalizedPath) {
                            callback({ redirectURL: `${currentApiBase}${normalizedPath}${parsed.search || ''}` });
                            return;
                        }
                    }
                } catch { }
                callback({});
            });
        } catch (err) {
            console.error('Failed to install API request redirect:', err);
        }
    }

    // Enable Web Serial API for T-Code devices (OSR2, SR6, etc.)
    const ses = mainWindow.webContents.session;

    // Allow serial permission checks
    ses.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
        if (permission === 'serial') return true;
        return true;
    });

    // Grant serial device access
    ses.setDevicePermissionHandler((details) => {
        if (details.deviceType === 'serial') return true;
        return true;
    });

    ses.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        if (!Array.isArray(portList) || portList.length === 0) {
            callback('');
            return;
        }

        // Prefer real USB serial devices over generic motherboard/virtual COM ports.
        const selected = portList.find((entry) => {
            const vid = Number(entry?.usbVendorId);
            const pid = Number(entry?.usbProductId);
            return Number.isFinite(vid) && vid > 0 && Number.isFinite(pid) && pid > 0;
        }) || portList[0];

        try {
            console.log('[serial] select-serial-port candidates:', (portList || []).map((p) => ({
                displayName: p?.displayName || '',
                portName: p?.portName || '',
                portId: p?.portId || '',
                usbVendorId: p?.usbVendorId ?? null,
                usbProductId: p?.usbProductId ?? null,
            })));
            console.log('[serial] selected serial port:', {
                displayName: selected?.displayName || '',
                portName: selected?.portName || '',
                portId: selected?.portId || '',
                usbVendorId: selected?.usbVendorId ?? null,
                usbProductId: selected?.usbProductId ?? null,
            });
        } catch { }

        callback(selected?.portId || '');
    });
    ses.on('serial-port-added', () => {});
    ses.on('serial-port-removed', () => {});

    let rendererReadySignal = false;
    const onRendererReady = (event) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (event?.sender?.id !== mainWindow.webContents.id) return;
        rendererReadySignal = true;
    };
    ipcMain.on('renderer-ready', onRendererReady);
    mainWindow.once('closed', () => {
        ipcMain.removeListener('renderer-ready', onRendererReady);
        if (playerWindow && !playerWindow.isDestroyed()) {
            try { playerWindow.close(); } catch { }
        }
    });

    const waitForRendererReady = (timeoutMs = 15000) => new Promise((resolve) => {
        if (rendererReadySignal) {
            resolve(true);
            return;
        }
        let done = false;
        const finish = (ready) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            ipcMain.removeListener('renderer-ready', onReadyOnce);
            resolve(ready);
        };
        const onReadyOnce = (event) => {
            if (!mainWindow || mainWindow.isDestroyed()) return;
            if (event?.sender?.id !== mainWindow.webContents.id) return;
            rendererReadySignal = true;
            finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        ipcMain.on('renderer-ready', onReadyOnce);
    });

    // 3. Loading Logic
    const loadContent = async () => {
        const splashText = getSplashText(initialSplashLanguage);
        const updateStatus = (msg) => {
            if (splashWindow && !splashWindow.isDestroyed()) {
                splashWindow.webContents.send('update-status', msg);
            }
        };

        // Wait for Web Server (esp. in Dev or if server.js takes time)
        // In production with embedded server, it might be instant, but let's check.
        if (isDev) {
            updateStatus(splashText.waitingDevServer);
            // Simple poll for dev server
            let retries = 0;
            while (retries < 20) {
                try {
                    await fetch('http://localhost:5173');
                    break;
                } catch (e) {
                    await new Promise(r => setTimeout(r, 500));
                    retries++;
                }
            }
        }

        updateStatus(SHOULD_EMBED_SERVER ? splashText.startingServer : splashText.connectingExternalServer);
        startServer();

        // Poll for Server Readiness (robust check)
        const http = require('http');
        const waitForServer = async (maxRetries = 20, delayMs = 500) => {
            let ready = false;
            let retries = 0;
            while (!ready && retries < maxRetries) {
                updateStatus(`${splashText.waitingServer} (${retries + 1}/${maxRetries})`);
                await new Promise(resolve => {
                    try {
                        const req = http.get(`${apiPrefix}settings`, (res) => {
                            if (res.statusCode === 200) ready = true;
                            resolve();
                        });
                        req.on('error', () => resolve());
                        req.setTimeout(1500, () => {
                            try { req.destroy(); } catch { }
                            resolve();
                        });
                        req.end();
                    } catch {
                        resolve();
                    }
                });
                if (!ready) {
                    await new Promise(r => setTimeout(r, delayMs));
                    retries++;
                }
            }
            return ready;
        };

        updateStatus(splashText.waitingServer);
        const isCustomAddress = savedAddr !== 'localhost:4000';
        let serverReady = await waitForServer(isCustomAddress ? 6 : 20, 500);

        if (!serverReady) {
            // Don't quit — proceed to main window so user can fix address in Settings
            updateStatus(splashText.serverUnavailableOpenSettings);
            await new Promise(r => setTimeout(r, 2000));
        }


        // Check for active scan (wait until finished)
        let scanning = serverReady;
        let scanRetries = 0;
        updateStatus(splashText.checkingLibrary);

        while (scanning && scanRetries < 60) {
            await new Promise(resolve => {
                const req = http.get(`${apiPrefix}status`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            scanning = json.isScanning;
                            if (scanning) updateStatus(splashText.scanningLibrary(scanRetries));
                        } catch { }
                        resolve();
                    });
                });
                req.on('error', () => resolve());
                req.setTimeout(1500, () => {
                    try { req.destroy(); } catch { }
                    resolve();
                });
                req.end();
            });

            if (scanning) {
                await new Promise(r => setTimeout(r, 1000));
                scanRetries++;
            }
        }

        updateStatus(splashText.loadingUi);
        await new Promise(r => setTimeout(r, 500));

        try {
            await mainWindow.loadURL(startUrl);
        } catch (err) {
            console.error('Failed to load main window:', err);
            // Retry once or show error
            updateStatus(splashText.loadErrorRetry);
            await new Promise(r => setTimeout(r, 1000));
            try { await mainWindow.loadURL(startUrl); } catch (e) { }
        }

        updateStatus(splashText.waitingUi);
        const rendererReady = await waitForRendererReady(20000);
        if (!rendererReady) {
            updateStatus(splashText.uiSlow);
            await new Promise(r => setTimeout(r, 700));
        } else {
            updateStatus(splashText.ready);
            await new Promise(r => setTimeout(r, 250));
        }

        // 4. Switch
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
        mainWindow.show();
        mainWindow.focus();
    };

    loadContent();
}

app.whenReady().then(() => {
    if (process.platform === 'win32') {
        try { app.setAppUserModelId('com.glyph.app'); } catch { }
    }
createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
    try { mpv.destroy(); } catch { }
    destroyMpvHostWindow();
    if (embeddedServerProcess && !embeddedServerProcess.killed) {
        try {
            embeddedServerProcess.kill();
        } catch { }
    }
});
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── IPC Handlers ──

ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Medien-Ordner auswählen',
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: 'Bild auswählen',
        filters: [{ name: 'Bilder', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    });
    if (result.canceled) return null;
    const fs = require('fs');
    const filePath = result.filePaths[0];
    const data = fs.readFileSync(filePath);
    return { filePath, base64: data.toString('base64') };
});

ipcMain.handle('select-executable', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: 'Player executable auswählen',
        filters: process.platform === 'win32'
            ? [{ name: 'Executable', extensions: ['exe'] }, { name: 'Alle Dateien', extensions: ['*'] }]
            : [{ name: 'Alle Dateien', extensions: ['*'] }],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

ipcMain.handle('select-funscript', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: 'Funscript auswählen',
        filters: [
            { name: 'Funscript', extensions: ['funscript'] },
            { name: 'Alle Dateien', extensions: ['*'] },
        ],
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

function tokenizeArgsTemplate(template, targetPath) {
    const source = String(template || '{path}').replace(/\{path\}/g, String(targetPath || ''));
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        if (m[1] !== undefined) out.push(m[1]);
        else if (m[2] !== undefined) out.push(m[2]);
    }
    return out.filter(Boolean);
}

function ensurePlayerWindow() {
    if (playerWindow && !playerWindow.isDestroyed()) return playerWindow;
    playerWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 960,
        minHeight: 600,
        backgroundColor: '#101018',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
        ...(glyphWindowIcon ? { icon: glyphWindowIcon } : {}),
    });
    if (glyphWindowIcon && process.platform === 'win32') {
        try { playerWindow.setIcon(glyphWindowIcon); } catch { }
    }
    playerWindow.on('closed', () => {
        playerWindow = null;
        playerWindowCurrentVideoId = null;
    });
    return playerWindow;
}

ipcMain.handle('open-with-player', async (_event, payload = {}) => {
    try {
        const executablePath = String(payload?.executablePath || '').trim();
        const targetPath = String(payload?.targetPath || '').trim();
        const argsTemplate = String(payload?.argsTemplate || '{path}');

        if (!targetPath) return { ok: false, error: 'Missing target path' };
        if (!executablePath) return { ok: false, error: 'Missing executable path' };
        if (!fs.existsSync(executablePath)) return { ok: false, error: 'Executable not found' };

        const args = tokenizeArgsTemplate(argsTemplate, targetPath);
        const child = spawn(executablePath, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('open-video', async (event, filePath) => {
    try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
            return { ok: false, error: 'Missing file path' };
        }

        const errorText = await shell.openPath(filePath);
        if (!errorText) return { ok: true };

        // Fallback for broken shell associations on Windows.
        if (process.platform === 'win32') {
            const { execFile } = require('child_process');
            await new Promise((resolve, reject) => {
                execFile('cmd.exe', ['/c', 'start', '""', filePath], { windowsHide: true }, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            return { ok: true, fallback: true };
        }

        return { ok: false, error: errorText };
    } catch (err) {
        console.error('Failed to open video:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('set-titlebar-theme', async (_event, mode) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const normalizedMode = normalizeThemeMode(typeof mode === 'string' ? mode : mode?.mode);
    const normalizedPalette = normalizeModernPalette(typeof mode === 'object' ? mode?.modernPalette : undefined);
    persistThemeMode({ mode: normalizedMode, modernPalette: normalizedPalette });
    const isModern = normalizedMode === 'modern';
    try {
        mainWindow.setTitleBarOverlay({
            color: isModern ? '#f3f4f6' : '#181820',
            symbolColor: isModern ? '#0b0c0f' : '#ffffff',
            height: 36,
        });
        return true;
    } catch (err) {
        const message = String(err?.message || err || '');
        if (!message.includes('Titlebar overlay is not enabled')) {
            console.warn('[titlebar] setTitleBarOverlay failed:', err);
        }
        return false;
    }
});

ipcMain.handle('set-server-address', async (_event, address) => {
    const addr = String(address || '').trim() || 'localhost:4000';
    saveServerAddress(addr);
    currentApiBase = `http://${addr}`;
    return { ok: true, address: addr };
});

ipcMain.handle('open-external-url', async (_event, rawUrl) => {
    try {
        const text = String(rawUrl || '').trim();
        if (!text) return false;
        let parsed;
        try {
            parsed = new URL(text);
        } catch {
            return false;
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        await shell.openExternal(parsed.toString());
        return true;
    } catch {
        return false;
    }
});

ipcMain.handle('open-path', async (_event, rawPath) => {
    try {
        const target = String(rawPath || '').trim();
        if (!target) return false;
        const resolved = path.resolve(target);
        if (!fs.existsSync(resolved)) {
            fs.mkdirSync(resolved, { recursive: true });
        }
        if (process.platform === 'win32') {
            const { spawn } = require('child_process');
            spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
            return true;
        }
        const errorText = await shell.openPath(resolved);
        return !errorText;
    } catch {
        return false;
    }
});

ipcMain.handle('open-player-window', async (_event, payload = {}) => {
    try {
        const videoId = String(payload?.videoId || '').trim();
        if (!videoId) return { ok: false, error: 'Missing video id' };
        const startSeconds = Number(payload?.startSeconds || 0);
        const queueVideos = Array.isArray(payload?.queueVideos) ? payload.queueVideos : null;

        // Guard: clicking an already-open video should not reload the player route,
        // because that can leave a blank player shell in separate-window mode.
        if (playerWindow && !playerWindow.isDestroyed() && playerWindowCurrentVideoId === videoId) {
            // Keep hidden renderer hidden; playback is already running in MPV.
            try { playerWindow.hide(); } catch { }
            return { ok: true, reused: true };
        }

        playerLaunchContext = {
            videoId,
            startSeconds: Number.isFinite(startSeconds) && startSeconds > 0 ? Math.max(1, Math.floor(startSeconds)) : 0,
            queueVideos,
        };
        const qs = new URLSearchParams();
        if (Number.isFinite(startSeconds) && startSeconds > 0) {
            qs.set('t', String(Math.max(1, Math.floor(startSeconds))));
        }
        qs.set('playerWindow', '1');
        const win = ensurePlayerWindow();
        const targetUrl = `${rendererBaseUrl}#/play/${encodeURIComponent(videoId)}?${qs.toString()}`;
        // Route change inside the same player window unmounts old VideoPlayer,
        // which sends mpvStop. Ignore that stale stop briefly so it can't kill
        // the freshly started mpv session for the next video.
        suppressNextMpvStopUntil = Date.now() + 4000;
        await win.loadURL(targetUrl);
        playerWindowCurrentVideoId = videoId;
        // Keep the player renderer hidden in separate-window mode.
        // The visible playback surface should be only the MPV window.
        try { win.hide(); } catch { }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('get-player-launch-context', async (_event, payload = {}) => {
    try {
        const requestedVideoId = String(payload?.videoId || '').trim();
        if (!playerLaunchContext) return null;
        if (requestedVideoId && String(playerLaunchContext.videoId || '') !== requestedVideoId) return null;
        return playerLaunchContext;
    } catch {
        return null;
    }
});

ipcMain.on('relay-device-sync-event', (event, payload = {}) => {
    try {
        const senderId = event?.sender?.id;
        const eventName = String(payload?.eventName || '').trim();
        const allowed = new Set(['mpv-handy-play', 'mpv-handy-pause', 'mpv-handy-seek', 'mpv-handy-stop', 'mpv-script-toggle', 'funscript-loaded']);
        if (!allowed.has(eventName)) return;
        const detail = (payload && typeof payload.detail === 'object' && payload.detail !== null) ? payload.detail : {};
        const out = { eventName, detail };
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win || win.isDestroyed()) continue;
            if (win.webContents?.id === senderId) continue;
            try { win.webContents.send('device-sync-event', out); } catch { }
        }
    } catch { }
});


ipcMain.handle('window-minimize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.minimize();
    return true;
});

ipcMain.handle('window-toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
});

ipcMain.handle('window-close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.close();
    return true;
});

ipcMain.handle('window-is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isMaximized();
});

ipcMain.handle('get-app-version', () => {
    try {
        return app.getVersion();
    } catch {
        return '';
    }
});

ipcMain.handle('hide-main-window-for-playback', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    try { mainWindow.hide(); } catch { return false; }
    return true;
});

ipcMain.handle('install-system-font', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            title: 'Schriftdatei auswaehlen',
            filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
        });
        if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };

        const sourcePath = result.filePaths[0];
        const fileName = path.basename(sourcePath);
        const localAppData = process.env.LOCALAPPDATA || app.getPath('home');
        const fontsDir = path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
        fs.mkdirSync(fontsDir, { recursive: true });

        const targetPath = path.join(fontsDir, fileName);
        fs.copyFileSync(sourcePath, targetPath);

        if (process.platform === 'win32') {
            const { execFile } = require('child_process');
            const regName = `${path.parse(fileName).name} (TrueType)`;
            await new Promise((resolve) => {
                execFile('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', regName, '/t', 'REG_SZ', '/d', fileName, '/f'], () => resolve());
            });
        }

        return { ok: true, fileName };
    } catch (err) {
        return { ok: false, error: err?.message || 'Failed to install font' };
    }
});
ipcMain.handle('get-system-fonts', async () => {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve(['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana']);
            return;
        }

        const psCommand = 'Add-Type -AssemblyName System.Drawing; [System.Drawing.FontFamily]::Families | Select-Object -ExpandProperty Name';
        const { exec } = require('child_process');

        exec(`powershell.exe -NoProfile -Command "${psCommand}"`, (error, stdout) => {
            if (error) {
                console.error('Failed to fetch system fonts:', error);
                resolve(['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana']);
                return;
            }

            const fonts = stdout.split('\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);

            resolve(fonts.length > 0 ? Array.from(new Set(fonts)).sort() : ['Arial', 'Helvetica']);
        });
    });
});

// ── MPV IPC Handlers ──

ipcMain.handle('mpv-load-file', async (event, filePath, options = {}) => {
    try {
        const callerWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        if (!callerWindow || callerWindow.isDestroyed()) return { ok: false, error: 'No window' };
        mpvClientWindow = callerWindow;
        mpvLoadingFile = true;
        mpvSessionId++;

        // Keep only the real MPV surface visible while playback is active.
        // - in-app mode: hide main renderer window
        // - separate-window mode: hide player shell window
        const isSeparateCaller = !!(playerWindow && !playerWindow.isDestroyed() && callerWindow === playerWindow);
        if (callerWindow === mainWindow || isSeparateCaller) {
            try { callerWindow.hide(); } catch { }
        }

        // Dann alte MPV-Instanz zerstören
        if (mpv.isRunning()) {
            const prevCallback = mpv.eventCallback;
            mpv.eventCallback = null; // suppress eof from old process
            await mpv.destroy();
            destroyMpvHostWindow();
            mpv.eventCallback = prevCallback;
        }

        await mpv.start(callerWindow, filePath, options);
        mpvLoadingFile = false;

        // Forward mpv events to renderer
        mpv.onEvent((data) => {
            if (mpvClientWindow && !mpvClientWindow.isDestroyed()) {
                mpvClientWindow.webContents.send('mpv-event', data);
            }
        });
        return { ok: true };
    } catch (err) {
        mpvLoadingFile = false;
        console.error('[mpv] Load file error:', err);
        if (mpvClientWindow && !mpvClientWindow.isDestroyed()) {
            restoreMainWindowAfterPlayback();
            mpvClientWindow.show();
            mpvClientWindow.focus();
        }
        return { ok: false, error: err.message || String(err) };
    }
});

ipcMain.handle('mpv-command', async (_event, ...args) => {
    try {
        return await mpv.command(...args);
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('mpv-script-message', async (_event, ...args) => {
    try {
        return await mpv.scriptMessage(...args);
    } catch (err) {
        return { error: err.message };
    }
});

ipcMain.handle('mpv-get-property', async (_event, name) => {
    try {
        return await mpv.getProperty(name);
    } catch (err) {
        return null;
    }
});

ipcMain.handle('mpv-set-property', async (_event, name, value) => {
    try {
        await mpv.setProperty(name, value);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-toggle-pause', async () => {
    try {
        await mpv.togglePause();
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-seek', async (_event, timeSeconds) => {
    try {
        await mpv.seek(timeSeconds);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-set-volume', async (_event, vol) => {
    try {
        await mpv.setVolume(vol);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-get-tracks', async () => {
    try {
        return await mpv.getTracks();
    } catch (err) {
        return { audio: [], sub: [] };
    }
});

ipcMain.handle('mpv-set-audio-track', async (_event, id) => {
    try {
        await mpv.setAudioTrack(id);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-set-subtitle-track', async (_event, id) => {
    try {
        await mpv.setSubtitleTrack(id);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('mpv-stop', async () => {
    if (Date.now() < suppressNextMpvStopUntil) {
        return { ok: true, skipped: 'suppressed-stale-stop' };
    }
    const sessionAtStop = mpvSessionId;
    try {
        await mpv.destroy();
        destroyMpvHostWindow();
        // Nur Fenster zeigen wenn kein neuer Load gestartet wurde
        if (!mpvLoadingFile && sessionAtStop === mpvSessionId) {
            const targetWindow = (mpvClientWindow && !mpvClientWindow.isDestroyed()) ? mpvClientWindow : mainWindow;
            if (targetWindow && !targetWindow.isDestroyed()) {
                restoreMainWindowAfterPlayback();
                targetWindow.show();
                targetWindow.focus();
            }
        }
        return { ok: true };
    } catch (err) {
        destroyMpvHostWindow();
        if (!mpvLoadingFile && sessionAtStop === mpvSessionId) {
            const targetWindow = (mpvClientWindow && !mpvClientWindow.isDestroyed()) ? mpvClientWindow : mainWindow;
            if (targetWindow && !targetWindow.isDestroyed()) {
                restoreMainWindowAfterPlayback();
                targetWindow.show();
                targetWindow.focus();
            }
        }
        return { ok: false, error: err.message };
    }
});

// Cleanup mpv on app quit
app.on('before-quit', async () => {
    try { await mpv.destroy(); } catch { }
});
