const { app, Tray, Menu, nativeImage, dialog, shell, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

let serverStarted = false;
let tray = null;
let serverMainLogPath = null;
let recentAddedWindow = null;
const LOGIN_ITEM_NAME = 'com.glyph.server';
let uiLang = 'en';

function normalizeUiLanguage(lang) {
    const raw = String(lang || '').toLowerCase();
    const base = raw.split(/[-_]/)[0];
    const supported = new Set(['de', 'en', 'es', 'ja', 'ru', 'ko', 'zh']);
    return supported.has(base) ? base : 'en';
}

function t(key) {
    const de = {
        tray_autostart: 'Autostart mit Windows',
        tray_recent: 'Neu hinzugefügte Dateien anzeigen',
        tray_open_log: 'Log öffnen',
        tray_clear_log: 'Log leeren',
        tray_open_data: 'Datenordner öffnen',
        tray_quit: 'Beenden',
        win_recent_title: 'Neu hinzugefügte Dateien',
        win_recent_heading: 'Neu hinzugefügte Dateien',
        win_recent_empty: 'Keine neuen Dateien gefunden.',
        win_recent_lib_fallback: 'Bibliothek',
        win_recent_unknown: 'Unbekannt',
        win_recent_server_offline: 'Server nicht erreichbar',
        win_recent_unknown_error: 'Unbekannter Fehler',
        server_start_error_title: 'Glyph Server konnte nicht gestartet werden',
        server_start_error_detail: 'Unbekannter Fehler beim Serverstart.',
    };
    const en = {
        tray_autostart: 'Start with Windows',
        tray_recent: 'Show recently added files',
        tray_open_log: 'Open log',
        tray_clear_log: 'Clear log',
        tray_open_data: 'Open data folder',
        tray_quit: 'Quit',
        win_recent_title: 'Recently added files',
        win_recent_heading: 'Recently added files',
        win_recent_empty: 'No recent files found.',
        win_recent_lib_fallback: 'Library',
        win_recent_unknown: 'Unknown',
        win_recent_server_offline: 'Server not reachable',
        win_recent_unknown_error: 'Unknown error',
        server_start_error_title: 'Glyph Server could not be started',
        server_start_error_detail: 'Unknown error while starting server.',
    };
    const es = {
        tray_autostart: 'Iniciar con Windows',
        tray_recent: 'Mostrar archivos añadidos recientemente',
        tray_open_log: 'Abrir registro',
        tray_clear_log: 'Limpiar registro',
        tray_open_data: 'Abrir carpeta de datos',
        tray_quit: 'Salir',
        win_recent_title: 'Archivos añadidos recientemente',
        win_recent_heading: 'Archivos añadidos recientemente',
        win_recent_empty: 'No se encontraron archivos recientes.',
        win_recent_lib_fallback: 'Biblioteca',
        win_recent_unknown: 'Desconocido',
        win_recent_server_offline: 'Servidor no disponible',
        win_recent_unknown_error: 'Error desconocido',
        server_start_error_title: 'No se pudo iniciar Glyph Server',
        server_start_error_detail: 'Error desconocido al iniciar el servidor.',
    };
    const ja = {
        tray_autostart: 'Windows 起動時に開始',
        tray_recent: '最近追加されたファイルを表示',
        tray_open_log: 'ログを開く',
        tray_clear_log: 'ログを消去',
        tray_open_data: 'データフォルダーを開く',
        tray_quit: '終了',
        win_recent_title: '最近追加されたファイル',
        win_recent_heading: '最近追加されたファイル',
        win_recent_empty: '最近のファイルは見つかりませんでした。',
        win_recent_lib_fallback: 'ライブラリ',
        win_recent_unknown: '不明',
        win_recent_server_offline: 'サーバーに接続できません',
        win_recent_unknown_error: '不明なエラー',
        server_start_error_title: 'Glyph Server を起動できませんでした',
        server_start_error_detail: 'サーバー起動時に不明なエラーが発生しました。',
    };
    const ru = {
        tray_autostart: 'Запускать вместе с Windows',
        tray_recent: 'Показать недавно добавленные файлы',
        tray_open_log: 'Открыть лог',
        tray_clear_log: 'Очистить лог',
        tray_open_data: 'Открыть папку данных',
        tray_quit: 'Выход',
        win_recent_title: 'Недавно добавленные файлы',
        win_recent_heading: 'Недавно добавленные файлы',
        win_recent_empty: 'Недавние файлы не найдены.',
        win_recent_lib_fallback: 'Библиотека',
        win_recent_unknown: 'Неизвестно',
        win_recent_server_offline: 'Сервер недоступен',
        win_recent_unknown_error: 'Неизвестная ошибка',
        server_start_error_title: 'Не удалось запустить Glyph Server',
        server_start_error_detail: 'Неизвестная ошибка при запуске сервера.',
    };
    const ko = {
        tray_autostart: 'Windows 시작 시 실행',
        tray_recent: '최근 추가 파일 보기',
        tray_open_log: '로그 열기',
        tray_clear_log: '로그 지우기',
        tray_open_data: '데이터 폴더 열기',
        tray_quit: '종료',
        win_recent_title: '최근 추가된 파일',
        win_recent_heading: '최근 추가된 파일',
        win_recent_empty: '최근 파일이 없습니다.',
        win_recent_lib_fallback: '라이브러리',
        win_recent_unknown: '알 수 없음',
        win_recent_server_offline: '서버에 연결할 수 없음',
        win_recent_unknown_error: '알 수 없는 오류',
        server_start_error_title: 'Glyph Server를 시작할 수 없습니다',
        server_start_error_detail: '서버 시작 중 알 수 없는 오류가 발생했습니다.',
    };
    const dicts = { de, en, es, ja, ru, ko };
    const dict = dicts[uiLang] || en;
    return dict[key] || key;
}

function detectUiLanguage() {
    let detected = normalizeUiLanguage(app.getLocale() || 'en');
    try {
        const { DatabaseSync } = require('node:sqlite');
        const dataDir = resolveDataDir();
        const dbPath = path.join(dataDir, 'app.db');
        if (fs.existsSync(dbPath)) {
            const db = new DatabaseSync(dbPath, { readOnly: true });
            const row = db.prepare(`SELECT language FROM settings WHERE id = 1`).get();
            try { db.close(); } catch { }
            if (row?.language) {
                detected = normalizeUiLanguage(row.language);
            }
        }
    } catch { }
    return detected;
}

function writeStartupLog(message) {
    try {
        if (!serverMainLogPath) {
            const base = process.platform === 'win32'
                ? (process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'))
                : path.join(require('os').homedir(), '.config');
            const dir = path.join(base, 'Glyph Server');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            serverMainLogPath = path.join(dir, 'server-main.log');
        }
        const line = `[${new Date().toISOString()}] ${message}\n`;
        fs.appendFileSync(serverMainLogPath, line, 'utf8');
    } catch { }
}

function resolveDataDir() {
    const envDir = String(process.env.GLYPH_DATA_DIR || '').trim();
    if (envDir) return path.resolve(envDir);
    const appDataRoot = process.platform === 'win32'
        ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
        : path.join(os.homedir(), '.config');
    const serverRoot = path.join(appDataRoot, 'GlyphServer');
    const configPath = path.join(serverRoot, 'config.json');
    try {
        if (fs.existsSync(configPath)) {
            const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const configured = String(cfg?.dataDir || '').trim();
            if (configured) return path.resolve(configured);
        }
    } catch { }
    return path.join(serverRoot, 'data');
}

function clearRuntimeLogsViaApi() {
    return new Promise((resolve) => {
        const req = http.request({
            method: 'POST',
            hostname: '127.0.0.1',
            port: 4000,
            path: '/api/logs/clear',
            timeout: 2500,
        }, (res) => {
            res.resume();
            resolve(res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            try { req.destroy(); } catch { }
            resolve(false);
        });
        req.end();
    });
}

function requestJson(pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            method: 'GET',
            hostname: '127.0.0.1',
            port: 4000,
            path: pathname,
            timeout: 4000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }
                try {
                    resolve(JSON.parse(body || 'null'));
                } catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            try { req.destroy(); } catch { }
            reject(new Error('Request timeout'));
        });
        req.end();
    });
}

function escapeHtml(input) {
    return String(input || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

async function fetchRecentAddedEntries() {
    const libraries = await requestJson('/api/libraries');
    if (!Array.isArray(libraries) || libraries.length === 0) return [];
    const visibleLibraries = libraries.filter((lib) => lib && lib.showRecentAdded !== false);
    const perLibraryFetch = visibleLibraries.slice(0, 12).map(async (lib) => {
        try {
            const videos = await requestJson(`/api/libraries/${encodeURIComponent(lib.id)}/videos?sort=date&limit=6`);
            if (!Array.isArray(videos)) return [];
            return videos.map((video) => ({
                libraryName: lib.name || t('win_recent_lib_fallback'),
                title: video?.title || video?.fileName || t('win_recent_unknown'),
                modifiedAt: Number(video?.modifiedAt || 0),
                extension: String(video?.extension || '').replace('.', '').toUpperCase(),
            }));
        } catch {
            return [];
        }
    });
    const merged = (await Promise.all(perLibraryFetch)).flat();
    return merged
        .sort((a, b) => (b.modifiedAt || 0) - (a.modifiedAt || 0))
        .slice(0, 25);
}

function formatTime(ts) {
    const n = Number(ts || 0);
    if (!Number.isFinite(n) || n <= 0) return '-';
    try {
        return new Date(n).toLocaleString();
    } catch {
        return '-';
    }
}

function buildRecentAddedHtml(items, errorMessage) {
    const rows = Array.isArray(items) ? items : [];
    const list = rows.length === 0
        ? `<div class="empty">${escapeHtml(errorMessage || t('win_recent_empty'))}</div>`
        : rows.map((item) => `
            <div class="row">
                <div class="title">${escapeHtml(item.title)}</div>
                <div class="meta">${escapeHtml(item.libraryName)} | ${escapeHtml(item.extension || '?')} | ${escapeHtml(formatTime(item.modifiedAt))}</div>
            </div>
        `).join('');
    return `<!doctype html>
<html lang="${uiLang}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>${escapeHtml(t('win_recent_title'))}</title>
<style>
html, body { width: 100%; height: 100%; overflow: hidden; }
body { margin:0; font-family: Segoe UI, Arial, sans-serif; background:#f1f4f8; color:#111827; }
.wrap { padding: 14px; box-sizing: border-box; height: 100%; display: flex; flex-direction: column; }
h1 { margin: 0 0 10px; font-size: 17px; font-weight: 700; }
.list { display:flex; flex-direction:column; gap:8px; overflow:auto; padding-right: 4px; flex: 1 1 auto; min-height: 0; }
.row { background:#ffffffd9; border:1px solid #d9e1ec; border-radius:10px; padding:10px 12px; }
.title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { margin-top: 4px; font-size: 12px; color:#5c6b80; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { background:#ffffffd9; border:1px dashed #c4cfde; border-radius:10px; padding:16px; color:#55657c; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${escapeHtml(t('win_recent_heading'))}</h1>
    <div class="list">${list}</div>
  </div>
</body>
</html>`;
}

async function openRecentAddedWindow() {
    let html = '';
    try {
        const items = await fetchRecentAddedEntries();
        html = buildRecentAddedHtml(items, '');
    } catch (err) {
        html = buildRecentAddedHtml([], `${t('win_recent_server_offline')} (${err?.message || t('win_recent_unknown_error')}).`);
    }
    if (recentAddedWindow && !recentAddedWindow.isDestroyed()) {
        recentAddedWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
        recentAddedWindow.focus();
        return;
    }
    recentAddedWindow = new BrowserWindow({
        width: 720,
        height: 560,
        minWidth: 560,
        minHeight: 360,
        title: t('win_recent_title'),
        autoHideMenuBar: true,
        backgroundColor: '#f1f4f8',
        webPreferences: {
            devTools: false,
        },
    });
    recentAddedWindow.on('closed', () => {
        recentAddedWindow = null;
    });
    recentAddedWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
}

function resolveServerIcon() {
    const candidates = [
        app.isPackaged ? path.join(process.resourcesPath, 'src', 'assets', 'icons', 'glyph.ico') : null,
        path.join(__dirname, '..', 'src', 'assets', 'icons', 'glyph.ico'),
        path.join(__dirname, '..', 'src', 'assets', 'icons', 'glyph-mark.svg'),
    ];
    for (const p of candidates) {
        try {
            if (!p) continue;
            if (!fs.existsSync(p)) continue;
            const img = nativeImage.createFromPath(p);
            if (img && !img.isEmpty()) return img;
        } catch { }
    }
    return nativeImage.createEmpty();
}

function startServerProcess() {
    if (serverStarted) return;

    const serverEntry = app.isPackaged
        ? path.join(app.getAppPath(), 'server', 'server.js')
        : path.join(__dirname, '..', 'server', 'server.js');
    try {
        writeStartupLog(`Starting server from ${serverEntry}`);
        process.env.GLYPH_EMBED_SERVER = '0';
        // Start server in-process to avoid packaged child-runtime/module-resolution issues.
        require(serverEntry);
        serverStarted = true;
        writeStartupLog('Server require() succeeded');
        console.log(`Glyph Server started from ${serverEntry}`);
    } catch (err) {
        writeStartupLog(`Server start failed: ${err?.stack || err?.message || String(err)}`);
        console.error('Failed to start Glyph Server in-process:', err);
        try {
            dialog.showErrorBox(
                t('server_start_error_title'),
                err?.stack || err?.message || t('server_start_error_detail')
            );
        } catch { }
    }
}

function stopServerProcess() {
    // In-process Express server is terminated when app exits.
}

function createTray() {
    if (tray || process.platform !== 'win32') return;
    const icon = resolveServerIcon();
    tray = new Tray(icon);
    tray.setToolTip('Glyph Server');

    const refreshMenu = () => {
        const openAtLogin = app.getLoginItemSettings({
            path: process.execPath,
            name: LOGIN_ITEM_NAME,
        }).openAtLogin;
        const menu = Menu.buildFromTemplate([
            {
                label: t('tray_autostart'),
                type: 'checkbox',
                checked: openAtLogin,
                click: (item) => {
                    try {
                        app.setLoginItemSettings({
                            openAtLogin: !!item.checked,
                            path: process.execPath,
                            name: LOGIN_ITEM_NAME,
                        });
                    } catch { }
                    refreshMenu();
                },
            },
            { type: 'separator' },
            {
                label: t('tray_recent'),
                click: async () => {
                    await openRecentAddedWindow();
                },
            },
            { type: 'separator' },
            {
                label: t('tray_open_log'),
                click: async () => {
                    try {
                        if (serverMainLogPath && fs.existsSync(serverMainLogPath)) {
                            const result = await shell.openPath(serverMainLogPath);
                            if (!result) return;
                        }
                    } catch { }
                    try {
                        const base = process.platform === 'win32'
                            ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
                            : path.join(os.homedir(), '.config');
                        await shell.openPath(path.join(base, 'Glyph Server'));
                    } catch { }
                },
            },
            {
                label: t('tray_clear_log'),
                click: async () => {
                    try {
                        if (serverMainLogPath) {
                            fs.writeFileSync(serverMainLogPath, '', 'utf8');
                        }
                    } catch { }
                    await clearRuntimeLogsViaApi();
                    writeStartupLog('Logs cleared from tray menu');
                },
            },
            {
                label: t('tray_open_data'),
                click: async () => {
                    const dataDir = resolveDataDir();
                    try {
                        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                    } catch { }
                    try { await shell.openPath(dataDir); } catch { }
                },
            },
            { type: 'separator' },
            {
                label: t('tray_quit'),
                click: () => app.quit(),
            },
        ]);
        tray.setContextMenu(menu);
    };
    refreshMenu();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        // Do nothing; keep background instance single.
    });
}

app.whenReady().then(() => {
    uiLang = detectUiLanguage();
    writeStartupLog(`App ready. isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`);
    if (process.platform === 'win32') {
        try { app.setAppUserModelId('com.glyph.server'); } catch { }
    }
    createTray();
    startServerProcess();
});

app.on('before-quit', () => {
    stopServerProcess();
    if (tray) {
        try { tray.destroy(); } catch { }
        tray = null;
    }
});

app.on('window-all-closed', (e) => {
    // Keep app alive as background process.
    e.preventDefault();
});


