const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const zlib = require('zlib');
function generateStableId(str) {
    return crypto.createHash('md5').update(String(str).toLowerCase()).digest('hex');
}
const tmdb = require('./tmdb');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStaticPath = require('ffmpeg-static');
const ffprobeStaticPath = require('ffprobe-static').path;
const { createRuntimeLogger } = require('./runtimeLogs');

function isRunnableBinary(binPathOrName) {
    const candidate = String(binPathOrName || '').trim();
    if (!candidate) return false;
    try {
        const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore', timeout: 2500 });
        return probe && probe.status === 0;
    } catch {
        return false;
    }
}

function resolveSystemBinary(name) {
    const bin = String(name || '').trim();
    if (!bin) return '';
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        const probe = spawnSync(cmd, [bin], { stdio: 'pipe', encoding: 'utf8', timeout: 2500 });
        const out = String(probe?.stdout || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
        if (probe && probe.status === 0 && out.length > 0) return out[0];
    } catch { }
    if (process.platform === 'darwin') {
        const candidates = [
            `/opt/homebrew/bin/${bin}`,
            `/usr/local/bin/${bin}`,
            `/opt/local/bin/${bin}`,
        ];
        for (const p of candidates) {
            try { if (fs.existsSync(p)) return p; } catch { }
        }
    }
    return '';
}

function resolveFfmpegBinary(preferred, fallbackName) {
    if (isRunnableBinary(preferred)) return preferred;
    const resolvedFallback = resolveSystemBinary(fallbackName) || fallbackName;
    if (isRunnableBinary(resolvedFallback)) return resolvedFallback;
    return preferred || fallbackName;
}

const ffmpegPath = resolveFfmpegBinary(ffmpegStaticPath, 'ffmpeg');
const ffprobePath = resolveFfmpegBinary(ffprobeStaticPath, 'ffprobe');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = 4000;
const HERESPHERE_THUMB_COMPOSITE_VERSION = 'hm1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));

function resolveDataDir() {
    const appDataRoot = process.platform === 'win32'
        ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
        : path.join(os.homedir(), '.config');
    const serverRoot = path.join(appDataRoot, 'GlyphServer');
    const defaultDataDir = path.join(serverRoot, 'data');
    const configPath = path.join(serverRoot, 'config.json');

    const envDir = String(process.env.GLYPH_DATA_DIR || '').trim();
    if (envDir) {
        return {
            dataDir: path.resolve(envDir),
            defaultDataDir,
            configPath,
            source: 'env',
        };
    }

    try {
        if (fs.existsSync(configPath)) {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            const configured = String(raw?.dataDir || '').trim();
            if (configured) {
                return {
                    dataDir: path.resolve(configured),
                    defaultDataDir,
                    configPath,
                    source: 'config',
                };
            }
        }
    } catch { }

    return {
        dataDir: defaultDataDir,
        defaultDataDir,
        configPath,
        source: 'default',
    };
}

const DATA_DIR_INFO = resolveDataDir();
const DATA_DIR = DATA_DIR_INFO.dataDir;
const DEFAULT_DATA_DIR = DATA_DIR_INFO.defaultDataDir;
const DATA_DIR_CONFIG_PATH = DATA_DIR_INFO.configPath;
const THUMB_DIR = path.join(DATA_DIR, 'thumbnails');
const TPDB_THUMB_DIR = path.join(DATA_DIR, 'tpdb-thumbnails');
const TPDB_PERFORMER_DIR = path.join(DATA_DIR, 'Perfomers');
const HEATMAP_DIR = path.join(DATA_DIR, 'heatmaps');
const PREVIEW_DIR = path.join(DATA_DIR, 'previews');
const POSTER_DIR = path.join(DATA_DIR, 'posters');
const BACKDROP_DIR = path.join(DATA_DIR, 'backdrops');
const TRANSCODE_DIR = path.join(DATA_DIR, 'transcode');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const LEGACY_DATA_DIR = path.join(__dirname, 'data');

// Serve transcode dir statically for HLS chunks
app.use('/api/transcode', express.static(TRANSCODE_DIR, {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Surrogate-Control', 'no-store');
    }
}));
const SQLITE_DB_PATH = path.join(DATA_DIR, 'app.db');
const THEME_CACHE_PATH = path.join(DATA_DIR, 'theme-cache.json');
const LEGACY_SETTINGS_PATH = path.join(__dirname, 'settings.json');
const LEGACY_METADATA_PATH = path.join(LEGACY_DATA_DIR, 'metadata.json');
const LEGACY_SQLITE_DB_PATH = path.join(LEGACY_DATA_DIR, 'app.db');
const LEGACY_THEME_CACHE_PATH = path.join(LEGACY_DATA_DIR, 'theme-cache.json');
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.wmv', '.webm', '.mov', '.m4v', '.flv', '.ts'];
const MULTI_AXIS_SUFFIXES = ['roll', 'twist', 'surge', 'sway', 'pitch'];
const ALL_LIBRARY_ID = '__all_videos__';
const TPDB_API_BASE = 'https://api.theporndb.net';
const TPDB_WEB_BASE = 'https://theporndb.net';
const STASHDB_API_BASE = 'https://stashdb.org/graphql';
const UI_LANGS = new Set(['de', 'en', 'es', 'ja', 'ru', 'ko']);

const runtimeLogger = createRuntimeLogger(800);
const addRuntimeLog = runtimeLogger.add;
const readRuntimeLogs = runtimeLogger.read;
const clearRuntimeLogs = runtimeLogger.clear;
const MIN_PLAYABLE_PREVIEW_DURATION_SEC = 0.8;
const audioPresenceCache = new Map();
const audioPresenceInFlight = new Map();
const audioProbeFailureUntil = new Map();
const AUDIO_PROBE_FAILURE_COOLDOWN_MS = 90 * 1000;
const detailsProbeCache = new Map();
const DETAILS_PROBE_CACHE_LIMIT = 4000;
const audioIndexStore = new Map(); // key(normalized path) -> { size, mtimeMs, hasAudio, checkedAt }
const audioIndexQueue = [];
const audioIndexQueued = new Set();
let audioIndexRunning = 0;
const AUDIO_INDEX_CONCURRENCY = 8;
const durationIndexStore = new Map(); // key(normalized path) -> { size, mtimeMs, durationSec, checkedAt }
const durationIndexQueue = [];
const durationIndexQueued = new Set();
let durationIndexRunning = 0;
const DURATION_INDEX_CONCURRENCY = 3;

function parsePositiveIntEnv(name, fallback) {
    const raw = String(process.env[name] || '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.floor(n));
}

function detectAxes(baseName, fileSet) {
    const mainFs = baseName + '.funscript';
    const hasFunscript = fileSet.has(mainFs);
    const axes = [];
    for (const axis of MULTI_AXIS_SUFFIXES) {
        if (fileSet.has(baseName + '.' + axis + '.funscript')) {
            axes.push(axis);
        }
    }
    return {
        hasFunscript: hasFunscript || axes.length > 0,
        // We don't need the full path here, just the boolean/list. 
        // Callsites constructs the path if needed, or we can return the relative name.
        // The original returned funscriptPath as absolute path, but we only have baseName here.
        // Let's return the filename and let caller join it.
        funscriptFile: hasFunscript ? mainFs : null,
        axes,
        isMultiAxis: axes.length > 0,
    };
}

// Ensure data directories exist
[DATA_DIR, THUMB_DIR, TPDB_THUMB_DIR, TPDB_PERFORMER_DIR, HEATMAP_DIR, PREVIEW_DIR, POSTER_DIR, BACKDROP_DIR, TRANSCODE_DIR, BACKUP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
// TPDB thumbnails should not use sidecar .src files.
try {
    if (fs.existsSync(TPDB_THUMB_DIR)) {
        for (const file of fs.readdirSync(TPDB_THUMB_DIR)) {
            if (String(file || '').toLowerCase().endsWith('.src')) {
                try { fs.rmSync(path.join(TPDB_THUMB_DIR, file), { force: true }); } catch { }
            }
        }
    }
} catch { }
console.log(`[GlyphServer] DATA_DIR=${DATA_DIR}`);
console.log(`[GlyphServer] DATA_DIR_SOURCE=${DATA_DIR_INFO.source}`);
console.log(`[GlyphServer] ffmpeg=${ffmpegPath}`);
console.log(`[GlyphServer] ffprobe=${ffprobePath}`);
addRuntimeLog('info', 'server', 'Media tools resolved', {
    ffmpegPath,
    ffprobePath,
});

function saveDataDirConfig(nextDataDir) {
    const rootDir = path.dirname(DATA_DIR_CONFIG_PATH);
    if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(DATA_DIR_CONFIG_PATH, JSON.stringify({ dataDir: String(nextDataDir || '') }, null, 2), 'utf8');
}

function migrateDataDirContents(targetDataDir) {
    const resolvedTarget = path.resolve(String(targetDataDir || ''));
    if (!resolvedTarget) throw new Error('Invalid target data directory');
    if (path.resolve(resolvedTarget) === path.resolve(DATA_DIR)) return;
    if (!fs.existsSync(resolvedTarget)) fs.mkdirSync(resolvedTarget, { recursive: true });

    db.exec('PRAGMA wal_checkpoint(FULL)');

    const targetDbPath = path.join(resolvedTarget, 'app.db');
    if (fs.existsSync(targetDbPath)) {
        throw new Error('Target directory already contains app.db');
    }
    fs.copyFileSync(SQLITE_DB_PATH, targetDbPath);

    const fileCopies = [
        [THEME_CACHE_PATH, path.join(resolvedTarget, 'theme-cache.json')],
    ];
    for (const [src, dst] of fileCopies) {
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, dst);
    }

    const dirCopies = [
        [THUMB_DIR, path.join(resolvedTarget, 'thumbnails')],
        [TPDB_THUMB_DIR, path.join(resolvedTarget, 'tpdb-thumbnails')],
        [TPDB_PERFORMER_DIR, path.join(resolvedTarget, 'Perfomers')],
        [HEATMAP_DIR, path.join(resolvedTarget, 'heatmaps')],
        [PREVIEW_DIR, path.join(resolvedTarget, 'previews')],
        [POSTER_DIR, path.join(resolvedTarget, 'posters')],
        [BACKDROP_DIR, path.join(resolvedTarget, 'backdrops')],
        [TRANSCODE_DIR, path.join(resolvedTarget, 'transcode')],
        [BACKUP_DIR, path.join(resolvedTarget, 'backups')],
    ];
    for (const [src, dst] of dirCopies) {
        if (!fs.existsSync(src)) continue;
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
    }
}

function migrateLegacyDataIfNeeded() {
    try {
        if (path.resolve(DATA_DIR) === path.resolve(LEGACY_DATA_DIR)) return;
        if (fs.existsSync(SQLITE_DB_PATH)) return;
        if (!fs.existsSync(LEGACY_SQLITE_DB_PATH)) return;

        fs.copyFileSync(LEGACY_SQLITE_DB_PATH, SQLITE_DB_PATH);
        if (fs.existsSync(LEGACY_THEME_CACHE_PATH) && !fs.existsSync(THEME_CACHE_PATH)) {
            fs.copyFileSync(LEGACY_THEME_CACHE_PATH, THEME_CACHE_PATH);
        }
        console.log('[GlyphServer] Migrated legacy data to APPDATA store');
    } catch (err) {
        console.warn('[GlyphServer] Legacy data migration skipped:', err?.message || String(err));
    }
}

function normalizeVrProjection(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === '180') return '180';
    if (v === '360') return '360';
    if (v === 'perspective' || v === 'flat' || v === '2d') return 'unknown';
    return 'unknown';
}

function normalizeVrStereoMode(value) {
    const v = String(value || '').trim().toLowerCase();
    if (v === 'sbs') return 'sbs';
    if (v === 'ou') return 'ou';
    return 'mono';
}

function detectVrMetaFromName(baseName) {
    const raw = String(baseName || '').toLowerCase();
    const compact = raw.replace(/[\s._-]+/g, '');

    const has360 = raw.includes('360') || compact.includes('360');
    const has180 = raw.includes('180') || compact.includes('180');
    const projection = has360 ? '360' : (has180 ? '180' : 'unknown');

    const hasSbs = /(^|[\s._-])(sbs|lr|leftright|sidebyside|3dh)($|[\s._-])/.test(raw) || compact.includes('sidebyside');
    const hasOu = /(^|[\s._-])(ou|tb|topbottom|overunder|updown)($|[\s._-])/.test(raw) || compact.includes('topbottom') || compact.includes('overunder');
    const stereoMode = hasSbs ? 'sbs' : (hasOu ? 'ou' : 'mono');

    const hasVrWord = /(^|[\s._-])vr($|[\s._-])/.test(raw) || compact.includes('virtualreality');
    const isVr = hasVrWord || projection !== 'unknown' || stereoMode !== 'mono';
    return { isVr, projection, stereoMode };
}

function detectVrMetaFromCandidates(candidates = []) {
    const list = Array.isArray(candidates) ? candidates : [];
    let isVr = false;
    let projection = 'unknown';
    let stereoMode = 'mono';

    for (const candidate of list) {
        const raw = String(candidate || '').trim();
        if (!raw) continue;
        const detected = detectVrMetaFromName(raw);
        if (detected.isVr) isVr = true;
        if (projection === 'unknown' && detected.projection !== 'unknown') {
            projection = detected.projection;
        }
        if (stereoMode === 'mono' && detected.stereoMode !== 'mono') {
            stereoMode = detected.stereoMode;
        }
    }

    return {
        isVr,
        projection: normalizeVrProjection(projection),
        stereoMode: normalizeVrStereoMode(stereoMode),
    };
}

function detectVrMetaFromMetadataRaw(raw = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const pickString = (...values) => {
        for (const value of values) {
            const text = String(value || '').trim();
            if (text) return text;
        }
        return '';
    };
    const pickBool = (...values) => {
        for (const value of values) {
            if (typeof value === 'boolean') return value;
            const text = String(value || '').trim().toLowerCase();
            if (!text) continue;
            if (['1', 'true', 'yes', 'on'].includes(text)) return true;
            if (['0', 'false', 'no', 'off'].includes(text)) return false;
        }
        return null;
    };

    const tags = []
        .concat(Array.isArray(src?.tags) ? src.tags : [])
        .concat(Array.isArray(src?.categories) ? src.categories : [])
        .map((tag) => (typeof tag === 'string' ? tag : (tag?.name || tag?.label || tag?.title || '')))
        .filter(Boolean);

    const projectionField = pickString(
        src?.projection,
        src?.projectionType,
        src?.projection_type,
        src?.vrProjection,
        src?.vr_projection,
        src?.videoProjection,
        src?.video_projection
    );
    const stereoField = pickString(
        src?.stereoMode,
        src?.stereo_mode,
        src?.stereo,
        src?.vrStereoMode,
        src?.vr_stereo_mode,
        src?.stereoType,
        src?.stereo_type
    );
    const vrFlag = pickBool(
        src?.isVr,
        src?.is_vr,
        src?.vr,
        src?.isVR,
        src?.virtualReality
    );

    const detected = detectVrMetaFromCandidates([projectionField, stereoField, ...tags]);
    const projection = normalizeVrProjection(detected.projection);
    const stereoMode = normalizeVrStereoMode(detected.stereoMode);
    const isVr = (vrFlag === true) || detected.isVr || projection !== 'unknown' || stereoMode !== 'mono';
    return { isVr, projection, stereoMode };
}

migrateLegacyDataIfNeeded();

// â”€â”€ Metadata Database (stored in app data, NOT next to videos) â”€â”€
// SQLite persistence
let db = new DatabaseSync(SQLITE_DB_PATH);
let backupOperationRunning = false;
const BACKUP_SCHEDULE_VALUES = new Set(['none', 'daily', 'weekly', 'monthly']);
let autoBackupTimer = null;
const AUTO_BACKUP_CHECK_MS = 30 * 60 * 1000;

function sqlQuote(value) {
    return String(value || '').replace(/'/g, "''");
}

function createBackupFileName(prefix = 'glyph-backup') {
    const dt = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}_${pad(dt.getHours())}-${pad(dt.getMinutes())}-${pad(dt.getSeconds())}`;
    return `${prefix}-${stamp}.db`;
}

function listDatabaseBackups() {
    let entries = [];
    try {
        entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
    } catch {
        entries = [];
    }
    const files = entries
        .filter((entry) => entry?.isFile?.() && /\.db$/i.test(String(entry.name || '')))
        .map((entry) => {
            const fullPath = path.join(BACKUP_DIR, entry.name);
            let stat = null;
            try { stat = fs.statSync(fullPath); } catch { stat = null; }
            return {
                fileName: String(entry.name || ''),
                size: Number(stat?.size || 0),
                modifiedAt: Number(stat?.mtimeMs || 0),
            };
        })
        .filter((item) => item.fileName);
    files.sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0));
    return files;
}

function createDatabaseBackupInternal(prefix = 'glyph-backup') {
    const fileName = createBackupFileName(prefix);
    const destPath = path.join(BACKUP_DIR, fileName);
    db.exec('PRAGMA wal_checkpoint(FULL)');
    db.exec(`VACUUM INTO '${sqlQuote(destPath)}'`);
    const stat = fs.statSync(destPath);
    return {
        fileName,
        size: Number(stat?.size || 0),
        modifiedAt: Number(stat?.mtimeMs || Date.now()),
    };
}

function createDatabaseBackup(prefix = 'glyph-backup') {
    if (backupOperationRunning) throw new Error('Backup operation already running');
    backupOperationRunning = true;
    try {
        return createDatabaseBackupInternal(prefix);
    } finally {
        backupOperationRunning = false;
    }
}

function reopenDatabaseAfterRestore() {
    try { db.close(); } catch { }
    db = new DatabaseSync(SQLITE_DB_PATH);
    initDatabase();
}

function restoreDatabaseBackup(fileName) {
    const safeName = path.basename(String(fileName || '').trim());
    if (!safeName || !/\.db$/i.test(safeName)) throw new Error('Invalid backup file');
    const srcPath = path.join(BACKUP_DIR, safeName);
    if (!fs.existsSync(srcPath)) throw new Error('Backup not found');
    if (backupOperationRunning) throw new Error('Backup operation already running');

    backupOperationRunning = true;
    let preRestoreBackup = null;
    try {
        preRestoreBackup = createDatabaseBackupInternal('pre-restore');
        try { db.close(); } catch { }

        const tempRestorePath = `${SQLITE_DB_PATH}.restore.tmp`;
        fs.copyFileSync(srcPath, tempRestorePath);
        fs.renameSync(tempRestorePath, SQLITE_DB_PATH);

        db = new DatabaseSync(SQLITE_DB_PATH);
        const check = db.prepare('PRAGMA integrity_check').get();
        const result = String(check?.integrity_check || '').toLowerCase();
        if (result !== 'ok') throw new Error(`Integrity check failed: ${result || 'unknown'}`);
        initDatabase();

        return { restoredFrom: safeName, preRestoreBackup };
    } catch (err) {
        try {
            if (preRestoreBackup?.fileName) {
                const rollbackPath = path.join(BACKUP_DIR, preRestoreBackup.fileName);
                const tempRollbackPath = `${SQLITE_DB_PATH}.rollback.tmp`;
                try { db.close(); } catch { }
                fs.copyFileSync(rollbackPath, tempRollbackPath);
                fs.renameSync(tempRollbackPath, SQLITE_DB_PATH);
                reopenDatabaseAfterRestore();
            }
        } catch {
            reopenDatabaseAfterRestore();
        }
        throw err;
    } finally {
        backupOperationRunning = false;
    }
}

function normalizeBackupSchedule(value) {
    const raw = String(value || '').trim().toLowerCase();
    return BACKUP_SCHEDULE_VALUES.has(raw) ? raw : 'none';
}

function shouldRunAutoBackup(schedule, lastAutoAt, now = Date.now()) {
    const safeSchedule = normalizeBackupSchedule(schedule);
    if (safeSchedule === 'none') return false;
    const last = Number(lastAutoAt || 0);
    if (!Number.isFinite(last) || last <= 0) return true;
    const diff = Math.max(0, Number(now) - last);
    if (safeSchedule === 'daily') return diff >= 24 * 60 * 60 * 1000;
    if (safeSchedule === 'weekly') return diff >= 7 * 24 * 60 * 60 * 1000;
    if (safeSchedule === 'monthly') return diff >= 30 * 24 * 60 * 60 * 1000;
    return false;
}

function runAutoBackupIfDue(force = false) {
    if (backupOperationRunning) return;
    const row = db.prepare(`
        SELECT backup_schedule AS backupSchedule, backup_last_auto_at AS backupLastAutoAt
        FROM settings
        WHERE id = 1
    `).get() || {};
    const schedule = normalizeBackupSchedule(row.backupSchedule);
    const lastAutoAt = Number(row.backupLastAutoAt || 0);
    if (!force && !shouldRunAutoBackup(schedule, lastAutoAt)) return;
    if (schedule === 'none' && !force) return;
    try {
        const backup = createDatabaseBackup('auto-backup');
        db.prepare(`
            UPDATE settings
            SET backup_last_auto_at = ?
            WHERE id = 1
        `).run(Date.now());
        addRuntimeLog('info', 'backup', 'Automatic backup created', { fileName: backup.fileName, schedule });
    } catch (err) {
        addRuntimeLog('error', 'backup', 'Automatic backup failed', { error: err?.message || String(err), schedule });
    }
}

function ensureAutoBackupTimer() {
    if (autoBackupTimer) clearInterval(autoBackupTimer);
    autoBackupTimer = setInterval(() => runAutoBackupIfDue(false), AUTO_BACKUP_CHECK_MS);
}

function normalizeFolderKey(folderPath) {
    return path.normalize(folderPath).toLowerCase();
}

function initDatabase() {
    db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            tmdb_api_key TEXT NOT NULL DEFAULT '',
            tpdb_api_key TEXT NOT NULL DEFAULT '',
            stashdb_api_key TEXT NOT NULL DEFAULT '',
            theme_json TEXT NOT NULL DEFAULT '{}',
            language TEXT NOT NULL DEFAULT 'en',
            watch_folders INTEGER NOT NULL DEFAULT 1,
            player_type TEXT NOT NULL DEFAULT 'internal',
            include_all_library INTEGER NOT NULL DEFAULT 0,
            backup_schedule TEXT NOT NULL DEFAULT 'none',
            backup_last_auto_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS libraries (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'videos',
            show_recent_added INTEGER NOT NULL DEFAULT 1,
            track_continue_watching INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS metadata (
            folder_key TEXT PRIMARY KEY,
            folder_path TEXT NOT NULL,
            data_json TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS tags (
            item_key TEXT PRIMARY KEY,
            item_type TEXT NOT NULL,
            item_path TEXT NOT NULL,
            tags_json TEXT NOT NULL DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS tag_categories (
            tag_key TEXT PRIMARY KEY,
            tag_name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            created_at INTEGER NOT NULL,
            sort_index INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS playlist_items (
            playlist_id TEXT NOT NULL,
            item_key TEXT NOT NULL,
            item_path TEXT NOT NULL,
            added_at INTEGER NOT NULL,
            sort_index INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (playlist_id, item_key),
            FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS watch_progress (
            video_id TEXT PRIMARY KEY,
            position_sec REAL NOT NULL DEFAULT 0,
            duration_sec REAL NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS vr_video_meta (
            video_path TEXT PRIMARY KEY,
            projection TEXT NOT NULL DEFAULT 'unknown',
            stereo_mode TEXT NOT NULL DEFAULT 'mono',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_audio_index (
            file_path_key TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            file_mtime_ms INTEGER NOT NULL DEFAULT 0,
            has_audio INTEGER NOT NULL DEFAULT 0,
            checked_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS media_duration_index (
            file_path_key TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL DEFAULT 0,
            file_mtime_ms INTEGER NOT NULL DEFAULT 0,
            duration_sec REAL NOT NULL DEFAULT 0,
            checked_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS funscript_mappings (
            id TEXT PRIMARY KEY,
            video_id TEXT NOT NULL,
            script_path TEXT NOT NULL,
            axis TEXT NOT NULL DEFAULT 'main',
            label TEXT NOT NULL DEFAULT '',
            is_default INTEGER NOT NULL DEFAULT 1,
            offset_ms INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_funscript_mapping_unique
        ON funscript_mappings(video_id, script_path, axis);

        CREATE TABLE IF NOT EXISTS funscript_history (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            video_id TEXT NOT NULL DEFAULT '',
            script_path TEXT NOT NULL DEFAULT '',
            axis TEXT NOT NULL DEFAULT '',
            label TEXT NOT NULL DEFAULT '',
            details_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_funscript_history_created
        ON funscript_history(created_at DESC);

        CREATE TABLE IF NOT EXISTS playlist_history (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL,
            undone_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_playlist_history_created
        ON playlist_history(created_at DESC);

        CREATE TABLE IF NOT EXISTS tpdb_video_metadata (
            video_key TEXT PRIMARY KEY,
            video_path TEXT NOT NULL,
            item_type TEXT NOT NULL DEFAULT 'scene',
            item_id TEXT NOT NULL DEFAULT '',
            source_url TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            release_date TEXT NOT NULL DEFAULT '',
            site_name TEXT NOT NULL DEFAULT '',
            poster_url TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tpdb_performers (
            performer_id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            disambiguation TEXT NOT NULL DEFAULT '',
            image_url TEXT NOT NULL DEFAULT '',
            face_url TEXT NOT NULL DEFAULT '',
            selected_image_url TEXT NOT NULL DEFAULT '',
            bio TEXT NOT NULL DEFAULT '',
            birthdate TEXT NOT NULL DEFAULT '',
            birthplace TEXT NOT NULL DEFAULT '',
            nationality TEXT NOT NULL DEFAULT '',
            gender TEXT NOT NULL DEFAULT '',
            data_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tpdb_video_performers (
            video_key TEXT NOT NULL,
            performer_id TEXT NOT NULL,
            performer_name TEXT NOT NULL DEFAULT '',
            sort_index INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (video_key, performer_id)
        );

        CREATE TABLE IF NOT EXISTS value_translations (
            cache_key TEXT PRIMARY KEY,
            domain TEXT NOT NULL DEFAULT '',
            source_text TEXT NOT NULL DEFAULT '',
            target_lang TEXT NOT NULL DEFAULT 'en',
            translated_text TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tpdb_video_performers_video
        ON tpdb_video_performers(video_key, sort_index, performer_name);

        CREATE INDEX IF NOT EXISTS idx_tpdb_video_performers_performer
        ON tpdb_video_performers(performer_id);

        CREATE INDEX IF NOT EXISTS idx_value_translations_lookup
        ON value_translations(domain, target_lang);
    `);

    const settingCols = db.prepare(`PRAGMA table_info(settings)`).all();
    const hasWatchFolders = settingCols.some(c => c.name === 'watch_folders');
    if (!hasWatchFolders) {
        db.exec(`ALTER TABLE settings ADD COLUMN watch_folders INTEGER NOT NULL DEFAULT 1`);
    }
    const hasTpdbApiKey = settingCols.some(c => c.name === 'tpdb_api_key');
    if (!hasTpdbApiKey) {
        db.exec(`ALTER TABLE settings ADD COLUMN tpdb_api_key TEXT NOT NULL DEFAULT ''`);
    }
    const hasStashdbApiKey = settingCols.some(c => c.name === 'stashdb_api_key');
    if (!hasStashdbApiKey) {
        db.exec(`ALTER TABLE settings ADD COLUMN stashdb_api_key TEXT NOT NULL DEFAULT ''`);
    }
    const hasPlayerType = settingCols.some(c => c.name === 'player_type');
    if (!hasPlayerType) {
        db.exec(`ALTER TABLE settings ADD COLUMN player_type TEXT NOT NULL DEFAULT 'internal'`);
    }
    const hasIncludeAllLibrary = settingCols.some(c => c.name === 'include_all_library');
    if (!hasIncludeAllLibrary) {
        db.exec(`ALTER TABLE settings ADD COLUMN include_all_library INTEGER NOT NULL DEFAULT 0`);
    }
    const hasBackupSchedule = settingCols.some(c => c.name === 'backup_schedule');
    if (!hasBackupSchedule) {
        db.exec(`ALTER TABLE settings ADD COLUMN backup_schedule TEXT NOT NULL DEFAULT 'none'`);
    }
    const hasBackupLastAutoAt = settingCols.some(c => c.name === 'backup_last_auto_at');
    if (!hasBackupLastAutoAt) {
        db.exec(`ALTER TABLE settings ADD COLUMN backup_last_auto_at INTEGER NOT NULL DEFAULT 0`);
    }
    const tpdbPerformerCols = db.prepare(`PRAGMA table_info(tpdb_performers)`).all();
    const hasTpdbSelectedImage = tpdbPerformerCols.some(c => c.name === 'selected_image_url');
    if (!hasTpdbSelectedImage) {
        db.exec(`ALTER TABLE tpdb_performers ADD COLUMN selected_image_url TEXT NOT NULL DEFAULT ''`);
    }
    db.prepare(`
        INSERT INTO settings (id)
        VALUES (1)
        ON CONFLICT(id) DO NOTHING
    `).run();
    db.prepare(`
        UPDATE settings
        SET tmdb_api_key = COALESCE(tmdb_api_key, ''),
            tpdb_api_key = COALESCE(tpdb_api_key, ''),
            stashdb_api_key = COALESCE(stashdb_api_key, ''),
            theme_json = COALESCE(NULLIF(theme_json, ''), '{}'),
            language = COALESCE(NULLIF(language, ''), 'en'),
            watch_folders = COALESCE(watch_folders, 1),
            player_type = COALESCE(NULLIF(player_type, ''), 'internal'),
            include_all_library = COALESCE(include_all_library, 0),
            backup_schedule = COALESCE(NULLIF(backup_schedule, ''), 'none'),
            backup_last_auto_at = COALESCE(backup_last_auto_at, 0)
        WHERE id = 1
    `).run();

    const libraryCols = db.prepare(`PRAGMA table_info(libraries)`).all();
    const hasShowRecentAdded = libraryCols.some(c => c.name === 'show_recent_added');
    if (!hasShowRecentAdded) {
        db.exec(`ALTER TABLE libraries ADD COLUMN show_recent_added INTEGER NOT NULL DEFAULT 1`);
    }
    const hasTrackContinueWatching = libraryCols.some(c => c.name === 'track_continue_watching');
    if (!hasTrackContinueWatching) {
        db.exec(`ALTER TABLE libraries ADD COLUMN track_continue_watching INTEGER NOT NULL DEFAULT 1`);
    }

    const playlistCols = db.prepare(`PRAGMA table_info(playlists)`).all();
    const hasSortIndex = playlistCols.some(c => c.name === 'sort_index');
    if (!hasSortIndex) {
        db.exec(`ALTER TABLE playlists ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0`);
        const rows = db.prepare(`SELECT id FROM playlists ORDER BY created_at ASC, LOWER(name) ASC`).all();
        const updateSort = db.prepare(`UPDATE playlists SET sort_index = ? WHERE id = ?`);
        rows.forEach((row, index) => updateSort.run(index + 1, row.id));
    }

    const playlistItemCols = db.prepare(`PRAGMA table_info(playlist_items)`).all();
    const hasItemSortIndex = playlistItemCols.some(c => c.name === 'sort_index');
    if (!hasItemSortIndex) {
        db.exec(`ALTER TABLE playlist_items ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0`);
        const rows = db.prepare(`
            SELECT playlist_id AS playlistId, item_key AS itemKey
            FROM playlist_items
            ORDER BY playlist_id ASC, added_at DESC, item_key ASC
        `).all();
        const updateSort = db.prepare(`UPDATE playlist_items SET sort_index = ? WHERE playlist_id = ? AND item_key = ?`);
        let lastPlaylistId = '';
        let idx = 0;
        for (const row of rows || []) {
            const playlistId = String(row?.playlistId || '');
            if (!playlistId) continue;
            if (playlistId !== lastPlaylistId) {
                lastPlaylistId = playlistId;
                idx = 1;
            } else {
                idx += 1;
            }
            updateSort.run(idx, playlistId, String(row?.itemKey || ''));
        }
    }
}

function getMetadata(folderPath) {
    const row = db.prepare(`
        SELECT data_json AS dataJson
        FROM metadata
        WHERE folder_key = ?
    `).get(normalizeFolderKey(folderPath));
    if (!row) return null;
    try {
        return JSON.parse(row.dataJson);
    } catch {
        return null;
    }
}

function setMetadata(folderPath, metadata) {
    db.prepare(`
        INSERT INTO metadata (folder_key, folder_path, data_json)
        VALUES (?, ?, ?)
        ON CONFLICT(folder_key) DO UPDATE SET
            folder_path = excluded.folder_path,
            data_json = excluded.data_json
    `).run(
        normalizeFolderKey(folderPath),
        folderPath,
        JSON.stringify(metadata || {})
    );
}

function normalizeTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const result = [];
    for (const raw of tags) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(value);
        if (result.length >= 40) break;
    }
    return result;
}

function replaceTagInList(tags, fromLower, toValue) {
    const result = [];
    const seen = new Set();
    for (const raw of normalizeTags(tags)) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const nextValue = value.toLowerCase() === fromLower ? toValue : value;
        const key = nextValue.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(nextValue);
    }
    return normalizeTags(result);
}

function removeTagFromList(tags, removeLowerSet) {
    return normalizeTags(tags).filter(tag => !removeLowerSet.has(String(tag || '').toLowerCase()));
}

function getTagsByKey(itemKey) {
    const row = db.prepare(`
        SELECT tags_json AS tagsJson
        FROM tags
        WHERE item_key = ?
    `).get(itemKey);
    if (!row) return [];
    try {
        return normalizeTags(JSON.parse(row.tagsJson));
    } catch {
        return [];
    }
}

function setTagsByKey(itemType, itemPath, tags) {
    const normalizedPath = path.normalize(itemPath);
    const itemKey = `${itemType}:${normalizedPath.toLowerCase()}`;
    const normalizedTags = normalizeTags(tags);
    db.prepare(`
        INSERT INTO tags (item_key, item_type, item_path, tags_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(item_key) DO UPDATE SET
            item_type = excluded.item_type,
            item_path = excluded.item_path,
            tags_json = excluded.tags_json
    `).run(itemKey, itemType, normalizedPath, JSON.stringify(normalizedTags));
    return normalizedTags;
}

function getFolderTags(folderPath) {
    return getTagsByKey(`folder:${path.normalize(folderPath).toLowerCase()}`);
}

function setFolderTags(folderPath, tags) {
    return setTagsByKey('folder', folderPath, tags);
}

function getVideoTags(videoPath) {
    return getTagsByKey(`video:${path.normalize(videoPath).toLowerCase()}`);
}

function setVideoTags(videoPath, tags) {
    return setTagsByKey('video', videoPath, tags);
}

function getTagCategoryMap() {
    const rows = db.prepare(`
        SELECT tag_key AS tagKey, tag_name AS tagName, category
        FROM tag_categories
    `).all();
    const out = {};
    for (const row of rows) {
        const key = normalizeTagKey(row.tagName || row.tagKey);
        if (!key) continue;
        out[key] = {
            tagName: String(row.tagName || '').trim() || key,
            category: normalizeTagCategoryName(row.category),
        };
    }
    return out;
}

function getCategoryForTag(tagName) {
    const key = normalizeTagKey(tagName);
    if (!key) return '';
    const row = db.prepare(`
        SELECT category
        FROM tag_categories
        WHERE tag_key = ?
    `).get(key);
    return normalizeTagCategoryName(row?.category || '');
}

function setCategoryForTag(tagName, category) {
    const key = normalizeTagKey(tagName);
    if (!key) return { tagName: '', category: '' };
    const normalizedName = String(tagName || '').trim().slice(0, 80) || key;
    const normalizedCategory = normalizeTagCategoryName(category);
    if (!normalizedCategory) {
        db.prepare(`DELETE FROM tag_categories WHERE tag_key = ?`).run(key);
        return { tagName: normalizedName, category: '' };
    }
    db.prepare(`
        INSERT INTO tag_categories (tag_key, tag_name, category)
        VALUES (?, ?, ?)
        ON CONFLICT(tag_key) DO UPDATE SET
            tag_name = excluded.tag_name,
            category = excluded.category
    `).run(key, normalizedName, normalizedCategory);
    return { tagName: normalizedName, category: normalizedCategory };
}

function renameTagCategory(fromTag, toTag) {
    const fromKey = normalizeTagKey(fromTag);
    const toKey = normalizeTagKey(toTag);
    if (!fromKey || !toKey || fromKey === toKey) return;
    const fromRow = db.prepare(`
        SELECT category
        FROM tag_categories
        WHERE tag_key = ?
    `).get(fromKey);
    if (!fromRow) return;
    const existingTo = db.prepare(`
        SELECT category
        FROM tag_categories
        WHERE tag_key = ?
    `).get(toKey);
    const category = normalizeTagCategoryName(existingTo?.category || fromRow.category || '');
    db.prepare(`DELETE FROM tag_categories WHERE tag_key = ?`).run(fromKey);
    if (category) setCategoryForTag(toTag, category);
}

function getVrMetaByPath(videoPath) {
    const normalizedPath = path.normalize(String(videoPath || ''));
    if (!normalizedPath) return null;
    const row = db.prepare(`
        SELECT projection, stereo_mode AS stereoMode
        FROM vr_video_meta
        WHERE video_path = ?
    `).get(normalizedPath);
    if (!row) return null;
    return {
        projection: normalizeVrProjection(row.projection),
        stereoMode: normalizeVrStereoMode(row.stereoMode),
    };
}

function setVrMetaByPath(videoPath, projection, stereoMode) {
    const normalizedPath = path.normalize(String(videoPath || ''));
    if (!normalizedPath) return null;
    const safeProjection = normalizeVrProjection(projection);
    const safeStereo = normalizeVrStereoMode(stereoMode);
    db.prepare(`
        INSERT INTO vr_video_meta (video_path, projection, stereo_mode, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_path) DO UPDATE SET
            projection = excluded.projection,
            stereo_mode = excluded.stereo_mode,
            updated_at = excluded.updated_at
    `).run(normalizedPath, safeProjection, safeStereo, Date.now());
    return { projection: safeProjection, stereoMode: safeStereo };
}

function normalizePlaylistName(name) {
    return String(name || '').trim().slice(0, 80);
}

function normalizePlaylistItemPath(itemPath) {
    return path.normalize(String(itemPath || '').trim());
}

function makePlaylistItemKey(itemPath) {
    return normalizePlaylistItemPath(itemPath).toLowerCase();
}

function getPlaylistById(playlistId) {
    if (!playlistId) return null;
    return db.prepare(`
        SELECT id, name, created_at AS createdAt, sort_index AS sortIndex
        FROM playlists
        WHERE id = ?
    `).get(playlistId) || null;
}

function getPlaylistByName(name) {
    const normalized = normalizePlaylistName(name);
    if (!normalized) return null;
    return db.prepare(`
        SELECT id, name, created_at AS createdAt, sort_index AS sortIndex
        FROM playlists
        WHERE name = ? COLLATE NOCASE
    `).get(normalized) || null;
}

function getPlaylistItemsById(playlistId) {
    const id = String(playlistId || '').trim();
    if (!id) return [];
    const rows = db.prepare(`
        SELECT item_key AS itemKey, item_path AS itemPath, added_at AS addedAt, sort_index AS sortIndex
        FROM playlist_items
        WHERE playlist_id = ?
        ORDER BY sort_index ASC, added_at DESC, item_key ASC
    `).all(id);
    return (rows || []).map((row) => ({
        itemKey: String(row.itemKey || ''),
        itemPath: String(row.itemPath || ''),
        addedAt: Number(row.addedAt || 0),
        sortIndex: Number(row.sortIndex || 0),
    }));
}

function getNextPlaylistItemSortIndex(playlistId) {
    const row = db.prepare(`
        SELECT MAX(sort_index) AS maxSort
        FROM playlist_items
        WHERE playlist_id = ?
    `).get(String(playlistId || '').trim());
    return Number(row?.maxSort || 0) + 1;
}

function getNextPlaylistSortIndex() {
    const row = db.prepare(`SELECT MAX(sort_index) AS maxSortIndex FROM playlists`).get();
    return Number(row?.maxSortIndex || 0) + 1;
}

function ensureUniquePlaylistName(baseName, options = {}) {
    const maxLen = 80;
    const initial = normalizePlaylistName(baseName) || 'Playlist';
    const excludeId = String(options?.excludeId || '').trim();
    const existsName = (name) => {
        if (!name) return true;
        const row = db.prepare(`
            SELECT id
            FROM playlists
            WHERE name = ? COLLATE NOCASE
            LIMIT 1
        `).get(name);
        if (!row) return false;
        if (excludeId && String(row.id || '') === excludeId) return false;
        return true;
    };
    if (!existsName(initial)) return initial;
    for (let i = 2; i < 5000; i += 1) {
        const suffix = ` (${i})`;
        const cut = Math.max(1, maxLen - suffix.length);
        const candidate = `${initial.slice(0, cut)}${suffix}`.trim();
        if (!existsName(candidate)) return candidate;
    }
    return `${initial.slice(0, 60)} ${Date.now()}`.slice(0, maxLen);
}

function snapshotPlaylistsByIds(ids) {
    const validIds = Array.isArray(ids)
        ? [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
    if (!validIds.length) return [];
    return validIds
        .map((id) => {
            const pl = getPlaylistById(id);
            if (!pl) return null;
            return {
                id: String(pl.id || ''),
                name: String(pl.name || ''),
                createdAt: Number(pl.createdAt || Date.now()),
                sortIndex: Number(pl.sortIndex || 0),
                items: getPlaylistItemsById(pl.id),
            };
        })
        .filter(Boolean);
}

function addPlaylistHistory(action, payload = {}) {
    const id = uuidv4();
    db.prepare(`
        INSERT INTO playlist_history (id, action, payload_json, created_at, undone_at)
        VALUES (?, ?, ?, ?, 0)
    `).run(
        id,
        String(action || ''),
        JSON.stringify(payload || {}),
        Date.now()
    );
    return id;
}

function listPlaylistHistory(limit = 40) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
    const rows = db.prepare(`
        SELECT id, action, payload_json AS payloadJson, created_at AS createdAt, undone_at AS undoneAt
        FROM playlist_history
        ORDER BY created_at DESC
        LIMIT ?
    `).all(safeLimit);
    return (rows || []).map((row) => {
        let payload = {};
        try { payload = JSON.parse(String(row.payloadJson || '{}')); } catch { payload = {}; }
        return {
            id: String(row.id || ''),
            action: String(row.action || ''),
            payload,
            createdAt: Number(row.createdAt || 0),
            undoneAt: Number(row.undoneAt || 0),
        };
    });
}

function getCurrentPlaylistOrderIds() {
    const rows = db.prepare(`
        SELECT id
        FROM playlists
        ORDER BY sort_index ASC, LOWER(name) ASC
    `).all();
    return (rows || []).map((row) => String(row.id || '')).filter(Boolean);
}

function applyPlaylistOrder(orderedIds) {
    const list = Array.isArray(orderedIds)
        ? orderedIds.map((id) => String(id || '').trim()).filter(Boolean)
        : [];
    const existingIds = new Set(getCurrentPlaylistOrderIds());
    const unique = [];
    const seen = new Set();
    for (const id of list) {
        if (!existingIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
    }
    for (const id of existingIds) {
        if (seen.has(id)) continue;
        unique.push(id);
    }
    const update = db.prepare(`UPDATE playlists SET sort_index = ? WHERE id = ?`);
    unique.forEach((id, index) => update.run(index + 1, id));
    return unique;
}

function restorePlaylistSnapshots(snapshots = []) {
    const rows = Array.isArray(snapshots) ? snapshots : [];
    const insertPlaylist = db.prepare(`
        INSERT INTO playlists (id, name, created_at, sort_index)
        VALUES (?, ?, ?, ?)
    `);
    const insertItem = db.prepare(`
        INSERT OR IGNORE INTO playlist_items (playlist_id, item_key, item_path, added_at, sort_index)
        VALUES (?, ?, ?, ?, ?)
    `);
    const restored = [];
    for (const snapshot of rows) {
        const originalId = String(snapshot?.id || '').trim();
        if (!originalId) continue;
        const existingById = getPlaylistById(originalId);
        const targetId = existingById ? uuidv4() : originalId;
        const rawName = String(snapshot?.name || '').trim() || 'Playlist';
        const name = ensureUniquePlaylistName(rawName);
        const createdAt = Number(snapshot?.createdAt || Date.now());
        const sortIndex = Number(snapshot?.sortIndex || getNextPlaylistSortIndex());
        insertPlaylist.run(targetId, name, createdAt, sortIndex);
        const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
        for (const item of items) {
            const itemPath = normalizePlaylistItemPath(item?.itemPath || '');
            const itemKey = String(item?.itemKey || '').trim() || makePlaylistItemKey(itemPath);
            if (!itemPath || !itemKey) continue;
            const sortIndex = Number(item?.sortIndex || 0) > 0 ? Number(item.sortIndex) : getNextPlaylistItemSortIndex(targetId);
            insertItem.run(targetId, itemKey, itemPath, Number(item?.addedAt || Date.now()), sortIndex);
        }
        restored.push({
            originalId,
            restoredId: targetId,
            restoredName: name,
            idConflict: !!existingById,
            nameConflict: name.toLowerCase() !== rawName.toLowerCase(),
        });
    }
    return restored;
}

function undoPlaylistHistoryById(historyId) {
    const id = String(historyId || '').trim();
    if (!id) throw new Error('Missing history id');
    const row = db.prepare(`
        SELECT id, action, payload_json AS payloadJson, undone_at AS undoneAt
        FROM playlist_history
        WHERE id = ?
    `).get(id);
    if (!row) throw new Error('History entry not found');
    if (Number(row.undoneAt || 0) > 0) throw new Error('History entry already undone');
    let payload = {};
    try { payload = JSON.parse(String(row.payloadJson || '{}')); } catch { payload = {}; }
    const action = String(row.action || '');

    db.exec('BEGIN');
    try {
        if (action === 'rename' || action === 'bulk-rename') {
            const changes = Array.isArray(payload?.changes) ? payload.changes : [];
            const update = db.prepare(`UPDATE playlists SET name = ? WHERE id = ?`);
            for (const change of changes) {
                const playlistId = String(change?.id || '').trim();
                const fromName = String(change?.from || '').trim();
                if (!playlistId || !fromName || !getPlaylistById(playlistId)) continue;
                const safeName = ensureUniquePlaylistName(fromName, { excludeId: playlistId });
                update.run(safeName, playlistId);
            }
        } else if (action === 'delete' || action === 'bulk-delete') {
            const snapshots = Array.isArray(payload?.snapshots) ? payload.snapshots : [];
            restorePlaylistSnapshots(snapshots);
        } else if (action === 'merge') {
            const targetId = String(payload?.targetId || '').trim();
            const addedItemKeys = Array.isArray(payload?.addedItemKeys)
                ? payload.addedItemKeys.map((key) => String(key || '').trim()).filter(Boolean)
                : [];
            if (targetId && addedItemKeys.length > 0) {
                const removeItem = db.prepare(`
                    DELETE FROM playlist_items
                    WHERE playlist_id = ? AND item_key = ?
                `);
                for (const itemKey of addedItemKeys) removeItem.run(targetId, itemKey);
            }
            const deletedSourceSnapshots = Array.isArray(payload?.deletedSourceSnapshots) ? payload.deletedSourceSnapshots : [];
            if (deletedSourceSnapshots.length > 0) restorePlaylistSnapshots(deletedSourceSnapshots);
        } else if (action === 'order') {
            const previousOrderIds = Array.isArray(payload?.previousOrderIds) ? payload.previousOrderIds : [];
            if (previousOrderIds.length > 0) applyPlaylistOrder(previousOrderIds);
        } else {
            throw new Error('Undo not supported for this action');
        }

        db.prepare(`UPDATE playlist_history SET undone_at = ? WHERE id = ?`).run(Date.now(), id);
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    return { id, action };
}

function createPlaylist(name) {
    const normalized = normalizePlaylistName(name);
    if (!normalized) throw new Error('Missing playlist name');

    const existing = getPlaylistByName(normalized);
    if (existing) return existing;

    const now = Date.now();
    const id = uuidv4();
    const sortIndex = getNextPlaylistSortIndex();
    db.prepare(`
        INSERT INTO playlists (id, name, created_at, sort_index)
        VALUES (?, ?, ?, ?)
    `).run(id, normalized, now, sortIndex);

    return { id, name: normalized, createdAt: now, sortIndex };
}

function addVideosToPlaylist(playlistId, videoPaths) {
    const validPaths = Array.isArray(videoPaths)
        ? [...new Set(videoPaths.map(normalizePlaylistItemPath).filter(Boolean))]
        : [];
    if (!playlistId || validPaths.length === 0) return { addedCount: 0, totalCount: 0 };

    const insertItem = db.prepare(`
        INSERT OR IGNORE INTO playlist_items (playlist_id, item_key, item_path, added_at, sort_index)
        VALUES (?, ?, ?, ?, ?)
    `);

    let addedCount = 0;
    const now = Date.now();
    let nextSortIndex = getNextPlaylistItemSortIndex(playlistId);
    for (const itemPath of validPaths) {
        const result = insertItem.run(playlistId, makePlaylistItemKey(itemPath), itemPath, now, nextSortIndex);
        if (result?.changes > 0) {
            addedCount += 1;
            nextSortIndex += 1;
        }
    }

    const row = db.prepare(`
        SELECT COUNT(*) AS count
        FROM playlist_items
        WHERE playlist_id = ?
    `).get(playlistId);

    return { addedCount, totalCount: Number(row?.count || 0) };
}

function listPlaylistsForManager() {
    const rows = db.prepare(`
        SELECT
            p.id,
            p.name,
            p.created_at AS createdAt,
            p.sort_index AS sortIndex,
            COUNT(pi.item_key) AS itemCount,
            COALESCE(SUM(CASE WHEN mdi.duration_sec > 0 THEN mdi.duration_sec ELSE 0 END), 0) AS totalDurationSec,
            MAX(pi.added_at) AS updatedAt
        FROM playlists p
        LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
        LEFT JOIN media_duration_index mdi ON mdi.file_path_key = pi.item_key
        GROUP BY p.id, p.name, p.created_at, p.sort_index
        ORDER BY p.sort_index ASC, LOWER(p.name) ASC
    `).all();
    return (rows || []).map((row) => ({
        id: String(row.id || ''),
        name: String(row.name || ''),
        createdAt: Number(row.createdAt || 0),
        sortIndex: Number(row.sortIndex || 0),
        itemCount: Number(row.itemCount || 0),
        totalDurationSec: Number(row.totalDurationSec || 0),
        updatedAt: Number(row.updatedAt || row.createdAt || 0),
    }));
}
function getPosterPath(folderPath) {
    const hash = path.normalize(folderPath).toLowerCase().split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
    return path.join(POSTER_DIR, `${Math.abs(hash).toString(36)}.jpg`);
}

function getPosterVersion(folderPath) {
    try {
        const stat = fs.statSync(getPosterPath(folderPath));
        return Number(stat?.mtimeMs || 0);
    } catch {
        return 0;
    }
}

function getBackdropPath(folderPath) {
    const hash = path.normalize(folderPath).toLowerCase().split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
    return path.join(BACKDROP_DIR, `${Math.abs(hash).toString(36)}.jpg`);
}

function hasPoster(folderPath) {
    return fs.existsSync(getPosterPath(folderPath));
}

function getBackdropVersion(folderPath) {
    try {
        const stat = fs.statSync(getBackdropPath(folderPath));
        return Number(stat?.mtimeMs || 0);
    } catch {
        return 0;
    }
}

function applySeriesMetadataToCaches(folderPath, metadataPatch = {}, extra = {}) {
    const target = path.normalize(String(folderPath || ''));
    if (!target) return;
    for (const cache of Object.values(libraryCache || {})) {
        if (!cache || !Array.isArray(cache.folders)) continue;
        for (const folder of cache.folders) {
            if (!folder?.path) continue;
            if (path.normalize(String(folder.path)) !== target) continue;
            if (metadataPatch && typeof metadataPatch === 'object') {
                folder.metadata = { ...(folder.metadata || {}), ...metadataPatch };
            }
            if (typeof extra.hasPoster === 'boolean') {
                folder.hasPoster = extra.hasPoster;
            }
            if (typeof extra.posterVersion === 'number' && Number.isFinite(extra.posterVersion)) {
                folder.posterVersion = extra.posterVersion;
            }
        }
    }
}

// â”€â”€ In-memory caches â”€â”€
let libraryCache = {}; // libraryId -> { videos: [], folders: [] }
// Global video lookup by ID for play functionality
let videoIndex = {}; // videoId -> video object with filePath
const tpdbVideoMetaByKey = new Map(); // normalized video path -> tpdb scene metadata
const tpdbPerformerById = new Map(); // performer id -> performer metadata
const tpdbVideoPerformersByKey = new Map(); // normalized video path -> performer refs
let isScanning = false;
let lastScanStartedAt = null;
let lastScanFinishedAt = null;
let lastScanDurationMs = 0;
let watchDebounceTimer = null;
let watchLastEventAtMs = 0;
const watchPendingLibraryIds = new Set();
const watchPendingReasonCounts = new Map();
const watchLibraryCooldownUntilMs = new Map();
const WATCH_LIBRARY_RESCAN_COOLDOWN_MS = 10000;
let rescanDebounceTimer = null;
let thumbnailDebounceTimer = null;
let heatmapDebounceTimer = null;
const libraryWatchers = new Map();

function loadSettings() {
    const normalizeLibraryType = (value) => {
        const raw = String(value || '').toLowerCase();
        if (raw === 'series') return 'series';
        if (raw === 'vr') return 'vr';
        return 'videos';
    };

    const settingsRow = db.prepare(`
        SELECT tmdb_api_key AS tmdbApiKey, tpdb_api_key AS tpdbApiKey, stashdb_api_key AS stashdbApiKey, theme_json AS themeJson, language, watch_folders AS watchFolders, player_type AS playerType,
               include_all_library AS includeAllLibrary, backup_schedule AS backupSchedule, backup_last_auto_at AS backupLastAutoAt
        FROM settings
        WHERE id = 1
    `).get();
    const libraryRows = db.prepare(`
        SELECT id, name, path, type, show_recent_added AS showRecentAdded, track_continue_watching AS trackContinueWatching
        FROM libraries
        ORDER BY rowid ASC
    `).all();

    return {
        libraries: (libraryRows || []).map(lib => ({
            ...lib,
            type: normalizeLibraryType(lib.type),
            showRecentAdded: lib.showRecentAdded === 0 ? false : true,
            trackContinueWatching: lib.trackContinueWatching === 0 ? false : true,
        })),
        tmdbApiKey: settingsRow?.tmdbApiKey || '',
        tpdbApiKey: settingsRow?.tpdbApiKey || '',
        stashdbApiKey: settingsRow?.stashdbApiKey || '',
        theme: settingsRow?.themeJson ? JSON.parse(settingsRow.themeJson) : {},
        language: settingsRow?.language || 'en',
        watchFolders: settingsRow?.watchFolders === 0 ? false : true,
        playerType: settingsRow?.playerType === 'external' ? 'external' : 'internal',
        includeAllLibrary: settingsRow?.includeAllLibrary === 1,
        backupSchedule: normalizeBackupSchedule(settingsRow?.backupSchedule),
        backupLastAutoAt: Number(settingsRow?.backupLastAutoAt || 0),
    };
}

function writeThemeCache(theme) {
    try {
        const safeTheme = {
            mode: theme?.mode === 'modern' ? 'modern' : 'default',
            modernPalette: ['silver', 'starlight', 'sky', 'lavender', 'copper'].includes(theme?.modernPalette)
                ? theme.modernPalette
                : 'silver',
        };
        fs.writeFileSync(THEME_CACHE_PATH, JSON.stringify(safeTheme), 'utf8');
    } catch { }
}

function saveSettings(settings) {
    const normalizeLibraryType = (value) => {
        const raw = String(value || '').toLowerCase();
        if (raw === 'series') return 'series';
        if (raw === 'vr') return 'vr';
        return 'videos';
    };

    const safe = {
        libraries: Array.isArray(settings.libraries) ? settings.libraries : [],
        tmdbApiKey: settings.tmdbApiKey || '',
        tpdbApiKey: settings.tpdbApiKey || '',
        stashdbApiKey: settings.stashdbApiKey || '',
        theme: settings.theme || {},
        language: ['de', 'en', 'es', 'ja', 'ru', 'ko'].includes(String(settings.language || '').toLowerCase())
            ? String(settings.language).toLowerCase()
            : 'en',
        watchFolders: settings.watchFolders === false ? false : true,
        playerType: settings.playerType === 'external' ? 'external' : 'internal',
        includeAllLibrary: settings.includeAllLibrary === true,
        backupSchedule: normalizeBackupSchedule(settings.backupSchedule),
    };

    db.exec('BEGIN');
    try {
        db.prepare(`
            UPDATE settings
            SET tmdb_api_key = ?, tpdb_api_key = ?, stashdb_api_key = ?, theme_json = ?, language = ?, watch_folders = ?, player_type = ?, include_all_library = ?, backup_schedule = ?
            WHERE id = 1
        `).run(safe.tmdbApiKey, safe.tpdbApiKey, safe.stashdbApiKey, JSON.stringify(safe.theme), safe.language, safe.watchFolders ? 1 : 0, safe.playerType, safe.includeAllLibrary ? 1 : 0, safe.backupSchedule);

        db.prepare(`DELETE FROM libraries`).run();
        const insertLibrary = db.prepare(`
            INSERT INTO libraries (id, name, path, type, show_recent_added, track_continue_watching)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const lib of safe.libraries) {
            if (!lib?.id || !lib?.path) continue;
            insertLibrary.run(
                lib.id,
                lib.name || path.basename(lib.path),
                lib.path,
                normalizeLibraryType(lib.type),
                lib.showRecentAdded === false ? 0 : 1,
                lib.trackContinueWatching === false ? 0 : 1
            );
        }

        db.exec('COMMIT');
        writeThemeCache(safe.theme);
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

function upsertWatchProgress(videoId, positionSec, durationSec) {
    const id = String(videoId || '').trim();
    if (!id) return;
    const pos = Number(positionSec);
    const dur = Number(durationSec);
    const safePos = Number.isFinite(pos) && pos > 0 ? pos : 0;
    const safeDur = Number.isFinite(dur) && dur > 0 ? dur : 0;
    db.prepare(`
        INSERT INTO watch_progress (video_id, position_sec, duration_sec, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
            position_sec = excluded.position_sec,
            duration_sec = excluded.duration_sec,
            updated_at = excluded.updated_at
    `).run(id, safePos, safeDur, Date.now());
}

function removeWatchProgress(videoId) {
    const id = String(videoId || '').trim();
    if (!id) return;
    db.prepare(`DELETE FROM watch_progress WHERE video_id = ?`).run(id);
}

function listWatchProgress(limit = 20) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
    const settings = loadSettings();
    const trackingMap = new Map(
        (settings.libraries || []).map((lib) => [String(lib.id), lib.trackContinueWatching !== false])
    );
    const rows = db.prepare(`
        SELECT video_id AS videoId, position_sec AS positionSec, duration_sec AS durationSec, updated_at AS updatedAt
        FROM watch_progress
        ORDER BY updated_at DESC
        LIMIT ?
    `).all(safeLimit);

    const result = [];
    for (const row of rows || []) {
        const video = videoIndex[row.videoId];
        if (!video) continue;
        const libraryId = String(video.libraryId || '');
        if (libraryId && trackingMap.get(libraryId) === false) continue;
        result.push({
            id: video.id,
            title: video.title,
            filePath: video.filePath,
            size: video.size,
            modifiedAt: video.modifiedAt,
            thumbVersion: getVideoThumbVersion(video.filePath, Number(video.modifiedAt || row.updatedAt || 0)),
            libraryId,
            libraryType: String(video.libraryType || 'videos').toLowerCase(),
            tags: Array.isArray(video.tags) ? video.tags : [],
            hasThumbnail: !!video.hasThumbnail,
            hasFunscript: !!video.hasFunscript,
            isMultiAxis: !!video.isMultiAxis,
            axes: Array.isArray(video.axes) ? video.axes : [],
            performers: Array.isArray(video.performers) ? video.performers : [],
            isFavorite: getVideoIsFavorite(video, getVideoFolderMetadata(video)),
            extension: video.extension || '',
            lastPositionSec: Number(row.positionSec || 0),
            durationSec: Number(row.durationSec || 0),
            updatedAt: Number(row.updatedAt || 0),
        });
    }
    return result;
}

function normalizeTagCategoryName(value) {
    const raw = String(value || '').trim().slice(0, 40);
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (lower === 'creator') return 'Artist';
    return raw;
}

function normalizeTagKey(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeFunscriptAxis(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw || raw === 'l0' || raw === 'default') return 'main';
    if (MULTI_AXIS_SUFFIXES.includes(raw)) return raw;
    return 'main';
}

function normalizeFunscriptLabel(value) {
    return String(value || '').trim().slice(0, 80);
}

function listFunscriptMappings(videoId = null) {
    if (videoId) {
        return db.prepare(`
            SELECT id, video_id AS videoId, script_path AS scriptPath, axis, label, is_default AS isDefault, offset_ms AS offsetMs, enabled, updated_at AS updatedAt
            FROM funscript_mappings
            WHERE video_id = ?
            ORDER BY axis ASC, is_default DESC, updated_at DESC
        `).all(String(videoId));
    }
    return db.prepare(`
        SELECT id, video_id AS videoId, script_path AS scriptPath, axis, label, is_default AS isDefault, offset_ms AS offsetMs, enabled, updated_at AS updatedAt
        FROM funscript_mappings
        ORDER BY updated_at DESC
    `).all();
}

function upsertFunscriptMapping({ videoId, scriptPath, axis = 'main', label = '', isDefault = true, offsetMs = 0, enabled = true }) {
    const now = Date.now();
    const normalizedVideoId = String(videoId || '').trim();
    const normalizedPath = path.normalize(String(scriptPath || '').trim());
    const normalizedAxis = normalizeFunscriptAxis(axis);
    const normalizedLabel = normalizeFunscriptLabel(label);
    if (!normalizedVideoId || !normalizedPath) return null;

    const existing = db.prepare(`
        SELECT id
        FROM funscript_mappings
        WHERE video_id = ? AND script_path = ? AND axis = ?
    `).get(normalizedVideoId, normalizedPath, normalizedAxis);
    const mappingId = existing?.id || uuidv4();

    db.prepare(`
        INSERT INTO funscript_mappings (id, video_id, script_path, axis, label, is_default, offset_ms, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id, script_path, axis) DO UPDATE SET
            label = excluded.label,
            is_default = excluded.is_default,
            offset_ms = excluded.offset_ms,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at
    `).run(
        mappingId,
        normalizedVideoId,
        normalizedPath,
        normalizedAxis,
        normalizedLabel,
        isDefault ? 1 : 0,
        Number(offsetMs || 0),
        enabled ? 1 : 0,
        now
    );
    return mappingId;
}

function setDefaultFunscriptMapping(mappingId, options = {}) {
    const id = String(mappingId || '').trim();
    if (!id) return null;
    const inTransaction = options?.inTransaction === true;
    const row = db.prepare(`
        SELECT id, video_id AS videoId, axis
        FROM funscript_mappings
        WHERE id = ?
    `).get(id);
    if (!row) return null;
    if (!inTransaction) db.exec('BEGIN');
    try {
        db.prepare(`
            UPDATE funscript_mappings
            SET is_default = 0, updated_at = ?
            WHERE video_id = ? AND axis = ?
        `).run(Date.now(), row.videoId, row.axis);
        db.prepare(`
            UPDATE funscript_mappings
            SET is_default = 1, updated_at = ?, enabled = 1
            WHERE id = ?
        `).run(Date.now(), id);
        if (!inTransaction) db.exec('COMMIT');
    } catch (err) {
        if (!inTransaction) db.exec('ROLLBACK');
        throw err;
    }
    return row;
}

function addFunscriptHistory(action, payload = {}) {
    const normalizedAction = String(action || '').trim().toLowerCase();
    if (!normalizedAction) return null;
    const videoId = String(payload.videoId || '').trim();
    const scriptPath = String(payload.scriptPath || '').trim();
    const axis = normalizeFunscriptAxis(payload.axis || '');
    const label = normalizeFunscriptLabel(payload.label || '');
    const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
    const id = uuidv4();
    const now = Date.now();
    db.prepare(`
        INSERT INTO funscript_history (id, action, video_id, script_path, axis, label, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        normalizedAction,
        videoId,
        scriptPath ? path.normalize(scriptPath) : '',
        axis || '',
        label || '',
        JSON.stringify(details),
        now
    );
    return id;
}

function listFunscriptHistory(limit = 40) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
    const rows = db.prepare(`
        SELECT id, action, video_id AS videoId, script_path AS scriptPath, axis, label, details_json AS detailsJson, created_at AS createdAt
        FROM funscript_history
        ORDER BY created_at DESC
        LIMIT ?
    `).all(safeLimit);
    return rows.map((row) => {
        let details = {};
        try { details = JSON.parse(String(row.detailsJson || '{}')); } catch { details = {}; }
        const video = row.videoId ? videoIndex[String(row.videoId)] : null;
        const resolvedVideoTitle = String(video?.title || details?.videoTitle || '');
        const resolvedVideoPath = String(video?.filePath || details?.videoPath || '');
        return {
            id: String(row.id || ''),
            action: String(row.action || ''),
            videoId: String(row.videoId || ''),
            videoTitle: resolvedVideoTitle,
            videoPath: resolvedVideoPath,
            scriptPath: String(row.scriptPath || ''),
            axis: String(row.axis || ''),
            label: String(row.label || ''),
            createdAt: Number(row.createdAt || 0),
            details,
        };
    });
}

function isContinueTrackingEnabledForVideoId(videoId) {
    const id = String(videoId || '').trim();
    if (!id) return true;
    const video = videoIndex[id];
    if (!video) return true;
    const libraryId = String(video.libraryId || '');
    if (!libraryId) return true;
    const settings = loadSettings();
    const lib = (settings.libraries || []).find((entry) => String(entry.id) === libraryId);
    return lib ? (lib.trackContinueWatching !== false) : true;
}

function normalizeVideoPathKey(videoPath) {
    return path.normalize(String(videoPath || '')).toLowerCase();
}

function getTpdbMetaForVideoPath(videoPath) {
    const key = normalizeVideoPathKey(videoPath);
    if (!key) return null;
    return tpdbVideoMetaByKey.get(key) || null;
}

function getVideoThumbVersion(videoPath, fallback = 0) {
    const meta = getTpdbMetaForVideoPath(videoPath);
    const v = Number(meta?.updatedAt || 0);
    if (Number.isFinite(v) && v > 0) return v;
    const fb = Number(fallback || 0);
    return Number.isFinite(fb) ? fb : 0;
}

function normalizeUiLanguage(value) {
    const raw = String(value || '').trim().toLowerCase();
    return UI_LANGS.has(raw) ? raw : 'en';
}

const PERFORMER_VALUE_TRANSLATIONS = {
    gender: {
        female: { de: 'Weiblich', en: 'Female', es: 'Femenino', ja: '女性', ru: 'Женский', ko: '여성' },
        male: { de: 'Männlich', en: 'Male', es: 'Masculino', ja: '男性', ru: 'Мужской', ko: '남성' },
        trans: { de: 'Trans', en: 'Trans', es: 'Trans', ja: 'トランス', ru: 'Транс', ko: '트랜스' },
        transgender: { de: 'Trans', en: 'Transgender', es: 'Transgénero', ja: 'トランスジェンダー', ru: 'Трансгендер', ko: '트랜스젠더' },
        nonbinary: { de: 'Nichtbinär', en: 'Non-binary', es: 'No binario', ja: 'ノンバイナリー', ru: 'Небинарный', ko: '논바이너리' },
    },
    breastType: {
        fake: { de: 'Künstlich', en: 'Fake', es: 'Artificial', ja: '豊胸', ru: 'Искусственная', ko: '보형물' },
        natural: { de: 'Natürlich', en: 'Natural', es: 'Natural', ja: 'ナチュラル', ru: 'Натуральная', ko: '자연' },
        augmented: { de: 'Vergrößert', en: 'Augmented', es: 'Aumentado', ja: '増強', ru: 'Увеличенная', ko: '확대' },
        implants: { de: 'Implantate', en: 'Implants', es: 'Implantes', ja: 'インプラント', ru: 'Импланты', ko: '임플란트' },
    },
    eyeColor: {
        brown: { de: 'Braun', en: 'Brown', es: 'Marrón', ja: '茶色', ru: 'Карие', ko: '갈색' },
        blue: { de: 'Blau', en: 'Blue', es: 'Azul', ja: '青', ru: 'Голубые', ko: '파란색' },
        green: { de: 'Grün', en: 'Green', es: 'Verde', ja: '緑', ru: 'Зелёные', ko: '초록색' },
        hazel: { de: 'Hasel', en: 'Hazel', es: 'Avellana', ja: 'ヘーゼル', ru: 'Ореховые', ko: '헤이즐' },
        gray: { de: 'Grau', en: 'Gray', es: 'Gris', ja: 'グレー', ru: 'Серые', ko: '회색' },
        grey: { de: 'Grau', en: 'Grey', es: 'Gris', ja: 'グレー', ru: 'Серые', ko: '회색' },
    },
    hairColor: {
        black: { de: 'Schwarz', en: 'Black', es: 'Negro', ja: '黒', ru: 'Чёрные', ko: '검은색' },
        brown: { de: 'Braun', en: 'Brown', es: 'Marrón', ja: '茶色', ru: 'Каштановые', ko: '갈색' },
        blonde: { de: 'Blond', en: 'Blonde', es: 'Rubio', ja: 'ブロンド', ru: 'Светлые', ko: '금발' },
        blond: { de: 'Blond', en: 'Blond', es: 'Rubio', ja: 'ブロンド', ru: 'Светлые', ko: '금발' },
        red: { de: 'Rot', en: 'Red', es: 'Rojo', ja: '赤', ru: 'Рыжие', ko: '빨간색' },
        brunette: { de: 'Brünett', en: 'Brunette', es: 'Castaño', ja: 'ブルネット', ru: 'Брюнетка', ko: '갈색(브루넷)' },
    },
    ethnicity: {
        caucasian: { de: 'Kaukasisch', en: 'Caucasian', es: 'Caucásica', ja: '白人', ru: 'Европеоидная', ko: '코카서스계' },
        asian: { de: 'Asiatisch', en: 'Asian', es: 'Asiática', ja: 'アジア系', ru: 'Азиатская', ko: '아시아계' },
        latina: { de: 'Lateinamerikanisch', en: 'Latina', es: 'Latina', ja: 'ラティーナ', ru: 'Латиноамериканская', ko: '라티나' },
        latino: { de: 'Lateinamerikanisch', en: 'Latino', es: 'Latino', ja: 'ラティーノ', ru: 'Латиноамериканский', ko: '라티노' },
        mixed: { de: 'Gemischt', en: 'Mixed', es: 'Mixta', ja: 'ミックス', ru: 'Смешанная', ko: '혼혈' },
    },
};

function normalizeLookupKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[_-]+/g, '');
}

function getMappedPerformerValue(domain, value, lang) {
    const safeLang = normalizeUiLanguage(lang);
    const map = PERFORMER_VALUE_TRANSLATIONS[String(domain || '')];
    if (!map) return '';
    const key = normalizeLookupKey(value);
    const hit = map[key];
    if (!hit) return '';
    return String(hit[safeLang] || hit.en || '').trim();
}

function toTitleCaseWords(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';
    return raw
        .split(/(\s+|-|\/)/g)
        .map((part) => {
            if (!part || /^(\s+|-|\/)$/.test(part)) return part;
            const upper = part.toUpperCase();
            // Keep short acronyms such as US/UK.
            if (/^[A-Z]{2,3}$/.test(upper)) return upper;
            const lower = part.toLowerCase();
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join('');
}

function prettifyPerformerDisplayValue(domain, value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const d = String(domain || '').trim();
    if (!['gender', 'breastType', 'ethnicity', 'eyeColor', 'hairColor'].includes(d)) return text;
    const hasLetters = /[A-Za-z]/.test(text);
    if (!hasLetters) return text;
    const allUpper = text === text.toUpperCase();
    const allLower = text === text.toLowerCase();
    if (!allUpper && !allLower) return text;
    return toTitleCaseWords(text);
}

function makeValueTranslationCacheKey(domain, sourceText, targetLang) {
    return `${String(domain || '').trim().toLowerCase()}|${normalizeUiLanguage(targetLang)}|${String(sourceText || '').trim().toLowerCase()}`;
}

function getCachedValueTranslation(domain, sourceText, targetLang) {
    const cacheKey = makeValueTranslationCacheKey(domain, sourceText, targetLang);
    const row = db.prepare(`
        SELECT translated_text AS translatedText
        FROM value_translations
        WHERE cache_key = ?
    `).get(cacheKey);
    return String(row?.translatedText || '').trim();
}

function setCachedValueTranslation(domain, sourceText, targetLang, translatedText) {
    const cacheKey = makeValueTranslationCacheKey(domain, sourceText, targetLang);
    const translated = String(translatedText || '').trim();
    if (!translated) return;
    db.prepare(`
        INSERT INTO value_translations (cache_key, domain, source_text, target_lang, translated_text, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
            translated_text = excluded.translated_text,
            updated_at = excluded.updated_at
    `).run(
        cacheKey,
        String(domain || '').trim().toLowerCase(),
        String(sourceText || '').trim(),
        normalizeUiLanguage(targetLang),
        translated,
        Date.now()
    );
}

async function autoTranslateUnknownText(sourceText, targetLang) {
    const text = String(sourceText || '').trim();
    const lang = normalizeUiLanguage(targetLang);
    if (!text || lang === 'en') return text;
    if (/^[\d\s.,:/()%-]+$/.test(text)) return text;
    const cached = getCachedValueTranslation('auto', text, lang);
    if (cached) return cached;
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(lang)}&dt=t&q=${encodeURIComponent(text)}`;
        const resp = await fetch(url, { method: 'GET' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const payload = await resp.json();
        const translated = Array.isArray(payload?.[0])
            ? payload[0].map((chunk) => String(chunk?.[0] || '')).join('').trim()
            : '';
        const out = translated || text;
        setCachedValueTranslation('auto', text, lang, out);
        return out;
    } catch {
        setCachedValueTranslation('auto', text, lang, text);
        return text;
    }
}

function tryLocalizeRegionToken(token, targetLang) {
    const raw = String(token || '').trim();
    const lang = normalizeUiLanguage(targetLang);
    if (!raw || lang === 'en') return raw;
    const upper = raw.toUpperCase();
    if (!/^[A-Z]{2}$/.test(upper)) return '';
    try {
        const dn = new Intl.DisplayNames([lang], { type: 'region' });
        const out = String(dn.of(upper) || '').trim();
        return out || '';
    } catch {
        return '';
    }
}

async function translatePerformerValue(domain, value, targetLang) {
    const text = String(value || '').trim();
    const lang = normalizeUiLanguage(targetLang);
    if (!text) return text;

    const mapped = getMappedPerformerValue(domain, text, lang);
    if (mapped) return mapped;

    if (lang === 'en') {
        return prettifyPerformerDisplayValue(domain, text);
    }

    const cacheDomain = `performer:${String(domain || '').trim().toLowerCase()}`;
    const cached = getCachedValueTranslation(cacheDomain, text, lang);
    if (cached) return cached;

    let translated = '';
    if (domain === 'nationality') {
        const tokens = text.split(',').map((p) => String(p || '').trim()).filter(Boolean);
        const out = [];
        for (const token of tokens) {
            const region = tryLocalizeRegionToken(token, lang);
            if (region) {
                out.push(region);
                continue;
            }
            const tokenMapped = getMappedPerformerValue('nationality', token, lang);
            if (tokenMapped) {
                out.push(tokenMapped);
                continue;
            }
            const tokenAuto = await autoTranslateUnknownText(token, lang);
            out.push(tokenAuto || token);
        }
        translated = out.join(', ');
    } else if (domain === 'birthplace') {
        const parts = text.split(',').map((p) => String(p || '').trim());
        translated = parts.map((part) => {
            const region = tryLocalizeRegionToken(part, lang);
            return region || part;
        }).join(', ');
    } else {
        translated = await autoTranslateUnknownText(text, lang);
    }

    const out = String(translated || text).trim();
    setCachedValueTranslation(cacheDomain, text, lang, out);
    return out;
}

function mapTpdbItemType(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'movie' || raw === 'movies') return 'movies';
    if (raw === 'jav') return 'jav';
    return 'scenes';
}

function mapTpdbItemTypeLabel(value) {
    const t = mapTpdbItemType(value);
    if (t === 'movies') return 'movie';
    if (t === 'jav') return 'jav';
    return 'scene';
}

function parseYearFromVideo(video) {
    const title = String(video?.title || '');
    const m = title.match(/\b(19|20)\d{2}\b/);
    if (!m || !m[0]) return '';
    return String(m[0]);
}

function normalizeMetadataSearchTerm(input = '') {
    const raw = String(input || '');
    if (!raw) return '';
    return raw
        .replace(/\.[a-z0-9]{2,4}$/i, ' ')
        .replace(/[._]+/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\b(1080p|720p|2160p|4k|x264|x265|h264|h265|hevc|aac|dts|bluray|web-dl|webrip|hdrip|proper|repack|uncensored|sub|eng|ger|jpn)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function computeOpenSubtitlesHash(filePath) {
    const target = String(filePath || '').trim();
    if (!target) return '';
    let fh = null;
    try {
        const stat = await fs.promises.stat(target);
        const size = Number(stat?.size || 0);
        if (size <= 0) return '';
        fh = await fs.promises.open(target, 'r');
        const chunkSize = 65536;
        const firstLen = Math.min(chunkSize, size);
        const lastOffset = Math.max(0, size - chunkSize);
        const lastLen = Math.min(chunkSize, size);
        const first = Buffer.alloc(firstLen);
        const last = Buffer.alloc(lastLen);
        await fh.read(first, 0, firstLen, 0);
        await fh.read(last, 0, lastLen, lastOffset);
        const mask = (1n << 64n) - 1n;
        let sum = BigInt(size) & mask;
        const accumulate = (buf) => {
            const loops = Math.floor(buf.length / 8);
            for (let i = 0; i < loops; i++) {
                const n = buf.readBigUInt64LE(i * 8);
                sum = (sum + n) & mask;
            }
        };
        accumulate(first);
        accumulate(last);
        return sum.toString(16).padStart(16, '0').toLowerCase();
    } catch {
        return '';
    } finally {
        if (fh) {
            try { await fh.close(); } catch { }
        }
    }
}

function parseStashSceneIdFromUrl(inputUrl = '') {
    const raw = String(inputUrl || '').trim();
    if (!raw) return null;
    let urlObj = null;
    try { urlObj = new URL(raw); } catch { return null; }
    const host = String(urlObj.hostname || '').toLowerCase();
    if (!host.includes('stashdb.org')) return null;
    const parts = String(urlObj.pathname || '')
        .split('/')
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    if (parts.length < 2) return null;
    const typeRaw = String(parts[0] || '').toLowerCase();
    const itemId = String(parts[1] || '').trim();
    if (!itemId) return null;
    if (typeRaw === 'scene' || typeRaw === 'scenes') return { itemType: 'scene', itemId };
    return null;
}

async function stashdbGraphql(query, variables = {}, apiKey = '') {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('StashDB API key is missing');
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Glyph/0.3',
        ApiKey: key,
        Authorization: `ApiKey ${key}`,
    };
    const res = await fetch(STASHDB_API_BASE, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: String(query || ''), variables: variables || {} }),
    });
    const rawBody = await res.text().catch(() => '');
    let payload = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = {}; }
    if (!res.ok) {
        const gqlError = Array.isArray(payload?.errors) && payload.errors.length > 0
            ? String(payload.errors[0]?.message || '').trim()
            : '';
        const bodyHint = String(rawBody || '').trim().slice(0, 300);
        const msg = String(payload?.error || payload?.message || gqlError || bodyHint || `StashDB request failed (${res.status})`);
        throw new Error(msg);
    }
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const msg = String(payload.errors[0]?.message || 'StashDB GraphQL error');
        throw new Error(msg);
    }
    return payload?.data || {};
}

function normalizeStashSceneImageList(images = []) {
    const list = Array.isArray(images) ? images : [];
    return list
        .map((row) => ({
            url: String(row?.url || '').trim(),
            width: Number(row?.width || 0),
            height: Number(row?.height || 0),
        }))
        .filter((row) => !!row.url);
}

function formatBodyModsValue(input) {
    if (Array.isArray(input)) {
        return input
            .map((row) => {
                if (typeof row === 'string') return row.trim();
                const location = String(row?.location || '').trim();
                const description = String(row?.description || '').trim();
                return [location, description].filter(Boolean).join(': ');
            })
            .filter(Boolean)
            .join(', ');
    }
    return String(input || '').trim();
}

function pickStashSceneImages(images = []) {
    const list = normalizeStashSceneImageList(images);
    if (list.length === 0) return { thumbUrl: '', posterUrl: '' };
    const byArea = [...list].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const landscape = byArea.find((img) => Number(img.width) >= Number(img.height) && img.url) || null;
    const portrait = byArea.find((img) => Number(img.height) > Number(img.width) && img.url) || null;
    const best = byArea[0];
    const thumbUrl = String((landscape || portrait || best)?.url || '').trim();
    const posterUrl = String((portrait || landscape || best)?.url || '').trim();
    return {
        thumbUrl: toAbsoluteTpdbUrl(thumbUrl),
        posterUrl: toAbsoluteTpdbUrl(posterUrl),
    };
}

function normalizeStashPerformer(raw = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const id = String(src?.id || '').trim();
    const name = String(src?.name || '').trim();
    const disambiguation = String(src?.disambiguation || '').trim();
    const images = normalizeStashSceneImageList(src?.images || []);
    const imageUrl = String(images[0]?.url || '').trim();
    const aliases = Array.isArray(src?.aliases)
        ? src.aliases.map((v) => String(v || '').trim()).filter(Boolean)
        : [];
    const toNum = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    return {
        id: id ? `stash:${id}` : (name ? `name:${slugifyStable(name)}` : ''),
        name,
        disambiguation,
        imageUrl,
        faceUrl: imageUrl,
        bio: '',
        age: toNum(src?.age),
        birthdate: String(src?.birth_date || '').trim(),
        birthplace: String(src?.country || '').trim(),
        nationality: String(src?.country || '').trim(),
        gender: String(src?.gender || '').trim(),
        careerStartYear: toNum(src?.career_start_year),
        careerEndYear: toNum(src?.career_end_year),
        heightCm: toNum(src?.height),
        cupSize: String(src?.cup_size || '').trim(),
        bandSize: String(src?.band_size || '').trim(),
        waistSize: toNum(src?.waist_size),
        hipSize: toNum(src?.hip_size),
        breastType: String(src?.breast_type || '').trim(),
        ethnicity: String(src?.ethnicity || '').trim(),
        eyeColor: String(src?.eye_color || '').trim(),
        hairColor: String(src?.hair_color || '').trim(),
        tattoos: formatBodyModsValue(src?.tattoos),
        piercings: formatBodyModsValue(src?.piercings),
        aliases,
        raw: {
            ...src,
            images,
            aliases,
        },
    };
}

function normalizeStashSceneResult(raw = {}) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const id = String(src?.id || '').trim();
    const title = String(src?.title || '').trim();
    const details = String(src?.details || '').trim();
    const date = String(src?.release_date || src?.production_date || '').trim();
    const siteName = String(src?.studio?.name || '').trim();
    const urls = Array.isArray(src?.urls) ? src.urls : [];
    const sourceUrlRaw = String(urls.find((u) => typeof u?.url === 'string' && u.url.trim())?.url || '').trim();
    const sourceUrl = sourceUrlRaw || (id ? `https://stashdb.org/scenes/${encodeURIComponent(id)}` : '');
    const { thumbUrl, posterUrl } = pickStashSceneImages(src?.images || []);
    const performersRaw = Array.isArray(src?.performers) ? src.performers : [];
    const performers = performersRaw
        .map((p) => normalizeStashPerformer(p?.performer || p))
        .filter((p) => p.id || p.name);
    return {
        id: id ? `stash:${id}` : '',
        provider: 'stashdb',
        itemType: 'scene',
        title,
        description: details,
        date,
        siteName,
        thumbUrl,
        posterUrl,
        sourceUrl,
        performers,
        raw: src,
    };
}

function unwrapStashSceneRow(row) {
    if (!row || typeof row !== 'object') return null;
    if (row.scene && typeof row.scene === 'object') return row.scene;
    if (row.node && typeof row.node === 'object') return row.node;
    return row;
}

function normalizeStashSceneRows(value) {
    if (Array.isArray(value)) {
        return value
            .map(unwrapStashSceneRow)
            .filter((row) => row && typeof row === 'object');
    }
    if (value && typeof value === 'object') {
        if (Array.isArray(value.scenes)) {
            return value.scenes
                .map(unwrapStashSceneRow)
                .filter((row) => row && typeof row === 'object');
        }
        if (Array.isArray(value.results)) {
            return value.results
                .map(unwrapStashSceneRow)
                .filter((row) => row && typeof row === 'object');
        }
        const single = unwrapStashSceneRow(value);
        return single && typeof single === 'object' ? [single] : [];
    }
    return [];
}

async function resolveStashSceneById(sceneId) {
    const id = String(sceneId || '').trim();
    if (!id) return null;
    const settings = loadSettings();
    const apiKey = String(settings?.stashdbApiKey || '').trim();
    if (!apiKey) return null;
    const query = `
        query FindScene($id: ID!) {
            findScene(id: $id) {
                id
                title
                details
                release_date
                production_date
                urls { url }
                studio { id name }
                images { url width height }
                performers {
                    performer {
                        id
                        name
                        disambiguation
                        gender
                        birth_date
                        country
                        images { url width height }
                    }
                }
            }
        }
    `;
    const data = await stashdbGraphql(query, { id }, apiKey);
    const scene = data?.findScene || null;
    if (!scene) return null;
    const normalized = normalizeStashSceneResult(scene);
    if (!normalized?.id) return null;
    return normalized;
}

async function resolveStashSearch({ video, query, useHash = true }) {
    const settings = loadSettings();
    const apiKey = String(settings?.stashdbApiKey || '').trim();
    if (!apiKey) return [];
    const rawTerm = String(query || video?.title || '').trim();
    const normalizedTerm = normalizeMetadataSearchTerm(rawTerm);
    const termCandidates = [...new Set([rawTerm, normalizedTerm].filter(Boolean))];
    const parseTerm = termCandidates[0] || '';
    const duration = Math.max(0, Math.round(Number(video?.duration || video?.durationSec || 0)));
    const hash = (useHash && video?.filePath) ? await computeOpenSubtitlesHash(video.filePath) : '';
    const out = [];
    const seen = new Set();
    const runStashQuery = async (label, gql, variables) => {
        try {
            return await stashdbGraphql(gql, variables, apiKey);
        } catch (err) {
            addRuntimeLog('warn', 'tpdb', `StashDB ${label} failed`, {
                error: String(err?.message || err || ''),
            });
            return null;
        }
    };

    if (hash) {
        const byFingerprintDirectQuery = `
            query FindByFingerprint($fp: FingerprintQueryInput!) {
                findSceneByFingerprint(fingerprint: $fp) {
                    id
                    title
                    details
                    release_date
                    production_date
                    urls { url }
                    studio { id name }
                    images { url width height }
                    performers {
                        performer {
                            id
                            name
                            disambiguation
                            gender
                            birth_date
                            country
                            images { url width height }
                        }
                    }
                }
            }
        `;
        const hashVariants = [...new Set([String(hash || '').toLowerCase(), String(hash || '').toUpperCase()].filter(Boolean))];
        for (const hashValue of hashVariants) {
            const data = await runStashQuery('findSceneByFingerprint', byFingerprintDirectQuery, {
                fp: { hash: hashValue, algorithm: 'OSHASH' },
            });
            const scenes = normalizeStashSceneRows(data?.findSceneByFingerprint);
            for (const scene of scenes) {
                const normalized = normalizeStashSceneResult(scene);
                if (!normalized?.id || seen.has(normalized.id)) continue;
                seen.add(normalized.id);
                out.push(normalized);
            }
            if (out.length > 0) break;
        }
    }

    if (out.length === 0 && hash) {
        const byFingerprintQuery = `
            query QueryExistingScene($input: QueryExistingSceneInput!) {
                queryExistingScene(input: $input) {
                    scenes {
                        id
                        title
                        details
                        release_date
                        production_date
                        urls { url }
                        studio { id name }
                        images { url width height }
                        performers {
                            performer {
                                id
                                name
                                disambiguation
                                gender
                                birth_date
                                country
                                images { url width height }
                            }
                        }
                    }
                }
            }
        `;
        const fingerprint = duration > 0
            ? { hash, algorithm: 'OSHASH', duration }
            : { hash, algorithm: 'OSHASH' };
        const data = await runStashQuery('queryExistingScene', byFingerprintQuery, {
            input: {
                title: undefined,
                fingerprints: [fingerprint],
            },
        });
        const scenes = normalizeStashSceneRows(data?.queryExistingScene);
        for (const scene of scenes) {
            const normalized = normalizeStashSceneResult(scene);
            if (!normalized?.id || seen.has(normalized.id)) continue;
            seen.add(normalized.id);
            out.push(normalized);
        }
    }

    if (out.length === 0 && termCandidates.length > 0) {
        const sceneFields = `
            id
            title
            details
            release_date
            production_date
            urls { url }
            studio { id name }
            images { url width height }
            performers {
                performer {
                    id
                    name
                    disambiguation
                    gender
                    birth_date
                    country
                    images { url width height }
                }
            }
        `;
        const searchSceneQuery = `
            query SearchScene($term: String!, $limit: Int) {
                searchScene(term: $term, limit: $limit) {
                    ${sceneFields}
                }
            }
        `;
        const pushScenes = (rows) => {
            for (const scene of rows) {
                const normalized = normalizeStashSceneResult(scene);
                if (!normalized?.id || seen.has(normalized.id)) continue;
                seen.add(normalized.id);
                out.push(normalized);
            }
        };
        for (const term of termCandidates) {
            const dataSearchScene = await runStashQuery('searchScene', searchSceneQuery, { term, limit: 25 });
            const searchSceneRows = normalizeStashSceneRows(dataSearchScene?.searchScene);
            pushScenes(searchSceneRows);
            if (out.length > 0) break;
        }
    }

    return out;
}

async function resolveStashPerformerImageCandidates(performer = {}) {
    const settings = loadSettings();
    const apiKey = String(settings?.stashdbApiKey || '').trim();
    if (!apiKey) return [];

    const out = [];
    const seen = new Set();
    const pushUrl = (value) => {
        const url = toAbsoluteTpdbUrl(value);
        if (!url) return;
        const key = canonicalizeImageUrl(url);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(url);
    };

    try {
        const rawImages = normalizeStashSceneImageList(performer?.raw?.images || []);
        for (const img of rawImages) pushUrl(img?.url);
    } catch { }

    const performerIdRaw = String(performer?.id || '').trim();
    const stashId = performerIdRaw.startsWith('stash:') ? performerIdRaw.slice('stash:'.length) : '';
    if (stashId) {
        const byIdQuery = `
            query FindPerformer($id: ID!) {
                findPerformer(id: $id) {
                    id
                    name
                    disambiguation
                    images { url width height }
                }
            }
        `;
        try {
            const data = await stashdbGraphql(byIdQuery, { id: stashId }, apiKey);
            const rows = normalizeStashSceneImageList(data?.findPerformer?.images || []);
            for (const img of rows) pushUrl(img?.url);
        } catch { }
    }

    const performerName = String(performer?.name || '').trim();
    if (performerName) {
        const byNameQuery = `
            query SearchPerformer($term: String!, $limit: Int) {
                searchPerformer(term: $term, limit: $limit) {
                    id
                    name
                    disambiguation
                    images { url width height }
                }
            }
        `;
        try {
            const data = await stashdbGraphql(byNameQuery, { term: performerName, limit: 20 }, apiKey);
            const rows = Array.isArray(data?.searchPerformer) ? data.searchPerformer : [];
            const exactKey = normalizePersonKey(performerName);
            const exact = [];
            for (const row of rows) {
                const rowKey = normalizePersonKey(row?.name || '');
                if (rowKey && rowKey === exactKey) exact.push(row);
            }
            // Avoid cross-person contamination: only exact name matches.
            // If there are multiple exact rows, keep the best single candidate by image count.
            const bestExact = exact
                .sort((a, b) => {
                    const aCount = Array.isArray(a?.images) ? a.images.length : 0;
                    const bCount = Array.isArray(b?.images) ? b.images.length : 0;
                    return bCount - aCount;
                })
                .slice(0, 1);
            for (const candidate of bestExact) {
                const imgs = normalizeStashSceneImageList(candidate?.images || []);
                for (const img of imgs) pushUrl(img?.url);
            }
        } catch { }
    }

    return out;
}

async function tpdbApiGet(endpoint, apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) throw new Error('ThePornDB API key is missing');
    const url = `${TPDB_API_BASE}${String(endpoint || '')}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${key}`,
            Accept: 'application/json',
            'User-Agent': 'Glyph/0.3',
        },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = String(data?.message || data?.error || `TPDB request failed (${res.status})`);
        throw new Error(msg);
    }
    return data;
}

function extractTpdbArray(raw) {
    if (Array.isArray(raw?.data)) return raw.data;
    if (Array.isArray(raw?.results)) return raw.results;
    if (Array.isArray(raw?.items)) return raw.items;
    if (Array.isArray(raw?.data?.results)) return raw.data.results;
    if (Array.isArray(raw?.data?.items)) return raw.data.items;
    if (Array.isArray(raw?.payload?.results)) return raw.payload.results;
    return [];
}

function extractTpdbObject(raw) {
    if (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) return raw.data;
    if (raw?.result && typeof raw.result === 'object' && !Array.isArray(raw.result)) return raw.result;
    if (raw?.item && typeof raw.item === 'object' && !Array.isArray(raw.item)) return raw.item;
    const list = extractTpdbArray(raw);
    return list.length > 0 ? list[0] : null;
}

function parseTpdbItemIdFromUrl(inputUrl = '') {
    const raw = String(inputUrl || '').trim();
    if (!raw) return null;
    let urlObj = null;
    try { urlObj = new URL(raw); } catch { return null; }
    const host = String(urlObj.hostname || '').toLowerCase();
    if (!host.includes('theporndb.net')) return null;
    const parts = String(urlObj.pathname || '')
        .split('/')
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    if (parts.length < 2) return null;
    const typeRaw = parts[0].toLowerCase();
    const itemId = parts[1];
    if (!itemId) return null;
    if (typeRaw === 'scene' || typeRaw === 'scenes') return { itemType: 'scenes', itemId };
    if (typeRaw === 'movie' || typeRaw === 'movies') return { itemType: 'movies', itemId };
    if (typeRaw === 'jav') return { itemType: 'jav', itemId };
    if (typeRaw === 'performer' || typeRaw === 'performers') return { itemType: 'performers', itemId };
    return null;
}

function slugifyStable(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function normalizePersonKey(value = '') {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function toAbsoluteTpdbUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('/')) return `${TPDB_WEB_BASE}${raw}`;
    return raw;
}

function canonicalizeImageUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        return `${String(u.hostname || '').toLowerCase()}${String(u.pathname || '')}`;
    } catch {
        return raw.toLowerCase();
    }
}

function canonicalizePerformerImageVisualKey(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const u = new URL(raw);
        const decodedPath = decodeURIComponent(String(u.pathname || ''));
        const cleanedPath = decodedPath
            .replace(/\/poster\/c\//g, '/poster/')
            .replace(/-thumb\.(jpg|jpeg|png|webp)$/i, '.$1');
        return `${String(u.hostname || '').toLowerCase()}${cleanedPath.toLowerCase()}`;
    } catch {
        return canonicalizeImageUrl(raw);
    }
}

function isCroppedTpdbImageVariant(value = '') {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return false;
    return raw.includes('/poster/c/') || raw.includes('-thumb.');
}

function normalizeTpdbPerformer(raw = {}) {
    if (typeof raw === 'string') {
        const name = String(raw || '').trim();
        return {
            id: '',
            name,
            disambiguation: '',
            imageUrl: '',
            faceUrl: '',
            bio: '',
            age: null,
            birthdate: '',
            birthplace: '',
            nationality: '',
            gender: '',
            extras: {},
            posters: [],
            raw: { name },
        };
    }
    const hasEmbeddedRaw = raw && typeof raw === 'object' && raw.raw && typeof raw.raw === 'object';
    const source = hasEmbeddedRaw ? raw.raw : raw;
    const extrasA = source?.extras && typeof source.extras === 'object' ? source.extras : {};
    const extrasB = source?.extra && typeof source.extra === 'object' ? source.extra : {};
    const parent = source?.parent && typeof source.parent === 'object' ? source.parent : {};
    const parentExtrasA = parent?.extras && typeof parent.extras === 'object' ? parent.extras : {};
    const parentExtrasB = parent?.extra && typeof parent.extra === 'object' ? parent.extra : {};
    const extras = { ...parentExtrasA, ...parentExtrasB, ...extrasA, ...extrasB };
    const posters = source?.posters && typeof source.posters === 'object' ? source.posters : {};
    const images = source?.images && typeof source.images === 'object' ? source.images : {};
    const avatar = source?.avatar && typeof source.avatar === 'object' ? source.avatar : {};
    const imageCandidates = [
        source?.imageUrl,
        source?.faceUrl,
        source?.posterUrl,
        source?.image,
        source?.face,
        source?.poster,
        source?.thumb,
        source?.thumbnail,
        source?.avatar,
        avatar?.url,
        avatar?.large,
        avatar?.medium,
        posters?.large,
        posters?.medium,
        posters?.small,
        posters?.original,
        images?.large,
        images?.medium,
        images?.small,
        images?.original,
        images?.avatar,
        images?.portrait,
        images?.headshot,
        parent?.image,
        parent?.thumbnail,
        parent?.face,
        raw?.imageUrl,
        raw?.faceUrl,
        raw?.posterUrl,
        raw?.image,
        raw?.face,
        raw?.poster,
        raw?.thumb,
        raw?.thumbnail,
    ].map((v) => toAbsoluteTpdbUrl(v)).filter(Boolean);
    const birthdate = String(extras?.birthday || source?.birthdate || source?.birthday || source?.date_of_birth || raw?.birthdate || raw?.birthday || parent?.birthdate || parent?.birthday || '').trim();
    const birthplace = String(extras?.birthplace || source?.birthplace || source?.birth_place || raw?.birthplace || raw?.birth_place || parent?.birthplace || parent?.birth_place || '').trim();
    const nationality = String(extras?.nationality || source?.nationality || source?.country || raw?.nationality || raw?.country || parent?.nationality || parent?.country || '').trim();
    const gender = String(extras?.gender || source?.gender || source?.sex || raw?.gender || raw?.sex || parent?.gender || parent?.sex || '').trim();
    const bio = String(source?.Bio || source?.bio || source?.biography || source?.description || raw?.bio || raw?.biography || raw?.description || parent?.bio || parent?.biography || parent?.description || '').trim();
    const ageRaw = Number(source?.age || raw?.age || extras?.age || parent?.age || 0);
    return {
        id: String(source?.id || source?._id || raw?.id || raw?._id || parent?.id || parent?._id || '').trim(),
        name: String(source?.name || raw?.name || parent?.name || '').trim(),
        disambiguation: String(source?.disambiguation || raw?.disambiguation || parent?.disambiguation || '').trim(),
        imageUrl: imageCandidates[0] || '',
        faceUrl: toAbsoluteTpdbUrl(source?.face || source?.faceUrl || raw?.face || raw?.faceUrl || parent?.face || ''),
        selectedImageUrl: toAbsoluteTpdbUrl(raw?.selectedImageUrl || source?.selectedImageUrl || raw?._glyphSelectedImage || source?._glyphSelectedImage || ''),
        bio,
        age: Number.isFinite(ageRaw) && ageRaw > 0 ? ageRaw : null,
        birthdate,
        birthplace,
        nationality,
        gender,
        extras,
        posters: Array.isArray(source?.posters) ? source.posters : (Array.isArray(raw?.posters) ? raw.posters : []),
        raw: source && typeof source === 'object' ? source : {},
    };
}

function pickFirstNonEmpty(...values) {
    for (const value of values) {
        const s = String(value || '').trim();
        if (s) return s;
    }
    return '';
}

function pickTpdbSceneImages(raw = {}) {
    const thumbnailsObj = raw?.thumbnails && typeof raw.thumbnails === 'object' ? raw.thumbnails : {};
    const postersObj = raw?.posters && typeof raw.posters === 'object' ? raw.posters : {};
    const imagesObj = raw?.images && typeof raw.images === 'object' ? raw.images : {};

    // Prefer landscape/still/preview-like assets for video thumbnails.
    const thumbUrl = pickFirstNonEmpty(
        raw?.thumbnail,
        raw?.thumb,
        raw?.image,
        raw?.background,
        raw?.backdrop,
        thumbnailsObj?.large,
        thumbnailsObj?.medium,
        thumbnailsObj?.small,
        thumbnailsObj?.original,
        imagesObj?.thumbnail,
        imagesObj?.thumb,
        imagesObj?.image,
        imagesObj?.background,
        imagesObj?.backdrop,
        raw?.preview,
        raw?.cover,
        raw?.poster,
        postersObj?.large,
        postersObj?.medium,
        postersObj?.small,
        postersObj?.original
    );

    // Keep a dedicated poster field too (useful for details/history).
    const posterUrl = pickFirstNonEmpty(
        raw?.poster,
        postersObj?.large,
        postersObj?.medium,
        postersObj?.small,
        postersObj?.original,
        raw?.image,
        raw?.thumbnail,
        raw?.thumb
    );

    return { thumbUrl: toAbsoluteTpdbUrl(thumbUrl), posterUrl: toAbsoluteTpdbUrl(posterUrl) };
}

function normalizeTpdbSceneResult(raw = {}, itemType = 'scenes') {
    const siteObj = raw?.site && typeof raw.site === 'object' ? raw.site : {};
    const performers = Array.isArray(raw?.performers)
        ? raw.performers.map((p) => normalizeTpdbPerformer(p)).filter((p) => p.id || p.name)
        : [];
    const title = String(raw?.title || '').trim();
    const { thumbUrl, posterUrl } = pickTpdbSceneImages(raw);
    const id = String(raw?.id || raw?._id || '').trim();
    return {
        id,
        itemType: mapTpdbItemType(itemType),
        title,
        description: String(raw?.description || '').trim(),
        date: String(raw?.date || '').trim(),
        siteName: String(siteObj?.name || '').trim(),
        thumbUrl: String(thumbUrl || '').trim(),
        posterUrl,
        sourceUrl: id ? `${TPDB_WEB_BASE}/${mapTpdbItemType(itemType)}/${encodeURIComponent(id)}` : '',
        performers,
        raw,
    };
}

function loadTpdbCaches() {
    tpdbVideoMetaByKey.clear();
    tpdbPerformerById.clear();
    tpdbVideoPerformersByKey.clear();

    const metaRows = db.prepare(`
        SELECT video_key AS videoKey, video_path AS videoPath, item_type AS itemType, item_id AS itemId, source_url AS sourceUrl,
               title, description, release_date AS releaseDate, site_name AS siteName, poster_url AS posterUrl, data_json AS dataJson, updated_at AS updatedAt
        FROM tpdb_video_metadata
    `).all();
    for (const row of metaRows || []) {
        let raw = {};
        try { raw = JSON.parse(String(row?.dataJson || '{}')); } catch { raw = {}; }
        const key = String(row?.videoKey || '').trim();
        if (!key) continue;
        tpdbVideoMetaByKey.set(key, {
            videoKey: key,
            videoPath: String(row?.videoPath || ''),
            itemType: String(row?.itemType || 'scene'),
            itemId: String(row?.itemId || ''),
            sourceUrl: String(row?.sourceUrl || ''),
            title: String(row?.title || ''),
            description: String(row?.description || ''),
            releaseDate: String(row?.releaseDate || ''),
            siteName: String(row?.siteName || ''),
            posterUrl: String(row?.posterUrl || ''),
            updatedAt: Number(row?.updatedAt || 0),
            raw,
        });
    }

    const performerRows = db.prepare(`
        SELECT performer_id AS performerId, name, disambiguation, image_url AS imageUrl, face_url AS faceUrl,
               selected_image_url AS selectedImageUrl,
               bio, birthdate, birthplace, nationality, gender, data_json AS dataJson, updated_at AS updatedAt
        FROM tpdb_performers
    `).all();
    for (const row of performerRows || []) {
        let raw = {};
        try { raw = JSON.parse(String(row?.dataJson || '{}')); } catch { raw = {}; }
        const id = String(row?.performerId || '').trim();
        if (!id) continue;
        const normalizedFromRaw = normalizeTpdbPerformer(raw || {});
        tpdbPerformerById.set(id, {
            id,
            name: String(row?.name || normalizedFromRaw?.name || '').trim(),
            disambiguation: String(row?.disambiguation || normalizedFromRaw?.disambiguation || '').trim(),
            imageUrl: String(row?.imageUrl || normalizedFromRaw?.imageUrl || '').trim(),
            faceUrl: String(row?.faceUrl || normalizedFromRaw?.faceUrl || '').trim(),
            selectedImageUrl: toAbsoluteTpdbUrl(row?.selectedImageUrl || normalizedFromRaw?.selectedImageUrl || ''),
            bio: String(row?.bio || normalizedFromRaw?.bio || '').trim(),
            birthdate: String(row?.birthdate || normalizedFromRaw?.birthdate || '').trim(),
            birthplace: String(row?.birthplace || normalizedFromRaw?.birthplace || '').trim(),
            nationality: String(row?.nationality || normalizedFromRaw?.nationality || '').trim(),
            gender: String(row?.gender || normalizedFromRaw?.gender || '').trim(),
            updatedAt: Number(row?.updatedAt || 0),
            raw: raw && typeof raw === 'object' ? raw : (normalizedFromRaw?.raw || {}),
        });
    }

    const relationRows = db.prepare(`
        SELECT video_key AS videoKey, performer_id AS performerId, performer_name AS performerName, sort_index AS sortIndex
        FROM tpdb_video_performers
        ORDER BY sort_index ASC, performer_name ASC
    `).all();
    for (const row of relationRows || []) {
        const key = String(row?.videoKey || '').trim();
        const performerId = String(row?.performerId || '').trim();
        if (!key || !performerId) continue;
        if (!tpdbVideoPerformersByKey.has(key)) tpdbVideoPerformersByKey.set(key, []);
        tpdbVideoPerformersByKey.get(key).push({
            id: performerId,
            name: String(row?.performerName || ''),
            sortIndex: Number(row?.sortIndex || 0),
        });
    }
}

function applyTpdbMetaToVideoObject(video) {
    if (!video?.filePath) return video;
    const key = normalizeVideoPathKey(video.filePath);
    const meta = tpdbVideoMetaByKey.get(key);
    if (!meta) return video;
    if (meta.title) video.title = meta.title;
    if (meta.description) video.tpdbDescription = meta.description;
    if (meta.releaseDate) video.tpdbReleaseDate = meta.releaseDate;
    if (meta.siteName) video.tpdbSiteName = meta.siteName;
    if (meta.itemType) video.tpdbItemType = meta.itemType;
    if (meta.itemId) video.tpdbItemId = meta.itemId;
    const performers = tpdbVideoPerformersByKey.get(key) || [];
    if (performers.length > 0) {
        video.performers = performers.map((p) => ({
            id: p.id,
            name: p.name || tpdbPerformerById.get(p.id)?.name || '',
            gender: String(tpdbPerformerById.get(p.id)?.gender || '').trim(),
        }));
    } else {
        video.performers = [];
    }
    video.thumbVersion = getVideoThumbVersion(video.filePath, Number(video?.modifiedAt || 0));
    return video;
}

function setTpdbVideoMetadata(videoPath, payload = {}) {
    const key = normalizeVideoPathKey(videoPath);
    if (!key) return null;
    const now = Date.now();
    const meta = {
        videoKey: key,
        videoPath: path.normalize(String(videoPath || '')),
        itemType: String(payload.itemType || 'scene'),
        itemId: String(payload.itemId || ''),
        sourceUrl: String(payload.sourceUrl || ''),
        title: String(payload.title || ''),
        description: String(payload.description || ''),
        releaseDate: String(payload.releaseDate || ''),
        siteName: String(payload.siteName || ''),
        posterUrl: String(payload.posterUrl || ''),
        raw: payload.raw && typeof payload.raw === 'object' ? payload.raw : {},
        updatedAt: now,
    };
    db.prepare(`
        INSERT INTO tpdb_video_metadata (
            video_key, video_path, item_type, item_id, source_url, title, description, release_date, site_name, poster_url, data_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_key) DO UPDATE SET
            video_path = excluded.video_path,
            item_type = excluded.item_type,
            item_id = excluded.item_id,
            source_url = excluded.source_url,
            title = excluded.title,
            description = excluded.description,
            release_date = excluded.release_date,
            site_name = excluded.site_name,
            poster_url = excluded.poster_url,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
    `).run(
        meta.videoKey,
        meta.videoPath,
        meta.itemType,
        meta.itemId,
        meta.sourceUrl,
        meta.title,
        meta.description,
        meta.releaseDate,
        meta.siteName,
        meta.posterUrl,
        JSON.stringify(meta.raw || {}),
        meta.updatedAt
    );
    tpdbVideoMetaByKey.set(key, meta);
    return meta;
}

function setTpdbPerformer(performer = {}) {
    const now = Date.now();
    const normalized = normalizeTpdbPerformer(performer);
    const fallbackName = String(normalized.name || '').trim();
    const id = String(normalized.id || '').trim() || (fallbackName ? `name:${slugifyStable(fallbackName)}` : '');
    if (!id) return null;
    const existing = tpdbPerformerById.get(id) || {};
    const selectedImageUrl = toAbsoluteTpdbUrl(
        performer?.selectedImageUrl ||
        normalized?.selectedImageUrl ||
        existing?.selectedImageUrl ||
        ''
    );
    db.prepare(`
        INSERT INTO tpdb_performers (
            performer_id, name, disambiguation, image_url, face_url, selected_image_url, bio, birthdate, birthplace, nationality, gender, data_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(performer_id) DO UPDATE SET
            name = excluded.name,
            disambiguation = excluded.disambiguation,
            image_url = excluded.image_url,
            face_url = excluded.face_url,
            selected_image_url = excluded.selected_image_url,
            bio = excluded.bio,
            birthdate = excluded.birthdate,
            birthplace = excluded.birthplace,
            nationality = excluded.nationality,
            gender = excluded.gender,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at
    `).run(
        id,
        normalized.name,
        normalized.disambiguation,
        normalized.imageUrl,
        normalized.faceUrl,
        selectedImageUrl,
        normalized.bio,
        normalized.birthdate,
        normalized.birthplace,
        normalized.nationality,
        normalized.gender,
        JSON.stringify(normalized.raw || {}),
        now
    );
    const out = {
        id,
        name: normalized.name,
        disambiguation: normalized.disambiguation,
        imageUrl: normalized.imageUrl,
        faceUrl: normalized.faceUrl,
        selectedImageUrl,
        bio: normalized.bio,
        birthdate: normalized.birthdate,
        birthplace: normalized.birthplace,
        nationality: normalized.nationality,
        gender: normalized.gender,
        raw: normalized.raw || {},
        updatedAt: now,
    };
    tpdbPerformerById.set(id, out);
    return out;
}

function setTpdbVideoPerformers(videoPath, performers = []) {
    const key = normalizeVideoPathKey(videoPath);
    if (!key) return [];
    db.prepare(`DELETE FROM tpdb_video_performers WHERE video_key = ?`).run(key);
    const insert = db.prepare(`
        INSERT INTO tpdb_video_performers (video_key, performer_id, performer_name, sort_index)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(video_key, performer_id) DO UPDATE SET
            performer_name = excluded.performer_name,
            sort_index = excluded.sort_index
    `);
    const out = [];
    let sortIndex = 0;
    for (const raw of Array.isArray(performers) ? performers : []) {
        const perf = normalizeTpdbPerformer(raw);
        const id = String(perf.id || '').trim() || (String(perf.name || '').trim() ? `name:${slugifyStable(perf.name)}` : '');
        const name = String(perf.name || '').trim();
        if (!id || !name) continue;
        sortIndex += 1;
        insert.run(key, id, name, sortIndex);
        out.push({ id, name, sortIndex });
    }
    tpdbVideoPerformersByKey.set(key, out);
    return out;
}

async function downloadImageToFile(imageUrl, outPath) {
    const url = String(imageUrl || '').trim();
    if (!url) return false;
    const res = await fetch(url, {
        headers: {
            Accept: 'image/*',
            'User-Agent': 'Glyph/0.3',
            Referer: 'https://theporndb.net/',
        },
    });
    if (!res.ok) throw new Error(`Image download failed (${res.status})`);
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
        throw new Error(`Invalid image content-type: ${contentType}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf || buf.length < 32) throw new Error('Invalid image payload');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return true;
}

function syncTpdbVideoMetaIntoCaches(videoPath) {
    const key = normalizeVideoPathKey(videoPath);
    const meta = tpdbVideoMetaByKey.get(key) || null;
    const performers = tpdbVideoPerformersByKey.get(key) || [];
    const apply = (video) => {
        if (!video) return;
        if (meta?.title) video.title = meta.title;
        if (meta?.description) video.tpdbDescription = meta.description;
        if (meta?.releaseDate) video.tpdbReleaseDate = meta.releaseDate;
        if (meta?.siteName) video.tpdbSiteName = meta.siteName;
        if (meta?.itemType) video.tpdbItemType = meta.itemType;
        if (meta?.itemId) video.tpdbItemId = meta.itemId;
        if (performers.length > 0) {
            video.performers = performers.map((p) => ({
                id: p.id,
                name: p.name || tpdbPerformerById.get(p.id)?.name || '',
                gender: String(tpdbPerformerById.get(p.id)?.gender || '').trim(),
            }));
        } else {
            video.performers = [];
        }
        video.hasThumbnail = hasAnyThumbForPath(video.filePath);
        video.thumbVersion = getVideoThumbVersion(video.filePath, Number(video?.modifiedAt || 0));
    };
    for (const entry of Object.values(videoIndex || {})) {
        if (!entry?.filePath) continue;
        if (normalizeVideoPathKey(entry.filePath) !== key) continue;
        apply(entry);
    }
    for (const cache of Object.values(libraryCache || {})) {
        const videos = Array.isArray(cache?.videos) ? cache.videos : [];
        for (const v of videos) {
            if (!v?.filePath) continue;
            if (normalizeVideoPathKey(v.filePath) !== key) continue;
            apply(v);
        }
    }
}

initDatabase();
loadTpdbCaches();
loadAudioIndexStore();
loadDurationIndexStore();
ensureAutoBackupTimer();
setTimeout(() => runAutoBackupIfDue(false), 3000);

function purgeLegacyJsonFiles() {
    for (const legacyFile of [LEGACY_SETTINGS_PATH, LEGACY_METADATA_PATH]) {
        try {
            if (fs.existsSync(legacyFile)) {
                fs.rmSync(legacyFile, { force: true });
                console.log(`Removed legacy JSON store: ${legacyFile}`);
            }
        } catch (err) {
            console.warn(`Failed to remove legacy JSON store ${legacyFile}: ${err.message}`);
        }
    }
}

function normalizeResolvedLower(p) {
    return path.resolve(p).toLowerCase();
}

function isUnderAnyLibraryRoot(targetPath, libraries) {
    const resolvedTarget = normalizeResolvedLower(targetPath);
    for (const lib of libraries) {
        if (!lib?.path) continue;
        const root = normalizeResolvedLower(lib.path);
        if (resolvedTarget === root) return true;
        if (resolvedTarget.startsWith(root + path.sep.toLowerCase())) return true;
    }
    return false;
}

function findLibraryByPath(targetPath) {
    const resolvedTarget = normalizeResolvedLower(targetPath);
    const libraries = (loadSettings().libraries || [])
        .filter((lib) => !!lib?.path)
        .sort((a, b) => String(b.path).length - String(a.path).length);
    for (const lib of libraries) {
        const root = normalizeResolvedLower(lib.path);
        if (resolvedTarget === root) return lib;
        if (resolvedTarget.startsWith(root + path.sep.toLowerCase())) return lib;
    }
    return null;
}

function cleanupOrphanArtifacts(options = {}) {
    const log = options && options.log === true;
    const stats = {
        metadataDeleted: 0,
        thumbnailsDeleted: 0,
        tpdbThumbnailsDeleted: 0,
        tpdbVideoMetadataDeleted: 0,
        tpdbVideoPerformerLinksDeleted: 0,
        tpdbPerformersDeleted: 0,
        tpdbPerformerImagesDeleted: 0,
        previewsDeleted: 0,
        postersDeleted: 0,
        tagsDeleted: 0,
        playlistItemsDeleted: 0,
        errors: 0,
    };
    const settings = loadSettings();
    const libraries = settings.libraries || [];

    // 1) Cleanup metadata rows with missing folders or paths outside configured libraries.
    const metadataRows = db.prepare(`SELECT folder_key AS folderKey, folder_path AS folderPath FROM metadata`).all();
    const deleteMetadata = db.prepare(`DELETE FROM metadata WHERE folder_key = ?`);
    const validMetadataPaths = [];

    for (const row of metadataRows) {
        const folderPath = row.folderPath;
        const exists = !!folderPath && fs.existsSync(folderPath);
        const inLibrary = exists && isUnderAnyLibraryRoot(folderPath, libraries);
        if (!exists || !inLibrary) {
            deleteMetadata.run(row.folderKey);
            stats.metadataDeleted += 1;
            continue;
        }
        validMetadataPaths.push(folderPath);
    }

    // 2) Cleanup orphan thumbnails for deleted videos.
    const validThumbNames = new Set();
    for (const v of Object.values(videoIndex)) {
        if (!v?.filePath) continue;
        const regularName = path.basename(getThumbPath(v.filePath));
        const legacyName = path.basename(getLegacyThumbPath(v.filePath));
        const tpdbName = path.basename(getTpdbThumbPath(v.filePath));
        const legacyTpdbName = path.basename(getLegacyTpdbThumbPath(v.filePath));
        validThumbNames.add(regularName);
        validThumbNames.add(legacyName);
        validThumbNames.add(legacyTpdbName);
        validThumbNames.add(`${regularName}.src`);
        validThumbNames.add(`${legacyName}.src`);
        // Keep compatibility with runs that stored TPDB thumbs in thumbnails/ by stable name.
        validThumbNames.add(tpdbName);
    }
    if (fs.existsSync(THUMB_DIR)) {
        for (const file of fs.readdirSync(THUMB_DIR)) {
            if (!validThumbNames.has(file)) {
                try {
                    fs.rmSync(path.join(THUMB_DIR, file), { force: true });
                    stats.thumbnailsDeleted += 1;
                } catch {
                    stats.errors += 1;
                }
            }
        }
    }

    const validTpdbThumbNames = new Set();
    for (const v of Object.values(videoIndex)) {
        if (!v?.filePath) continue;
        const tpdbName = path.basename(getTpdbThumbPath(v.filePath));
        validTpdbThumbNames.add(tpdbName);
    }
    if (fs.existsSync(TPDB_THUMB_DIR)) {
        for (const file of fs.readdirSync(TPDB_THUMB_DIR)) {
            if (!validTpdbThumbNames.has(file)) {
                try {
                    fs.rmSync(path.join(TPDB_THUMB_DIR, file), { force: true });
                    stats.tpdbThumbnailsDeleted += 1;
                } catch {
                    stats.errors += 1;
                }
            }
        }
    }

    // 2b) Cleanup orphan previews for deleted videos.
    const validPreviewNames = new Set(
        Object.values(videoIndex).map(v => path.basename(getPreviewPath(v.filePath)))
    );
    if (fs.existsSync(PREVIEW_DIR)) {
        for (const file of fs.readdirSync(PREVIEW_DIR)) {
            if (!validPreviewNames.has(file)) {
                try {
                    const fullPath = path.join(PREVIEW_DIR, file);
                    fs.rmSync(fullPath, { force: true });
                    stats.previewsDeleted += 1;
                    clearPreviewProbeCache(fullPath);
                } catch {
                    stats.errors += 1;
                }
            }
        }
    }

    // 2c) Cleanup orphan fetched metadata/performer relations for deleted videos.
    const validVideoKeys = new Set();
    for (const v of Object.values(videoIndex || {})) {
        const filePath = String(v?.filePath || '').trim();
        if (!filePath || !fs.existsSync(filePath) || !isUnderAnyLibraryRoot(filePath, libraries)) continue;
        const key = normalizeVideoPathKey(filePath);
        if (key) validVideoKeys.add(key);
    }

    const tpdbMetaRows = db.prepare(`
        SELECT video_key AS videoKey, video_path AS videoPath
        FROM tpdb_video_metadata
    `).all() || [];
    const deleteTpdbMeta = db.prepare(`DELETE FROM tpdb_video_metadata WHERE video_key = ?`);
    const validTpdbKeys = new Set(validVideoKeys);
    for (const row of tpdbMetaRows) {
        const rowPath = String(row?.videoPath || '').trim();
        const rowKey = String(row?.videoKey || '').trim() || normalizeVideoPathKey(rowPath);
        const pathLooksValid = !!rowPath && fs.existsSync(rowPath) && isUnderAnyLibraryRoot(rowPath, libraries);
        if (rowKey && (validVideoKeys.has(rowKey) || pathLooksValid)) {
            validTpdbKeys.add(rowKey);
            continue;
        }
        if (!rowKey) continue;
        try {
            const del = deleteTpdbMeta.run(rowKey);
            stats.tpdbVideoMetadataDeleted += Number(del?.changes || 0);
            tpdbVideoMetaByKey.delete(rowKey);
        } catch {
            stats.errors += 1;
        }
    }

    const relationRows = db.prepare(`
        SELECT video_key AS videoKey
        FROM tpdb_video_performers
    `).all() || [];
    const deleteTpdbVideoRefs = db.prepare(`DELETE FROM tpdb_video_performers WHERE video_key = ?`);
    const orphanRelationKeys = new Set();
    for (const row of relationRows) {
        const rowKey = String(row?.videoKey || '').trim();
        if (!rowKey || validTpdbKeys.has(rowKey)) continue;
        orphanRelationKeys.add(rowKey);
    }
    for (const key of orphanRelationKeys) {
        try {
            const del = deleteTpdbVideoRefs.run(key);
            stats.tpdbVideoPerformerLinksDeleted += Number(del?.changes || 0);
            tpdbVideoPerformersByKey.delete(key);
        } catch {
            stats.errors += 1;
        }
    }

    const referencedPerformerIds = new Set(
        (db.prepare(`SELECT DISTINCT performer_id AS performerId FROM tpdb_video_performers`).all() || [])
            .map((row) => String(row?.performerId || '').trim())
            .filter(Boolean)
    );
    const performerRows = db.prepare(`SELECT performer_id AS performerId FROM tpdb_performers`).all() || [];
    const deleteTpdbPerformer = db.prepare(`DELETE FROM tpdb_performers WHERE performer_id = ?`);
    for (const row of performerRows) {
        const performerId = String(row?.performerId || '').trim();
        if (!performerId || referencedPerformerIds.has(performerId)) continue;
        try {
            const del = deleteTpdbPerformer.run(performerId);
            stats.tpdbPerformersDeleted += Number(del?.changes || 0);
            tpdbPerformerById.delete(performerId);
            const imagePath = getTpdbPerformerImagePath(performerId);
            if (imagePath && fs.existsSync(imagePath)) {
                fs.rmSync(imagePath, { force: true });
                stats.tpdbPerformerImagesDeleted += 1;
            }
        } catch {
            stats.errors += 1;
        }
    }

    // 3) Cleanup orphan posters for deleted folders/libraries.
    const validPosterPaths = new Set();
    for (const lib of libraries) {
        if (lib?.path && fs.existsSync(lib.path)) validPosterPaths.add(lib.path);
    }
    for (const cache of Object.values(libraryCache)) {
        for (const folder of cache?.folders || []) {
            if (folder?.path && fs.existsSync(folder.path)) validPosterPaths.add(folder.path);
        }
        for (const video of cache?.videos || []) {
            if (video?.directory && fs.existsSync(video.directory)) validPosterPaths.add(video.directory);
        }
    }
    for (const metaPath of validMetadataPaths) {
        if (fs.existsSync(metaPath)) validPosterPaths.add(metaPath);
    }

    const validPosterNames = new Set(
        Array.from(validPosterPaths).map(p => path.basename(getPosterPath(p)))
    );
    if (fs.existsSync(POSTER_DIR)) {
        for (const file of fs.readdirSync(POSTER_DIR)) {
            if (!validPosterNames.has(file)) {
                try {
                    fs.rmSync(path.join(POSTER_DIR, file), { force: true });
                    stats.postersDeleted += 1;
                } catch {
                    stats.errors += 1;
                }
            }
        }
    }

    const validPerformerImageNames = new Set(
        (db.prepare(`SELECT performer_id AS performerId FROM tpdb_performers`).all() || [])
            .map((row) => String(row?.performerId || '').trim())
            .filter(Boolean)
            .map((id) => path.basename(getTpdbPerformerImagePath(id)))
    );
    if (fs.existsSync(TPDB_PERFORMER_DIR)) {
        for (const file of fs.readdirSync(TPDB_PERFORMER_DIR)) {
            if (!validPerformerImageNames.has(file)) {
                try {
                    fs.rmSync(path.join(TPDB_PERFORMER_DIR, file), { force: true });
                    stats.tpdbPerformerImagesDeleted += 1;
                } catch {
                    stats.errors += 1;
                }
            }
        }
    }

    // 4) Cleanup orphan tags.
    const tagRows = db.prepare(`
        SELECT item_key AS itemKey, item_type AS itemType, item_path AS itemPath
        FROM tags
    `).all();
    const deleteTag = db.prepare(`DELETE FROM tags WHERE item_key = ?`);
    for (const row of tagRows) {
        const itemPath = row.itemPath;
        const exists = !!itemPath && fs.existsSync(itemPath);
        const inLibrary = exists && isUnderAnyLibraryRoot(itemPath, libraries);
        if (!exists || !inLibrary) {
            deleteTag.run(row.itemKey);
            stats.tagsDeleted += 1;
        }
    }

    // 5) Cleanup orphan playlist items.
    const playlistRows = db.prepare(`
        SELECT playlist_id AS playlistId, item_key AS itemKey, item_path AS itemPath
        FROM playlist_items
    `).all();
    const deletePlaylistItem = db.prepare(`DELETE FROM playlist_items WHERE playlist_id = ? AND item_key = ?`);
    for (const row of playlistRows) {
        const itemPath = row.itemPath;
        const exists = !!itemPath && fs.existsSync(itemPath);
        const inLibrary = exists && isUnderAnyLibraryRoot(itemPath, libraries);
        if (!exists || !inLibrary) {
            deletePlaylistItem.run(row.playlistId, row.itemKey);
            stats.playlistItemsDeleted += 1;
        }
    }

    if (log) {
        addRuntimeLog('info', 'cleanup', 'Loose/generated file cleanup completed', {
            ...stats,
            totalDeleted:
                Number(stats.metadataDeleted || 0) +
                Number(stats.thumbnailsDeleted || 0) +
                Number(stats.tpdbThumbnailsDeleted || 0) +
                Number(stats.tpdbPerformerImagesDeleted || 0) +
                Number(stats.previewsDeleted || 0) +
                Number(stats.postersDeleted || 0) +
                Number(stats.tagsDeleted || 0) +
                Number(stats.playlistItemsDeleted || 0),
        });
    }

    return stats;
}

function closeLibraryWatchers() {
    for (const watcher of libraryWatchers.values()) {
        try { watcher.close(); } catch { }
    }
    libraryWatchers.clear();
}

function mergeWatchReasonCounts(sourceMap) {
    for (const [key, count] of sourceMap.entries()) {
        const prev = Number(watchPendingReasonCounts.get(key) || 0);
        watchPendingReasonCounts.set(key, prev + Number(count || 0));
    }
}

function formatWatchReasonSummary(reasonCountsMap) {
    const pairs = [...reasonCountsMap.entries()]
        .filter(([k]) => !!String(k || '').trim())
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
    if (pairs.length === 0) return 'watch';
    return pairs
        .slice(0, 6)
        .map(([reason, count]) => (Number(count || 0) > 1 ? `${reason} x${count}` : String(reason)))
        .join(', ');
}

function scheduleWatchRescan(reason, libraryId = '') {
    const libId = String(libraryId || '').trim();
    const reasonText = String(reason || '').trim();
    const hasIncomingEvent = !!libId || !!reasonText;
    if (libId) watchPendingLibraryIds.add(libId);
    if (reasonText) {
        const key = reasonText;
        const prev = Number(watchPendingReasonCounts.get(key) || 0);
        watchPendingReasonCounts.set(key, prev + 1);
    }
    if (hasIncomingEvent) watchLastEventAtMs = Date.now();
    if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(async () => {
        watchDebounceTimer = null;
        const now = Date.now();
        const quietWindowMs = 2500;
        const elapsed = now - Number(watchLastEventAtMs || 0);
        if (elapsed < quietWindowMs) {
            watchDebounceTimer = setTimeout(() => scheduleWatchRescan('', ''), quietWindowMs - elapsed);
            return;
        }

        const pendingIds = [...watchPendingLibraryIds];
        watchPendingLibraryIds.clear();
        const reasonCounts = new Map(watchPendingReasonCounts);
        watchPendingReasonCounts.clear();
        const reasonLabel = formatWatchReasonSummary(reasonCounts);
        if (pendingIds.length === 0) return;

        if (isScanning) {
            for (const id of pendingIds) watchPendingLibraryIds.add(id);
            if (reasonCounts.size > 0) {
                mergeWatchReasonCounts(reasonCounts);
            }
            if (!watchDebounceTimer) {
                watchDebounceTimer = setTimeout(() => scheduleWatchRescan('', ''), 2600);
            }
            return;
        }

        if (pendingIds.length === 1) {
            const targetId = String(pendingIds[0]);
            const cooldownUntil = Number(watchLibraryCooldownUntilMs.get(targetId) || 0);
            if (cooldownUntil > now) {
                watchPendingLibraryIds.add(targetId);
                if (reasonCounts.size > 0) mergeWatchReasonCounts(reasonCounts);
                const waitMs = Math.max(350, cooldownUntil - now);
                if (!watchDebounceTimer) {
                    watchDebounceTimer = setTimeout(() => scheduleWatchRescan('', ''), waitMs);
                }
                return;
            }
            const settings = loadSettings();
            const targetLib = (settings.libraries || []).find((lib) => String(lib?.id || '') === targetId);
            const targetName = String(targetLib?.name || targetId);
            console.log(`Watch change detected (${reasonLabel}), rescanning library "${targetName}"...`);
            addRuntimeLog('info', 'watch', 'Watch change detected, targeted library rescan started', {
                reason: reasonLabel,
                libraryId: targetId,
                libraryName: targetName,
            });
            await scanLibraryById(targetId);
            watchLibraryCooldownUntilMs.set(targetId, Date.now() + WATCH_LIBRARY_RESCAN_COOLDOWN_MS);
            return;
        }

        console.log(`Watch change detected (${reasonLabel}), rescanning libraries...`);
        addRuntimeLog('info', 'watch', 'Watch change detected, full rescan started', { reason: reasonLabel, affectedLibraries: pendingIds.length });
        await scanAllLibraries();
    }, 1200);
}

function scheduleFullRescan(reason, delayMs = 600) {
    if (rescanDebounceTimer) clearTimeout(rescanDebounceTimer);
    rescanDebounceTimer = setTimeout(async () => {
        rescanDebounceTimer = null;
        if (isScanning) {
            scheduleFullRescan(`${reason}:retry`, 800);
            return;
        }
        console.log(`Scheduled rescan (${reason})`);
        addRuntimeLog('info', 'scan', 'Scheduled full rescan', { reason });
        await scanAllLibraries();
    }, delayMs);
}

function scheduleThumbnailGeneration(delayMs = 700) {
    if (thumbnailDebounceTimer) clearTimeout(thumbnailDebounceTimer);
    thumbnailDebounceTimer = setTimeout(() => {
        thumbnailDebounceTimer = null;
        generateAllThumbnails().catch(err => {
            console.error('Thumb gen error:', err);
            addRuntimeLog('error', 'thumbnail', 'Thumbnail batch scheduling failed', { error: err?.message || String(err) });
        });
    }, delayMs);
}

function scheduleHeatmapGeneration(delayMs = 1100) {
    if (heatmapDebounceTimer) clearTimeout(heatmapDebounceTimer);
    heatmapDebounceTimer = setTimeout(() => {
        heatmapDebounceTimer = null;
        generateAllHeatmaps().catch(err => {
            console.error('Heatmap gen error:', err);
            addRuntimeLog('error', 'heatmap', 'Heatmap batch scheduling failed', { error: err?.message || String(err) });
        });
    }, delayMs);
}

function refreshLibraryWatchers() {
    closeLibraryWatchers();
    const settings = loadSettings();
    if (settings.watchFolders === false) return;

    for (const lib of settings.libraries || []) {
        if (!lib?.path || !fs.existsSync(lib.path)) continue;

        try {
            const watcher = fs.watch(lib.path, { recursive: true }, (eventType) => {
                scheduleWatchRescan(`${lib.name}:${eventType}`, lib.id);
            });
            libraryWatchers.set(lib.id, watcher);
        } catch (errRecursive) {
            try {
                const watcher = fs.watch(lib.path, (eventType) => {
                    scheduleWatchRescan(`${lib.name}:${eventType}`, lib.id);
                });
                libraryWatchers.set(lib.id, watcher);
            } catch (err) {
                console.warn(`Watcher could not be started for ${lib.path}: ${err.message}`);
            }
        }
    }
}

// —— Thumbnail Generation ——

function getThumbPath(videoPath) {
    const hash = generateStableId(String(videoPath || ''));
    return path.join(THUMB_DIR, `${hash}.jpg`);
}

function getLegacyThumbPath(videoPath) {
    const hash = String(videoPath || '').split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
    return path.join(THUMB_DIR, `${Math.abs(hash).toString(36)}.jpg`);
}

function getTpdbThumbPath(videoPath) {
    const hash = generateStableId(String(videoPath || ''));
    return path.join(TPDB_THUMB_DIR, `${hash}.jpg`);
}

function getLegacyTpdbThumbPath(videoPath) {
    const hash = generateStableId(String(videoPath || ''));
    return path.join(THUMB_DIR, `${hash}.tpdb.jpg`);
}

function getTpdbPerformerImagePath(performerId) {
    const hash = generateStableId(String(performerId || ''));
    return path.join(TPDB_PERFORMER_DIR, `${hash}.jpg`);
}

function getThumbSourcePath(thumbPath) {
    return `${String(thumbPath || '')}.src`;
}

function isTpdbThumbPath(thumbPath) {
    try {
        const target = path.resolve(String(thumbPath || ''));
        const root = path.resolve(TPDB_THUMB_DIR);
        return target === root || target.startsWith(`${root}${path.sep}`);
    } catch {
        return false;
    }
}

function readThumbSource(thumbPath) {
    if (isTpdbThumbPath(thumbPath)) return '';
    try {
        return String(fs.readFileSync(getThumbSourcePath(thumbPath), 'utf8') || '').trim();
    } catch {
        return '';
    }
}

function writeThumbSource(thumbPath, source) {
    if (isTpdbThumbPath(thumbPath)) {
        try { fs.rmSync(getThumbSourcePath(thumbPath), { force: true }); } catch { }
        return;
    }
    try {
        fs.writeFileSync(getThumbSourcePath(thumbPath), String(source || ''));
    } catch { }
}

function getTpdbThumbUrlForVideoPath(videoPath) {
    const key = normalizeVideoPathKey(videoPath);
    const tpdbThumbPath = getTpdbThumbPath(videoPath);
    const legacyTpdbThumbPath = getLegacyTpdbThumbPath(videoPath);
    const fromSourceMarker = (() => {
        const src = readThumbSource(tpdbThumbPath) || readThumbSource(legacyTpdbThumbPath);
        if (!src) return '';
        if (src.startsWith('tpdb:')) return toAbsoluteTpdbUrl(src.slice(5));
        return '';
    })();
    if (!key) return String(fromSourceMarker || '').trim();
    const meta = tpdbVideoMetaByKey.get(key);
    const fromRaw = toAbsoluteTpdbUrl(meta?.raw?._glyphThumbUrl || meta?.raw?.thumbnail || meta?.raw?.thumb || '');
    const fromPoster = toAbsoluteTpdbUrl(meta?.posterUrl || '');
    return String(fromRaw || fromPoster || fromSourceMarker || '').trim();
}

function hasTpdbPreferredThumbForPath(videoPath) {
    return !!getTpdbThumbUrlForVideoPath(videoPath);
}

async function ensureTpdbPreferredThumbnail(videoPath) {
    const preferredUrl = getTpdbThumbUrlForVideoPath(videoPath);
    if (!preferredUrl) return false;
    const thumbPath = getTpdbThumbPath(videoPath);
    const legacyThumbPath = getLegacyTpdbThumbPath(videoPath);
    const hasFile = hasValidThumbFile(thumbPath);
    if (!hasFile && hasValidThumbFile(legacyThumbPath)) {
        try {
            fs.copyFileSync(legacyThumbPath, thumbPath);
        } catch { }
    }
    const needsSync = !hasValidThumbFile(thumbPath);
    if (!needsSync) return true;
    if (fs.existsSync(thumbPath)) {
        try { fs.rmSync(thumbPath, { force: true }); } catch { }
    }
    await downloadImageToFile(preferredUrl, thumbPath);
    return hasValidThumbFile(thumbPath);
}

function collectTpdbImageCandidates(value, out = [], depth = 0) {
    if (depth > 3 || value == null) return out;
    if (Array.isArray(value)) {
        for (const item of value) collectTpdbImageCandidates(item, out, depth + 1);
        return out;
    }
    if (typeof value === 'string') {
        const url = toAbsoluteTpdbUrl(value);
        if (url) out.push(url);
        return out;
    }
    if (typeof value !== 'object') return out;
    const keys = [
        'image', 'imageUrl', 'thumbnail', 'thumb', 'face',
        'poster', 'avatar', 'large', 'medium', 'small', 'original', 'headshot', 'url',
    ];
    for (const key of keys) {
        if (value[key] != null) collectTpdbImageCandidates(value[key], out, depth + 1);
    }
    return out;
}

function extractTpdbPosterUrlsFromRaw(raw = {}) {
    try {
        const text = JSON.stringify(raw || {});
        const matches = text.match(/https?:\/\/(?:cdn|thumb)\.theporndb\.net\/[^"\\\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"\\\s<>]*)?/gi) || [];
        return matches.map((u) => toAbsoluteTpdbUrl(u)).filter(Boolean);
    } catch {
        return [];
    }
}

function getTpdbPerformerImageCandidates(performer = {}) {
    const raw = performer?.raw && typeof performer.raw === 'object' ? performer.raw : {};
    const normalizedRaw = normalizeTpdbPerformer(raw);
    const out = [
        performer?.selectedImageUrl,
        performer?.imageUrl,
        performer?.faceUrl,
        raw?.image,
        raw?.thumbnail,
        raw?.face,
        raw?.poster,
        raw?.imageUrl,
        raw?.faceUrl,
        raw?.gallery,
        raw?.images,
        raw?.posters,
        raw?.photos,
        raw?.stills,
        raw?.avatars,
        raw?.parent,
        normalizedRaw?.imageUrl,
        normalizedRaw?.faceUrl,
    ].map((v) => toAbsoluteTpdbUrl(v)).filter(Boolean);
    collectTpdbImageCandidates(raw?.images, out);
    collectTpdbImageCandidates(raw?.posters, out);
    collectTpdbImageCandidates(raw?.gallery, out);
    collectTpdbImageCandidates(raw?.photos, out);
    collectTpdbImageCandidates(raw?.stills, out);
    collectTpdbImageCandidates(raw?.avatars, out);
    collectTpdbImageCandidates(raw?.parent, out);
    out.push(...extractTpdbPosterUrlsFromRaw(raw));
    out.push(...extractTpdbPosterUrlsFromRaw(raw?.parent || {}));
    const seen = new Set();
    const deduped = [];
    for (const url of out.map((u) => toAbsoluteTpdbUrl(u)).filter(Boolean)) {
        const key = canonicalizeImageUrl(url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        deduped.push(url);
    }
    return deduped;
}

async function ensureTpdbPerformerImageById(performerId) {
    const id = String(performerId || '').trim();
    if (!id) return '';
    const performer = tpdbPerformerById.get(id);
    if (!performer) return '';
    const outPath = getTpdbPerformerImagePath(id);
    const selectedRaw = String(performer?.selectedImageUrl || '').trim();
    if (selectedRaw.startsWith('local:') && hasValidThumbFile(outPath)) {
        return outPath;
    }
    const selectedImage = toAbsoluteTpdbUrl(performer?.selectedImageUrl || '');
    const candidateSet = new Set();
    const desiredCandidates = [];
    if (selectedImage) {
        const key = canonicalizeImageUrl(selectedImage);
        if (key) {
            candidateSet.add(key);
            desiredCandidates.push(selectedImage);
        }
    }
    for (const candidate of getTpdbPerformerImageCandidates(performer)) {
        const key = canonicalizeImageUrl(candidate);
        if (!key || candidateSet.has(key)) continue;
        candidateSet.add(key);
        desiredCandidates.push(candidate);
    }
    if (desiredCandidates.length === 0) return '';
    const currentSource = readThumbSource(outPath);
    const selectedSource = selectedImage ? `tpdb:${selectedImage}` : '';
    if (hasValidThumbFile(outPath) && selectedSource && currentSource === selectedSource) {
        return outPath;
    }
    if (hasValidThumbFile(outPath) && !selectedSource && desiredCandidates.some((u) => currentSource === `tpdb:${u}`)) {
        return outPath;
    }
    for (const candidate of desiredCandidates) {
        try {
            if (fs.existsSync(outPath)) {
                try { fs.rmSync(outPath, { force: true }); } catch { }
            }
            await downloadImageToFile(candidate, outPath);
            if (hasValidThumbFile(outPath)) {
                writeThumbSource(outPath, `tpdb:${candidate}`);
                return outPath;
            }
        } catch { }
    }
    return '';
}

function getHeatmapPath(videoPath, suffix = 'detailed') {
    const hash = videoPath.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
    return path.join(HEATMAP_DIR, `${Math.abs(hash).toString(36)}.${String(suffix || 'detailed')}.svg`);
}

function getPreviewPath(videoPath) {
    const hash = videoPath.split('').reduce((a, c) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0);
    return path.join(PREVIEW_DIR, `${Math.abs(hash).toString(36)}.mp4`);
}

function collectLibraryArtifacts(rootPath) {
    const result = {
        videoPaths: [],
        folderPaths: new Set(),
    };
    if (!rootPath || !fs.existsSync(rootPath)) return result;

    const stack = [rootPath];
    while (stack.length > 0) {
        const current = stack.pop();
        result.folderPaths.add(current);
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (!VIDEO_EXTENSIONS.includes(ext)) continue;
            result.videoPaths.push(fullPath);
            result.folderPaths.add(path.dirname(fullPath));
        }
    }

    return result;
}

function cleanupGeneratedArtifactsForLibrary(library, remainingLibraries = []) {
    const stats = {
        thumbsDeleted: 0,
        previewsDeleted: 0,
        previewTempsDeleted: 0,
        postersDeleted: 0,
    };
    if (!library?.path) return stats;

    let videoPaths = [];
    let folderPaths = new Set([library.path]);

    const cachedVideos = Array.isArray(libraryCache?.[library.id]?.videos)
        ? libraryCache[library.id].videos
            .map((v) => String(v?.filePath || '').trim())
            .filter(Boolean)
        : [];

    if (cachedVideos.length > 0) {
        videoPaths = cachedVideos;
        for (const filePath of cachedVideos) {
            folderPaths.add(path.dirname(filePath));
        }
    } else {
        const scanned = collectLibraryArtifacts(library.path);
        videoPaths = scanned.videoPaths;
        folderPaths = scanned.folderPaths;
    }

    for (const videoPath of videoPaths) {
        if (isUnderAnyLibraryRoot(videoPath, remainingLibraries)) continue;
        const thumbPath = getThumbPath(videoPath);
        const legacyThumbPath = getLegacyThumbPath(videoPath);
        const tpdbThumbPath = getTpdbThumbPath(videoPath);
        const legacyTpdbThumbPath = getLegacyTpdbThumbPath(videoPath);
        const previewPath = getPreviewPath(videoPath);
        const previewTmpPath = `${previewPath}.tmp`;

        if (fs.existsSync(thumbPath)) {
            try { fs.rmSync(thumbPath, { force: true }); stats.thumbsDeleted += 1; } catch { }
        }
        if (fs.existsSync(getThumbSourcePath(thumbPath))) {
            try { fs.rmSync(getThumbSourcePath(thumbPath), { force: true }); } catch { }
        }
        if (fs.existsSync(legacyThumbPath)) {
            try { fs.rmSync(legacyThumbPath, { force: true }); stats.thumbsDeleted += 1; } catch { }
        }
        if (fs.existsSync(getThumbSourcePath(legacyThumbPath))) {
            try { fs.rmSync(getThumbSourcePath(legacyThumbPath), { force: true }); } catch { }
        }
        if (fs.existsSync(tpdbThumbPath)) {
            try { fs.rmSync(tpdbThumbPath, { force: true }); stats.thumbsDeleted += 1; } catch { }
        }
        if (fs.existsSync(getThumbSourcePath(tpdbThumbPath))) {
            try { fs.rmSync(getThumbSourcePath(tpdbThumbPath), { force: true }); } catch { }
        }
        if (fs.existsSync(legacyTpdbThumbPath)) {
            try { fs.rmSync(legacyTpdbThumbPath, { force: true }); stats.thumbsDeleted += 1; } catch { }
        }
        if (fs.existsSync(getThumbSourcePath(legacyTpdbThumbPath))) {
            try { fs.rmSync(getThumbSourcePath(legacyTpdbThumbPath), { force: true }); } catch { }
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); stats.previewsDeleted += 1; } catch { }
            clearPreviewProbeCache(previewPath);
        }
        if (fs.existsSync(previewTmpPath)) {
            try { fs.rmSync(previewTmpPath, { force: true }); stats.previewTempsDeleted += 1; } catch { }
        }
    }

    for (const folderPath of folderPaths) {
        if (isUnderAnyLibraryRoot(folderPath, remainingLibraries)) continue;
        const posterPath = getPosterPath(folderPath);
        if (!fs.existsSync(posterPath)) continue;
        try { fs.rmSync(posterPath, { force: true }); stats.postersDeleted += 1; } catch { }
    }

    return stats;
}

function collectTpdbVideoKeysForRemovedLibrary(library, remainingLibraries = []) {
    const keys = new Set();
    if (!library?.path) return keys;

    const isRemovablePath = (videoPath) => {
        const p = String(videoPath || '').trim();
        if (!p) return false;
        if (!isUnderAnyLibraryRoot(p, [library])) return false;
        if (isUnderAnyLibraryRoot(p, remainingLibraries)) return false;
        return true;
    };

    for (const entry of Object.values(videoIndex || {})) {
        const p = String(entry?.filePath || '').trim();
        const key = normalizeVideoPathKey(p);
        if (!key) continue;
        const byLibraryId = String(entry?.libraryId || '') === String(library.id || '');
        const byPath = isRemovablePath(p);
        if (!byLibraryId && !byPath) continue;
        if (byPath) keys.add(key);
    }

    const cacheVideos = Array.isArray(libraryCache?.[library.id]?.videos) ? libraryCache[library.id].videos : [];
    for (const entry of cacheVideos) {
        const p = String(entry?.filePath || '').trim();
        if (!isRemovablePath(p)) continue;
        const key = normalizeVideoPathKey(p);
        if (key) keys.add(key);
    }

    const metaRows = db.prepare(`
        SELECT video_key AS videoKey, video_path AS videoPath
        FROM tpdb_video_metadata
    `).all();
    for (const row of metaRows || []) {
        const p = String(row?.videoPath || '').trim();
        if (!isRemovablePath(p)) continue;
        const key = String(row?.videoKey || '').trim() || normalizeVideoPathKey(p);
        if (key) keys.add(key);
    }

    return keys;
}

function cleanupFetchedMetadataForLibrary(library, remainingLibraries = []) {
    const stats = {
        videoMetadataDeleted: 0,
        videoPerformerLinksDeleted: 0,
        performerMetadataDeleted: 0,
        performerImagesDeleted: 0,
        cacheEntriesUpdated: 0,
        errors: 0,
    };
    if (!library?.path) return stats;

    const keys = collectTpdbVideoKeysForRemovedLibrary(library, remainingLibraries);
    if (!keys.size) return stats;

    const deleteVideoMeta = db.prepare(`DELETE FROM tpdb_video_metadata WHERE video_key = ?`);
    const deleteVideoPerformerRefs = db.prepare(`DELETE FROM tpdb_video_performers WHERE video_key = ?`);

    const clearVideoTpdbFields = (video, key) => {
        if (!video?.filePath) return false;
        if (normalizeVideoPathKey(video.filePath) !== key) return false;
        delete video.tpdbDescription;
        delete video.tpdbReleaseDate;
        delete video.tpdbSiteName;
        delete video.tpdbItemType;
        delete video.tpdbItemId;
        video.performers = [];
        video.thumbVersion = getVideoThumbVersion(video.filePath, Number(video?.modifiedAt || 0));
        return true;
    };

    for (const key of keys) {
        try {
            const localRefs = tpdbVideoPerformersByKey.get(key) || [];
            const deletedRefs = deleteVideoPerformerRefs.run(key);
            const deletedMeta = deleteVideoMeta.run(key);
            stats.videoPerformerLinksDeleted += Number(deletedRefs?.changes || localRefs.length || 0);
            stats.videoMetadataDeleted += Number(deletedMeta?.changes || 0);

            tpdbVideoMetaByKey.delete(key);
            tpdbVideoPerformersByKey.delete(key);

            for (const entry of Object.values(videoIndex || {})) {
                if (clearVideoTpdbFields(entry, key)) stats.cacheEntriesUpdated += 1;
            }
            for (const cache of Object.values(libraryCache || {})) {
                const videos = Array.isArray(cache?.videos) ? cache.videos : [];
                for (const video of videos) {
                    if (clearVideoTpdbFields(video, key)) stats.cacheEntriesUpdated += 1;
                }
            }
        } catch {
            stats.errors += 1;
        }
    }

    const referencedPerformerIds = new Set(
        (db.prepare(`SELECT DISTINCT performer_id AS performerId FROM tpdb_video_performers`).all() || [])
            .map((row) => String(row?.performerId || '').trim())
            .filter(Boolean)
    );
    const allPerformerRows = db.prepare(`SELECT performer_id AS performerId FROM tpdb_performers`).all() || [];
    const deletePerformer = db.prepare(`DELETE FROM tpdb_performers WHERE performer_id = ?`);

    for (const row of allPerformerRows) {
        const performerId = String(row?.performerId || '').trim();
        if (!performerId || referencedPerformerIds.has(performerId)) continue;
        try {
            const del = deletePerformer.run(performerId);
            if (Number(del?.changes || 0) > 0) stats.performerMetadataDeleted += Number(del.changes || 0);
            tpdbPerformerById.delete(performerId);
            const imagePath = getTpdbPerformerImagePath(performerId);
            if (imagePath && fs.existsSync(imagePath)) {
                fs.rmSync(imagePath, { force: true });
                stats.performerImagesDeleted += 1;
            }
        } catch {
            stats.errors += 1;
        }
    }

    return stats;
}

const MIN_VALID_THUMB_BYTES = 1024;

function hasValidThumbFile(thumbPath) {
    try {
        const st = fs.statSync(thumbPath);
        return st.isFile() && st.size >= MIN_VALID_THUMB_BYTES;
    } catch {
        return false;
    }
}

function hasAnyThumbForPath(videoPath) {
    const regular = getThumbPath(videoPath);
    const legacyRegular = getLegacyThumbPath(videoPath);
    const tpdb = getTpdbThumbPath(videoPath);
    const legacyTpdb = getLegacyTpdbThumbPath(videoPath);
    return hasValidThumbFile(tpdb) || hasValidThumbFile(legacyTpdb) || hasValidThumbFile(regular) || hasValidThumbFile(legacyRegular) || hasTpdbPreferredThumbForPath(videoPath);
}

const MIN_VALID_PREVIEW_BYTES = 24 * 1024;

function hasValidPreviewFile(previewPath) {
    try {
        const st = fs.statSync(previewPath);
        return st.isFile() && st.size >= MIN_VALID_PREVIEW_BYTES;
    } catch {
        return false;
    }
}

function hasFallbackPreviewCandidate(previewPath) {
    // Some ffprobe runs return false negatives on specific container/codec combos.
    // Keep a reasonably sized mp4 as a last-resort candidate instead of deleting it.
    return hasValidPreviewFile(previewPath);
}

function getVideoDurationSeconds(videoPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(videoPath, (err, data) => {
            const d = Number(data?.format?.duration || 0);
            if (!err && Number.isFinite(d) && d > 0) return resolve(d);

            // Fallback probe path: fluent-ffmpeg can fail on some containers
            // where a direct ffprobe call still returns a valid duration.
            const args = [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                videoPath,
            ];
            execFile(ffprobePath, args, (probeErr, stdout) => {
                if (probeErr) return resolve(0);
                const parsed = Number(String(stdout || '').trim());
                resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : 0);
            });
        });
    });
}

function buildThumbSeekCandidates(durationSeconds) {
    const values = [5, 2, 1, 0];
    const d = Number(durationSeconds || 0);
    if (d > 1) {
        const maxPoint = Math.max(0, d - 0.2);
        for (const ratio of [0.1, 0.25, 0.5, 0.75, 0.9]) {
            const v = Math.max(0, Math.min(maxPoint, d * ratio));
            if (Number.isFinite(v)) values.push(v);
        }
    }
    const seen = new Set();
    const out = [];
    for (const v of values) {
        const n = Math.max(0, Number(v || 0));
        const key = n.toFixed(2);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
    }
    return out;
}

function runThumbFfmpeg(videoPath, thumbPath, seekSeconds, inputSeek) {
    return new Promise((resolve) => {
        const seek = String(Math.max(0, Number(seekSeconds) || 0).toFixed(2));
        const baseArgs = ['-v', 'error'];
        const preInputSeek = inputSeek ? ['-ss', seek] : [];
        const postInputSeek = inputSeek ? [] : ['-ss', seek];
        const args = [
            ...baseArgs,
            '-threads', String(THUMB_FFMPEG_THREADS),
            ...preInputSeek,
            '-i', videoPath,
            ...postInputSeek,
            '-map', '0:v:0',
            '-an', '-sn', '-dn',
            '-frames:v', '1',
            '-vf', 'thumbnail,scale=480:-1:force_original_aspect_ratio=decrease',
            '-q:v', '4',
            '-f', 'image2',
            '-y',
            thumbPath,
        ];

        const child = execFile(ffmpegPath, args, { timeout: 25000 }, (err, _stdout, stderr) => {
            const stderrText = String(stderr || '').trim();
            if (err) {
                finishFfmpegJob(jobId, 'error', err?.message || 'thumb ffmpeg failed');
                try { fs.rmSync(thumbPath, { force: true }); } catch { }
                return resolve({
                    ok: false,
                    error: err?.message || 'ffmpeg execution failed',
                    code: err?.code || null,
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
            }
            if (!hasValidThumbFile(thumbPath)) {
                finishFfmpegJob(jobId, 'error', 'invalid thumb output');
                try { fs.rmSync(thumbPath, { force: true }); } catch { }
                return resolve({
                    ok: false,
                    error: 'ffmpeg created invalid thumbnail output',
                    code: null,
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
            }
            finishFfmpegJob(jobId, 'ok', '');
            resolve({ ok: true, error: null, code: null, stderr: null });
        });
        const jobId = startFfmpegJob('thumbnail', { videoPath, outputPath: thumbPath, seekSeconds, mode: inputSeek ? 'input-seek' : 'output-seek' }, child);
    });
}

function parseFlexibleTimestampSeconds(value) {
    if (value == null) return null;
    if (typeof value === 'number') {
        return Number.isFinite(value) && value >= 0 ? value : null;
    }
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
        const sec = Number(raw.replace(',', '.'));
        return Number.isFinite(sec) && sec >= 0 ? sec : null;
    }
    const parts = raw.split(':').map((p) => p.trim());
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    const nums = parts.map((p) => Number(p));
    let h = 0;
    let m = 0;
    let s = 0;
    if (nums.length === 2) {
        [m, s] = nums;
    } else {
        [h, m, s] = nums;
    }
    if (m >= 60 || s >= 60) return null;
    return (h * 3600) + (m * 60) + s;
}

function captureFrameAtTimestamp(videoPath, timestampSec) {
    return new Promise((resolve) => {
        try {
            const seek = String(Math.max(0, Number(timestampSec) || 0).toFixed(3));
            const args = [
                '-ss', seek,
                '-i', videoPath,
                '-frames:v', '1',
                '-q:v', '3',
                '-vf', 'scale=640:-1:force_original_aspect_ratio=decrease',
                '-f', 'image2pipe',
                '-vcodec', 'mjpeg',
                'pipe:1',
            ];
            execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
                if (err || !stdout || stdout.length < 64) {
                    return resolve({
                        ok: false,
                        error: err?.message || 'frame capture failed',
                        stderr: String(stderr || '').trim(),
                    });
                }
                return resolve({ ok: true, data: stdout });
            });
        } catch (err) {
            resolve({ ok: false, error: err?.message || 'frame capture failed' });
        }
    });
}

// Simple Queue for Thumbnail Generation
const thumbQueue = [];
let thumbRunning = 0;
const DEFAULT_THUMB_CONCURRENCY = Math.max(1, Math.min(2, Math.floor((os.cpus()?.length || 4) / 4) || 1));
const MAX_THUMB_CONCURRENCY = parsePositiveIntEnv('GLYPH_THUMB_CONCURRENCY', DEFAULT_THUMB_CONCURRENCY);
const THUMB_FFMPEG_THREADS = parsePositiveIntEnv('GLYPH_THUMB_FFMPEG_THREADS', 1);
const activeTasks = new Set(); // Track active files
const queuedThumbs = new Set();
const activeThumbProcs = new Map();
let thumbControlMode = 'running'; // running | paused | stopped

const previewQueue = [];
let previewRunning = 0;
const MAX_PREVIEW_CONCURRENCY = 1;
const previewInFlight = new Map();
const previewFailureUntil = new Map();
const PREVIEW_FAILURE_COOLDOWN_MS = 30 * 1000;
const previewProbeCache = new Map();
const ffmpegJobsRunning = new Map();
const ffmpegJobsRecent = [];
let ffmpegJobSeq = 0;

function trimPathLabel(p) {
    const text = String(p || '').trim();
    if (!text) return '';
    const name = text.split(/[\\/]/).pop() || text;
    if (name.length <= 72) return name;
    return `${name.slice(0, 69)}...`;
}

function startFfmpegJob(kind, meta = {}, child = null) {
    const id = `ff-${Date.now()}-${++ffmpegJobSeq}`;
    const job = {
        id,
        kind: String(kind || 'unknown'),
        startedAt: Date.now(),
        pid: Number(child?.pid || 0) || null,
        videoPath: String(meta.videoPath || ''),
        outputPath: String(meta.outputPath || ''),
        seekSeconds: Number(meta.seekSeconds || 0),
        mode: String(meta.mode || ''),
        status: 'running',
    };
    ffmpegJobsRunning.set(id, job);
    return id;
}

function finishFfmpegJob(id, status = 'done', error = '') {
    const job = ffmpegJobsRunning.get(id);
    if (!job) return;
    ffmpegJobsRunning.delete(id);
    const endedAt = Date.now();
    ffmpegJobsRecent.unshift({
        ...job,
        status: String(status || 'done'),
        error: String(error || ''),
        endedAt,
        durationMs: Math.max(0, endedAt - Number(job.startedAt || endedAt)),
    });
    if (ffmpegJobsRecent.length > 80) ffmpegJobsRecent.length = 80;
}

function logPreview(level, message, meta = null) {
    addRuntimeLog(level, 'preview', message, meta || undefined);
}

function processThumbQueue() {
    if (thumbControlMode !== 'running') return;
    if (thumbRunning >= MAX_THUMB_CONCURRENCY || thumbQueue.length === 0) return;

    thumbRunning++;
    const { videoPath, resolve, quick = false } = thumbQueue.shift();
    queuedThumbs.delete(videoPath);
    activeTasks.add(videoPath);

    const thumbPath = getThumbPath(videoPath);
    if (hasTpdbPreferredThumbForPath(videoPath)) {
        const tpdbThumbPath = getTpdbThumbPath(videoPath);
        const legacyTpdbThumbPath = getLegacyTpdbThumbPath(videoPath);
        thumbRunning--;
        activeTasks.delete(videoPath);
        if (hasValidThumbFile(tpdbThumbPath)) resolve(tpdbThumbPath);
        else if (hasValidThumbFile(legacyTpdbThumbPath)) resolve(legacyTpdbThumbPath);
        else if (hasValidThumbFile(thumbPath)) resolve(thumbPath);
        else resolve(null);
        setImmediate(() => processThumbQueue());
        return;
    }
    if (hasValidThumbFile(thumbPath)) {
        thumbRunning--;
        activeTasks.delete(videoPath);
        resolve(thumbPath);
        setImmediate(() => processThumbQueue());
        return;
    }
    if (fs.existsSync(thumbPath)) {
        try { fs.rmSync(thumbPath, { force: true }); } catch { }
    }

    (async () => {
        let ok = false;
        const attempts = [];
        let durationSeconds = 0;
        let seekCandidates = buildQuickThumbSeekCandidates();
        if (!quick) {
            durationSeconds = await getVideoDurationSeconds(videoPath);
            seekCandidates = buildThumbSeekCandidates(durationSeconds);
        }

        for (const sec of seekCandidates) {
            const inputResult = await runThumbFfmpeg(videoPath, thumbPath, sec, true);
            attempts.push({ seek: sec, mode: 'input', ok: !!inputResult?.ok, error: inputResult?.error || null, code: inputResult?.code || null, stderr: inputResult?.stderr || null });
            ok = !!inputResult?.ok;
            if (ok) break;

            if (!quick) {
                const outputResult = await runThumbFfmpeg(videoPath, thumbPath, sec, false);
                attempts.push({ seek: sec, mode: 'output', ok: !!outputResult?.ok, error: outputResult?.error || null, code: outputResult?.code || null, stderr: outputResult?.stderr || null });
                ok = !!outputResult?.ok;
                if (ok) break;
            }
        }

        thumbRunning--;
        activeTasks.delete(videoPath);
        if (!ok) {
            addRuntimeLog('error', 'thumbnail', 'Thumbnail generation failed', {
                videoPath,
                thumbPath,
                durationSeconds,
                seekCandidates,
                quick,
                attempts,
            });
        }
        resolve(ok ? thumbPath : null);
        processThumbQueue();
    })();
}

function generateThumbnail(videoPath, opts = {}) {
    return new Promise((resolve) => {
        if (thumbControlMode === 'stopped') return resolve(null);
        if (hasTpdbPreferredThumbForPath(videoPath)) return resolve(getTpdbThumbPath(videoPath));
        if (queuedThumbs.has(videoPath) || activeTasks.has(videoPath)) return resolve(getThumbPath(videoPath));
        const quick = opts?.quick === true;
        if (quick) thumbQueue.unshift({ videoPath, resolve, quick: true });
        else thumbQueue.push({ videoPath, resolve, quick: false });
        queuedThumbs.add(videoPath);
        processThumbQueue();
    });
}

async function generateAllThumbnails() {
    let queued = 0;
    const videos = Object.values(videoIndex);
    for (let i = 0; i < videos.length; i += 1) {
        const vid = videos[i];
        if (hasTpdbPreferredThumbForPath(vid.filePath)) {
            if (!hasValidThumbFile(getTpdbThumbPath(vid.filePath)) && !hasValidThumbFile(getLegacyTpdbThumbPath(vid.filePath))) {
                try { await ensureTpdbPreferredThumbnail(vid.filePath); } catch { }
            }
            continue;
        }
        if (!hasValidThumbFile(getThumbPath(vid.filePath)) && !hasValidThumbFile(getLegacyThumbPath(vid.filePath))) {
            queued++;
            generateThumbnail(vid.filePath).then(() => { });
        }
        // Yield regularly to keep API responsive on huge libraries.
        if (i > 0 && i % 250 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    if (queued > 0) {
        console.log(`Thumbnail generation queued (${queued} new)`);
        addRuntimeLog('info', 'thumbnail', 'Thumbnail generation queued', { queuedNew: queued, queueSize: thumbQueue.length });
    }
}

function getThumbControlState() {
    return {
        mode: thumbControlMode,
        queueSize: thumbQueue.length,
        running: thumbRunning,
        active: Array.from(activeTasks),
    };
}

function setThumbControlMode(mode) {
    if (mode === 'start' || mode === 'running' || mode === 'resume') {
        thumbControlMode = 'running';
        processThumbQueue();
        return getThumbControlState();
    }
    if (mode === 'pause' || mode === 'paused') {
        thumbControlMode = 'paused';
        return getThumbControlState();
    }
    if (mode === 'stop' || mode === 'stopped') {
        thumbControlMode = 'stopped';
        while (thumbQueue.length > 0) {
            const item = thumbQueue.shift();
            if (item?.videoPath) queuedThumbs.delete(item.videoPath);
            if (item?.resolve) item.resolve(null);
        }
        for (const [videoPath, proc] of activeThumbProcs.entries()) {
            try { proc.kill('SIGTERM'); } catch { }
            activeThumbProcs.delete(videoPath);
            activeTasks.delete(videoPath);
        }
        return getThumbControlState();
    }
    return getThumbControlState();
}

function setPreviewNoStoreHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function buildPreviewSegmentStarts(durationSec, segmentSec = 2.4) {
    const d = Number(durationSec || 0);
    if (!Number.isFinite(d) || d <= 0) return [3];
    const minStart = d > 2.5 ? 0.2 : 0;
    const maxStart = Math.max(minStart, d - segmentSec - 0.15);
    const targetTotalSec = 15.0;
    const segmentCount = Math.max(4, Math.min(8, Math.round(targetTotalSec / Math.max(0.6, segmentSec))));
    const anchors = [];
    for (let i = 0; i < segmentCount; i += 1) {
        const ratio = segmentCount === 1 ? 0.5 : (i / (segmentCount - 1));
        // Spread across start/mid, but avoid the very end where many files have credits.
        anchors.push(0.05 + (0.77 * ratio));
    }
    const starts = [];
    for (const a of anchors) {
        const center = d * a;
        const start = Math.max(minStart, Math.min(maxStart, center - (segmentSec / 2)));
        const rounded = Math.round(start * 5) / 5;
        if (!starts.includes(rounded)) starts.push(rounded);
    }
    if (starts.length === 0) starts.push(Math.max(minStart, Math.min(maxStart, 0.8)));
    return starts;
}

function getPreviewSegmentSeconds(durationSec) {
    const d = Number(durationSec || 0);
    if (!Number.isFinite(d) || d <= 0) return 3.0;
    if (d <= 4) return 1.1;
    if (d <= 8) return 1.6;
    if (d <= 20) return 2.2;
    if (d <= 45) return 2.8;
    return 3.4;
}

function clearPreviewProbeCache(previewPath) {
    if (!previewPath) return;
    previewProbeCache.delete(previewPath);
}

function probePreviewPlayable(previewPath) {
    return new Promise((resolve) => {
        let finished = false;
        const done = (info) => {
            if (finished) return;
            finished = true;
            resolve(info || { ok: false, durationSec: 0, durationKnown: false, width: 0, height: 0 });
        };
        const timer = setTimeout(() => done({ ok: false, durationSec: 0, durationKnown: false, width: 0, height: 0 }), 9000);
        ffmpeg.ffprobe(previewPath, (err, data) => {
            clearTimeout(timer);
            if (err || !data) return done({ ok: false, durationSec: 0, durationKnown: false, width: 0, height: 0 });
            const streams = Array.isArray(data.streams) ? data.streams : [];
            const videoStream = streams.find(s => s && s.codec_type === 'video');
            const width = Number(videoStream?.width || 0);
            const height = Number(videoStream?.height || 0);
            const durationSec = Number(data?.format?.duration || videoStream?.duration || 0);
            if (!videoStream) return done({ ok: false, durationSec: 0, durationKnown: false, width: 0, height: 0 });
            if (!(width > 0 && height > 0)) return done({ ok: false, durationSec: 0, durationKnown: false, width, height });

            const durationKnown = Number.isFinite(durationSec) && durationSec > 0.1;
            if (!durationKnown) {
                // Some ffprobe/container combinations don't return duration for tiny fragmented MP4s.
                // Keep it playable if the stream itself is valid.
                return done({ ok: true, durationSec: 0, durationKnown: false, width, height });
            }
            done({ ok: true, durationSec, durationKnown: true, width, height });
        });
    });
}

async function hasPlayablePreviewFile(previewPath, opts = {}) {
    try {
        const st = fs.statSync(previewPath);
        if (!st.isFile() || st.size < MIN_VALID_PREVIEW_BYTES) return false;
        const key = `${st.size}:${Math.trunc(st.mtimeMs || 0)}`;
        const minDurationSec = Math.max(0.6, Number(opts?.minDurationSec || 0));
        const cached = previewProbeCache.get(previewPath);
        if (cached && cached.key === key) {
            if (!cached.ok) return false;
            if (!cached.durationKnown) return true;
            return Number(cached.durationSec || 0) >= minDurationSec;
        }
        const info = await probePreviewPlayable(previewPath);
        previewProbeCache.set(previewPath, {
            key,
            ok: !!info.ok,
            durationSec: Number(info.durationSec || 0),
            durationKnown: !!info.durationKnown,
        });
        if (!info.ok) return false;
        if (!info.durationKnown) return true;
        return Number(info.durationSec || 0) >= minDurationSec;
    } catch {
        return false;
    }
}

function runPreviewFfmpeg(videoPath, previewPath, segmentStarts, segmentSec = 2.4, mode = 'primary', videoId = null) {
    return new Promise((resolve) => {
        const starts = Array.isArray(segmentStarts) && segmentStarts.length > 0
            ? segmentStarts
            : [3];
        const safeSegmentSec = Math.max(0.6, Number(segmentSec || 2.0));
        const tmpPath = `${previewPath}.tmp`;
        const args = ['-v', 'error'];
        logPreview('info', 'preview ffmpeg start', {
            videoId,
            mode,
            segmentCount: starts.length,
            segmentSec: Number(safeSegmentSec.toFixed(2)),
            tmpPath,
        });

        try { fs.rmSync(tmpPath, { force: true }); } catch { }
        try { fs.rmSync(previewPath, { force: true }); } catch { }

        for (let i = 0; i < starts.length; i += 1) {
            const seek = String(Math.max(0, Number(starts[i]) || 0).toFixed(2));
            args.push('-ss', seek, '-t', String(safeSegmentSec.toFixed(2)), '-i', videoPath);
        }

        const chain = [];
        for (let i = 0; i < starts.length; i += 1) {
            chain.push(
                `[${i}:v]fps=20,scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v${i}]`
            );
        }
        const refs = starts.map((_, i) => `[v${i}]`).join('');
        chain.push(`${refs}concat=n=${starts.length}:v=1:a=0[vout]`);
        args.push(
            '-filter_complex', chain.join(';'),
            '-map', '[vout]',
            '-an', '-sn', '-dn',
            ...(mode === 'primary'
                ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-profile:v', 'baseline', '-g', '40', '-keyint_min', '40', '-sc_threshold', '0', '-tune', 'zerolatency']
                : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-profile:v', 'baseline', '-g', '40', '-keyint_min', '40', '-sc_threshold', '0']),
            '-movflags', '+faststart',
            '-f', 'mp4',
            '-y',
            tmpPath,
        );

        const child = execFile('ffmpeg', args, { timeout: 70000 }, async (err, _stdout, stderr) => {
            const stderrText = String(stderr || '').trim();
            if (err || !hasValidPreviewFile(tmpPath)) {
                finishFfmpegJob(jobId, 'error', err?.message || 'preview ffmpeg failed');
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
                try { fs.rmSync(previewPath, { force: true }); } catch { }
                logPreview('error', 'preview ffmpeg failed', {
                    videoId,
                    mode,
                    error: err?.message || 'invalid temp preview',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
                return resolve({
                    ok: false,
                    error: err?.message || 'preview generation failed',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
            }
            try {
                fs.renameSync(tmpPath, previewPath);
            } catch {
                try { fs.copyFileSync(tmpPath, previewPath); } catch { }
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
            }
            const expectedMinDurationSec = Math.max(2.5, safeSegmentSec * starts.length * 0.65);
            if (!(await hasPlayablePreviewFile(previewPath, { minDurationSec: expectedMinDurationSec }))) {
                if (!hasFallbackPreviewCandidate(previewPath)) {
                    finishFfmpegJob(jobId, 'error', 'preview output too short');
                    try { fs.rmSync(previewPath, { force: true }); } catch { }
                    logPreview('error', 'preview finalize invalid/too-short output', { videoId, mode, previewPath, expectedMinDurationSec });
                    return resolve({
                        ok: false,
                        error: 'preview output became invalid or too short after finalize',
                        stderr: stderrText ? stderrText.slice(-1200) : null,
                    });
                }
                logPreview('warn', 'preview finalize probe failed but fallback candidate kept', { videoId, mode, previewPath });
            }
            let size = 0;
            try { size = fs.statSync(previewPath).size; } catch { }
            logPreview('info', 'preview ffmpeg success', { videoId, mode, size });
            finishFfmpegJob(jobId, 'ok', '');
            resolve({ ok: true });
        });
        const jobId = startFfmpegJob('preview', { videoPath, outputPath: previewPath, mode }, child);
    });
}

function runPreviewSimpleFfmpeg(videoPath, previewPath, durationSec = 0, startRatio = 0.35, videoId = null) {
    return new Promise((resolve) => {
        const d = Number(durationSec || 0);
        const maxStart = Number.isFinite(d) && d > 0 ? Math.max(0, d - 1.0) : 3.0;
        const ratio = Number.isFinite(startRatio) ? startRatio : 0.35;
        const startSec = Math.max(0, Math.min(maxStart, d > 0 ? d * ratio : 3.0));
        const clipSec = Number.isFinite(d) && d > 0
            ? Math.max(2.2, Math.min(12.0, d * 0.75))
            : 10.0;
        const tmpPath = `${previewPath}.tmp`;
        try { fs.rmSync(tmpPath, { force: true }); } catch { }
        try { fs.rmSync(previewPath, { force: true }); } catch { }
        const args = [
            '-v', 'error',
            '-ss', String(startSec.toFixed(2)),
            '-i', videoPath,
            '-map', '0:v:0',
            '-an', '-sn', '-dn',
            '-t', String(clipSec.toFixed(2)),
            '-vf', 'fps=20,scale=960:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '30',
            '-profile:v', 'baseline',
            '-movflags', '+faststart',
            '-f', 'mp4',
            '-y',
            tmpPath,
        ];
        logPreview('info', 'preview simple start', {
            videoId,
            startSec: Number(startSec.toFixed(2)),
            clipSec: Number(clipSec.toFixed(2)),
            startRatio: Number(ratio.toFixed(2)),
        });
        const child = execFile('ffmpeg', args, { timeout: 55000 }, async (err, _stdout, stderr) => {
            const stderrText = String(stderr || '').trim();
            if (err || !hasValidPreviewFile(tmpPath)) {
                finishFfmpegJob(jobId, 'error', err?.message || 'preview simple failed');
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
                try { fs.rmSync(previewPath, { force: true }); } catch { }
                logPreview('error', 'preview simple failed', {
                    videoId,
                    error: err?.message || 'invalid temp preview',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
                return resolve({
                    ok: false,
                    error: err?.message || 'simple preview generation failed',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
            }
            try {
                fs.renameSync(tmpPath, previewPath);
            } catch {
                try { fs.copyFileSync(tmpPath, previewPath); } catch { }
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
            }
            // Keep fallback acceptance aligned with serving threshold to avoid
            // throwing away usable previews on tricky/short encodes.
            const expectedMinDurationSec = MIN_PLAYABLE_PREVIEW_DURATION_SEC;
            if (!(await hasPlayablePreviewFile(previewPath, { minDurationSec: expectedMinDurationSec }))) {
                if (!hasFallbackPreviewCandidate(previewPath)) {
                    finishFfmpegJob(jobId, 'error', 'preview simple output too short');
                    try { fs.rmSync(previewPath, { force: true }); } catch { }
                    logPreview('error', 'preview simple finalize invalid/too-short output', { videoId, previewPath, expectedMinDurationSec });
                    return resolve({
                        ok: false,
                        error: 'simple preview output became invalid or too short after finalize',
                        stderr: stderrText ? stderrText.slice(-1200) : null,
                    });
                }
                logPreview('warn', 'preview simple finalize probe failed but fallback candidate kept', { videoId, previewPath });
            }
            let size = 0;
            try { size = fs.statSync(previewPath).size; } catch { }
            logPreview('info', 'preview simple success', { videoId, size });
            finishFfmpegJob(jobId, 'ok', '');
            resolve({ ok: true });
        });
        const jobId = startFfmpegJob('preview-simple', { videoPath, outputPath: previewPath, mode: `ratio:${Number(ratio.toFixed(2))}` }, child);
    });
}

function runPreviewUltraFallbackFfmpeg(videoPath, previewPath, videoId = null) {
    return new Promise((resolve) => {
        const tmpPath = `${previewPath}.tmp`;
        try { fs.rmSync(tmpPath, { force: true }); } catch { }
        try { fs.rmSync(previewPath, { force: true }); } catch { }
        const args = [
            '-v', 'error',
            '-i', videoPath,
            '-map', '0:v:0',
            '-an', '-sn', '-dn',
            '-t', '10.0',
            '-vf', 'fps=12,scale=560:560:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '34',
            '-profile:v', 'baseline',
            '-movflags', '+faststart',
            '-f', 'mp4',
            '-y',
            tmpPath,
        ];
        logPreview('info', 'preview ultra fallback start', { videoId });
        const child = execFile('ffmpeg', args, { timeout: 45000 }, async (err, _stdout, stderr) => {
            const stderrText = String(stderr || '').trim();
            if (err || !hasValidPreviewFile(tmpPath)) {
                finishFfmpegJob(jobId, 'error', err?.message || 'preview ultra fallback failed');
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
                try { fs.rmSync(previewPath, { force: true }); } catch { }
                logPreview('error', 'preview ultra fallback failed', {
                    videoId,
                    error: err?.message || 'invalid temp preview',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
                return resolve({
                    ok: false,
                    error: err?.message || 'ultra fallback preview generation failed',
                    stderr: stderrText ? stderrText.slice(-1200) : null,
                });
            }
            try {
                fs.renameSync(tmpPath, previewPath);
            } catch {
                try { fs.copyFileSync(tmpPath, previewPath); } catch { }
                try { fs.rmSync(tmpPath, { force: true }); } catch { }
            }
            const expectedMinDurationSec = MIN_PLAYABLE_PREVIEW_DURATION_SEC;
            if (!(await hasPlayablePreviewFile(previewPath, { minDurationSec: expectedMinDurationSec }))) {
                if (!hasFallbackPreviewCandidate(previewPath)) {
                    finishFfmpegJob(jobId, 'error', 'preview ultra output too short');
                    try { fs.rmSync(previewPath, { force: true }); } catch { }
                    logPreview('error', 'preview ultra fallback finalize invalid/too-short output', { videoId, previewPath, expectedMinDurationSec });
                    return resolve({
                        ok: false,
                        error: 'ultra fallback output became invalid or too short after finalize',
                        stderr: stderrText ? stderrText.slice(-1200) : null,
                    });
                }
                logPreview('warn', 'preview ultra fallback finalize probe failed but fallback candidate kept', { videoId, previewPath });
            }
            let size = 0;
            try { size = fs.statSync(previewPath).size; } catch { }
            logPreview('info', 'preview ultra fallback success', { videoId, size });
            finishFfmpegJob(jobId, 'ok', '');
            resolve({ ok: true });
        });
        const jobId = startFfmpegJob('preview-ultra', { videoPath, outputPath: previewPath, mode: 'ultra' }, child);
    });
}

async function processPreviewQueue() {
    if (previewRunning >= MAX_PREVIEW_CONCURRENCY || previewQueue.length === 0) return;
    previewRunning += 1;
    const { videoPath, videoId, resolve } = previewQueue.shift();
    const previewPath = getPreviewPath(videoPath);
    logPreview('info', 'preview queue start', { videoId, previewPath, queueSize: previewQueue.length });

    try {
        if (await hasPlayablePreviewFile(previewPath)) {
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const durationSec = await getVideoDurationSeconds(videoPath);
        const segmentSec = getPreviewSegmentSeconds(durationSec);
        const segmentStarts = buildPreviewSegmentStarts(durationSec, segmentSec);
        const primary = await runPreviewFfmpeg(videoPath, previewPath, segmentStarts, segmentSec, 'primary', videoId);
        if (primary.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const fallback = await runPreviewFfmpeg(videoPath, previewPath, segmentStarts, segmentSec, 'fallback', videoId);
        if (fallback.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const simple = await runPreviewSimpleFfmpeg(videoPath, previewPath, durationSec, 0.35, videoId);
        if (simple.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const simpleEarly = await runPreviewSimpleFfmpeg(videoPath, previewPath, durationSec, 0.18, videoId);
        if (simpleEarly.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const simpleLate = await runPreviewSimpleFfmpeg(videoPath, previewPath, durationSec, 0.72, videoId);
        if (simpleLate.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        const ultra = await runPreviewUltraFallbackFfmpeg(videoPath, previewPath, videoId);
        if (ultra.ok && hasValidPreviewFile(previewPath)) {
            previewFailureUntil.delete(videoPath);
            resolve(previewPath);
            return;
        }
        if (fs.existsSync(previewPath)) {
            try { fs.rmSync(previewPath, { force: true }); } catch { }
            clearPreviewProbeCache(previewPath);
        }

        previewFailureUntil.set(videoPath, Date.now() + PREVIEW_FAILURE_COOLDOWN_MS);
        logPreview('warn', 'preview all generation paths failed', { videoId, videoPath });
        resolve(null);
    } catch {
        previewFailureUntil.set(videoPath, Date.now() + PREVIEW_FAILURE_COOLDOWN_MS);
        logPreview('error', 'preview queue crashed', { videoId, videoPath });
        resolve(null);
    } finally {
        previewRunning -= 1;
        setImmediate(() => { processPreviewQueue().catch(() => { }); });
    }
}

async function generatePreviewOnDemand(videoPath, opts = {}) {
    if (!videoPath) return null;
    const previewPath = getPreviewPath(videoPath);
    if (await hasPlayablePreviewFile(previewPath)) return previewPath;
    if (fs.existsSync(previewPath)) {
        try { fs.rmSync(previewPath, { force: true }); } catch { }
        clearPreviewProbeCache(previewPath);
    }

    const blockedUntil = Number(previewFailureUntil.get(videoPath) || 0);
    const ignoreCooldown = Boolean(opts && opts.ignoreCooldown);
    if (!ignoreCooldown && blockedUntil > Date.now()) {
        logPreview('warn', 'preview blocked by cooldown', { videoId: opts?.videoId || null, blockedUntil });
        return null;
    }

    const inFlight = previewInFlight.get(videoPath);
    if (inFlight) return inFlight;

    const next = new Promise((resolve) => {
        previewQueue.push({ videoPath, videoId: opts?.videoId || null, resolve });
        logPreview('info', 'preview queued', {
            videoId: opts?.videoId || null,
            queueSize: previewQueue.length,
            inFlight: previewInFlight.size,
        });
        processPreviewQueue().catch(() => { });
    }).finally(() => {
        previewInFlight.delete(videoPath);
    });
    previewInFlight.set(videoPath, next);
    return next;
}
// —— Scanning ——

function registerVideo(video, targetIndex = videoIndex) {
    targetIndex[video.id] = video;
    return video;
}

function normalizeMediaPathKey(filePath) {
    return path.normalize(String(filePath || '')).toLowerCase();
}

function makeDetailsProbeCacheKey(video) {
    const filePath = String(video?.filePath || '').trim();
    const key = normalizeMediaPathKey(filePath);
    const size = Number(video?.size || 0);
    const mtimeMs = Number(video?.modifiedAt || 0);
    return `${key}|${size}|${mtimeMs}`;
}

function getDetailsProbeCache(video) {
    const key = makeDetailsProbeCacheKey(video);
    if (!key || key.startsWith('|')) return null;
    return detailsProbeCache.get(key) || null;
}

function setDetailsProbeCache(video, payload) {
    const key = makeDetailsProbeCacheKey(video);
    if (!key || key.startsWith('|')) return;
    detailsProbeCache.set(key, payload);
    if (detailsProbeCache.size <= DETAILS_PROBE_CACHE_LIMIT) return;
    const first = detailsProbeCache.keys().next();
    if (!first.done) detailsProbeCache.delete(first.value);
}

function loadAudioIndexStore() {
    try {
        audioIndexStore.clear();
        const rows = db.prepare(`
            SELECT file_path_key AS filePathKey, file_size AS fileSize, file_mtime_ms AS fileMtimeMs, has_audio AS hasAudio, checked_at AS checkedAt
            FROM media_audio_index
        `).all();
        for (const row of rows || []) {
            const key = String(row?.filePathKey || '').trim();
            if (!key) continue;
            audioIndexStore.set(key, {
                size: Number(row?.fileSize || 0),
                mtimeMs: Number(row?.fileMtimeMs || 0),
                hasAudio: Number(row?.hasAudio || 0) === 1,
                checkedAt: Number(row?.checkedAt || 0),
            });
        }
    } catch (err) {
        console.warn('[AudioIndex] Failed to load index:', err?.message || String(err));
    }
}

function loadDurationIndexStore() {
    try {
        durationIndexStore.clear();
        const rows = db.prepare(`
            SELECT file_path_key AS filePathKey, file_size AS fileSize, file_mtime_ms AS fileMtimeMs, duration_sec AS durationSec, checked_at AS checkedAt
            FROM media_duration_index
        `).all();
        for (const row of rows || []) {
            const key = String(row?.filePathKey || '').trim();
            if (!key) continue;
            durationIndexStore.set(key, {
                size: Number(row?.fileSize || 0),
                mtimeMs: Number(row?.fileMtimeMs || 0),
                durationSec: Number(row?.durationSec || 0),
                checkedAt: Number(row?.checkedAt || 0),
            });
        }
    } catch (err) {
        console.warn('[DurationIndex] Failed to load index:', err?.message || String(err));
    }
}

function enqueueAudioIndex(videoLike) {
    const filePath = String(videoLike?.filePath || '').trim();
    if (!filePath) return;
    const key = normalizeMediaPathKey(filePath);
    if (!key) return;
    if (audioIndexQueued.has(key)) return;

    const size = Number(videoLike?.size || 0);
    const mtimeMs = Number(videoLike?.modifiedAt || 0);
    const indexed = getIndexedHasAudio(filePath, size, mtimeMs);
    if (typeof indexed === 'boolean') return;

    audioIndexQueued.add(key);
    audioIndexQueue.push({ filePath, size, mtimeMs, key });
    setImmediate(() => { processAudioIndexQueue().catch(() => { }); });
}

function enqueueDurationIndex(videoLike) {
    const filePath = String(videoLike?.filePath || '').trim();
    if (!filePath) return;
    const key = normalizeMediaPathKey(filePath);
    if (!key) return;
    if (durationIndexQueued.has(key)) return;

    const size = Number(videoLike?.size || 0);
    const mtimeMs = Number(videoLike?.modifiedAt || 0);
    const indexed = getIndexedDuration(filePath, size, mtimeMs);
    if (Number(indexed || 0) > 0) return;

    durationIndexQueued.add(key);
    durationIndexQueue.push({ filePath, size, mtimeMs, key });
    setImmediate(() => { processDurationIndexQueue().catch(() => { }); });
}

function applyHasAudioToVideoCaches(filePath, hasAudio) {
    const normalized = normalizeMediaPathKey(filePath);
    if (!normalized) return;
    const flag = !!hasAudio;
    for (const video of Object.values(videoIndex)) {
        if (!video?.filePath) continue;
        if (normalizeMediaPathKey(video.filePath) === normalized) {
            video.hasAudio = flag;
        }
    }
    for (const cache of Object.values(libraryCache)) {
        for (const video of (cache?.videos || [])) {
            if (!video?.filePath) continue;
            if (normalizeMediaPathKey(video.filePath) === normalized) {
                video.hasAudio = flag;
            }
        }
    }
}

async function processAudioIndexQueue() {
    while (audioIndexRunning < AUDIO_INDEX_CONCURRENCY && audioIndexQueue.length > 0) {
        const job = audioIndexQueue.shift();
        if (!job) break;
        audioIndexRunning += 1;
        (async () => {
            try {
                const hasAudio = await probeHasAudioViaExec(job.filePath);
                if (typeof hasAudio === 'boolean') {
                    persistIndexedHasAudio(job.filePath, job.size, job.mtimeMs, hasAudio);
                    applyHasAudioToVideoCaches(job.filePath, hasAudio);
                }
            } catch { }
            finally {
                audioIndexQueued.delete(job.key);
                audioIndexRunning = Math.max(0, audioIndexRunning - 1);
                if (audioIndexQueue.length > 0) {
                    setImmediate(() => { processAudioIndexQueue().catch(() => { }); });
                }
            }
        })();
    }
}

async function processDurationIndexQueue() {
    while (durationIndexRunning < DURATION_INDEX_CONCURRENCY && durationIndexQueue.length > 0) {
        const job = durationIndexQueue.shift();
        if (!job) break;
        durationIndexRunning += 1;
        (async () => {
            try {
                const sec = await getVideoDurationSeconds(job.filePath);
                if (Number(sec || 0) > 0) {
                    persistIndexedDuration(job.filePath, job.size, job.mtimeMs, sec);
                    applyDurationToVideoCaches(job.filePath, sec);
                }
            } catch { }
            finally {
                durationIndexQueued.delete(job.key);
                durationIndexRunning = Math.max(0, durationIndexRunning - 1);
                if (durationIndexQueue.length > 0) {
                    setImmediate(() => { processDurationIndexQueue().catch(() => { }); });
                }
            }
        })();
    }
}

function getIndexedHasAudio(filePath, size = 0, mtimeMs = 0) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return null;
    const entry = audioIndexStore.get(key);
    if (!entry) return null;
    const safeSize = Number(size || 0);
    const safeMtime = Number(mtimeMs || 0);
    if (entry.size !== safeSize || entry.mtimeMs !== safeMtime) return null;
    return !!entry.hasAudio;
}

function getIndexedDuration(filePath, size = 0, mtimeMs = 0) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return null;
    const entry = durationIndexStore.get(key);
    if (!entry) return null;
    const safeSize = Number(size || 0);
    const safeMtime = Number(mtimeMs || 0);
    if (entry.size !== safeSize || entry.mtimeMs !== safeMtime) return null;
    const sec = Number(entry.durationSec || 0);
    return sec > 0 ? sec : null;
}

const upsertAudioIndexStmt = db.prepare(`
    INSERT INTO media_audio_index (file_path_key, file_path, file_size, file_mtime_ms, has_audio, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path_key) DO UPDATE SET
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        has_audio = excluded.has_audio,
        checked_at = excluded.checked_at
`);

const upsertDurationIndexStmt = db.prepare(`
    INSERT INTO media_duration_index (file_path_key, file_path, file_size, file_mtime_ms, duration_sec, checked_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path_key) DO UPDATE SET
        file_path = excluded.file_path,
        file_size = excluded.file_size,
        file_mtime_ms = excluded.file_mtime_ms,
        duration_sec = excluded.duration_sec,
        checked_at = excluded.checked_at
`);

function persistIndexedHasAudio(filePath, size, mtimeMs, hasAudio) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return;
    const now = Date.now();
    const safeSize = Number(size || 0);
    const safeMtime = Number(mtimeMs || 0);
    const flag = !!hasAudio;
    audioIndexStore.set(key, {
        size: safeSize,
        mtimeMs: safeMtime,
        hasAudio: flag,
        checkedAt: now,
    });
    audioPresenceCache.set(key, flag);
    audioProbeFailureUntil.delete(key);
    try {
        upsertAudioIndexStmt.run(key, String(filePath || ''), safeSize, safeMtime, flag ? 1 : 0, now);
    } catch { }
}

function persistIndexedDuration(filePath, size, mtimeMs, durationSec) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return;
    const now = Date.now();
    const safeSize = Number(size || 0);
    const safeMtime = Number(mtimeMs || 0);
    const sec = Math.max(0, Number(durationSec || 0));
    durationIndexStore.set(key, {
        size: safeSize,
        mtimeMs: safeMtime,
        durationSec: sec,
        checkedAt: now,
    });
    try {
        upsertDurationIndexStmt.run(key, String(filePath || ''), safeSize, safeMtime, sec, now);
    } catch { }
}

function applyDurationToVideoCaches(filePath, durationSec) {
    const normalized = normalizeMediaPathKey(filePath);
    if (!normalized) return;
    const sec = Math.max(0, Number(durationSec || 0));
    for (const video of Object.values(videoIndex)) {
        if (!video?.filePath) continue;
        if (normalizeMediaPathKey(video.filePath) === normalized) {
            video.durationSec = sec;
        }
    }
    for (const cache of Object.values(libraryCache)) {
        for (const video of (cache?.videos || [])) {
            if (!video?.filePath) continue;
            if (normalizeMediaPathKey(video.filePath) === normalized) {
                video.durationSec = sec;
            }
        }
    }
}

function setHasAudioCache(filePath, hasAudio) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return;
    audioPresenceCache.set(key, !!hasAudio);
}

function getHasAudioCache(filePath) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return null;
    if (!audioPresenceCache.has(key)) return null;
    return !!audioPresenceCache.get(key);
}

function probeHasAudioViaExec(filePath) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=index',
            '-of', 'csv=p=0',
            filePath,
        ];
        execFile(ffprobePath, args, { timeout: 4500 }, (err, stdout) => {
            if (err) return resolve(null);
            const out = String(stdout || '').trim();
            if (!out) return resolve(false);
            resolve(true);
        });
    });
}

function probeHasAudio(filePath) {
    const key = normalizeMediaPathKey(filePath);
    if (!key) return Promise.resolve(false);
    if (audioPresenceCache.has(key)) return Promise.resolve(!!audioPresenceCache.get(key));
    if (audioPresenceInFlight.has(key)) return audioPresenceInFlight.get(key);
    const blockedUntil = Number(audioProbeFailureUntil.get(key) || 0);
    if (blockedUntil > Date.now()) return Promise.resolve(null);

    const probePromise = new Promise((resolve) => {
        probeHasAudioViaExec(filePath).then((fallback) => {
            if (typeof fallback === 'boolean') {
                audioPresenceCache.set(key, fallback);
                audioProbeFailureUntil.delete(key);
                resolve(fallback);
                return;
            }
            audioProbeFailureUntil.set(key, Date.now() + AUDIO_PROBE_FAILURE_COOLDOWN_MS);
            resolve(null);
        }).catch(() => {
            audioProbeFailureUntil.set(key, Date.now() + AUDIO_PROBE_FAILURE_COOLDOWN_MS);
            resolve(null);
        });
    }).finally(() => {
        audioPresenceInFlight.delete(key);
    });

    audioPresenceInFlight.set(key, probePromise);
    return probePromise;
}

async function mapWithConcurrency(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    const maxWorkers = Math.max(1, Number(limit || 1));
    const out = new Array(list.length);
    let cursor = 0;
    const runOne = async () => {
        while (true) {
            const idx = cursor;
            cursor += 1;
            if (idx >= list.length) return;
            out[idx] = await worker(list[idx], idx);
        }
    };
    const workers = Array.from({ length: Math.min(maxWorkers, list.length) }, () => runOne());
    await Promise.all(workers);
    return out;
}

function buildQuickThumbSeekCandidates() {
    return [2, 0];
}

function buildVrMetaForVideo(baseTitle, filePath, libraryType = 'videos') {
    const tpdbMeta = filePath ? getTpdbMetaForVideoPath(filePath) : null;
    const fileNameBase = filePath
        ? path.basename(String(filePath || ''), path.extname(String(filePath || '')))
        : '';
    const detectedFromRaw = detectVrMetaFromMetadataRaw(tpdbMeta?.raw || {});
    const detected = detectVrMetaFromCandidates([
        fileNameBase,
        baseTitle,
        tpdbMeta?.title,
        tpdbMeta?.sourceUrl,
    ]);
    const override = getVrMetaByPath(filePath);
    // Raw metadata defaults to unknown/mono even when no real VR hints exist.
    // Only let raw override filename/title detection when it carries a meaningful value.
    const rawProjection = normalizeVrProjection(detectedFromRaw?.projection);
    const rawStereoMode = normalizeVrStereoMode(detectedFromRaw?.stereoMode);
    const detectedProjection = normalizeVrProjection(detected?.projection);
    const detectedStereoMode = normalizeVrStereoMode(detected?.stereoMode);
    const baseProjection = rawProjection !== 'unknown' ? rawProjection : detectedProjection;
    const baseStereoMode = rawStereoMode !== 'mono' ? rawStereoMode : detectedStereoMode;
    const overrideProjection = normalizeVrProjection(override?.projection);
    const overrideStereoMode = normalizeVrStereoMode(override?.stereoMode);
    const projection = overrideProjection !== 'unknown' ? overrideProjection : baseProjection;
    const stereoMode = overrideStereoMode !== 'mono' ? overrideStereoMode : baseStereoMode;
    const isVrLibrary = String(libraryType || '').toLowerCase() === 'vr';
    const isVr = isVrLibrary || !!detectedFromRaw.isVr || !!detected.isVr || projection !== 'unknown' || stereoMode !== 'mono';
    return { isVr, vrProjection: projection, vrStereoMode: stereoMode };
}

function refreshVrMetaForPath(videoPath) {
    const normalizedPath = path.normalize(String(videoPath || ''));
    if (!normalizedPath) return;
    const normalizedKey = normalizedPath.toLowerCase();

    for (const video of Object.values(videoIndex)) {
        if (!video?.filePath) continue;
        if (path.normalize(video.filePath).toLowerCase() !== normalizedKey) continue;
        const vrMeta = buildVrMetaForVideo(video.title || path.basename(video.filePath, path.extname(video.filePath)), video.filePath, video.libraryType || 'videos');
        video.isVr = !!vrMeta.isVr;
        video.vrProjection = vrMeta.vrProjection;
        video.vrStereoMode = vrMeta.vrStereoMode;
    }

    for (const cache of Object.values(libraryCache)) {
        if (!cache?.videos) continue;
        for (const video of cache.videos) {
            if (!video?.filePath) continue;
            if (path.normalize(video.filePath).toLowerCase() !== normalizedKey) continue;
            const vrMeta = buildVrMetaForVideo(video.title || path.basename(video.filePath, path.extname(video.filePath)), video.filePath, video.libraryType || 'videos');
            video.isVr = !!vrMeta.isVr;
            video.vrProjection = vrMeta.vrProjection;
            video.vrStereoMode = vrMeta.vrStereoMode;
        }
    }
}

async function scanFlatVideosAsync(dirPath, videos = [], recursive = true, targetIndex = videoIndex, libraryType = 'videos', libraryId = '') {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        const fileSet = new Set(entries.map(e => e.name));

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory() && recursive) {
                await scanFlatVideosAsync(fullPath, videos, true, targetIndex, libraryType, libraryId);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (!VIDEO_EXTENSIONS.includes(ext)) continue;

                const baseName = path.basename(entry.name, ext);
                const axisInfo = detectAxes(baseName, fileSet);
                const vrMeta = buildVrMetaForVideo(baseName, fullPath, libraryType);
                let stats;
                try { stats = await fs.promises.stat(fullPath); } catch { stats = { size: 0, mtimeMs: Date.now() }; }
                const sizeNum = Number(stats.size || 0);
                const mtimeNum = Number(stats.mtimeMs || Date.now());
                const durationSec = Number(getIndexedDuration(fullPath, sizeNum, mtimeNum) || 0);

                const videoTitle = (() => {
                    const saved = tpdbVideoMetaByKey.get(normalizeVideoPathKey(fullPath));
                    return String(saved?.title || baseName || '');
                })();
                const video = registerVideo({
                    id: generateStableId(fullPath),
                    title: videoTitle,
                    fileName: entry.name,
                    filePath: fullPath,
                    directory: dirPath,
                    extension: ext,
                    size: sizeNum,
                    modifiedAt: mtimeNum,
                    hasFunscript: axisInfo.hasFunscript,
                    funscriptPath: axisInfo.funscriptFile ? path.join(dirPath, axisInfo.funscriptFile) : null,
                    axes: axisInfo.axes,
                    isMultiAxis: axisInfo.isMultiAxis,
                    isVr: vrMeta.isVr,
                    vrProjection: vrMeta.vrProjection,
                    vrStereoMode: vrMeta.vrStereoMode,
                    hasAudio: getIndexedHasAudio(fullPath, sizeNum, mtimeNum),
                    durationSec: durationSec,
                    libraryType: String(libraryType || 'videos').toLowerCase(),
                    libraryId: String(libraryId || ''),
                    tags: getVideoTags(fullPath),
                }, targetIndex);
                applyTpdbMetaToVideoObject(video);
                enqueueAudioIndex(video);
                enqueueDurationIndex(video);
                videos.push(video);
            }
        }
    } catch (err) {
        console.error(`Error scanning ${dirPath}:`, err.message);
        addRuntimeLog('warn', 'scan', 'Error scanning directory', { dirPath, error: err?.message || String(err) });
    }
    return videos;
}

async function scanFolderStructureAsync(rootPath, targetIndex = videoIndex, libraryId = '') {
    const folders = [];
    let allVideos = [];
    try {
        const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(rootPath, entry.name);
            const metadata = getMetadata(fullPath);
            const tags = getFolderTags(fullPath);
            const hasPosterFile = hasPoster(fullPath);

            let stats;
            try { stats = await fs.promises.stat(fullPath); } catch { stats = { mtimeMs: 0 }; }

            const videos = await scanFlatVideosAsync(fullPath, [], true, targetIndex, 'series', libraryId);
            allVideos = allVideos.concat(videos);

            let subfolders = [];
            try {
                const subEntries = await fs.promises.readdir(fullPath, { withFileTypes: true });
                subfolders = subEntries.filter(e => e.isDirectory()).map(e => ({
                    name: e.name,
                    path: path.join(fullPath, e.name),
                    videoCount: 0,
                }));
            } catch { }

            const funscriptCount = videos.filter(v => v.hasFunscript).length;
            folders.push({
                id: generateStableId(fullPath),
                name: entry.name,
                path: fullPath,
                videoCount: videos.length,
                funscriptCount,
                subfolders,
                metadata,
                tags,
                hasPoster: hasPosterFile,
                posterVersion: hasPosterFile ? getPosterVersion(fullPath) : 0,
                modifiedAt: Number(stats.mtimeMs || 0),
            });
        }
    } catch (err) {
        console.error(`Error scanning folder structure ${rootPath}:`, err.message);
        addRuntimeLog('warn', 'scan', 'Error scanning folder structure', { rootPath, error: err?.message || String(err) });
    }
    return { folders, videos: allVideos };
}

async function scanLibrary(lib, targetCache = libraryCache, targetIndex = videoIndex) {
    const libType = String(lib?.type || 'videos').toLowerCase();
    if (libType === 'series') {
        const { folders, videos } = await scanFolderStructureAsync(lib.path, targetIndex, lib.id);
        targetCache[lib.id] = { videos: videos || [], folders };
        return;
    }
    const videos = await scanFlatVideosAsync(lib.path, [], true, targetIndex, libType, lib.id);
    targetCache[lib.id] = { videos: videos || [], folders: [] };
}

async function scanAllLibraries() {
    if (isScanning) return;
    const settings = loadSettings();
    const libs = settings.libraries || [];
    const nextLibraryCache = {};
    const nextVideoIndex = {};
    isScanning = true;
    lastScanStartedAt = Date.now();
    console.time('scanAllLibraries');
    try {
        for (const lib of libs) {
            nextLibraryCache[lib.id] = { videos: [], folders: [] };
            if (!lib?.path || !fs.existsSync(lib.path)) {
                addRuntimeLog('warn', 'scan', 'Library path not found during scan', {
                    libraryId: String(lib?.id || ''),
                    libraryName: String(lib?.name || ''),
                    path: String(lib?.path || ''),
                });
                libraryCache[lib.id] = nextLibraryCache[lib.id];
                continue;
            }
            try {
                await scanLibrary(lib, nextLibraryCache, nextVideoIndex);
                const cache = nextLibraryCache[lib.id];
                console.log(`Scanned "${lib.name}" (${lib.id}): ${cache.videos.length} videos, ${cache.folders.length} folders`);
                // Keep UI responsive during long full scans by publishing partial results.
                libraryCache[lib.id] = cache;
            } catch (err) {
                console.error(`Failed scanning "${lib?.name || lib?.id}":`, err?.message || String(err));
                addRuntimeLog('error', 'scan', 'Library scan failed', {
                    libraryId: String(lib?.id || ''),
                    libraryName: String(lib?.name || ''),
                    error: err?.message || String(err),
                });
            }
        }
        libraryCache = nextLibraryCache;
        videoIndex = nextVideoIndex;
        try {
            autoLinkFunscriptsForLibrary('', { recordHistory: false, source: 'auto-scan-all' });
        } catch (err) {
            console.error('Automatic funscript linking after full scan failed:', err?.message || String(err));
            addRuntimeLog('warn', 'funscript', 'Automatic funscript linking failed after full scan', {
                error: err?.message || String(err),
            });
        }
    } finally {
        console.timeEnd('scanAllLibraries');
        isScanning = false;
        lastScanFinishedAt = Date.now();
        lastScanDurationMs = lastScanFinishedAt - lastScanStartedAt;
        cleanupOrphanArtifacts();
        refreshLibraryWatchers();
        scheduleThumbnailGeneration();
        scheduleHeatmapGeneration();
    }
}

async function scanLibraryById(libraryId) {
    const id = String(libraryId || '').trim();
    if (!id) return;
    if (isScanning) return;

    const settings = loadSettings();
    const libs = settings.libraries || [];
    const lib = libs.find((entry) => String(entry?.id || '') === id);

    isScanning = true;
    lastScanStartedAt = Date.now();
    console.time(`scanLibraryById:${id}`);
    try {
        if (!lib || !lib.path || !fs.existsSync(lib.path)) {
            libraryCache[id] = { videos: [], folders: [] };
            const filteredIndex = {};
            for (const [videoId, video] of Object.entries(videoIndex || {})) {
                if (String(video?.libraryId || '') === id) continue;
                filteredIndex[videoId] = video;
            }
            videoIndex = filteredIndex;
            return;
        }

        const nextCache = {};
        const nextIndex = {};
        await scanLibrary(lib, nextCache, nextIndex);

        const filteredIndex = {};
        for (const [videoId, video] of Object.entries(videoIndex || {})) {
            if (String(video?.libraryId || '') === id) continue;
            filteredIndex[videoId] = video;
        }

        libraryCache[id] = nextCache[id] || { videos: [], folders: [] };
        videoIndex = { ...filteredIndex, ...nextIndex };
        try {
            autoLinkFunscriptsForLibrary(id, { recordHistory: false, source: 'auto-scan-library' });
        } catch (err) {
            console.error(`Automatic funscript linking after library scan failed (${id}):`, err?.message || String(err));
            addRuntimeLog('warn', 'funscript', 'Automatic funscript linking failed after library scan', {
                libraryId: id,
                error: err?.message || String(err),
            });
        }

        const cache = libraryCache[id] || { videos: [], folders: [] };
        console.log(`Scanned "${lib.name}" (${lib.id}): ${cache.videos.length} videos, ${cache.folders.length} folders`);
    } finally {
        console.timeEnd(`scanLibraryById:${id}`);
        isScanning = false;
        lastScanFinishedAt = Date.now();
        lastScanDurationMs = lastScanFinishedAt - lastScanStartedAt;
        cleanupOrphanArtifacts();
        refreshLibraryWatchers();
        scheduleThumbnailGeneration();
        scheduleHeatmapGeneration();
    }
}

function getHeresphereToken() {
    return String(process.env.GLYPH_HERESPHERE_TOKEN || '').trim();
}

function isAuthorizedForHeresphere(req) {
    const token = getHeresphereToken();
    if (!token) return true;
    const provided = String(req.query?.token || '').trim();
    return provided && provided === token;
}

function heresphereUnauthorized(res) {
    return res.status(401).json({ error: 'Unauthorized' });
}

function getRequestBaseUrl(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    const host = req.get('host');
    return `${protocol}://${host}`;
}

function getNetworkIpCandidates() {
    const out = [];
    const interfaces = os.networkInterfaces() || {};
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.internal) continue;
            if (entry.family !== 'IPv4') continue;
            if (!entry.address) continue;
            out.push(entry.address);
        }
    }
    return [...new Set(out)].sort();
}

function getVrLibrariesAndVideos() {
    const settings = loadSettings();
    const vrLibraries = (settings.libraries || []).filter((lib) => String(lib?.type || '').toLowerCase() === 'vr');
    const byLibrary = vrLibraries.map((lib) => {
        const cache = libraryCache[lib.id] || { videos: [] };
        const videos = (cache.videos || [])
            .filter((v) => String(v?.libraryType || '').toLowerCase() === 'vr')
            .sort((a, b) => Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0));
        return { library: lib, videos };
    });
    return { vrLibraries, byLibrary };
}

function buildHeresphereVideoUrl(baseUrl, videoId, token = '') {
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${baseUrl}/api/heresphere/video/${encodeURIComponent(videoId)}${tokenPart}`;
}

function buildHeresphereStreamUrl(baseUrl, videoId, token = '') {
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${baseUrl}/api/heresphere/stream/${encodeURIComponent(videoId)}${tokenPart}`;
}

function buildHeresphereThumbUrl(baseUrl, videoId, token = '') {
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${baseUrl}/api/heresphere/thumbnail/${encodeURIComponent(videoId)}${tokenPart}`;
}

function getHeresphereProjection(vrProjection) {
    const projection = normalizeVrProjection(vrProjection);
    if (projection === '360') return 'equirectangular360';
    if (projection === '180') return 'equirectangular';
    return 'flat';
}

function getHeresphereStereo(vrStereoMode) {
    const stereo = normalizeVrStereoMode(vrStereoMode);
    if (stereo === 'ou') return 'tb';
    if (stereo === 'sbs') return 'sbs';
    return 'mono';
}

function getVideoFolderMetadata(video) {
    try {
        const dir = String(video?.directory || path.dirname(String(video?.filePath || '')) || '');
        return getMetadata(dir) || {};
    } catch {
        return {};
    }
}

function getVideoMetadata(video) {
    try {
        const filePath = String(video?.filePath || '').trim();
        if (!filePath) return {};
        return getMetadata(filePath) || {};
    } catch {
        return {};
    }
}

function parseNumericRating(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n >= 0 && n <= 5) return n;
    if (n > 5 && n <= 10) return Math.max(0, Math.min(5, n / 2));
    if (n > 10 && n <= 100) return Math.max(0, Math.min(5, n / 20));
    return null;
}

function getVideoRating5(video, folderMeta) {
    // Prefer explicit metadata rating if available.
    const fromMeta = parseNumericRating(folderMeta?.rating);
    if (fromMeta !== null) return fromMeta;
    // Fallback: parse "rating X.Y" from title.
    const title = String(video?.title || '');
    const m = title.match(/rating\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (m && m[1]) {
        const fromTitle = parseNumericRating(Number(m[1]));
        if (fromTitle !== null) return fromTitle;
    }
    return null;
}

function getVideoReleasedDate(video, folderMeta) {
    const date = String(folderMeta?.date || folderMeta?.releaseDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    const yearMeta = String(folderMeta?.year || '').trim();
    if (/^\d{4}$/.test(yearMeta)) return `${yearMeta}-01-01`;
    const title = String(video?.title || '');
    const yearMatch = title.match(/\b(19|20)\d{2}\b/);
    if (yearMatch && yearMatch[0]) return `${yearMatch[0]}-01-01`;
    return null;
}

function getVideoIsFavorite(video, _folderMeta) {
    const tags = Array.isArray(video?.tags) ? video.tags.map((t) => String(t || '').toLowerCase()) : [];
    if (tags.some((t) => t.includes('favorite') || t.includes('favorit') || t === 'fav')) return true;
    const videoMeta = getVideoMetadata(video);
    if (videoMeta?.favorite === true) return true;
    return false;
}

function getVideoTagDtos(video) {
    const tags = Array.isArray(video?.tags) ? video.tags : [];
    const categoryMap = getTagCategoryMap();
    const out = [];
    const seen = new Set();
    const normalizeTagLabelKey = (text) => String(text || '')
        .toLowerCase()
        .replace(/\s*[:：∶]\s*/g, ':')
        .replace(/\s+/g, ' ')
        .trim();
    const normalizeDisplayLabel = (text) => String(text || '')
        .replace(/\s*[:：∶]\s*/g, '∶')
        .replace(/\s+/g, ' ')
        .trim();
    const pushLabel = (group, label) => {
        const grp = String(group || '').trim() || 'Tag';
        const safe = String(label || '').trim();
        if (!safe) return;
        const key = `${grp}:${normalizeTagLabelKey(safe)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name: `${grp}:${normalizeDisplayLabel(safe)}` });
    };

    tags.forEach((tag) => {
        const raw = String(tag || '').trim();
        if (!raw) return;
        const key = normalizeTagKey(raw);
        const cat = normalizeTagCategoryName(categoryMap?.[key]?.category || '');
        let tagName = raw;
        if (cat) {
            const escapedCat = cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Remove duplicated category prefix variants from stored tag text.
            tagName = tagName.replace(new RegExp(`^\\s*${escapedCat}\\s*[:：∶]\\s*`, 'i'), '').trim();
        }
        // Keep all user tags in one HereSphere category ("Tags"),
        // while showing Glyph category context in the label.
        // Use a colon-like separator to avoid HereSphere creating extra categories.
        const label = cat ? `${cat}∶${tagName}` : tagName;
        pushLabel('Tags', label);
    });

    // Glyph-style filter tags
    if (video?.hasFunscript) {
        pushLabel('Filter', 'Has Funscript');
        pushLabel('Filter', video?.isMultiAxis ? 'Multi-Axis' : 'Single-Axis');
    } else {
        pushLabel('Filter', 'No Funscript');
    }
    if (video?.hasAudio === true) pushLabel('Filter', 'Has Audio');
    if (video?.hasAudio === false) pushLabel('Filter', 'No Audio');

    return out.filter((t) => t.name.length > 4);
}

function getPrimaryScriptPathForVideo(video) {
    if (!video?.id) return String(video?.funscriptPath || '').trim() || null;
    try {
        const mapped = db.prepare(`
            SELECT script_path AS scriptPath
            FROM funscript_mappings
            WHERE video_id = ? AND enabled = 1
            ORDER BY
                CASE WHEN LOWER(axis) = 'main' AND is_default = 1 THEN 0
                     WHEN is_default = 1 THEN 1
                     WHEN LOWER(axis) = 'main' THEN 2
                     ELSE 3 END,
                updated_at DESC
            LIMIT 1
        `).get(String(video.id));
        const mappedPath = String(mapped?.scriptPath || '').trim();
        if (mappedPath) return mappedPath;
    } catch { }
    const direct = String(video?.funscriptPath || '').trim();
    return direct || null;
}

function heatColorForLevel(v) {
    const t = Math.max(0, Math.min(1, Number(v || 0)));
    if (t < 0.33) {
        const k = t / 0.33;
        const r = Math.round(40 + (255 - 40) * k);
        const g = Math.round(170 + (210 - 170) * k);
        const b = Math.round(80 - 60 * k);
        return `rgb(${r},${g},${b})`;
    }
    if (t < 0.66) {
        const k = (t - 0.33) / 0.33;
        return `rgb(255,${Math.round(210 - 90 * k)},${Math.round(20 + 10 * k)})`;
    }
    const k = (t - 0.66) / 0.34;
    return `rgb(${Math.round(255 - 35 * k)},${Math.round(120 - 100 * k)},${Math.round(30 - 20 * k)})`;
}

function buildHeatmapBarsFromActions(actionsInput, segmentCount = 110) {
    const actions = Array.isArray(actionsInput) ? actionsInput : [];
    if (actions.length < 2) return [];
    const total = Math.max(1, Number(actions[actions.length - 1]?.at || 0));
    const seg = Array.from({ length: segmentCount }, () => 0);
    for (let i = 0; i < actions.length - 1; i += 1) {
        const a = actions[i];
        const b = actions[i + 1];
        const dt = Math.max(1, Number(b?.at || 0) - Number(a?.at || 0));
        const dp = Math.abs(Number(b?.pos || 0) - Number(a?.pos || 0));
        const speed = dp / dt;
        const at = Math.max(0, Math.min(total, Number(a?.at || 0)));
        const idx = Math.max(0, Math.min(segmentCount - 1, Math.floor((at / total) * segmentCount)));
        if (speed > seg[idx]) seg[idx] = speed;
    }
    const max = Math.max(...seg, 0.0001);
    return seg.map((v) => v / max);
}

function buildDetailedHeatmapData(actionsInput, segmentCount = 220) {
    const actions = Array.isArray(actionsInput) ? actionsInput : [];
    if (actions.length < 2) return null;
    const total = Math.max(1, Number(actions[actions.length - 1]?.at || 0));
    const segmentDuration = total / segmentCount;
    const movementPerSegment = new Array(segmentCount).fill(0);
    const strokePerSegment = new Array(segmentCount).fill(0);
    const pos = Array.from({ length: segmentCount }, () => 0);
    const posCount = Array.from({ length: segmentCount }, () => 0);

    for (let i = 0; i < actions.length - 1; i += 1) {
        const a = actions[i];
        const b = actions[i + 1];
        const t1 = Number(a?.at || 0);
        const t2 = Number(b?.at || 0);
        if (t2 <= t1) continue;

        const dt = t2 - t1;
        const dp = Math.abs(Number(b?.pos || 0) - Number(a?.pos || 0));
        const avgPos = Math.max(0, Math.min(100, (Number(a?.pos || 0) + Number(b?.pos || 0)) / 2));

        const firstSeg = Math.max(0, Math.floor(t1 / segmentDuration));
        const lastSeg = Math.min(segmentCount - 1, Math.floor((t2 - 1) / segmentDuration));

        for (let seg = firstSeg; seg <= lastSeg; seg += 1) {
            const segStart = seg * segmentDuration;
            const segEnd = segStart + segmentDuration;
            const overlapStart = Math.max(segStart, t1);
            const overlapEnd = Math.min(segEnd, t2);
            const overlap = overlapEnd - overlapStart;
            if (overlap <= 0) continue;

            const overlapRatio = overlap / dt;
            if (dp > 0) {
                movementPerSegment[seg] += dp * overlapRatio;
                strokePerSegment[seg] += overlapRatio;
            }
            pos[seg] += avgPos;
            posCount[seg] += 1;
        }
    }

    for (let i = 0; i < segmentCount; i += 1) {
        pos[i] = posCount[i] > 0 ? (pos[i] / posCount[i]) : (i > 0 ? pos[i - 1] : 50);
    }

    const segmentSeconds = Math.max(segmentDuration / 1000, 1e-6);
    const speed = movementPerSegment.map((m) => m / segmentSeconds);
    const strokes = strokePerSegment.map((s) => s / segmentSeconds);

    // Normalize by 95th percentile (same as client)
    const speedN = normalizeByPercentileServer(speed, 95);
    const strokesN = normalizeByPercentileServer(strokes, 95);
    const norm = speedN.map((v, i) => (v * 0.65) + (strokesN[i] * 0.35));

    return { norm, pos, total };
}

function percentileServer(values, p) {
    if (!values || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const t = idx - lo;
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
}

function normalizeByPercentileServer(values, p = 95) {
    const nonZero = values.filter((v) => v > 0);
    if (nonZero.length === 0) return values.map(() => 0);
    const scale = Math.max(percentileServer(nonZero, p), 1e-6);
    return values.map((v) => Math.max(0, Math.min(1, v / scale)));
}

function heatColorForDetailedLevel(v) {
    const t = Math.max(0, Math.min(1, Number(v || 0)));
    const stops = [
        { t: 0.00, c: [15, 23, 42] },    // background (no movement)
        { t: 0.03, c: [34, 112, 238] },   // blue (very slow)
        { t: 0.14, c: [33, 174, 255] },   // cyan
        { t: 0.28, c: [49, 190, 103] },   // green
        { t: 0.46, c: [231, 212, 64] },   // yellow
        { t: 0.64, c: [244, 152, 53] },   // orange
        { t: 0.82, c: [232, 70, 51] },    // red
        { t: 0.93, c: [218, 58, 126] },   // magenta (rare)
        { t: 1.00, c: [245, 105, 200] },  // pink (very fast peaks)
    ];
    let a = stops[0];
    let b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i += 1) {
        const s1 = stops[i];
        const s2 = stops[i + 1];
        if (t >= s1.t && t <= s2.t) {
            a = s1;
            b = s2;
            break;
        }
    }
    const span = Math.max(0.0001, b.t - a.t);
    const p = (t - a.t) / span;
    const r = Math.round(a.c[0] + ((b.c[0] - a.c[0]) * p));
    const g = Math.round(a.c[1] + ((b.c[1] - a.c[1]) * p));
    const bl = Math.round(a.c[2] + ((b.c[2] - a.c[2]) * p));
    return [r, g, bl];
}

function crc32Buffer(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        c ^= buf[i];
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
    }
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const payload = Buffer.isBuffer(data) ? data : Buffer.alloc(0);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length, 0);
    const crc = Buffer.alloc(4);
    const crcVal = crc32Buffer(Buffer.concat([typeBuf, payload]));
    crc.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBuf, payload, crc]);
}

function encodePngRgba(width, height, rgba) {
    const w = Math.max(1, Math.floor(Number(width || 1)));
    const h = Math.max(1, Math.floor(Number(height || 1)));
    const expected = w * h * 4;
    if (!Buffer.isBuffer(rgba) || rgba.length !== expected) return null;

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const stride = w * 4;
    const raw = Buffer.alloc((stride + 1) * h);
    for (let y = 0; y < h; y += 1) {
        const srcOff = y * stride;
        const dstOff = y * (stride + 1);
        raw[dstOff] = 0; // filter type none
        rgba.copy(raw, dstOff + 1, srcOff, srcOff + stride);
    }
    const idat = zlib.deflateSync(raw, { level: 8 });
    return Buffer.concat([
        signature,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

function parseRgbString(rgbText) {
    const m = String(rgbText || '').match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
    if (!m) return [255, 255, 255];
    return [
        Math.max(0, Math.min(255, Number(m[1] || 255))),
        Math.max(0, Math.min(255, Number(m[2] || 255))),
        Math.max(0, Math.min(255, Number(m[3] || 255))),
    ];
}

function lerpSample(values, t) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    if (values.length === 1) return Number(values[0] || 0);
    const clamped = Math.max(0, Math.min(1, Number(t || 0)));
    const idx = clamped * (values.length - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(values.length - 1, i0 + 1);
    const k = idx - i0;
    const a = Number(values[i0] || 0);
    const b = Number(values[i1] || 0);
    return a + ((b - a) * k);
}

function makeSolidBgRgba(width, height, color = [15, 23, 42, 255]) {
    const w = Math.max(1, Math.floor(Number(width || 1)));
    const h = Math.max(1, Math.floor(Number(height || 1)));
    const buf = Buffer.alloc(w * h * 4);
    const r = color[0] | 0;
    const g = color[1] | 0;
    const b = color[2] | 0;
    const a = color[3] | 0;
    for (let i = 0; i < buf.length; i += 4) {
        buf[i] = r;
        buf[i + 1] = g;
        buf[i + 2] = b;
        buf[i + 3] = a;
    }
    return buf;
}

function setRgbaPixel(buf, width, x, y, rgba) {
    if (!buf) return;
    const w = Math.max(1, Math.floor(Number(width || 1)));
    const xx = Math.floor(Number(x || 0));
    const yy = Math.floor(Number(y || 0));
    if (xx < 0 || yy < 0) return;
    const off = (yy * w + xx) * 4;
    if (off < 0 || off + 3 >= buf.length) return;
    buf[off] = rgba[0] | 0;
    buf[off + 1] = rgba[1] | 0;
    buf[off + 2] = rgba[2] | 0;
    buf[off + 3] = rgba[3] | 0;
}

function buildDetailedHeatmapPng(data, opts = {}) {
    const norm = Array.isArray(data?.norm) ? data.norm : [];
    const pos = Array.isArray(data?.pos) ? data.pos : [];
    if (!norm.length || !pos.length) return null;

    const w = Math.max(120, Number(opts.width || 746));
    const h = Math.max(18, Number(opts.height || 30));
    const rgba = makeSolidBgRgba(w, h, [15, 23, 42, 255]);
    const pad = 2;
    const usableH = Math.max(8, h - (pad * 2));

    for (let x = 0; x < w; x += 1) {
        const t = w <= 1 ? 0 : (x / (w - 1));
        const vRaw = Math.max(0, Math.min(1, lerpSample(norm, t)));
        if (vRaw <= 0.005) continue; // truly zero → keep dark background
        const pRaw = Math.max(0, Math.min(100, lerpSample(pos, t)));
        // Push high-end colors later so red/pink are not overrepresented.
        const eased = Math.pow(vRaw, 1.18);

        const centerY = pad + ((1 - (pRaw / 100)) * usableH);
        const halfThickness = Math.max(1, (0.04 + (eased * 0.20)) * usableH);
        const y0 = Math.max(pad, Math.floor(centerY - halfThickness));
        const y1 = Math.min(h - pad - 1, Math.ceil(centerY + halfThickness));

        const rgb = heatColorForDetailedLevel(vRaw);
        for (let y = y0; y <= y1; y += 1) {
            setRgbaPixel(rgba, w, x, y, [rgb[0], rgb[1], rgb[2], 255]);
        }
    }
    return encodePngRgba(w, h, rgba);
}

function buildSimpleHeatmapPng(normInput, opts = {}) {
    const norm = Array.isArray(normInput) ? normInput : [];
    if (!norm.length) return null;
    const w = Math.max(120, Number(opts.width || 746));
    const h = Math.max(8, Number(opts.height || 16));
    const rgba = makeSolidBgRgba(w, h, [15, 23, 42, 255]);
    for (let x = 0; x < w; x += 1) {
        const t = w <= 1 ? 0 : (x / (w - 1));
        const v = Math.max(0, Math.min(1, lerpSample(norm, t)));
        const rgb = parseRgbString(heatColorForLevel(v));
        for (let y = 0; y < h; y += 1) {
            setRgbaPixel(rgba, w, x, y, [rgb[0], rgb[1], rgb[2], 255]);
        }
    }
    return encodePngRgba(w, h, rgba);
}

function makeSafeHeatmapNamePart(value, fallback = 'item') {
    const base = String(value || '').trim();
    const cleaned = base
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .toLowerCase();
    const out = cleaned.replace(/[^a-z0-9._-]/g, '');
    if (!out) return fallback;
    return out.slice(0, 72);
}

function inferAxisFromScriptPath(scriptPath) {
    const full = String(scriptPath || '').trim();
    if (!full) return 'main';
    const name = path.basename(full, '.funscript');
    const m = name.match(/\.([a-z0-9_-]+)$/i);
    const axisRaw = m && m[1] ? String(m[1]) : 'main';
    return normalizeFunscriptAxis(axisRaw);
}

function getVideoHeatmapCachePath(video, scriptPath, mode = 'detailed') {
    const scriptMtime = (scriptPath && fs.existsSync(scriptPath)) ? Number(fs.statSync(scriptPath).mtimeMs || 0) : 0;
    const key = generateStableId(`${video?.id || ''}|${video?.filePath || ''}|${scriptPath || ''}|${scriptMtime}|${mode}|v10`);
    const shortKey = key.slice(0, 10);
    const axis = makeSafeHeatmapNamePart(inferAxisFromScriptPath(scriptPath), 'main');
    const videoNameRaw = String(video?.title || path.basename(String(video?.filePath || ''), path.extname(String(video?.filePath || ''))) || 'video');
    const videoName = makeSafeHeatmapNamePart(videoNameRaw, 'video');
    return path.join(HEATMAP_DIR, `${videoName}.${axis}.${shortKey}.png`);
}

function ensureVideoHeatmapCache(video, variant = 'detailed') {
    const mode = 'detailed';
    const scriptPath = getPrimaryScriptPathForVideo(video);
    if (!scriptPath || !fs.existsSync(scriptPath)) return { ok: false, reason: 'no-script' };
    const parsed = parseFunscriptActionsFromFile(scriptPath);
    const detail = buildDetailedHeatmapData(parsed?.actions || [], 560);
    const bars = Array.isArray(detail?.norm) ? detail.norm : [];
    if (!bars.length) return { ok: false, reason: 'no-data' };
    const heatmapPath = getVideoHeatmapCachePath(video, scriptPath, mode);
    if (!fs.existsSync(heatmapPath)) {
        const png = mode === 'simple'
            ? buildSimpleHeatmapPng(bars, { width: 746, height: 16 })
            : buildDetailedHeatmapPng(detail, { width: 746, height: 30 });
        if (!png) return { ok: false, reason: 'no-png' };
        fs.writeFileSync(heatmapPath, png);
        return { ok: true, created: true, path: heatmapPath };
    }
    return { ok: true, created: false, path: heatmapPath };
}

async function generateAllHeatmaps(opts = {}) {
    const variants = ['detailed'];
    const libraryId = String(opts?.libraryId || '').trim();
    const onlyVr = opts?.onlyVr === true;
    const videos = Object.values(videoIndex || {}).filter((video) => {
        if (!video?.id || !video?.filePath) return false;
        if (libraryId && String(video?.libraryId || '') !== libraryId) return false;
        if (onlyVr && String(video?.libraryType || '').toLowerCase() !== 'vr') return false;
        return true;
    });

    const stats = {
        variant: 'detailed',
        libraryId: libraryId || null,
        onlyVr: !!onlyVr,
        processed: 0,
        generated: 0,
        skipped: 0,
    };

    for (let i = 0; i < videos.length; i += 1) {
        const video = videos[i];
        stats.processed += 1;
        let createdForVideo = false;
        for (const mode of variants) {
            const r = ensureVideoHeatmapCache(video, mode);
            if (r.ok && r.created) createdForVideo = true;
        }
        if (createdForVideo) stats.generated += 1;
        else stats.skipped += 1;

        if (i > 0 && i % 120 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }

    return stats;
}

function getArtifactTargetVideos(opts = {}) {
    const libraryId = String(opts?.libraryId || '').trim();
    return Object.values(videoIndex || {}).filter((video) => {
        if (!video?.id || !video?.filePath) return false;
        if (libraryId && String(video?.libraryId || '') !== libraryId) return false;
        return true;
    });
}

function deleteThumbnailArtifactsForVideoPath(videoPath) {
    const p = String(videoPath || '').trim();
    if (!p) return 0;
    const targets = [
        getThumbPath(p),
        getLegacyThumbPath(p),
        getTpdbThumbPath(p),
        getLegacyTpdbThumbPath(p),
    ];
    let deleted = 0;
    for (const target of targets) {
        if (!target) continue;
        if (fs.existsSync(target)) {
            try { fs.rmSync(target, { force: true }); deleted += 1; } catch { }
        }
        const srcPath = getThumbSourcePath(target);
        if (srcPath && fs.existsSync(srcPath)) {
            try { fs.rmSync(srcPath, { force: true }); } catch { }
        }
    }
    return deleted;
}

function deletePreviewArtifactsForVideoPath(videoPath) {
    const p = String(videoPath || '').trim();
    if (!p) return 0;
    const previewPath = getPreviewPath(p);
    const tmpPath = `${previewPath}.tmp`;
    let deleted = 0;
    if (fs.existsSync(previewPath)) {
        try { fs.rmSync(previewPath, { force: true }); deleted += 1; } catch { }
        clearPreviewProbeCache(previewPath);
    }
    if (fs.existsSync(tmpPath)) {
        try { fs.rmSync(tmpPath, { force: true }); deleted += 1; } catch { }
    }
    previewFailureUntil.delete(p);
    return deleted;
}

function deleteHeatmapArtifactsForVideo(video) {
    const filePath = String(video?.filePath || '').trim();
    if (!filePath) return 0;
    const targets = new Set();
    targets.add(getHeatmapPath(filePath, 'detailed'));
    const scriptPath = getPrimaryScriptPathForVideo(video);
    if (scriptPath) {
        targets.add(getVideoHeatmapCachePath(video, scriptPath, 'detailed'));
    }
    let deleted = 0;
    for (const target of targets) {
        if (!target) continue;
        if (!fs.existsSync(target)) continue;
        try { fs.rmSync(target, { force: true }); deleted += 1; } catch { }
    }
    return deleted;
}

function deleteAllHeatmapArtifacts() {
    let deleted = 0;
    try {
        if (!fs.existsSync(HEATMAP_DIR)) return 0;
        const entries = fs.readdirSync(HEATMAP_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const target = path.join(HEATMAP_DIR, entry.name);
            try { fs.rmSync(target, { force: true }); deleted += 1; } catch { }
        }
    } catch { }
    return deleted;
}

function deleteHeatmapArtifactsForVideos(videos = [], opts = {}) {
    const scopeAll = opts?.scopeAll === true;
    if (scopeAll) return deleteAllHeatmapArtifacts();

    let deleted = 0;
    const targets = new Set();
    for (const video of videos) {
        if (!video?.filePath) continue;
        const baseNameRaw = String(video?.title || path.basename(String(video?.filePath || ''), path.extname(String(video?.filePath || ''))) || 'video');
        const safeVideoName = makeSafeHeatmapNamePart(baseNameRaw, 'video');
        targets.add(`${safeVideoName}.`);
        const hash = Number(hashString(String(video.filePath || '')));
        const legacyPrefix = `${Math.abs(hash).toString(36)}.`;
        targets.add(legacyPrefix);
    }

    try {
        if (fs.existsSync(HEATMAP_DIR)) {
            const entries = fs.readdirSync(HEATMAP_DIR, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isFile()) continue;
                const name = String(entry.name || '');
                const matches = Array.from(targets).some((prefix) => name.startsWith(prefix));
                if (!matches) continue;
                const target = path.join(HEATMAP_DIR, name);
                try { fs.rmSync(target, { force: true }); deleted += 1; } catch { }
            }
        }
    } catch { }

    // Keep exact-path deletion as fallback for currently-derived paths.
    for (const video of videos) deleted += deleteHeatmapArtifactsForVideo(video);
    return deleted;
}

async function generateThumbnailsForVideos(videos = [], opts = {}) {
    const onlyMissing = opts?.onlyMissing !== false;
    const stats = {
        processed: 0,
        queued: 0,
        generated: 0,
        skipped: 0,
    };
    for (let i = 0; i < videos.length; i += 1) {
        const video = videos[i];
        const videoPath = String(video?.filePath || '').trim();
        if (!videoPath || !fs.existsSync(videoPath)) continue;
        stats.processed += 1;

        const hasTpdbPreferred = hasTpdbPreferredThumbForPath(videoPath);
        const hasThumb = hasValidThumbFile(getThumbPath(videoPath)) || hasValidThumbFile(getLegacyThumbPath(videoPath));
        const hasTpdbThumb = hasValidThumbFile(getTpdbThumbPath(videoPath)) || hasValidThumbFile(getLegacyTpdbThumbPath(videoPath));
        const hasAny = hasTpdbPreferred ? hasTpdbThumb : hasThumb;

        if (onlyMissing && hasAny) {
            stats.skipped += 1;
            continue;
        }

        if (hasTpdbPreferred) {
            try {
                await ensureTpdbPreferredThumbnail(videoPath);
                stats.generated += 1;
            } catch {
                stats.skipped += 1;
            }
        } else {
            stats.queued += 1;
            generateThumbnail(videoPath).then(() => { });
        }

        if (i > 0 && i % 120 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    return stats;
}

async function generatePreviewsForVideos(videos = [], opts = {}) {
    const onlyMissing = opts?.onlyMissing !== false;
    const stats = {
        processed: 0,
        queued: 0,
        skipped: 0,
    };
    for (let i = 0; i < videos.length; i += 1) {
        const video = videos[i];
        const videoPath = String(video?.filePath || '').trim();
        if (!videoPath || !fs.existsSync(videoPath)) continue;
        stats.processed += 1;

        const previewPath = getPreviewPath(videoPath);
        const hasPlayable = await hasPlayablePreviewFile(previewPath, { minDurationSec: MIN_PLAYABLE_PREVIEW_DURATION_SEC });
        const hasAny = hasPlayable || hasFallbackPreviewCandidate(previewPath);
        if (onlyMissing && hasAny) {
            stats.skipped += 1;
            continue;
        }

        stats.queued += 1;
        generatePreviewOnDemand(videoPath, { ignoreCooldown: true, videoId: video.id }).then(() => { }).catch(() => { });

        if (i > 0 && i % 120 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
    return stats;
}

function extractTagNameFromHeresphere(rawTag) {
    const input = typeof rawTag === 'string'
        ? rawTag
        : (rawTag && typeof rawTag === 'object' ? rawTag.name : '');
    const value = String(input || '').trim();
    if (!value) return '';
    if (/^tag\s*:/i.test(value)) return String(value.split(':').slice(1).join(':') || '').trim();
    // Ignore structured control/meta tags from HereSphere/Stash-like payloads.
    if (value.includes(':')) return '';
    return value;
}

function extractHeresphereIncomingTags(body) {
    const arr = Array.isArray(body?.tags) ? body.tags : [];
    const flat = arr.map(extractTagNameFromHeresphere).filter(Boolean);
    return normalizeTags(flat);
}

function applyHeresphereWriteBack(video, body) {
    if (!video?.filePath || !body || typeof body !== 'object') return { changed: false };
    const nextTags = extractHeresphereIncomingTags(body);
    let changed = false;
    let savedTags = null;

    if (Array.isArray(body?.tags)) {
        const prevTags = normalizeTags(getVideoTags(video.filePath));
        savedTags = setVideoTags(video.filePath, nextTags);
        video.tags = savedTags;
        applyTagsToCaches({ videoPath: video.filePath, tags: savedTags });
        syncSeriesFolderTagsForVideo(video.filePath, prevTags, savedTags);
        changed = true;
    }

    const hasRating = Number.isFinite(Number(body?.rating));
    const hasFavorite = typeof body?.isFavorite === 'boolean';
    if (hasRating || hasFavorite) {
        const metaPath = hasFavorite ? String(video.filePath || '') : String(video.directory || '');
        const meta = getMetadata(metaPath) || {};
        if (hasRating) meta.rating = Number(body.rating);
        if (hasFavorite) meta.favorite = Boolean(body.isFavorite);
        setMetadata(metaPath, meta);
        changed = true;
    }

    return { changed, tags: savedTags || undefined };
}

function streamVideoFile(video, req, res) {
    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        });
        return file.pipe(res);
    }

    res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
    });
    return fs.createReadStream(filePath).pipe(res);
}

async function buildHeresphereVideoDataPayload(video, baseUrl, token) {
    let durationSec = Number(video?.durationSec || 0);
    if (!(durationSec > 0) && video?.filePath) {
        durationSec = await new Promise((resolve) => {
            ffmpeg.ffprobe(video.filePath, (err, meta) => {
                if (err) return resolve(0);
                resolve(Number(meta?.format?.duration || 0));
            });
        });
    }

    const projection = getHeresphereProjection(video?.vrProjection);
    const stereo = getHeresphereStereo(video?.vrStereoMode);
    const buster = Math.max(1, Number(video?.modifiedAt || Date.now()));
    const streamUrl = `${baseUrl}/heresphere/stream/${encodeURIComponent(String(video?.id || ''))}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const thumbBase = buildHeresphereThumbUrl(baseUrl, String(video?.id || ''), token);
    const thumbUrl = `${thumbBase}${thumbBase.includes('?') ? '&' : '?'}v=${buster}&hm=${encodeURIComponent(HERESPHERE_THUMB_COMPOSITE_VERSION)}`;
    const heatmapUrl = `${baseUrl}/api/videos/${encodeURIComponent(String(video?.id || ''))}/heatmap?variant=detailed&v=${buster}`;
    const folderMeta = getVideoFolderMetadata(video);
    const rating = getVideoRating5(video, folderMeta);
    const released = getVideoReleasedDate(video, folderMeta);
    const isFavorite = getVideoIsFavorite(video, folderMeta);
    const tags = getVideoTagDtos(video);

    // Build scripts array for HereSphere haptic support
    const scripts = [];
    if (video?.hasFunscript) {
        const scriptTokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
        const mainScriptUrl = `${baseUrl}/heresphere/script/${encodeURIComponent(String(video?.id || ''))}${scriptTokenParam}`;
        scripts.push({ name: 'Default', url: mainScriptUrl });
    }

    return {
        access: 1,
        title: String(video?.title || path.basename(video?.filePath || '') || 'Untitled'),
        thumbnailImage: thumbUrl,
        heatmapImage: heatmapUrl,
        dateReleased: released || undefined,
        dateAdded: new Date(Number(video?.modifiedAt || Date.now())).toISOString().slice(0, 10),
        duration: Math.max(0, Number(durationSec || 0)) * 1000,
        rating: rating !== null ? Number(rating) : undefined,
        isFavorite,
        projection,
        stereo,
        tags,
        scripts: scripts.length > 0 ? scripts : undefined,
        media: [
            {
                name: 'Direct',
                sources: [
                    {
                        resolution: Number(video?.height || 0) || 0,
                        url: streamUrl,
                    },
                ],
            },
        ],
        // Backward-compatible fields for older clients:
        authorized: '1',
        fullAccess: true,
        id: String(video?.id || ''),
        videoLength: Math.max(0, Math.round(Number(durationSec || 0))),
        is3d: stereo !== 'mono',
        screenType: projection === 'equirectangular360'
            ? 'sphere'
            : (projection === 'equirectangular' ? 'dome' : 'flat'),
        stereoMode: stereo,
        skipIntro: 0,
        thumbnailUrl: thumbUrl,
        heatmap: heatmapUrl,
        heatmap_url: heatmapUrl,
        heatmapUrl,
        encodings: [
            {
                name: 'Direct',
                videoSources: [
                    {
                        resolution: Number(video?.height || 0) || 0,
                        url: streamUrl,
                    },
                ],
            },
        ],
    };
}

// â”€â”€ API Routes â”€â”€

app.get('/api/heresphere/info', (req, res) => {
    const token = getHeresphereToken();
    const tokenRequired = !!token;
    const tokenQuery = tokenRequired ? `?token=${encodeURIComponent(token)}` : '';
    const localhostUrl = `http://localhost:${PORT}/api/heresphere/${tokenQuery}`;
    const lanUrls = getNetworkIpCandidates().map((ip) => `http://${ip}:${PORT}/api/heresphere/${tokenQuery}`);
    const localhostTestUrl = `http://localhost:${PORT}/api/heresphere-test${tokenQuery}`;
    const lanTestUrls = getNetworkIpCandidates().map((ip) => `http://${ip}:${PORT}/api/heresphere-test${tokenQuery}`);

    res.json({
        tokenRequired,
        feedPath: '/api/heresphere/',
        localhostUrl,
        lanUrls,
        localhostTestUrl,
        lanTestUrls,
        note: 'Fuer Headset/TV bitte eine LAN-URL verwenden, nicht localhost.',
    });
});

// HereSphere Web Stream discovery compatibility:
// Some clients probe non-/api routes like /heresphere and /heresphere/scan.
app.get('/', (req, res) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(307, `/heresphere/${q}`);
});
app.get('/heresphere', (req, res) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const feedUrl = `/api/heresphere${q}`;
    const { byLibrary } = getVrLibrariesAndVideos();
    const vrLibraryCount = Array.isArray(byLibrary) ? byLibrary.length : 0;
    const totalVrVideos = (Array.isArray(byLibrary) ? byLibrary : []).reduce((sum, entry) => {
        const n = Array.isArray(entry?.videos) ? entry.videos.length : 0;
        return sum + n;
    }, 0);
    const escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const librariesListHtml = vrLibraryCount > 0
        ? byLibrary.map(({ library, videos }) => {
            const libName = escapeHtml(String(library?.name || 'VR'));
            const count = Array.isArray(videos) ? videos.length : 0;
            return `<li><span>${libName}</span><strong>${count}</strong></li>`;
        }).join('')
        : '';

    const currentTheme = loadSettings()?.theme || {};
    const pickHex = (val, fallback) => {
        const s = String(val || '').trim();
        return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ? s : fallback;
    };
    const hexToRgb = (hex) => {
        const h = String(hex || '').replace('#', '');
        if (h.length === 3) {
            return {
                r: parseInt(h[0] + h[0], 16),
                g: parseInt(h[1] + h[1], 16),
                b: parseInt(h[2] + h[2], 16),
            };
        }
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    };
    const isDarkHex = (hex) => {
        const { r, g, b } = hexToRgb(hex);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return lum < 0.55;
    };
    const bgPrimary = pickHex(currentTheme.bgPrimary, '#e7ebf2');
    const bgCard = pickHex(currentTheme.bgCard, '#f4f7fc');
    const accentPrimary = pickHex(currentTheme.accentPrimary, '#5e87b1');
    const accentSecondary = pickHex(currentTheme.accentSecondary, '#7ca3c9');
    const darkMode = isDarkHex(bgPrimary);
    const textPrimary = darkMode ? '#e5e7eb' : '#1f2937';
    const textSecondary = darkMode ? '#cbd5e1' : '#475569';
    const pageGlow = darkMode
        ? `radial-gradient(1100px 520px at 18% -8%, ${accentPrimary}55 0%, rgba(17,24,39,0) 55%)`
        : `radial-gradient(1100px 520px at 18% -8%, ${accentPrimary}44 0%, rgba(17,24,39,0) 55%)`;
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glyph HereSphere</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background:
        ${pageGlow},
        linear-gradient(160deg, ${bgPrimary} 0%, ${darkMode ? '#0f172a' : '#d7dde8'} 100%);
      color: ${textPrimary}; font-family: Inter, Segoe UI, Roboto, Arial, sans-serif;
    }
    .card {
      width: min(680px, 92vw); border-radius: 16px; padding: 22px 22px 18px;
      background: ${darkMode ? 'rgba(17, 24, 39, 0.72)' : 'rgba(244, 247, 252, 0.72)'};
      border: 1px solid rgba(148, 163, 184, 0.35);
      box-shadow: 0 18px 46px rgba(20, 27, 45, 0.16);
      backdrop-filter: blur(8px) saturate(1.1);
    }
    h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.2; }
    p { margin: 0 0 14px; color: ${textSecondary}; line-height: 1.45; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0 10px; }
    .stats {
      margin-top: 6px; margin-bottom: 12px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
    }
    .stat {
      border-radius: 12px; padding: 10px 12px;
      background: ${darkMode ? 'rgba(15, 23, 42, 0.55)' : 'rgba(255, 255, 255, 0.7)'};
      border: 1px solid rgba(148, 163, 184, 0.35);
    }
    .stat .label { font-size: 12px; color: ${textSecondary}; }
    .stat .value { font-size: 20px; font-weight: 700; color: ${textPrimary}; line-height: 1.15; margin-top: 2px; }
    .libs {
      margin-top: 8px;
      border-radius: 12px;
      background: ${darkMode ? 'rgba(15, 23, 42, 0.42)' : 'rgba(255, 255, 255, 0.55)'};
      border: 1px solid rgba(148, 163, 184, 0.30);
      overflow: hidden;
    }
    .libs-header {
      font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: ${textSecondary}; padding: 10px 12px; border-bottom: 1px solid rgba(148, 163, 184, 0.25);
    }
    .libs ul { margin: 0; padding: 0; list-style: none; }
    .libs li {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 9px 12px; border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      font-size: 13px; color: ${textPrimary};
    }
    .libs li:last-child { border-bottom: none; }
    .libs li strong {
      font-size: 12px; font-weight: 700;
      color: ${darkMode ? '#dbeafe' : '#1d4f80'};
      background: ${darkMode ? 'rgba(59, 130, 246, 0.2)' : 'rgba(59, 130, 246, 0.14)'};
      border: 1px solid ${darkMode ? 'rgba(96, 165, 250, 0.35)' : 'rgba(59, 130, 246, 0.28)'};
      padding: 3px 8px; border-radius: 999px;
    }
    .empty-note {
      margin-top: 8px; padding: 10px 12px; border-radius: 12px;
      border: 1px solid rgba(239, 68, 68, 0.30);
      background: ${darkMode ? 'rgba(127, 29, 29, 0.25)' : 'rgba(254, 226, 226, 0.55)'};
      color: ${darkMode ? '#fecaca' : '#7f1d1d'};
      font-size: 13px; line-height: 1.4;
    }
    .btn {
      appearance: none; border: 0; border-radius: 12px; padding: 10px 14px;
      font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .btn-primary {
      background: linear-gradient(180deg, ${accentSecondary} 0%, ${accentPrimary} 100%);
      color: #f8fafc;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 6px 16px rgba(61, 105, 149, 0.35);
    }
    .btn-primary:hover { filter: brightness(1.03); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Glyph HereSphere Feed</h1>
    <p>If you opened this in HereSphere browser, press the button below to switch to the Web Stream API feed.</p>
    <div class="stats">
      <div class="stat">
        <div class="label">VR Libraries detected</div>
        <div class="value">${vrLibraryCount}</div>
      </div>
      <div class="stat">
        <div class="label">Total VR videos</div>
        <div class="value">${totalVrVideos}</div>
      </div>
    </div>
    ${vrLibraryCount > 0 ? `<div class="libs"><div class="libs-header">VR Libraries</div><ul>${librariesListHtml}</ul></div>` : ''}
    ${vrLibraryCount === 0 ? `<div class="empty-note">No VR libraries configured. Add at least one library with type "VR" in Glyph settings.</div>` : ''}
    <div class="row">
      <a class="btn btn-primary" href="${feedUrl}">Open in HereSphere Library</a>
    </div>
  </div>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});
app.get('/heresphere/', (req, res) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(307, `/heresphere${q}`);
});
app.get('/heresphere/scan', (req, res) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(307, `/api/heresphere/scan${q}`);
});
app.post('/heresphere', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const { byLibrary } = getVrLibrariesAndVideos();
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const library = byLibrary.map(({ library, videos }) => ({
        name: String(library?.name || 'VR'),
        list: (videos || []).map((video) => `${baseUrl}/heresphere/${encodeURIComponent(String(video.id || ''))}${token ? `?token=${encodeURIComponent(token)}` : ''}`),
    }));
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({ access: 1, library });
});
app.post('/heresphere/scan', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const { byLibrary } = getVrLibrariesAndVideos();
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const nowDate = new Date().toISOString().slice(0, 10);
    const scanData = byLibrary.flatMap(({ videos }) => (
        (videos || []).map((video) => ({
            link: `${baseUrl}/heresphere/${encodeURIComponent(String(video.id || ''))}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
            title: String(video.title || path.basename(video.filePath || '') || 'Untitled'),
            dateAdded: nowDate,
            duration: Number(video.durationSec || 0),
        }))
    ));
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({ scanData });
});
app.get('/heresphere/video/:id', async (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(404).json({ error: 'Video not found' });
    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (!fs.existsSync(video.filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const payload = await buildHeresphereVideoDataPayload(video, baseUrl, token);
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json(payload);
});
app.get('/heresphere/stream/:id', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    return streamVideoFile(video, req, res);
});

// Serve raw funscript files for HereSphere haptic playback
app.get('/heresphere/script/:id', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    const video = videoIndex[id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!video.hasFunscript) return res.status(404).json({ error: 'No funscript available' });

    try {
        const scriptPath = getPrimaryScriptPathForVideo(video);
        if (!scriptPath || !fs.existsSync(scriptPath)) {
            return res.status(404).json({ error: 'Funscript file not found' });
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(scriptPath)}"`);
        return fs.createReadStream(scriptPath).pipe(res);
    } catch (err) {
        console.error('[HereSphere] Error serving funscript:', err.message);
        return res.status(500).json({ error: 'Failed to read funscript' });
    }
});
app.get('/api/heresphere/script/:id', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    const video = videoIndex[id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!video.hasFunscript) return res.status(404).json({ error: 'No funscript available' });
    try {
        const scriptPath = getPrimaryScriptPathForVideo(video);
        if (!scriptPath || !fs.existsSync(scriptPath)) {
            return res.status(404).json({ error: 'Funscript file not found' });
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(scriptPath)}"`);
        return fs.createReadStream(scriptPath).pipe(res);
    } catch (err) {
        console.error('[HereSphere] Error serving funscript:', err.message);
        return res.status(500).json({ error: 'Failed to read funscript' });
    }
});

async function handleHeresphereThumbnail(req, res) {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    const thumbPath = getThumbPath(video.filePath);
    if (!hasValidThumbFile(thumbPath)) {
        addRuntimeLog('warn', 'heresphere', 'Thumbnail missing for HereSphere composite', {
            videoId: id,
            videoPath: String(video?.filePath || ''),
        });
        const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        return res.redirect(307, `/api/videos/${encodeURIComponent(id)}/thumbnail${q}`);
    }

    const heat = ensureVideoHeatmapCache(video, 'detailed');
    if (!heat?.ok || !heat?.path || !fs.existsSync(heat.path)) {
        addRuntimeLog('warn', 'heresphere', 'Heatmap missing for HereSphere composite', {
            videoId: id,
            reason: String(heat?.reason || 'unknown'),
            heatmapPath: String(heat?.path || ''),
        });
        return res.sendFile(thumbPath);
    }

    // Compose thumbnail + heatmap in memory (no extra files on disk).
    // Layout: keep thumb width, place heatmap as bottom strip.
    const args = [
        '-v', 'error',
        '-i', thumbPath,
        '-i', heat.path,
        '-filter_complex',
        '[0:v]scale=480:-1[bg];[1:v]scale=480:30[hm];[bg][hm]overlay=0:H-h',
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'png',
        'pipe:1',
    ];

    execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 15000 }, (err, stdout, stderr) => {
        if (err || !stdout || stdout.length < 256) {
            addRuntimeLog('warn', 'heresphere', 'Thumbnail+heatmap compose fallback', {
                videoId: id,
                error: err?.message || null,
                stderr: String(stderr || '').slice(-600),
            });
            return res.sendFile(thumbPath);
        }
        addRuntimeLog('info', 'heresphere', 'Thumbnail+heatmap composed', { videoId: id });
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        return res.end(stdout);
    });
}
app.get('/heresphere/thumbnail/:id', handleHeresphereThumbnail);
app.get('/api/heresphere/thumbnail/:id', handleHeresphereThumbnail);

app.get('/api/heresphere-test', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const baseUrl = getRequestBaseUrl(req);
    const token = getHeresphereToken();
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : '';
    const testThumb = `${baseUrl}/api/heresphere-test/thumbnail${tokenPart}`;
    const testVideoMeta = `${baseUrl}/api/heresphere-test/video${tokenPart}`;
    res.json({
        authorized: '1',
        scenes: [
            {
                name: 'Glyph Test',
                list: [
                    {
                        id: 'glyph-test-1',
                        title: 'Glyph HereSphere Test Item',
                        videoLength: 10,
                        thumbnail: testThumb,
                        thumbnail_url: testThumb,
                        thumbnailUrl: testThumb,
                        url: testVideoMeta,
                        video_url: testVideoMeta,
                    },
                ],
            },
        ],
    });
});

app.get('/api/heresphere-test/video', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const baseUrl = getRequestBaseUrl(req);
    const token = getHeresphereToken();
    const tokenPart = token ? `?token=${encodeURIComponent(token)}` : '';
    res.json({
        authorized: '1',
        fullAccess: true,
        title: 'Glyph HereSphere Test Video',
        id: 'glyph-test-1',
        videoLength: 10,
        is3d: true,
        screenType: 'dome',
        stereoMode: 'sbs',
        skipIntro: 0,
        thumbnailUrl: `${baseUrl}/api/heresphere-test/thumbnail${tokenPart}`,
        encodings: [
            {
                name: 'Direct',
                videoSources: [
                    {
                        resolution: 0,
                        // Uses an existing sample file route; if unavailable, this still validates feed schema in client.
                        url: `${baseUrl}/api/heresphere-test/stream${tokenPart}`,
                    },
                ],
            },
        ],
    });
});

app.get('/api/heresphere-test/thumbnail', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
<rect width="100%" height="100%" fill="#0f172a"/>
<text x="50%" y="45%" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="30" text-anchor="middle">Glyph HereSphere Test</text>
<text x="50%" y="58%" fill="#93c5fd" font-family="Arial, sans-serif" font-size="20" text-anchor="middle">If this appears, source parsing works</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.status(200).send(svg);
});

app.get('/api/heresphere-test/stream', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    // Minimal response: this endpoint exists to validate source wiring first.
    // Real stream validation should use /api/heresphere with actual library videos.
    return res.status(501).json({ error: 'Test stream endpoint has no media file. Feed format validation only.' });
});

app.get('/api/heresphere', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const { byLibrary } = getVrLibrariesAndVideos();
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);

    const scenes = byLibrary.map(({ library, videos }) => ({
        name: String(library?.name || 'VR'),
        list: videos.map((video) => {
            const thumbBase = buildHeresphereThumbUrl(baseUrl, video.id, token);
            const thumbUrl = `${thumbBase}${thumbBase.includes('?') ? '&' : '?'}v=${Math.max(1, Number(video?.modifiedAt || Date.now()))}&hm=${encodeURIComponent(HERESPHERE_THUMB_COMPOSITE_VERSION)}`;
            return {
                id: String(video.id),
                title: String(video.title || path.basename(video.filePath || '') || 'Untitled'),
                videoLength: Math.max(0, Math.round(Number(video.durationSec || 0))),
                // Keep multiple key variants for broad client compatibility.
                thumbnail: thumbUrl,
                thumbnail_url: thumbUrl,
                thumbnailUrl: thumbUrl,
                tags: getVideoTagDtos(video),
                heatmap: `${baseUrl}/api/videos/${encodeURIComponent(String(video.id))}/heatmap?variant=detailed&v=${Math.max(1, Number(video?.modifiedAt || Date.now()))}`,
                heatmap_url: `${baseUrl}/api/videos/${encodeURIComponent(String(video.id))}/heatmap?variant=detailed&v=${Math.max(1, Number(video?.modifiedAt || Date.now()))}`,
                heatmapUrl: `${baseUrl}/api/videos/${encodeURIComponent(String(video.id))}/heatmap?variant=detailed&v=${Math.max(1, Number(video?.modifiedAt || Date.now()))}`,
                url: buildHeresphereVideoUrl(baseUrl, video.id, token),
                video_url: buildHeresphereVideoUrl(baseUrl, video.id, token),
            };
        }),
    }));

    // HereSphere-style index response (used by WebStream API discovery).
    const library = byLibrary.map(({ library, videos }) => ({
        name: String(library?.name || 'VR'),
        list: (videos || []).map((video) => `${baseUrl}/heresphere/${encodeURIComponent(String(video.id || ''))}${token ? `?token=${encodeURIComponent(token)}` : ''}`),
    }));

    res.json({
        access: 1,
        library,
        authorized: '1',
        scenes,
    });
});

app.get('/api/heresphere/scan', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const { byLibrary } = getVrLibrariesAndVideos();
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const nowDate = new Date().toISOString().slice(0, 10);

    const scanData = byLibrary.flatMap(({ videos }) => (
        (videos || []).map((video) => ({
            link: `${baseUrl}/heresphere/${encodeURIComponent(String(video.id || ''))}${token ? `?token=${encodeURIComponent(token)}` : ''}`,
            title: String(video.title || path.basename(video.filePath || '') || 'Untitled'),
            dateAdded: nowDate,
            duration: Number(video.durationSec || 0),
        }))
    ));

    res.json({ scanData });
});

app.get('/api/heresphere/video/:id', async (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(404).json({ error: 'Video not found' });

    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (!fs.existsSync(video.filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }

    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const payload = await buildHeresphereVideoDataPayload(video, baseUrl, token);
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json(payload);
});

app.get('/api/heresphere/stream/:id', (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const video = videoIndex[req.params.id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        });
        return file.pipe(res);
    }

    res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
    });
    return fs.createReadStream(filePath).pipe(res);
});
app.post('/heresphere/:id', async (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(404).json({ error: 'Video not found' });
    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (!fs.existsSync(video.filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }
    try { applyHeresphereWriteBack(video, req.body || {}); } catch { }
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const payload = await buildHeresphereVideoDataPayload(video, baseUrl, token);
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json(payload);
});
app.get('/heresphere/:id', async (req, res) => {
    if (!isAuthorizedForHeresphere(req)) return heresphereUnauthorized(res);
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(404).json({ error: 'Video not found' });
    const video = videoIndex[id];
    if (!video || String(video.libraryType || '').toLowerCase() !== 'vr') {
        return res.status(404).json({ error: 'Video not found' });
    }
    if (!fs.existsSync(video.filePath)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }
    const token = getHeresphereToken();
    const baseUrl = getRequestBaseUrl(req);
    const payload = await buildHeresphereVideoDataPayload(video, baseUrl, token);
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json(payload);
});

// Playlist APIs
app.get('/api/playlists', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT
                p.id,
                p.name,
                p.created_at AS createdAt,
                p.sort_index AS sortIndex,
                COUNT(pi.item_key) AS itemCount
            FROM playlists p
            LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
            GROUP BY p.id, p.name, p.created_at, p.sort_index
            ORDER BY p.sort_index ASC, LOWER(p.name) ASC
        `).all();
        res.json((rows || []).map(row => ({
            id: row.id,
            name: row.name,
            createdAt: Number(row.createdAt || 0),
            sortIndex: Number(row.sortIndex || 0),
            itemCount: Number(row.itemCount || 0),
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlists/manager', (req, res) => {
    try {
        res.json({ playlists: listPlaylistsForManager() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/manager/order', (req, res) => {
    const orderedIds = Array.isArray(req.body?.orderedIds) ? req.body.orderedIds : [];
    try {
        const previousOrderIds = getCurrentPlaylistOrderIds();
        db.exec('BEGIN');
        const appliedOrderIds = applyPlaylistOrder(orderedIds);
        db.exec('COMMIT');
        addPlaylistHistory('order', { previousOrderIds, appliedOrderIds });
        res.json({ success: true, playlists: listPlaylistsForManager() });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/manager/bulk-rename', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? [...new Set(req.body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
    const prefix = String(req.body?.prefix || '');
    const suffix = String(req.body?.suffix || '');
    if (!ids.length) return res.status(400).json({ error: 'No playlists selected' });
    if (!prefix && !suffix) return res.status(400).json({ error: 'Nothing to rename' });

    try {
        const update = db.prepare(`UPDATE playlists SET name = ? WHERE id = ?`);
        const changes = [];
        db.exec('BEGIN');
        for (const id of ids) {
            const pl = getPlaylistById(id);
            if (!pl) continue;
            const from = String(pl.name || '');
            const nextBase = `${prefix}${from}${suffix}`;
            const to = ensureUniquePlaylistName(nextBase, { excludeId: id });
            if (!to || to.toLowerCase() === from.toLowerCase()) continue;
            update.run(to, id);
            changes.push({ id, from, to });
        }
        db.exec('COMMIT');
        if (changes.length > 0) addPlaylistHistory('bulk-rename', { changes });
        res.json({ success: true, changedCount: changes.length, playlists: listPlaylistsForManager() });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/manager/bulk-delete', (req, res) => {
    const ids = Array.isArray(req.body?.ids)
        ? [...new Set(req.body.ids.map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
    if (!ids.length) return res.status(400).json({ error: 'No playlists selected' });
    try {
        const snapshots = snapshotPlaylistsByIds(ids);
        if (!snapshots.length) return res.json({ success: true, deletedCount: 0, playlists: listPlaylistsForManager() });
        const del = db.prepare(`DELETE FROM playlists WHERE id = ?`);
        db.exec('BEGIN');
        let deletedCount = 0;
        for (const snap of snapshots) {
            const result = del.run(snap.id);
            if (Number(result?.changes || 0) > 0) deletedCount += 1;
        }
        db.exec('COMMIT');
        if (deletedCount > 0) addPlaylistHistory('bulk-delete', { snapshots });
        res.json({ success: true, deletedCount, playlists: listPlaylistsForManager() });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlists/history', (req, res) => {
    try {
        const limit = Number(req.query?.limit || 50);
        res.json({ items: listPlaylistHistory(limit) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/history/:id/undo', (req, res) => {
    try {
        const result = undoPlaylistHistoryById(req.params.id);
        res.json({ success: true, result, playlists: listPlaylistsForManager() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/manager/merge', (req, res) => {
    const sourceIds = Array.isArray(req.body?.sourceIds)
        ? [...new Set(req.body.sourceIds.map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
    const targetId = String(req.body?.targetId || '').trim();
    const deleteSources = req.body?.deleteSources === true;

    if (!targetId) return res.status(400).json({ error: 'Missing target playlist' });
    if (sourceIds.length === 0) return res.status(400).json({ error: 'Missing source playlists' });
    if (sourceIds.includes(targetId)) return res.status(400).json({ error: 'Target playlist cannot be a source' });

    const target = getPlaylistById(targetId);
    if (!target) return res.status(404).json({ error: 'Target playlist not found' });
    const existingSources = sourceIds.map((id) => getPlaylistById(id)).filter(Boolean);
    if (existingSources.length === 0) {
        return res.status(404).json({ error: 'Source playlists not found' });
    }
    const deletedSourceSnapshots = deleteSources
        ? snapshotPlaylistsByIds(existingSources.map((s) => s.id))
        : [];

    const insertItem = db.prepare(`
        INSERT OR IGNORE INTO playlist_items (playlist_id, item_key, item_path, added_at, sort_index)
        VALUES (?, ?, ?, ?, ?)
    `);
    const getSourceItems = db.prepare(`
        SELECT item_key AS itemKey, item_path AS itemPath
        FROM playlist_items
        WHERE playlist_id = ?
    `);
    const deleteSourcePlaylist = db.prepare(`DELETE FROM playlists WHERE id = ?`);

    try {
        db.exec('BEGIN');
        let addedCount = 0;
        const addedItemKeys = [];
        const now = Date.now();
        let nextSortIndex = getNextPlaylistItemSortIndex(target.id);
        for (const source of existingSources) {
            const rows = getSourceItems.all(source.id);
            for (const row of rows) {
                const itemKey = String(row?.itemKey || '').trim();
                const itemPath = normalizePlaylistItemPath(row?.itemPath || '');
                if (!itemKey || !itemPath) continue;
                const result = insertItem.run(target.id, itemKey, itemPath, now, nextSortIndex);
                if (Number(result?.changes || 0) > 0) {
                    addedCount += 1;
                    addedItemKeys.push(itemKey);
                    nextSortIndex += 1;
                }
            }
        }

        let deletedSources = 0;
        if (deleteSources) {
            for (const source of existingSources) {
                const result = deleteSourcePlaylist.run(source.id);
                if (Number(result?.changes || 0) > 0) deletedSources += 1;
            }
        }
        db.exec('COMMIT');
        addPlaylistHistory('merge', {
            targetId: target.id,
            sourceIds: existingSources.map((s) => s.id),
            addedItemKeys,
            deletedSourceSnapshots,
            deleteSources,
        });

        const allPlaylists = listPlaylistsForManager();
        const updatedTarget = allPlaylists.find((pl) => pl.id === target.id) || null;
        res.json({
            success: true,
            target: updatedTarget,
            addedCount,
            deletedSources,
            playlists: allPlaylists,
        });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists', (req, res) => {
    const name = normalizePlaylistName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Missing playlist name' });

    try {
        const playlist = createPlaylist(ensureUniquePlaylistName(name));
        res.json({ success: true, playlist });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


app.post('/api/playlists/:id/rename', (req, res) => {
    const playlist = getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const name = normalizePlaylistName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Missing playlist name' });

    try {
        const safeName = ensureUniquePlaylistName(name, { excludeId: playlist.id });
        const from = String(playlist.name || '');
        if (!safeName || safeName.toLowerCase() === from.toLowerCase()) {
            const updated = getPlaylistById(playlist.id);
            return res.json({ success: true, playlist: updated || playlist });
        }
        db.prepare(`
            UPDATE playlists
            SET name = ?
            WHERE id = ?
        `).run(safeName, playlist.id);
        addPlaylistHistory('rename', { changes: [{ id: playlist.id, from, to: safeName }] });

        const updated = getPlaylistById(playlist.id);
        res.json({ success: true, playlist: updated || { ...playlist, name: safeName } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/playlists/:id', (req, res) => {
    const playlist = getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    try {
        const snapshots = snapshotPlaylistsByIds([playlist.id]);
        const result = db.prepare(`DELETE FROM playlists WHERE id = ?`).run(playlist.id);
        if (Number(result?.changes || 0) > 0 && snapshots.length > 0) {
            addPlaylistHistory('delete', { snapshots });
        }
        res.json({ success: true, deleted: Number(result?.changes || 0) > 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/playlists/add', (req, res) => {
    const playlistId = String(req.body?.playlistId || '').trim();
    const playlistName = normalizePlaylistName(req.body?.playlistName);
    const videoPaths = Array.isArray(req.body?.videoPaths) ? req.body.videoPaths : [];

    if (videoPaths.length === 0) return res.status(400).json({ error: 'Missing videos' });

    db.exec('BEGIN');
    try {
        let playlist = null;
        if (playlistId) playlist = getPlaylistById(playlistId);
        if (!playlist && playlistName) playlist = createPlaylist(playlistName);
        if (!playlist) throw new Error('Playlist not found');

        const result = addVideosToPlaylist(playlist.id, videoPaths);

        db.exec('COMMIT');
        res.json({
            success: true,
            playlist,
            addedCount: result.addedCount,
            totalCount: result.totalCount,
        });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/:id/remove', (req, res) => {
    const playlist = getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const videoPaths = Array.isArray(req.body?.videoPaths) ? req.body.videoPaths : [];
    const validPaths = [...new Set(videoPaths.map(normalizePlaylistItemPath).filter(Boolean))];
    if (validPaths.length === 0) return res.status(400).json({ error: 'Missing videos' });

    try {
        const removeItem = db.prepare(`
            DELETE FROM playlist_items
            WHERE playlist_id = ? AND item_key = ?
        `);

        db.exec('BEGIN');
        let removedCount = 0;
        for (const itemPath of validPaths) {
            const result = removeItem.run(playlist.id, makePlaylistItemKey(itemPath));
            if (result?.changes > 0) removedCount += 1;
        }
        db.exec('COMMIT');

        const row = db.prepare(`
            SELECT COUNT(*) AS count
            FROM playlist_items
            WHERE playlist_id = ?
        `).get(playlist.id);

        res.json({ success: true, removedCount, totalCount: Number(row?.count || 0) });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/playlists/:id/reorder', (req, res) => {
    const playlist = getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    const orderedPaths = Array.isArray(req.body?.videoPaths) ? req.body.videoPaths : [];
    const normalized = orderedPaths.map(normalizePlaylistItemPath).filter(Boolean);
    const uniquePaths = [...new Set(normalized)];
    if (uniquePaths.length === 0) return res.status(400).json({ error: 'Missing videos' });

    const existingRows = db.prepare(`
        SELECT item_key AS itemKey, item_path AS itemPath
        FROM playlist_items
        WHERE playlist_id = ?
    `).all(playlist.id);
    const existingByPath = new Map();
    for (const row of existingRows || []) {
        const itemPath = normalizePlaylistItemPath(row?.itemPath || '');
        const itemKey = String(row?.itemKey || '').trim();
        if (!itemPath || !itemKey) continue;
        existingByPath.set(itemPath, itemKey);
    }
    if (existingByPath.size === 0) return res.status(400).json({ error: 'Playlist has no items' });
    if (uniquePaths.length !== existingByPath.size) {
        return res.status(400).json({ error: 'Reorder list must include all playlist videos' });
    }
    for (const itemPath of uniquePaths) {
        if (!existingByPath.has(itemPath)) {
            return res.status(400).json({ error: 'Reorder list contains unknown video path' });
        }
    }

    const updateSort = db.prepare(`
        UPDATE playlist_items
        SET sort_index = ?
        WHERE playlist_id = ? AND item_key = ?
    `);

    try {
        db.exec('BEGIN');
        uniquePaths.forEach((itemPath, index) => {
            updateSort.run(index + 1, playlist.id, existingByPath.get(itemPath));
        });
        db.exec('COMMIT');
        res.json({ success: true });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/playlists/:id/videos', (req, res) => {
    const playlist = getPlaylistById(req.params.id);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

    try {
        const rows = db.prepare(`
            SELECT item_key AS itemKey, item_path AS itemPath, added_at AS addedAt, sort_index AS sortIndex
            FROM playlist_items
            WHERE playlist_id = ?
            ORDER BY sort_index ASC, added_at DESC, item_key ASC
        `).all(playlist.id);

        const videos = [];
        for (const row of rows) {
            const itemPath = normalizePlaylistItemPath(row.itemPath);
            if (!itemPath || !fs.existsSync(itemPath)) continue;

            const video = findVideoByPath(itemPath);
            let stats = null;
            try { stats = fs.statSync(itemPath); } catch { stats = null; }

            const extension = path.extname(itemPath).toLowerCase();
            const fileName = path.basename(itemPath);
            const baseTitle = fileName ? path.basename(fileName, extension) : itemPath;
            const libraryType = String(video?.libraryType || 'videos').toLowerCase();
            const vrMeta = buildVrMetaForVideo(video?.title || baseTitle, itemPath, libraryType);

            videos.push({
                id: video?.id || makePlaylistItemKey(itemPath),
                playlistItemKey: String(row?.itemKey || makePlaylistItemKey(itemPath)),
                title: video?.title || baseTitle,
                fileName: video?.fileName || fileName,
                extension: video?.extension || extension,
                size: Number(video?.size || stats?.size || 0),
                modifiedAt: Number(video?.modifiedAt || stats?.mtimeMs || Date.now()),
                durationSec: Number(video?.durationSec || 0),
                hasFunscript: !!video?.hasFunscript,
                axes: Array.isArray(video?.axes) ? video.axes : [],
                isMultiAxis: !!video?.isMultiAxis,
                filePath: itemPath,
                libraryType,
                libraryId: String(video?.libraryId || ''),
                isVr: !!vrMeta.isVr,
                vrProjection: vrMeta.vrProjection,
                vrStereoMode: vrMeta.vrStereoMode,
                hasThumbnail: hasAnyThumbForPath(itemPath),
                thumbVersion: getVideoThumbVersion(itemPath, Number(video?.modifiedAt || stats?.mtimeMs || Date.now())),
                tags: video?.tags || getVideoTags(itemPath),
                performers: Array.isArray(video?.performers) ? video.performers : [],
                isFavorite: getVideoIsFavorite(video || { filePath: itemPath, directory: path.dirname(itemPath), tags: video?.tags || getVideoTags(itemPath) }, getMetadata(path.dirname(itemPath)) || {}),
                playlistAddedAt: Number(row.addedAt || 0),
            });
        }

        res.json({ playlist, videos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Libraries list
app.get('/api/libraries', (req, res) => {
    const settings = loadSettings();
    const libs = settings.libraries.map(lib => {
        const cache = libraryCache[lib.id];
        const cacheEntry = cache || { videos: [], folders: [] };
        return {
            ...lib,
            videoCount: cacheEntry.videos.length,
            folderCount: cacheEntry.folders.length,
            hasPoster: hasPoster(lib.path),
        };
    });
    if (isAllVideosLibraryEnabled(settings)) {
        const combined = getCombinedLibraryCache();
        libs.unshift({
            id: ALL_LIBRARY_ID,
            name: 'All videos',
            path: '',
            type: 'videos',
            showRecentAdded: false,
            trackContinueWatching: true,
            videoCount: combined.videos.length,
            folderCount: 0,
            hasPoster: false,
            isVirtual: true,
        });
    }
    res.json(libs);
});

// Videos for a library (flat view)
app.get('/api/libraries/:id/videos', async (req, res) => {
    const settings = loadSettings();
    const isAll = String(req.params.id || '') === ALL_LIBRARY_ID;
    const cache = isAll
        ? (isAllVideosLibraryEnabled(settings) ? getCombinedLibraryCache() : null)
        : libraryCache[req.params.id];
    if (!cache) return res.json([]);

    const { search, sort, order, funscript, favorite, extension, subfolder, multiaxis, vrProjection, vrStereoMode, audio, limit } = req.query;
    let results = [...cache.videos];

    if (subfolder) {
        const ns = path.normalize(subfolder);
        results = results.filter(v => path.normalize(v.directory).startsWith(ns));
    }
    if (search) {
        const q = search.toLowerCase();
        results = results.filter(v => v.title.toLowerCase().includes(q));
    }
    if (funscript === 'yes') results = results.filter(v => v.hasFunscript);
    if (funscript === 'no') results = results.filter(v => !v.hasFunscript);
    if (favorite === 'yes') results = results.filter(v => getVideoIsFavorite(v, getVideoFolderMetadata(v)));
    if (multiaxis === 'yes') results = results.filter(v => v.isMultiAxis);
    if (multiaxis === 'no') results = results.filter(v => !v.isMultiAxis);
    if (vrProjection) {
        const wantedProjection = normalizeVrProjection(vrProjection);
        results = results.filter(v => normalizeVrProjection(v.vrProjection) === wantedProjection);
    }
    if (vrStereoMode) {
        const wantedStereo = normalizeVrStereoMode(vrStereoMode);
        results = results.filter(v => normalizeVrStereoMode(v.vrStereoMode) === wantedStereo);
    }
    if (audio === 'yes' || audio === 'no') {
        const withAudio = results.map((video) => {
            let hasAudio = typeof video.hasAudio === 'boolean'
                ? video.hasAudio
                : getIndexedHasAudio(video.filePath, Number(video.size || 0), Number(video.modifiedAt || 0));
            if (typeof hasAudio === 'boolean') {
                video.hasAudio = hasAudio;
            } else {
                enqueueAudioIndex(video);
            }
            return { video, hasAudio };
        });
        results = withAudio
            .filter((entry) => (audio === 'yes' ? entry.hasAudio === true : entry.hasAudio === false))
            .map((entry) => ({ ...entry.video, hasAudio: entry.hasAudio }));
    }
    if (extension) results = results.filter(v => v.extension === `.${extension}`);
    if (sort === 'duration') {
        for (const next of results) {
            if (!next?.filePath) continue;
            if (Number(next.durationSec || 0) > 0) {
                continue;
            }
            const indexedDuration = getIndexedDuration(next.filePath, Number(next.size || 0), Number(next.modifiedAt || 0));
            if (Number(indexedDuration || 0) > 0) {
                next.durationSec = Number(indexedDuration || 0);
            }
        }
        const direction = String(order || '').toLowerCase() === 'asc' ? 1 : -1;
        results.sort((a, b) => {
            const da = Number(a?.durationSec || 0);
            const db = Number(b?.durationSec || 0);
            const aKnown = da > 0;
            const bKnown = db > 0;
            if (aKnown && bKnown) return (da - db) * direction;
            if (aKnown) return -1;
            if (bKnown) return 1;
            return String(a?.title || '').localeCompare(String(b?.title || '')) * direction;
        });
    } else if (sort === 'date') results.sort((a, b) => b.modifiedAt - a.modifiedAt);
    else if (sort === 'size') results.sort((a, b) => b.size - a.size);
    else results.sort((a, b) => a.title.localeCompare(b.title));

    const parsedLimit = Number.parseInt(limit, 10);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        results = results.slice(0, Math.min(parsedLimit, 200));
    }

    for (const v of results) {
        if (!v?.filePath) continue;
        if (Number(v.durationSec || 0) > 0) continue;
        const indexedDuration = getIndexedDuration(v.filePath, Number(v.size || 0), Number(v.modifiedAt || 0));
        if (Number(indexedDuration || 0) > 0) {
            v.durationSec = Number(indexedDuration || 0);
        }
    }

    res.json(results.map(v => {
        const baseTitle = String(v?.title || path.basename(v?.filePath || '', path.extname(v?.filePath || '')) || '');
        const effectiveVr = buildVrMetaForVideo(baseTitle, v?.filePath || '', v?.libraryType || 'videos');
        return {
            id: v.id, title: v.title, fileName: v.fileName, extension: v.extension,
            size: v.size, modifiedAt: v.modifiedAt, hasFunscript: v.hasFunscript,
            durationSec: Number(v.durationSec || 0),
            filePath: v.filePath,
            hasAudio: typeof v.hasAudio === 'boolean'
                ? v.hasAudio
                : getIndexedHasAudio(v.filePath, Number(v.size || 0), Number(v.modifiedAt || 0)),
            libraryType: v.libraryType || 'videos',
            libraryId: String(v.libraryId || req.params.id || ''),
            isVr: !!effectiveVr.isVr,
            vrProjection: normalizeVrProjection(effectiveVr.vrProjection),
            vrStereoMode: normalizeVrStereoMode(effectiveVr.vrStereoMode),
            hasThumbnail: hasAnyThumbForPath(v.filePath),
            thumbVersion: getVideoThumbVersion(v.filePath, Number(v.modifiedAt || 0)),
            axes: v.axes || [], isMultiAxis: v.isMultiAxis || false,
            tags: Array.isArray(v.tags) ? v.tags : [],
            performers: Array.isArray(v.performers) ? v.performers : [],
            isFavorite: getVideoIsFavorite(v, getVideoFolderMetadata(v)),
            tpdbItemType: String(v.tpdbItemType || ''),
            tpdbItemId: String(v.tpdbItemId || ''),
        };
    }));
});

// Folders for a series library
app.get('/api/libraries/:id/folders', (req, res) => {
    if (String(req.params.id || '') === ALL_LIBRARY_ID) return res.json([]);
    const cache = libraryCache[req.params.id];
    if (!cache) return res.json([]);
    res.json(cache.folders.map(f => ({
        id: f.id, name: f.name, path: f.path, videoCount: f.videoCount,
        funscriptCount: f.funscriptCount || 0,
        subfolders: f.subfolders, metadata: f.metadata, hasPoster: f.hasPoster,
        posterVersion: Number(f.posterVersion || 0),
        modifiedAt: Number(f.modifiedAt || 0),
        tags: Array.isArray(f.tags) ? f.tags : [],
    })));
});

// Browse library folder structure
app.get('/api/libraries/:id/browse', (req, res) => {
    if (String(req.params.id || '') === ALL_LIBRARY_ID) {
        return res.status(400).json({ error: 'Folder browse is not available for All videos library' });
    }
    const settings = loadSettings();
    const library = settings.libraries.find(l => l.id === req.params.id);
    if (!library) return res.status(404).json({ error: 'Library not found' });
    const libType = String(library?.type || 'videos').toLowerCase();

    let requestPath = req.query.path || library.path;
    const normalizedLibPath = path.resolve(library.path);
    const normalizedReqPath = path.resolve(requestPath);
    if (!normalizedReqPath.startsWith(normalizedLibPath)) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(normalizedReqPath)) return res.status(404).json({ error: 'Path not found' });

    try {
        const entries = fs.readdirSync(normalizedReqPath, { withFileTypes: true });
        const fileSet = new Set(entries.map(e => e.name));
        const folders = [];
        const videos = [];

        for (const entry of entries) {
            const fullPath = path.join(normalizedReqPath, entry.name);
            if (entry.isDirectory()) {
                // Count videos in subfolder
                let videoCount = 0;
                try {
                    const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                    videoCount = subEntries.filter(e => e.isFile() && VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())).length;
                } catch { }
                folders.push({
                    name: entry.name,
                    path: fullPath,
                    videoCount,
                    hasPoster: hasPoster(fullPath),
                    tags: getFolderTags(fullPath),
                });
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    const baseName = path.basename(entry.name, ext);
                    const axisInfo = detectAxes(baseName, fileSet);
                    const vrMeta = buildVrMetaForVideo(baseName, fullPath, libType);
                    let stats;
                    try { stats = fs.statSync(fullPath); } catch { stats = { size: 0, mtimeMs: Date.now() }; }

                    // Registering video here might be redundant if we don't want to pollute index with browse calls, 
                    // but logic kept same as before.
                    const savedTitle = String(tpdbVideoMetaByKey.get(normalizeVideoPathKey(fullPath))?.title || baseName || '');
                    const video = registerVideo({
                        id: generateStableId(fullPath), title: savedTitle, fileName: entry.name,
                        filePath: fullPath, directory: normalizedReqPath, extension: ext,
                        size: stats.size, modifiedAt: stats.mtimeMs,
                        hasFunscript: axisInfo.hasFunscript,
                        funscriptPath: axisInfo.funscriptFile ? path.join(normalizedReqPath, axisInfo.funscriptFile) : null,
                        axes: axisInfo.axes, isMultiAxis: axisInfo.isMultiAxis,
                        isVr: vrMeta.isVr,
                        vrProjection: vrMeta.vrProjection,
                        vrStereoMode: vrMeta.vrStereoMode,
                        hasAudio: getIndexedHasAudio(fullPath, Number(stats.size || 0), Number(stats.mtimeMs || Date.now())),
                        libraryType: libType,
                        libraryId: library.id,
                        tags: getVideoTags(fullPath),
                    });
                    applyTpdbMetaToVideoObject(video);
                    enqueueAudioIndex(video);
                    videos.push({
                        id: video.id, name: entry.name, title: video?.title || baseName,
                        path: fullPath, filePath: fullPath, size: stats.size,
                        modifiedAt: Number(stats?.mtimeMs || Date.now()),
                        extension: ext, hasFunscript: axisInfo.hasFunscript,
                        libraryType: libType,
                        libraryId: library.id,
                        isVr: vrMeta.isVr,
                        vrProjection: vrMeta.vrProjection,
                        vrStereoMode: vrMeta.vrStereoMode,
                        hasAudio: video?.hasAudio === true,
                        hasThumbnail: hasAnyThumbForPath(fullPath),
                        thumbVersion: getVideoThumbVersion(fullPath, Number(stats?.mtimeMs || Date.now())),
                        axes: axisInfo.axes, isMultiAxis: axisInfo.isMultiAxis,
                        tags: Array.isArray(video.tags) ? video.tags : [],
                        performers: Array.isArray(video.performers) ? video.performers : [],
                        isFavorite: getVideoIsFavorite(video, getVideoFolderMetadata(video)),
                        tpdbItemType: String(video.tpdbItemType || ''),
                        tpdbItemId: String(video.tpdbItemId || ''),
                    });
                    generateThumbnail(fullPath);
                }
            }
        }
        res.json({
            path: normalizedReqPath,
            parent: normalizedReqPath === normalizedLibPath ? null : path.dirname(normalizedReqPath),
            folders,
            videos,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/libraries/:id/extensions', (req, res) => {
    const settings = loadSettings();
    const isAll = String(req.params.id || '') === ALL_LIBRARY_ID;
    const cache = isAll
        ? (isAllVideosLibraryEnabled(settings) ? getCombinedLibraryCache() : null)
        : libraryCache[req.params.id];
    if (!cache) return res.json([]);
    const exts = [...new Set(cache.videos.map(v => v.extension))].sort();
    res.json(exts);
});

app.get('/api/libraries/:id/tags', (req, res) => {
    const settings = loadSettings();
    const isAll = String(req.params.id || '') === ALL_LIBRARY_ID;
    const cache = isAll
        ? (isAllVideosLibraryEnabled(settings) ? getCombinedLibraryCache() : null)
        : libraryCache[req.params.id];
    if (!cache) return res.json([]);

    const tagSet = new Set();
    for (const video of cache.videos || []) {
        for (const tag of (video.tags || [])) {
            const value = String(tag || '').trim();
            if (value) tagSet.add(value);
        }
    }
    for (const folder of cache.folders || []) {
        for (const tag of (folder.tags || [])) {
            const value = String(tag || '').trim();
            if (value) tagSet.add(value);
        }
    }

    res.json([...tagSet].sort((a, b) => a.localeCompare(b)));
});

function collectStatusSnapshot() {
    const settings = loadSettings();
    const libraries = settings.libraries || [];
    const totalVideos = Object.values(libraryCache).reduce((sum, cache) => sum + (cache?.videos?.length || 0), 0);
    const totalSeriesFolders = Object.values(libraryCache).reduce((sum, cache) => sum + (cache?.folders?.length || 0), 0);
    const reachableLibraries = libraries.filter(lib => {
        try { return fs.existsSync(lib.path); } catch { return false; }
    }).length;

    return {
        isScanning,
        uptimeSeconds: Math.floor(process.uptime()),
        librariesTotal: libraries.length,
        librariesReachable: reachableLibraries,
        cachedLibraries: Object.keys(libraryCache).length,
        indexedVideos: Object.keys(videoIndex).length,
        totalVideos,
        totalSeriesFolders,
        queueSize: thumbQueue.length,
        thumbRunning,
        thumbMode: thumbControlMode,
        thumbConcurrency: MAX_THUMB_CONCURRENCY,
        activeTasks: Array.from(activeTasks),
        lastScanStartedAt,
        lastScanFinishedAt,
        lastScanDurationMs,
        now: Date.now(),
    };
}

function collectPerformanceSnapshot() {
    const now = Date.now();
    const blockedPreviews = Array.from(previewFailureUntil.values()).reduce((count, until) => (
        Number(until || 0) > now ? count + 1 : count
    ), 0);
    const ffmpegRunning = Array.from(ffmpegJobsRunning.values()).map((job) => ({
        id: job.id,
        kind: job.kind,
        pid: job.pid,
        mode: job.mode,
        video: trimPathLabel(job.videoPath),
        output: trimPathLabel(job.outputPath),
        runtimeMs: Math.max(0, now - Number(job.startedAt || now)),
        startedAt: job.startedAt,
    }));
    const ffmpegRecent = ffmpegJobsRecent.slice(0, 20).map((job) => ({
        id: job.id,
        kind: job.kind,
        pid: job.pid,
        mode: job.mode,
        video: trimPathLabel(job.videoPath),
        status: job.status,
        durationMs: Number(job.durationMs || 0),
        endedAt: job.endedAt,
        error: job.error ? String(job.error).slice(0, 220) : '',
    }));

    return {
        now,
        scan: {
            isScanning: !!isScanning,
            lastScanStartedAt,
            lastScanFinishedAt,
            lastScanDurationMs: Number(lastScanDurationMs || 0),
        },
        thumbnails: {
            queueSize: thumbQueue.length,
            running: Number(thumbRunning || 0),
            concurrency: MAX_THUMB_CONCURRENCY,
            ffmpegThreadsPerJob: THUMB_FFMPEG_THREADS,
            queuedDistinct: queuedThumbs.size,
            activeTasks: activeTasks.size,
            mode: thumbControlMode,
        },
        previews: {
            queueSize: previewQueue.length,
            running: Number(previewRunning || 0),
            concurrency: MAX_PREVIEW_CONCURRENCY,
            inFlight: previewInFlight.size,
            blockedByCooldown: blockedPreviews,
        },
        audioIndex: {
            queueSize: audioIndexQueue.length,
            running: Number(audioIndexRunning || 0),
            concurrency: AUDIO_INDEX_CONCURRENCY,
            queuedDistinct: audioIndexQueued.size,
        },
        ffmpeg: {
            runningCount: ffmpegRunning.length,
            running: ffmpegRunning,
            recent: ffmpegRecent,
        },
    };
}

function isAllVideosLibraryEnabled(settings) {
    return !!(settings && settings.includeAllLibrary === true);
}

function getCombinedLibraryCache() {
    const allVideos = [];
    for (const cache of Object.values(libraryCache || {})) {
        if (!cache?.videos?.length) continue;
        allVideos.push(...cache.videos);
    }
    return { videos: allVideos, folders: [] };
}

// Server Status Dashboard
app.get('/api/status', (req, res) => {
    res.json(collectStatusSnapshot());
});

app.get('/api/status/perf', (req, res) => {
    res.json(collectPerformanceSnapshot());
});

app.get('/api/logs', (req, res) => {
    const logs = readRuntimeLogs({
        limit: req.query.limit,
        level: req.query.level,
        area: req.query.area,
        q: req.query.q,
    });
    res.json({ items: logs, total: logs.length });
});

app.post('/api/logs/client', (req, res) => {
    try {
        const levelRaw = String(req.body?.level || 'info').trim().toLowerCase();
        const areaRaw = String(req.body?.area || 'client').trim().toLowerCase();
        const messageRaw = String(req.body?.message || '').trim();
        const meta = (req.body?.meta && typeof req.body.meta === 'object') ? req.body.meta : undefined;
        if (!messageRaw) return res.status(400).json({ error: 'Missing message' });

        const level = ['debug', 'info', 'warn', 'error'].includes(levelRaw) ? levelRaw : 'info';
        const area = areaRaw || 'client';
        const message = messageRaw.slice(0, 240);
        addRuntimeLog(level, area, message, meta);
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to write client log' });
    }
});

app.post('/api/logs/clear', (_req, res) => {
    clearRuntimeLogs();
    res.json({ ok: true });
});

app.post('/api/status/cleanup-loose-files', (_req, res) => {
    try {
        const stats = cleanupOrphanArtifacts({ log: true });
        const totalDeleted =
            Number(stats?.metadataDeleted || 0) +
            Number(stats?.thumbnailsDeleted || 0) +
            Number(stats?.tpdbThumbnailsDeleted || 0) +
            Number(stats?.tpdbVideoMetadataDeleted || 0) +
            Number(stats?.tpdbVideoPerformerLinksDeleted || 0) +
            Number(stats?.tpdbPerformersDeleted || 0) +
            Number(stats?.tpdbPerformerImagesDeleted || 0) +
            Number(stats?.previewsDeleted || 0) +
            Number(stats?.postersDeleted || 0) +
            Number(stats?.tagsDeleted || 0) +
            Number(stats?.playlistItemsDeleted || 0);
        res.json({ ok: true, stats, totalDeleted });
    } catch (err) {
        addRuntimeLog('error', 'cleanup', 'Loose/generated file cleanup failed', { error: err?.message || String(err) });
        res.status(500).json({ error: err.message || String(err) });
    }
});

app.post('/api/artifacts/maintenance', async (req, res) => {
    try {
        const mode = String(req.body?.mode || 'regenerate_missing').trim().toLowerCase();
        const validModes = new Set(['delete_only', 'regenerate_missing', 'rebuild_all']);
        if (!validModes.has(mode)) {
            return res.status(400).json({ error: 'Invalid mode' });
        }

        const rawTypes = Array.isArray(req.body?.types) ? req.body.types : [];
        const allowedTypes = new Set(['thumbnails', 'previews', 'heatmaps']);
        const types = Array.from(new Set(rawTypes.map((v) => String(v || '').trim().toLowerCase())))
            .filter((v) => allowedTypes.has(v));
        if (types.length === 0) {
            return res.status(400).json({ error: 'No valid artifact types selected' });
        }

        const scope = req.body?.scope && typeof req.body.scope === 'object' ? req.body.scope : {};
        const scopeKind = String(scope?.kind || 'all').trim().toLowerCase();
        const libraryId = scopeKind === 'library' ? String(scope?.libraryId || '').trim() : '';
        if (scopeKind === 'library' && !libraryId) {
            return res.status(400).json({ error: 'Missing libraryId for library scope' });
        }
        const targetVideos = getArtifactTargetVideos({ libraryId });

        const results = {
            thumbnails: { processed: targetVideos.length, deleted: 0, queued: 0, generated: 0, skipped: 0 },
            previews: { processed: targetVideos.length, deleted: 0, queued: 0, skipped: 0 },
            heatmaps: { processed: targetVideos.length, deleted: 0, generated: 0, skipped: 0 },
        };

        if (types.includes('thumbnails')) {
            if (mode === 'delete_only' || mode === 'rebuild_all') {
                for (const video of targetVideos) {
                    results.thumbnails.deleted += deleteThumbnailArtifactsForVideoPath(video.filePath);
                }
            }
            if (mode === 'regenerate_missing' || mode === 'rebuild_all') {
                const regen = await generateThumbnailsForVideos(targetVideos, {
                    onlyMissing: mode === 'regenerate_missing',
                });
                results.thumbnails.queued += Number(regen?.queued || 0);
                results.thumbnails.generated += Number(regen?.generated || 0);
                results.thumbnails.skipped += Number(regen?.skipped || 0);
            }
        }

        if (types.includes('previews')) {
            if (mode === 'delete_only' || mode === 'rebuild_all') {
                for (const video of targetVideos) {
                    results.previews.deleted += deletePreviewArtifactsForVideoPath(video.filePath);
                }
            }
            if (mode === 'regenerate_missing' || mode === 'rebuild_all') {
                const regen = await generatePreviewsForVideos(targetVideos, {
                    onlyMissing: mode === 'regenerate_missing',
                });
                results.previews.queued += Number(regen?.queued || 0);
                results.previews.skipped += Number(regen?.skipped || 0);
            }
        }

        if (types.includes('heatmaps')) {
            if (mode === 'delete_only' || mode === 'rebuild_all') {
                results.heatmaps.deleted += deleteHeatmapArtifactsForVideos(targetVideos, {
                    scopeAll: scopeKind !== 'library',
                });
            }
            if (mode === 'regenerate_missing' || mode === 'rebuild_all') {
                const heatmapStats = await generateAllHeatmaps({ libraryId });
                results.heatmaps.generated += Number(heatmapStats?.generated || 0);
                results.heatmaps.skipped += Number(heatmapStats?.skipped || 0);
            }
        }

        addRuntimeLog('info', 'maintenance', 'Artifact maintenance executed', {
            mode,
            types,
            libraryId: libraryId || null,
            processedVideos: targetVideos.length,
            results,
        });
        return res.json({
            ok: true,
            mode,
            types,
            libraryId: libraryId || null,
            processedVideos: targetVideos.length,
            results,
        });
    } catch (err) {
        addRuntimeLog('error', 'maintenance', 'Artifact maintenance failed', { error: err?.message || String(err) });
        return res.status(500).json({ error: err?.message || String(err) });
    }
});

app.get('/api/thumbnails/control', (req, res) => {
    res.json(getThumbControlState());
});

app.post('/api/thumbnails/control', (req, res) => {
    const action = String(req.body?.action || '').toLowerCase();
    const state = setThumbControlMode(action);
    if (action === 'start' || action === 'running' || action === 'resume') {
        scheduleThumbnailGeneration(100);
    }
    res.json(state);
});




// Series detail (metadata + episodes for a folder)
app.get('/api/series/detail', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath || !fs.existsSync(folderPath)) {
        return res.status(404).json({ error: 'Folder not found' });
    }
    const owningLibrary = findLibraryByPath(folderPath);
    const libraryId = String(owningLibrary?.id || '');
    const libraryType = String(owningLibrary?.type || 'series').toLowerCase();

    const storedMetadata = getMetadata(folderPath);
    const metadata = storedMetadata && typeof storedMetadata === 'object'
        ? { ...storedMetadata }
        : storedMetadata;
    if (metadata && metadata.backdropIsLocal) {
        metadata.backdropUpdatedAt = getBackdropVersion(folderPath);
    }
    const hasPosterFile = hasPoster(folderPath);

    // Get seasons (subfolders) and episodes (videos)
    const seasons = [];
    const directVideos = [];

    try {
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);
            if (entry.isDirectory()) {
                const seasonVideos = [];
                try {
                    const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
                    for (const sub of subEntries) {
                        const subFull = path.join(fullPath, sub.name);
                        if (sub.isFile()) {
                            const ext = path.extname(sub.name).toLowerCase();
                            if (VIDEO_EXTENSIONS.includes(ext)) {
                                const baseName = path.basename(sub.name, ext);
                                const funscriptPath = path.join(fullPath, baseName + '.funscript');
                                const hasFunscript = fs.existsSync(funscriptPath);
                                let stats;
                                try { stats = fs.statSync(subFull); } catch { stats = { size: 0, mtimeMs: Date.now() }; }
                                const video = registerVideo({
                                    id: generateStableId(subFull), title: baseName, fileName: sub.name,
                                    filePath: subFull, extension: ext, size: stats.size,
                                    modifiedAt: stats.mtimeMs, hasFunscript,
                                    funscriptPath: hasFunscript ? funscriptPath : null,
                                    hasAudio: getIndexedHasAudio(subFull, Number(stats.size || 0), Number(stats.mtimeMs || Date.now())),
                                    durationSec: Number(getIndexedDuration(subFull, Number(stats.size || 0), Number(stats.mtimeMs || Date.now())) || 0),
                                    libraryId,
                                    libraryType,
                                });
                                enqueueAudioIndex(video);
                                seasonVideos.push({
                                    id: video.id, title: video.title, fileName: video.fileName,
                                    extension: video.extension, size: video.size,
                                    modifiedAt: video.modifiedAt, hasFunscript: video.hasFunscript,
                                    durationSec: Number(video.durationSec || 0),
                                    filePath: video.filePath,
                                    libraryId,
                                    libraryType,
                                    tags: getVideoTags(subFull),
                                    isFavorite: getVideoIsFavorite(video, getVideoFolderMetadata(video)),
                                    hasThumbnail: hasAnyThumbForPath(video.filePath),
                                    thumbVersion: getVideoThumbVersion(video.filePath, Number(video.modifiedAt || Date.now())),
                                });
                            }
                        }
                    }
                } catch { }
                seasonVideos.sort((a, b) => a.title.localeCompare(b.title));
                seasons.push({ name: entry.name, path: fullPath, videos: seasonVideos });
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    const baseName = path.basename(entry.name, ext);
                    const funscriptPath = path.join(folderPath, baseName + '.funscript');
                    const hasFunscript = fs.existsSync(funscriptPath);
                    let stats;
                    try { stats = fs.statSync(fullPath); } catch { stats = { size: 0, mtimeMs: Date.now() }; }
                    const video = registerVideo({
                        id: generateStableId(fullPath), title: baseName, fileName: entry.name,
                        filePath: fullPath, extension: ext, size: stats.size,
                        modifiedAt: stats.mtimeMs, hasFunscript,
                        funscriptPath: hasFunscript ? funscriptPath : null,
                        hasAudio: getIndexedHasAudio(fullPath, Number(stats.size || 0), Number(stats.mtimeMs || Date.now())),
                        durationSec: Number(getIndexedDuration(fullPath, Number(stats.size || 0), Number(stats.mtimeMs || Date.now())) || 0),
                        libraryId,
                        libraryType,
                    });
                    enqueueAudioIndex(video);
                    directVideos.push({
                        id: video.id, title: video.title, fileName: video.fileName,
                        extension: video.extension, size: video.size,
                        modifiedAt: video.modifiedAt, hasFunscript: video.hasFunscript,
                        durationSec: Number(video.durationSec || 0),
                        filePath: video.filePath,
                        libraryId,
                        libraryType,
                        tags: getVideoTags(fullPath),
                        isFavorite: getVideoIsFavorite(video, getVideoFolderMetadata(video)),
                        hasThumbnail: hasAnyThumbForPath(video.filePath),
                        thumbVersion: getVideoThumbVersion(video.filePath, Number(video.modifiedAt || Date.now())),
                    });
                }
            }
        }
    } catch (err) {
        console.error('Series detail error:', err.message);
    }

    seasons.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    directVideos.sort((a, b) => a.title.localeCompare(b.title));

    res.json({
        name: path.basename(folderPath),
        path: folderPath,
        metadata,
        hasPoster: hasPosterFile,
        posterVersion: hasPosterFile ? getPosterVersion(folderPath) : 0,
        seasons,
        directVideos,
    });
});

// Serve poster images (from app data directory)
app.get('/api/poster', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath) return res.status(400).json({ error: 'Missing path' });
    const posterPath = getPosterPath(folderPath);
    if (!fs.existsSync(posterPath)) return res.status(404).json({ error: 'No poster' });
    res.sendFile(posterPath);
});

// Serve custom local backdrops
app.get('/api/backdrop', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath) return res.status(400).json({ error: 'Missing path' });
    const backdropPath = getBackdropPath(folderPath);
    if (!fs.existsSync(backdropPath)) return res.status(404).json({ error: 'No backdrop' });
    res.sendFile(backdropPath);
});

// Upload custom poster image
app.post('/api/poster/upload', async (req, res) => {
    const { folderPath, imageData } = req.body;
    if (!folderPath || !imageData) return res.status(400).json({ error: 'Missing data' });
    try {
        const posterPath = getPosterPath(folderPath);
        // imageData is base64 encoded (with or without data: prefix)
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(posterPath, Buffer.from(base64, 'base64'));
        // Update metadata to reflect poster
        const metadata = getMetadata(folderPath) || {};
        metadata.posterDownloaded = true;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata, {
            hasPoster: true,
            posterVersion: getPosterVersion(folderPath),
        });
        scheduleFullRescan('poster-upload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upload custom local backdrop image
app.post('/api/backdrop/upload', async (req, res) => {
    const { folderPath, imageData } = req.body || {};
    if (!folderPath || !imageData) return res.status(400).json({ error: 'Missing data' });
    try {
        const backdropPath = getBackdropPath(folderPath);
        const base64 = String(imageData).replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(backdropPath, Buffer.from(base64, 'base64'));
        const metadata = getMetadata(folderPath) || {};
        metadata.backdropIsLocal = true;
        metadata.backdropUpdatedAt = Date.now();
        metadata.backdropPath = null;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata);
        scheduleFullRescan('backdrop-upload');
        res.json({ success: true, backdropUpdatedAt: metadata.backdropUpdatedAt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove custom poster image
app.post('/api/poster/remove', (req, res) => {
    const { folderPath } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: 'Missing folderPath' });
    try {
        const posterPath = getPosterPath(folderPath);
        let removed = false;
        if (fs.existsSync(posterPath)) {
            fs.rmSync(posterPath, { force: true });
            removed = true;
        }
        const metadata = getMetadata(folderPath) || {};
        metadata.posterDownloaded = false;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata, {
            hasPoster: false,
            posterVersion: 0,
        });
        scheduleFullRescan('poster-remove');
        res.json({ success: true, removed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set backdrop path (from TMDB)
app.post('/api/poster/set-backdrop', (req, res) => {
    const { folderPath, backdropPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'Missing folderPath' });
    try {
        const metadata = getMetadata(folderPath) || {};
        metadata.backdropPath = backdropPath || null;
        metadata.backdropIsLocal = false;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata);
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename series (update metadata title)
app.post('/api/metadata/rename', async (req, res) => {
    const { folderPath, newTitle } = req.body;
    if (!folderPath || !newTitle) return res.status(400).json({ error: 'Missing folderPath or newTitle' });
    try {
        const metadata = getMetadata(folderPath) || {};
        metadata.title = newTitle;
        setMetadata(folderPath, metadata);
        scheduleFullRescan('metadata-rename');
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const transcodeProcesses = new Map();

function waitForFile(filePath, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const interval = setInterval(() => {
            if (fs.existsSync(filePath)) {
                clearInterval(interval);
                resolve(true);
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(interval);
                resolve(false);
            }
        }, 500);
    });
}

function getTranscodeOutDir(videoId) {
    return path.join(TRANSCODE_DIR, String(videoId || ''));
}

function cleanupTranscodeOutput(videoId) {
    try {
        const outDir = getTranscodeOutDir(videoId);
        if (fs.existsSync(outDir)) {
            fs.rmSync(outDir, { recursive: true, force: true });
        }
    } catch (err) {
        console.warn('[transcode] Failed to cleanup cache for ' + videoId + ': ' + err.message);
    }
}

function cleanupStaleTranscodeCaches(maxAgeMs = 6 * 60 * 60 * 1000) {
    try {
        if (!fs.existsSync(TRANSCODE_DIR)) return;
        const now = Date.now();
        const entries = fs.readdirSync(TRANSCODE_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dirPath = path.join(TRANSCODE_DIR, entry.name);
            try {
                const stat = fs.statSync(dirPath);
                const ageMs = now - Math.max(stat.mtimeMs || 0, stat.ctimeMs || 0);
                if (ageMs > maxAgeMs) {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                }
            } catch { }
        }
    } catch (err) {
        console.warn('[transcode] Failed stale cache cleanup: ' + err.message);
    }
}

function streamVideoFileWithRange(filePath, req, res, contentType = 'application/octet-stream') {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = String(range).replace(/bytes=/i, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            return res.end();
        }
        const safeEnd = Number.isFinite(end) && end >= start ? Math.min(end, fileSize - 1) : (fileSize - 1);
        const chunkSize = (safeEnd - start) + 1;
        const stream = fs.createReadStream(filePath, { start, end: safeEnd });
        const head = {
            'Content-Range': `bytes ${start}-${safeEnd}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
        };
        res.writeHead(206, head);
        return stream.pipe(res);
    }

    const fullHead = {
        'Accept-Ranges': 'bytes',
        'Content-Length': fileSize,
        'Content-Type': contentType,
    };
    res.writeHead(200, fullHead);
    return fs.createReadStream(filePath).pipe(res);
}

// Get video file path for mpv player
app.get('/api/videos/:id/filepath', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!fs.existsSync(video.filePath)) return res.status(404).json({ error: 'File not found on disk' });
    res.json({ filePath: video.filePath });
});

// Direct, codec/container-agnostic byte stream for remote MPV playback
app.get('/api/videos/:id/direct', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const filePath = String(video.filePath || '');
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const ext = String(path.extname(filePath) || '').toLowerCase();
    const mimeByExt = {
        '.mp4': 'video/mp4',
        '.mkv': 'video/x-matroska',
        '.webm': 'video/webm',
        '.avi': 'video/x-msvideo',
        '.mov': 'video/quicktime',
        '.m4v': 'video/x-m4v',
        '.wmv': 'video/x-ms-wmv',
        '.flv': 'video/x-flv',
        '.ts': 'video/mp2t',
        '.mpeg': 'video/mpeg',
        '.mpg': 'video/mpeg',
    };
    const contentType = mimeByExt[ext] || 'application/octet-stream';
    return streamVideoFileWithRange(filePath, req, res, contentType);
});

app.post('/api/videos/:id/favorite', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (typeof req.body?.isFavorite !== 'boolean') return res.status(400).json({ error: 'Missing isFavorite' });
    try {
        const filePath = String(video?.filePath || '').trim();
        if (!filePath) return res.status(400).json({ error: 'Missing file path' });
        const metadata = getMetadata(filePath) || {};
        metadata.favorite = Boolean(req.body.isFavorite);
        setMetadata(filePath, metadata);
        res.json({ success: true, isFavorite: getVideoIsFavorite(video, metadata) });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// Direct video stream for compatible files
app.get('/api/videos/:id/play', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        const fullHead = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, fullHead);
        fs.createReadStream(filePath).pipe(res);
    }
});

// Serve poster images (from app data directory)
app.get('/api/poster', (req, res) => {
    const folderPath = req.query.path;
    if (!folderPath) return res.status(400).json({ error: 'Missing path' });
    const posterPath = getPosterPath(folderPath);
    if (!fs.existsSync(posterPath)) return res.status(404).json({ error: 'No poster' });
    res.sendFile(posterPath);
});

// Upload custom poster image
app.post('/api/poster/upload', async (req, res) => {
    const { folderPath, imageData } = req.body;
    if (!folderPath || !imageData) return res.status(400).json({ error: 'Missing data' });
    try {
        const posterPath = getPosterPath(folderPath);
        // imageData is base64 encoded (with or without data: prefix)
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(posterPath, Buffer.from(base64, 'base64'));
        // Update metadata to reflect poster
        const metadata = getMetadata(folderPath) || {};
        metadata.posterDownloaded = true;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata, {
            hasPoster: true,
            posterVersion: getPosterVersion(folderPath),
        });
        scheduleFullRescan('poster-upload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set backdrop path (from TMDB)
app.post('/api/poster/set-backdrop', (req, res) => {
    const { folderPath, backdropPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'Missing folderPath' });
    try {
        const metadata = getMetadata(folderPath) || {};
        metadata.backdropPath = backdropPath || null;
        metadata.backdropIsLocal = false;
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata);
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Rename series (update metadata title)
app.post('/api/metadata/rename', async (req, res) => {
    const { folderPath, newTitle } = req.body;
    if (!folderPath || !newTitle) return res.status(400).json({ error: 'Missing folderPath or newTitle' });
    try {
        const metadata = getMetadata(folderPath) || {};
        metadata.title = newTitle;
        setMetadata(folderPath, metadata);
        scheduleFullRescan('metadata-rename');
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Direct video stream for compatible files
app.get('/api/videos/:id/play', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const partialHead = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(206, partialHead);
        file.pipe(res);
    } else {
        const fullHead = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
        };
        res.writeHead(200, fullHead);
        fs.createReadStream(filePath).pipe(res);
    }
});

// Start MP4 transcoding stream
app.get('/api/videos/:id/stream', async (req, res) => {
    const videoId = req.params.id;
    const video = videoIndex[videoId];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const filePath = video.filePath;
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const { probeMeta } = await new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, meta) => resolve({ probeMeta: err ? null : meta }));
    });
    const sourceDuration = Number(probeMeta?.format?.duration) || 0;
    const allAudioStreams = (probeMeta?.streams || []).filter(s => s.codec_type === 'audio');
    const defaultAudioTrack = allAudioStreams.findIndex(s => s?.disposition?.default === 1);

    let requestedAudioTrack = Number.isFinite(Number(req.query.audioTrack))
        ? Math.max(0, Number(req.query.audioTrack))
        : (defaultAudioTrack >= 0 ? defaultAudioTrack : 0);

    if (allAudioStreams.length > 0) {
        requestedAudioTrack = Math.min(requestedAudioTrack, allAudioStreams.length - 1);
    } else {
        requestedAudioTrack = 0;
    }

    const startTime = parseFloat(req.query.startTime) || 0;

    // Parse subtitle track for hardsubs
    const requestedSubtitleTrackStr = req.query.subtitleTrack;
    let requestedSubtitleTrack = null;
    if (requestedSubtitleTrackStr && requestedSubtitleTrackStr !== 'null' && requestedSubtitleTrackStr !== 'undefined') {
        requestedSubtitleTrack = parseInt(requestedSubtitleTrackStr, 10);
        if (isNaN(requestedSubtitleTrack)) {
            requestedSubtitleTrack = null;
        }
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (transcodeProcesses.has(videoId)) {
        const oldProcess = transcodeProcesses.get(videoId);
        try {
            if (oldProcess.res) oldProcess.command.unpipe(oldProcess.res);
            oldProcess.command.kill('SIGKILL');
        } catch { }
        transcodeProcesses.delete(videoId);
    }

    const videoStream = (probeMeta?.streams || []).find(s => s.codec_type === 'video');
    const sourceVideoCodec = videoStream?.codec_name?.toLowerCase();
    // Only stream-copy if starting from the beginning AND we aren't burning in subtitles.
    // Seeking (-ss) with -c:v copy causes video keyframe snapping that desyncs progressive mp4 audio.
    const canCopyVideo = sourceVideoCodec === 'h264' && startTime === 0 && requestedSubtitleTrack === null;

    console.log(`[Stream] ${videoId} audioTrack=${requestedAudioTrack} subTrack=${requestedSubtitleTrack} start=${startTime} videoCodec=${sourceVideoCodec} (copy=${canCopyVideo})`);

    const outputOptions = [
        '-map 0:v:0',
        `-map 0:a:${requestedAudioTrack}?`,
        '-ac', '2',
        '-ar', '48000',
        '-af', 'aresample=async=1',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4'
    ];

    if (canCopyVideo) {
        outputOptions.push('-c:v', 'copy');
    } else {
        // High quality (crf 16) encoding when transcode is forced
        outputOptions.push(
            '-c:v', 'libx264',
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p',
            '-preset', 'fast',
            '-crf', '16',
            '-max_muxing_queue_size', '9999'
        );

        // Burn subtitles if requested
        if (requestedSubtitleTrack !== null) {
            // FFmpeg filter syntax is notoriously tricky with Windows drive letters (C:\).
            // We must escape the drive colon, and use forward slashes. 
            // e.g. "F:\Movie.mkv" -> "F\:/Movie.mkv"
            let filterPath = filePath.replace(/\\/g, '/');
            filterPath = filterPath.replace(/^([a-zA-Z]):/, '$1\\:');
            // Escape any commas (which separate filters)
            filterPath = filterPath.replace(/,/g, '\\,');

            outputOptions.push('-vf', `subtitles='${filterPath}':si=${requestedSubtitleTrack}`);
        }
    }

    const command = ffmpeg(filePath);

    if (startTime > 0) {
        command.inputOptions([`-ss ${startTime}`]);
    }

    command
        .outputOptions(outputOptions)
        .audioCodec('aac')
        .audioBitrate('192k');

    command.on('start', (cmdLine) => console.log(`[FFmpeg Stream] Started: ${cmdLine}`));

    command.on('error', (err) => {
        if (!err.message.includes('SIGKILL') &&
            !err.message.includes('ffmpeg was killed') &&
            !err.message.includes('Premature close') &&
            !err.message.includes('Output stream closed')) {
            console.error('[FFmpeg Stream] Error:', err.message);
        }
        transcodeProcesses.delete(videoId);
    });

    command.on('end', () => {
        transcodeProcesses.delete(videoId);
    });

    transcodeProcesses.set(videoId, { command, audioTrack: requestedAudioTrack, res });

    command.pipe(res, { end: true });

    req.on('close', () => {
        if (transcodeProcesses.has(videoId) && transcodeProcesses.get(videoId).command === command) {
            try {
                command.unpipe(res);
                command.kill('SIGKILL');
            } catch { }
            transcodeProcesses.delete(videoId);
        }
    });
});

// Stop stream
app.post('/api/videos/:id/stream/stop', (req, res) => {
    const videoId = req.params.id;
    if (transcodeProcesses.has(videoId)) {
        try { transcodeProcesses.get(videoId).command.kill('SIGKILL'); } catch { }
        transcodeProcesses.delete(videoId);
    }
    res.json({ success: true, message: 'Stopped' });
});

// Get Audio Tracks
app.get('/api/videos/:id/audio-tracks', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    ffmpeg.ffprobe(video.filePath, (err, metadata) => {
        if (err) {
            setHasAudioCache(video.filePath, false);
            persistIndexedHasAudio(video.filePath, Number(video.size || 0), Number(video.modifiedAt || 0), false);
            return res.status(500).json({ error: err.message });
        }
        const tracks = (metadata.streams || [])
            .map((s, globalIndex) => ({ ...s, _globalIndex: globalIndex }))
            .filter(s => s.codec_type === 'audio')
            .map((s, audioStreamIndex) => ({
                index: s._globalIndex,
                audioStreamIndex,
                language: s.tags?.language || 'Unknown',
                title: s.tags?.title || `Track ${s.index}`,
                codec: s.codec_name || '',
                channels: s.channels || null,
        }));
        setHasAudioCache(video.filePath, tracks.length > 0);
        persistIndexedHasAudio(video.filePath, Number(video.size || 0), Number(video.modifiedAt || 0), tracks.length > 0);
        video.hasAudio = tracks.length > 0;
        res.json(tracks);
    });
});

// Get Subtitle Tracks
app.get('/api/videos/:id/subtitle-tracks', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    ffmpeg.ffprobe(video.filePath, (err, metadata) => {
        if (err) return res.status(500).json({ error: err.message });
        const subs = metadata.streams.filter(s => s.codec_type === 'subtitle');
        res.json(subs.map((s, relativeIndex) => ({
            index: s.index,
            relativeIndex: relativeIndex,
            language: s.tags?.language || 'Unknown',
            title: s.tags?.title || `Track ${s.index}`,
            codec: s.codec_name || ''
        })));
    });
});

// Extract and serve subtitle track for native playback
app.get('/api/videos/:id/subtitle/:trackIndex', async (req, res) => {
    const videoId = req.params.id;
    const trackIndex = parseInt(req.params.trackIndex, 10);
    const video = videoIndex[videoId];

    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (isNaN(trackIndex)) return res.status(400).json({ error: 'Invalid track index' });

    const outDir = getTranscodeOutDir(videoId);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, `subtitle_${trackIndex}.vtt`);

    // If already extracted, serve it directly
    if (fs.existsSync(outPath)) {
        res.setHeader('Content-Type', 'text/vtt');
        return fs.createReadStream(outPath).pipe(res);
    }

    console.log(`[Subtitle] Extracting track ${trackIndex} to ${outPath}`);

    const command = ffmpeg(video.filePath)
        .inputOptions(['-y'])
        .outputOptions([
            `-map 0:${trackIndex}`,
            '-f webvtt'
        ])
        .output(outPath);

    command.on('end', () => {
        console.log(`[Subtitle] Extraction complete for track ${trackIndex}`);
        if (fs.existsSync(outPath)) {
            res.setHeader('Content-Type', 'text/vtt');
            fs.createReadStream(outPath).pipe(res);
        } else {
            res.status(500).json({ error: 'Failed to find extracted subtitle file' });
        }
    });

    command.on('error', (err) => {
        console.error(`[Subtitle] Extraction error:`, err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Subtitle extraction failed' });
        }
    });

    command.run();
});

// Upload custom thumbnail for a video
app.post('/api/videos/:id/thumbnail/upload', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const { imageData } = req.body;
    if (!imageData) return res.status(400).json({ error: 'Missing imageData' });
    try {
        const thumbPath = getThumbPath(video.filePath);
        const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(thumbPath, Buffer.from(base64, 'base64'));
        writeThumbSource(thumbPath, 'custom:upload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/videos/:id/thumbnail/regenerate', async (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const timestampSec = parseFlexibleTimestampSeconds(req.body?.timestamp);
    if (!Number.isFinite(timestampSec) || timestampSec < 0) {
        return res.status(400).json({ error: 'Invalid timestamp (use mm:ss or hh:mm:ss)' });
    }

    try {
        const useTpdbThumbSlot = hasTpdbPreferredThumbForPath(video.filePath);
        const thumbPath = useTpdbThumbSlot ? getTpdbThumbPath(video.filePath) : getThumbPath(video.filePath);
        const legacyPath = useTpdbThumbSlot ? getLegacyTpdbThumbPath(video.filePath) : getLegacyThumbPath(video.filePath);
        try { fs.rmSync(thumbPath, { force: true }); } catch { }
        try { fs.rmSync(legacyPath, { force: true }); } catch { }

        let result = await runThumbFfmpeg(video.filePath, thumbPath, timestampSec, true);
        if (!result?.ok) result = await runThumbFfmpeg(video.filePath, thumbPath, timestampSec, false);
        if (!result?.ok || !hasValidThumbFile(thumbPath)) {
            return res.status(500).json({ error: result?.error || 'Thumbnail regeneration failed' });
        }

        writeThumbSource(thumbPath, `manual:timestamp:${Number(timestampSec).toFixed(2)}`);
        video.thumbVersion = Date.now();
        addRuntimeLog('info', 'thumbnail', 'Thumbnail regenerated at timestamp', {
            videoId: video.id,
            videoPath: video.filePath,
            timestampSec: Number(timestampSec.toFixed(3)),
            target: useTpdbThumbSlot ? 'tpdb-preferred' : 'thumbnail',
        });
        return res.json({ success: true, timestampSec: Number(timestampSec.toFixed(3)), thumbVersion: video.thumbVersion });
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Thumbnail regeneration failed' });
    }
});

app.get('/api/videos/:id/thumbnail/preview', async (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const timestampSec = parseFlexibleTimestampSeconds(req.query?.timestamp);
    if (!Number.isFinite(timestampSec) || timestampSec < 0) {
        return res.status(400).json({ error: 'Invalid timestamp (use mm:ss or hh:mm:ss)' });
    }
    if (!video?.filePath || !fs.existsSync(video.filePath)) {
        return res.status(404).json({ error: 'Video file not found' });
    }
    try {
        const frame = await captureFrameAtTimestamp(video.filePath, timestampSec);
        if (!frame?.ok || !frame?.data) {
            return res.status(500).json({ error: frame?.error || 'Preview capture failed' });
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'image/jpeg');
        return res.send(frame.data);
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Preview capture failed' });
    }
});

// Serve or lazily generate detailed heatmap image
app.get('/api/videos/:id/heatmap', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    try {
        const result = ensureVideoHeatmapCache(video, 'detailed');
        if (!result.ok || !result.path) return res.status(404).json({ error: 'No heatmap data' });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'image/png');
        return res.sendFile(result.path);
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Heatmap generation failed' });
    }
});

app.post('/api/heatmaps/generate', (req, res) => {
    (async () => {
        try {
            const libraryId = String(req.body?.libraryId || '').trim();
            const onlyVr = req.body?.onlyVr === true;
            const stats = await generateAllHeatmaps({ libraryId, onlyVr });
            addRuntimeLog('info', 'heatmap', 'Heatmap cache generation finished', stats);
            return res.json({ ok: true, ...stats });
        } catch (err) {
            return res.status(500).json({ error: err?.message || 'Heatmap cache generation failed' });
        }
    })();
});

// Serve video thumbnails
app.get('/api/videos/:id/thumbnail', async (req, res) => {
    const video = videoIndex[req.params.id];
    if (video) {
        const thumbPath = getThumbPath(video.filePath);
        const legacyThumbPath = getLegacyThumbPath(video.filePath);
        const tpdbThumbPath = getTpdbThumbPath(video.filePath);
        const legacyTpdbThumbPath = getLegacyTpdbThumbPath(video.filePath);
        const fastMode = String(req.query.fast || '') === '1';
        // Thumbnails can change after metadata/custom updates. Avoid stale browser cache.
        res.setHeader('Cache-Control', 'no-store');

        // Always prefer TPDB thumbnails when present on disk.
        if (hasValidThumbFile(tpdbThumbPath)) return res.sendFile(tpdbThumbPath);
        if (hasValidThumbFile(legacyTpdbThumbPath)) {
            try {
                if (!hasValidThumbFile(tpdbThumbPath)) {
                    fs.copyFileSync(legacyTpdbThumbPath, tpdbThumbPath);
                    const legacySrc = readThumbSource(legacyTpdbThumbPath);
                    if (legacySrc) writeThumbSource(tpdbThumbPath, legacySrc);
                }
            } catch { }
            return res.sendFile(legacyTpdbThumbPath);
        }

        if (hasTpdbPreferredThumbForPath(video.filePath)) {
            try {
                await ensureTpdbPreferredThumbnail(video.filePath);
            } catch (err) {
                addRuntimeLog('warn', 'tpdb', 'Failed to sync preferred TPDB thumbnail', {
                    videoId: video.id,
                    videoPath: video.filePath,
                    error: String(err?.message || err || ''),
                });
            }
            if (hasValidThumbFile(tpdbThumbPath)) return res.sendFile(tpdbThumbPath);
            if (hasValidThumbFile(legacyTpdbThumbPath)) return res.sendFile(legacyTpdbThumbPath);
            return res.status(404).json({ error: 'TPDB thumbnail not ready' });
        }

        if (hasValidThumbFile(thumbPath)) return res.sendFile(thumbPath);
        if (hasValidThumbFile(legacyThumbPath)) return res.sendFile(legacyThumbPath);
        if (fs.existsSync(thumbPath)) {
            try { fs.rmSync(thumbPath, { force: true }); } catch { }
        }
        // Always queue generation, but optionally return immediately to avoid blocking request slots.
        if (fastMode) {
            generateThumbnail(video.filePath, { quick: true }).catch(() => { });
            res.setHeader('Cache-Control', 'no-store');
            return res.status(404).json({ error: 'Thumbnail not ready' });
        }
        generateThumbnail(video.filePath).then(tp => {
            if (tp && hasValidThumbFile(tp)) return res.sendFile(tp);
            return res.status(404).json({ error: 'No thumbnail' });
        });
        return;
    }
    res.status(404).json({ error: 'Video not found' });
});

// Serve or lazily generate hover preview clips
app.get('/api/videos/:id/preview', async (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    if (!fs.existsSync(video.filePath)) return res.status(404).json({ error: 'File not found on disk' });

    const previewPath = getPreviewPath(video.filePath);
    const forceRegen = String(req.query.regen || '') === '1';
    if (forceRegen) {
        try { fs.rmSync(previewPath, { force: true }); } catch { }
        clearPreviewProbeCache(previewPath);
        previewFailureUntil.delete(video.filePath);
    }
    if (await hasPlayablePreviewFile(previewPath, { minDurationSec: MIN_PLAYABLE_PREVIEW_DURATION_SEC })) {
        setPreviewNoStoreHeaders(res);
        res.setHeader('Content-Type', 'video/mp4');
        return res.sendFile(previewPath);
    }
    if (hasFallbackPreviewCandidate(previewPath)) {
        setPreviewNoStoreHeaders(res);
        res.setHeader('Content-Type', 'video/mp4');
        return res.sendFile(previewPath);
    }
    if (fs.existsSync(previewPath) && !(await hasPlayablePreviewFile(previewPath, { minDurationSec: MIN_PLAYABLE_PREVIEW_DURATION_SEC }))) {
        try { fs.rmSync(previewPath, { force: true }); } catch { }
        clearPreviewProbeCache(previewPath);
    }

    const warmOnly = String(req.query.warm || '') === '1';
    const generated = await generatePreviewOnDemand(video.filePath, { ignoreCooldown: !warmOnly, videoId: video.id });
    if (generated && hasValidPreviewFile(generated)) {
        setPreviewNoStoreHeaders(res);
        res.setHeader('Content-Type', 'video/mp4');
        return res.sendFile(generated);
    }

    // Avoid caching "not ready yet" responses in browser/CDN.
    setPreviewNoStoreHeaders(res);
    if (warmOnly) return res.status(202).json({ queued: true });
    return res.status(404).json({ error: 'Preview not available yet' });
});

app.get('/api/videos/:id/preview/debug', async (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const previewPath = getPreviewPath(video.filePath);
    const tmpPath = `${previewPath}.tmp`;
    const blockedUntil = Number(previewFailureUntil.get(video.filePath) || 0);
    const inFlight = previewInFlight.has(video.filePath);

    let previewStat = null;
    let tmpStat = null;
    try {
        const st = fs.statSync(previewPath);
        previewStat = { exists: true, size: st.size, mtimeMs: Math.trunc(st.mtimeMs || 0) };
    } catch {
        previewStat = { exists: false, size: 0, mtimeMs: 0 };
    }
    try {
        const st = fs.statSync(tmpPath);
        tmpStat = { exists: true, size: st.size, mtimeMs: Math.trunc(st.mtimeMs || 0) };
    } catch {
        tmpStat = { exists: false, size: 0, mtimeMs: 0 };
    }

    const logs = readRuntimeLogs({ limit: 200, area: 'preview' });
    const relatedLogs = logs.filter((l) => {
        const meta = l.meta || {};
        return String(meta.videoId || '') === String(video.id)
            || String(meta.previewPath || '') === String(previewPath)
            || String(meta.tmpPath || '') === String(tmpPath);
    }).slice(0, 80);

    res.json({
        videoId: video.id,
        filePath: video.filePath,
        previewPath,
        tmpPath,
        preview: previewStat,
        tmp: tmpStat,
        queueSize: previewQueue.length,
        previewRunning,
        inFlight,
        blockedUntil,
        now: Date.now(),
        logs: relatedLogs,
    });
});

// GET video file path (uses global videoIndex for reliable lookup)
app.get('/api/videos/:id/path', (req, res) => {
    const video = videoIndex[req.params.id];
    if (video) return res.json({ filePath: video.filePath });
    res.status(404).json({ error: 'Video not found' });
});

app.get('/api/videos/:id/vr-meta', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const baseTitle = video.title || path.basename(video.filePath || '', path.extname(video.filePath || ''));
    const detected = detectVrMetaFromName(baseTitle);
    const override = getVrMetaByPath(video.filePath);
    const effective = buildVrMetaForVideo(baseTitle, video.filePath, video.libraryType || 'videos');

    res.json({
        videoId: video.id,
        filePath: video.filePath,
        libraryType: String(video.libraryType || 'videos').toLowerCase(),
        isVr: !!effective.isVr,
        projection: effective.vrProjection,
        stereoMode: effective.vrStereoMode,
        detected: {
            isVr: !!detected.isVr,
            projection: detected.projection,
            stereoMode: detected.stereoMode,
        },
        override: override ? {
            projection: normalizeVrProjection(override.projection),
            stereoMode: normalizeVrStereoMode(override.stereoMode),
        } : null,
    });
});

app.post('/api/videos/:id/vr-meta', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const projection = normalizeVrProjection(req.body?.projection);
    const stereoMode = normalizeVrStereoMode(req.body?.stereoMode);
    const override = setVrMetaByPath(video.filePath, projection, stereoMode);
    refreshVrMetaForPath(video.filePath);

    const refreshed = videoIndex[video.id] || video;
    res.json({
        ok: true,
        videoId: refreshed.id,
        filePath: refreshed.filePath,
        libraryType: String(refreshed.libraryType || 'videos').toLowerCase(),
        isVr: !!refreshed.isVr,
        projection: normalizeVrProjection(refreshed.vrProjection),
        stereoMode: normalizeVrStereoMode(refreshed.vrStereoMode),
        override,
    });
});

// GET video details (ffprobe)
app.get('/api/videos/:id/details', (req, res) => {
    const videoId = req.params.id;
    const video = videoIndex[videoId];

    if (!video) {
        return res.status(404).json({ error: 'Video not found' });
    }

    const cached = getDetailsProbeCache(video);
    if (cached) {
        return res.json(cached);
    }

    const args = [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        video.filePath
    ];

    execFile(ffprobePath, args, (err, stdout) => {
        if (err) {
            if (err.message && (err.message.includes('ENOENT') || err.message.includes('not found'))) {
                return res.status(500).json({ error: 'ffprobe not found on server' });
            }
            return res.status(500).json({ error: 'Failed to probe video' });
        }
        try {
            const data = JSON.parse(stdout);
            const streams = data.streams || [];
            const videoStream = streams.find(s => s.codec_type === 'video') || {};
            const format = data.format || {};
            const hasAudio = streams.some(s => s.codec_type === 'audio');
            setHasAudioCache(video.filePath, hasAudio);
            persistIndexedHasAudio(video.filePath, Number(video.size || 0), Number(video.modifiedAt || 0), hasAudio);
            video.hasAudio = hasAudio;
            const audio_codecs = streams
                .filter(s => s.codec_type === 'audio')
                .map(s => String(s.codec_name || '').toLowerCase())
                .filter(Boolean);
            const baseTitle = video.title || path.basename(video.filePath || '', path.extname(video.filePath || ''));
            const vrMeta = buildVrMetaForVideo(baseTitle, video.filePath, video.libraryType || 'videos');
            const payload = {
                width: videoStream.width,
                height: videoStream.height,
                codec_name: videoStream.codec_name,
                duration: parseFloat(format.duration || videoStream.duration || 0),
                bit_rate: parseInt(format.bit_rate || videoStream.bit_rate || 0),
                size: parseInt(format.size || 0),
                format_name: format.format_name || format.format_long_name || '',
                format_long_name: format.format_long_name || '',
                audio_codecs,
                path: video.filePath,
                libraryType: String(video.libraryType || 'videos').toLowerCase(),
                libraryId: String(video.libraryId || ''),
                isVr: !!vrMeta.isVr,
                vrProjection: vrMeta.vrProjection,
                vrStereoMode: vrMeta.vrStereoMode,
            };
            video.durationSec = Number(payload.duration || 0);
            persistIndexedDuration(video.filePath, Number(video.size || 0), Number(video.modifiedAt || 0), Number(payload.duration || 0));
            setDetailsProbeCache(video, payload);
            res.json(payload);
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse probe data' });
        }
    });
});

// GET funscript data
app.get('/api/videos/:id/funscript', (req, res) => {
    const video = videoIndex[req.params.id];
    if (!video) return res.status(404).json({ error: 'Not found' });

    try {
        const result = {
            metadata: { axes: video.axes || [], isMultiAxis: video.isMultiAxis || false },
            actions: []
        };

        const mappings = listFunscriptMappings(video.id)
            .filter((row) => Number(row.enabled || 0) === 1)
            .filter((row) => !!row.scriptPath && fs.existsSync(String(row.scriptPath)));

        if (mappings.length > 0) {
            const byAxis = new Map();
            const selectedScriptPaths = {};
            for (const mapping of mappings) {
                const axis = normalizeFunscriptAxis(mapping.axis);
                if (!byAxis.has(axis)) byAxis.set(axis, []);
                byAxis.get(axis).push(mapping);
            }

            for (const [axis, rows] of byAxis.entries()) {
                rows.sort((a, b) => {
                    if (Number(b.isDefault || 0) !== Number(a.isDefault || 0)) {
                        return Number(b.isDefault || 0) - Number(a.isDefault || 0);
                    }
                    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
                });
                const selected = rows[0];
                if (!selected?.scriptPath) continue;
                try {
                    const parsed = JSON.parse(fs.readFileSync(String(selected.scriptPath), 'utf-8'));
                    const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
                    selectedScriptPaths[axis] = String(selected.scriptPath || '');
                    if (axis === 'main') result.actions = actions;
                    else result[axis] = actions;
                } catch (e) {
                    console.warn(`[Funscript] Failed to read mapped axis ${axis} for ${video.id}:`, e.message);
                }
            }

            const mappedAxes = Object.keys(result).filter((key) => key !== 'metadata' && key !== 'actions');
            result.metadata = {
                ...result.metadata,
                axes: mappedAxes,
                isMultiAxis: mappedAxes.length > 0,
                mappings: mappings.map((row) => ({
                    id: row.id,
                    axis: row.axis,
                    label: row.label || '',
                    isDefault: Number(row.isDefault || 0) === 1,
                    offsetMs: Number(row.offsetMs || 0),
                    scriptPath: String(row.scriptPath || ''),
                })),
                scriptPaths: selectedScriptPaths,
                mainScriptPath: String(selectedScriptPaths.main || ''),
            };
            return res.json(result);
        }

        // Fallback to filename-based detection when no explicit mappings exist.
        if (video.funscriptPath && fs.existsSync(video.funscriptPath)) {
            const mainFs = JSON.parse(fs.readFileSync(video.funscriptPath, 'utf-8'));
            if (Array.isArray(mainFs?.actions)) {
                result.actions = mainFs.actions;
                result.metadata.mainScriptPath = String(video.funscriptPath || '');
            }
        }

        const fallbackScriptPaths = {};
        if (video.isMultiAxis && Array.isArray(video.axes)) {
            for (const axis of video.axes) {
                const axisPath = path.join(video.directory, `${video.title}.${axis}.funscript`);
                if (!fs.existsSync(axisPath)) continue;
                try {
                    const axisFs = JSON.parse(fs.readFileSync(axisPath, 'utf-8'));
                    if (Array.isArray(axisFs?.actions)) {
                        result[axis] = axisFs.actions;
                        fallbackScriptPaths[axis] = String(axisPath);
                    }
                } catch (e) {
                    console.warn(`[Funscript] Failed to read axis ${axis} for ${video.id}:`, e.message);
                }
            }
        }
        if (Object.keys(fallbackScriptPaths).length > 0) {
            result.metadata.scriptPaths = fallbackScriptPaths;
        }

        if (!Array.isArray(result.actions) || result.actions.length === 0) {
            return res.status(404).json({ error: 'Not found' });
        }
        return res.json(result);
    } catch (err) {
        console.error('[Funscript] Error assembling funscripts:', err);
        return res.status(500).json({ error: 'Failed to read funscript' });
    }
});

// â”€â”€ TMDB Routes â”€â”€

app.post('/api/tmdb/search', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key nicht konfiguriert' });
    const { query, type } = req.body;
    try {
        const q = encodeURIComponent(query);
        // Search both TV and movie in multiple languages, include adult content
        const searches = [
            tmdb.tmdbGet(`/search/tv?query=${q}&language=de-DE&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
            tmdb.tmdbGet(`/search/tv?query=${q}&language=en-US&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
            tmdb.tmdbGet(`/search/tv?query=${q}&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
            tmdb.tmdbGet(`/search/movie?query=${q}&language=de-DE&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
            tmdb.tmdbGet(`/search/movie?query=${q}&language=en-US&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
            tmdb.tmdbGet(`/search/movie?query=${q}&include_adult=true`, settings.tmdbApiKey).catch(() => ({ results: [] })),
        ];
        const allRes = await Promise.all(searches);

        // Merge and deduplicate by ID + media_type
        const seen = new Set();
        const merged = [];
        for (const r of allRes.flatMap(a => a.results || [])) {
            const mediaType = r.media_type || (r.title ? 'movie' : 'tv');
            const key = `${mediaType}_${r.id}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push({ ...r, media_type: mediaType });
            }
        }
        // Sort: preferred type first, then by popularity
        const preferredType = type === 'movie' ? 'movie' : 'tv';
        merged.sort((a, b) => {
            if (a.media_type === preferredType && b.media_type !== preferredType) return -1;
            if (b.media_type === preferredType && a.media_type !== preferredType) return 1;
            return (b.popularity || 0) - (a.popularity || 0);
        });

        res.json({ results: merged, total_results: merged.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tmdb/fetch-by-id', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key nicht konfiguriert' });
    const { tmdbId, type, folderPath } = req.body;
    try {
        const details = type === 'movie'
            ? await tmdb.getMovieDetails(tmdbId, settings.tmdbApiKey)
            : await tmdb.getSeriesDetails(tmdbId, settings.tmdbApiKey);

        const metadata = {
            tmdbId: details.id,
            title: details.title || details.name,
            originalTitle: details.original_title || details.original_name,
            overview: details.overview,
            releaseDate: details.release_date || details.first_air_date,
            voteAverage: details.vote_average,
            genres: (details.genres || []).map(g => g.name),
            posterPath: details.poster_path,
            backdropPath: details.backdrop_path,
            numberOfSeasons: details.number_of_seasons,
            numberOfEpisodes: details.number_of_episodes,
            status: details.status,
            backdropIsLocal: false,
            type, fetchedAt: new Date().toISOString(),
        };
        if (details.poster_path) {
            try {
                const posterSavePath = getPosterPath(folderPath);
                await tmdb.downloadPoster(details.poster_path, posterSavePath);
                metadata.posterDownloaded = true;
            } catch {
                metadata.posterDownloaded = false;
            }
        }
        if (details.backdrop_path) {
            try {
                const backdropSavePath = getBackdropPath(folderPath);
                await tmdb.downloadPoster(details.backdrop_path, backdropSavePath, 'w1280');
                metadata.backdropIsLocal = true;
                metadata.backdropUpdatedAt = Date.now();
                metadata.backdropPath = null;
            } catch {
                metadata.backdropIsLocal = false;
            }
        }
        setMetadata(folderPath, metadata);
        applySeriesMetadataToCaches(folderPath, metadata, {
            hasPoster: hasPoster(folderPath),
            posterVersion: getPosterVersion(folderPath),
        });
        scheduleFullRescan('tmdb-fetch-by-id');
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tmdb/images', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key missing' });
    const { tmdbId, type } = req.body;
    try {
        const images = await tmdb.getImages(tmdbId, type === 'movie' ? 'movie' : 'tv', settings.tmdbApiKey);

        // Also fetch titles in multiple languages
        const tmdbType = type === 'movie' ? 'movie' : 'tv';
        const titleKey = type === 'movie' ? 'title' : 'name';
        const [detailsDe, detailsEn, detailsJa] = await Promise.all([
            tmdb.tmdbGet(`/${tmdbType}/${tmdbId}?language=de-DE`, settings.tmdbApiKey).catch(() => null),
            tmdb.tmdbGet(`/${tmdbType}/${tmdbId}?language=en-US`, settings.tmdbApiKey).catch(() => null),
            tmdb.tmdbGet(`/${tmdbType}/${tmdbId}?language=ja-JP`, settings.tmdbApiKey).catch(() => null),
        ]);

        const titles = {};
        if (detailsDe) titles.de = detailsDe[titleKey] || detailsDe.title || detailsDe.name;
        if (detailsEn) titles.en = detailsEn[titleKey] || detailsEn.title || detailsEn.name;
        if (detailsJa) titles.ja = detailsJa[titleKey] || detailsJa.title || detailsJa.name;

        res.json({ ...images, titles });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function applyTagsToCaches({ folderPath, videoPath, tags }) {
    for (const cache of Object.values(libraryCache)) {
        for (const folder of cache?.folders || []) {
            if (folderPath && path.normalize(folder.path) === path.normalize(folderPath)) {
                folder.tags = tags;
            }
        }
        for (const video of cache?.videos || []) {
            if (videoPath && path.normalize(video.filePath) === path.normalize(videoPath)) {
                video.tags = tags;
            }
        }
    }
}

function findVideoByPath(videoPath) {
    if (!videoPath) return null;
    const normalizedTarget = path.normalize(videoPath);
    for (const video of Object.values(videoIndex)) {
        if (path.normalize(video.filePath) === normalizedTarget) return video;
    }
    return null;
}

function isPathInside(childPath, parentPath) {
    const child = path.resolve(childPath).toLowerCase();
    const parent = path.resolve(parentPath).toLowerCase();
    return child === parent || child.startsWith(parent + path.sep.toLowerCase());
}

function findOwningSeriesFolder(videoPath) {
    if (!videoPath) return null;
    let best = null;
    for (const cache of Object.values(libraryCache)) {
        for (const folder of cache?.folders || []) {
            if (!folder?.path) continue;
            if (!isPathInside(videoPath, folder.path)) continue;
            if (!best || folder.path.length > best.folder.path.length) {
                best = { cache, folder };
            }
        }
    }
    return best;
}

function syncSeriesFolderTagsForVideo(videoPath, previousTags, nextTags) {
    const match = findOwningSeriesFolder(videoPath);
    if (!match) return null;

    const folderPath = match.folder.path;
    const videosInSeries = (match.cache?.videos || []).filter(v => v?.filePath && isPathInside(v.filePath, folderPath));

    const toMap = (arr) => {
        const map = new Map();
        for (const tag of normalizeTags(arr || [])) map.set(tag.toLowerCase(), tag);
        return map;
    };

    const prevMap = toMap(previousTags || []);
    const nextMap = toMap(nextTags || []);
    const folderMap = toMap(match.folder.tags || []);

    for (const [key, value] of nextMap.entries()) {
        if (!folderMap.has(key)) folderMap.set(key, value);
    }

    for (const key of prevMap.keys()) {
        if (nextMap.has(key)) continue;
        const existsOnOtherEpisode = videosInSeries.some(v =>
            path.normalize(v.filePath) !== path.normalize(videoPath) &&
            (v.tags || []).some(tag => String(tag || '').trim().toLowerCase() === key)
        );
        if (!existsOnOtherEpisode) folderMap.delete(key);
    }

    const saved = setFolderTags(folderPath, [...folderMap.values()]);
    applyTagsToCaches({ folderPath, tags: saved });
    return saved;
}

function detectFunscriptCandidatesForVideo(video) {
    const out = [];
    if (!video?.filePath || !video?.title) return out;
    const dir = path.dirname(video.filePath);
    const base = String(video.title);
    const mainPath = path.join(dir, `${base}.funscript`);
    if (fs.existsSync(mainPath)) {
        out.push({ scriptPath: mainPath, axis: 'main', label: '' });
    }
    for (const axis of MULTI_AXIS_SUFFIXES) {
        const axisPath = path.join(dir, `${base}.${axis}.funscript`);
        if (fs.existsSync(axisPath)) {
            out.push({ scriptPath: axisPath, axis, label: axis.toUpperCase() });
        }
    }
    return out;
}

function autoLinkFunscriptsForLibrary(libraryId = '', options = {}) {
    const targetLibraryId = String(libraryId || '').trim();
    const recordHistory = options?.recordHistory === true;
    const source = String(options?.source || '').trim() || (recordHistory ? 'manual' : 'auto');

    const videos = Object.values(videoIndex || {}).filter((video) => {
        if (!video?.id || !video?.filePath) return false;
        if (!targetLibraryId) return true;
        return String(video.libraryId || '') === targetLibraryId;
    });

    const deleteByVideo = db.prepare(`DELETE FROM funscript_mappings WHERE video_id = ?`);
    let scannedVideos = 0;
    let linkedScripts = 0;
    let changedVideos = 0;

    db.exec('BEGIN');
    try {
        for (const video of videos) {
            const detected = detectFunscriptCandidatesForVideo(video);
            const beforeCount = Number(listFunscriptMappings(String(video.id)).length || 0);
            deleteByVideo.run(String(video.id));
            const firstPerAxis = new Set();
            for (const item of detected) {
                const axis = normalizeFunscriptAxis(item.axis);
                const isDefault = !firstPerAxis.has(axis);
                if (isDefault) firstPerAxis.add(axis);
                upsertFunscriptMapping({
                    videoId: String(video.id),
                    scriptPath: item.scriptPath,
                    axis,
                    label: item.label || '',
                    isDefault,
                    enabled: true,
                    offsetMs: 0,
                });
                linkedScripts += 1;
            }
            const afterCount = Number(detected.length || 0);
            if (beforeCount !== afterCount || afterCount > 0) changedVideos += 1;
            scannedVideos += 1;
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }

    if (recordHistory) {
        addFunscriptHistory('scan', {
            details: {
                libraryId: targetLibraryId || '',
                scannedVideos,
                linkedScripts,
                changedVideos,
                source,
            },
        });
    }

    return { scannedVideos, linkedScripts, changedVideos };
}

function parseFunscriptActionsFromFile(scriptPath) {
    const normalizedPath = path.normalize(String(scriptPath || '').trim());
    if (!normalizedPath || !fs.existsSync(normalizedPath)) return null;
    const raw = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
    const actionsRaw = Array.isArray(raw?.actions) ? raw.actions : [];
    const actions = actionsRaw
        .map((entry) => ({
            at: Number(entry?.at || 0),
            pos: Number(entry?.pos || 0),
        }))
        .filter((entry) => Number.isFinite(entry.at) && Number.isFinite(entry.pos) && entry.at >= 0)
        .sort((a, b) => a.at - b.at);
    if (actions.length < 2) return { actions: [], stats: { count: actions.length, durationMs: 0 } };

    // Keep response payload bounded for large scripts.
    const MAX_POINTS = 3000;
    let points = actions;
    if (actions.length > MAX_POINTS) {
        const step = Math.ceil(actions.length / MAX_POINTS);
        points = actions.filter((_, idx) => idx % step === 0);
        const last = actions[actions.length - 1];
        const tail = points[points.length - 1];
        if (!tail || tail.at !== last.at || tail.pos !== last.pos) points.push(last);
    }

    const positions = actions.map((a) => a.pos);
    const count = actions.length;
    const sum = positions.reduce((acc, val) => acc + val, 0);
    const durationMs = Number(actions[actions.length - 1]?.at || 0);
    const stats = {
        count,
        durationMs,
        minPos: Math.min(...positions),
        maxPos: Math.max(...positions),
        avgPos: count > 0 ? (sum / count) : 0,
    };
    return { actions: points, stats };
}

app.get('/api/funscripts/manager', (req, res) => {
    try {
        const statusFilter = String(req.query?.status || '').trim().toLowerCase();
        const search = String(req.query?.search || '').trim().toLowerCase();
        const libraryIdFilter = String(req.query?.libraryId || '').trim();
        const limitRaw = Number(req.query?.limit);
        const offsetRaw = Number(req.query?.offset);
        const usePaging = Number.isFinite(limitRaw) && limitRaw > 0;
        const limit = usePaging ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 0;
        const offset = usePaging ? Math.max(0, Math.floor(Number.isFinite(offsetRaw) ? offsetRaw : 0)) : 0;
        const allMappings = listFunscriptMappings();
        const byVideo = new Map();
        for (const mapping of allMappings) {
            const key = String(mapping.videoId || '');
            if (!key) continue;
            if (!byVideo.has(key)) byVideo.set(key, []);
            byVideo.get(key).push({
                ...mapping,
                exists: fs.existsSync(String(mapping.scriptPath || '')),
                isDefault: Number(mapping.isDefault || 0) === 1,
                enabled: Number(mapping.enabled || 0) === 1,
            });
        }

        const rows = [];
        for (const video of Object.values(videoIndex)) {
            const videoId = String(video?.id || '');
            if (!videoId) continue;
            if (libraryIdFilter && String(video?.libraryId || '') !== libraryIdFilter) continue;
            const mappings = byVideo.get(videoId) || [];
            const existingCount = mappings.filter((m) => m.exists).length;
            const axisToCount = new Map();
            for (const m of mappings) {
                const axis = normalizeFunscriptAxis(m.axis);
                axisToCount.set(axis, Number(axisToCount.get(axis) || 0) + 1);
            }
            const distinctAxisCount = axisToCount.size;
            const hasMultiPerAxis = [...axisToCount.values()].some((count) => Number(count || 0) > 1);
            let status = 'missing';
            if (mappings.length > 0 && existingCount === 0) status = 'orphan';
            else if (hasMultiPerAxis) status = 'multiple';
            else if (distinctAxisCount > 1) status = 'multi-axis';
            else if (existingCount > 0) status = 'linked';

            if (statusFilter && statusFilter !== 'all' && status !== statusFilter) continue;
            if (search) {
                const hay = `${video.title || ''} ${video.fileName || ''} ${video.filePath || ''}`.toLowerCase();
                if (!hay.includes(search)) continue;
            }

            rows.push({
                videoId,
                title: String(video.title || ''),
                filePath: String(video.filePath || ''),
                libraryId: String(video.libraryId || ''),
                libraryType: String(video.libraryType || 'videos'),
                status,
                mappingCount: mappings.length,
                mappings,
            });
        }

        rows.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
        const total = rows.length;
        const items = usePaging ? rows.slice(offset, offset + limit) : rows;
        res.json({
            items,
            total,
            offset,
            limit,
            hasMore: usePaging ? (offset + items.length) < total : false,
            libraries: (loadSettings().libraries || []).map((lib) => ({ id: String(lib.id || ''), name: String(lib.name || ''), type: String(lib.type || 'videos') })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/funscripts/history', (req, res) => {
    try {
        const limit = Number(req.query?.limit || 40);
        const items = listFunscriptHistory(limit);
        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funscripts/scan', (req, res) => {
    try {
        const libraryId = String(req.body?.libraryId || '').trim();
        const { scannedVideos, linkedScripts } = autoLinkFunscriptsForLibrary(libraryId, {
            recordHistory: true,
            source: 'manual',
        });
        res.json({ success: true, scannedVideos, linkedScripts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funscripts/link', (req, res) => {
    const videoId = String(req.body?.videoId || '').trim();
    const scriptPath = String(req.body?.scriptPath || '').trim();
    const axis = normalizeFunscriptAxis(req.body?.axis || 'main');
    const label = normalizeFunscriptLabel(req.body?.label || '');
    const setDefault = req.body?.setDefault !== false;
    if (!videoId || !scriptPath) return res.status(400).json({ error: 'Missing videoId/scriptPath' });
    const video = videoIndex[videoId];
    if (!video) return res.status(404).json({ error: 'Video not found' });
    const normalizedPath = path.normalize(scriptPath);
    if (!fs.existsSync(normalizedPath)) return res.status(400).json({ error: 'Script file does not exist' });
    try {
        const mappingId = upsertFunscriptMapping({
            videoId,
            scriptPath: normalizedPath,
            axis,
            label,
            isDefault: !!setDefault,
            enabled: true,
            offsetMs: Number(req.body?.offsetMs || 0),
        });
        if (setDefault && mappingId) {
            setDefaultFunscriptMapping(mappingId);
        }
        addFunscriptHistory('link', {
            videoId,
            scriptPath: normalizedPath,
            axis,
            label,
            details: {
                setDefault: !!setDefault,
                videoTitle: String(video?.title || ''),
                videoPath: String(video?.filePath || ''),
            },
        });
        res.json({ success: true, mappingId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funscripts/default', (req, res) => {
    const mappingId = String(req.body?.mappingId || '').trim();
    if (!mappingId) return res.status(400).json({ error: 'Missing mappingId' });
    try {
        const row = setDefaultFunscriptMapping(mappingId);
        if (!row) return res.status(404).json({ error: 'Mapping not found' });
        const current = db.prepare(`
            SELECT script_path AS scriptPath, label, axis
            FROM funscript_mappings
            WHERE id = ?
        `).get(mappingId);
        addFunscriptHistory('set-default', {
            videoId: row.videoId,
            scriptPath: String(current?.scriptPath || ''),
            axis: String(current?.axis || row.axis || ''),
            label: String(current?.label || ''),
            details: {
                videoTitle: String(videoIndex[String(row.videoId)]?.title || ''),
                videoPath: String(videoIndex[String(row.videoId)]?.filePath || ''),
            },
        });
        res.json({ success: true, videoId: row.videoId, axis: row.axis });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/funscripts/unlink', (req, res) => {
    const mappingId = String(req.body?.mappingId || '').trim();
    if (!mappingId) return res.status(400).json({ error: 'Missing mappingId' });
    try {
        const existing = db.prepare(`
            SELECT id, video_id AS videoId, axis, is_default AS isDefault
            FROM funscript_mappings
            WHERE id = ?
        `).get(mappingId);
        if (!existing) return res.status(404).json({ error: 'Mapping not found' });
        const current = db.prepare(`
            SELECT script_path AS scriptPath, label
            FROM funscript_mappings
            WHERE id = ?
        `).get(mappingId);
        db.exec('BEGIN');
        db.prepare(`DELETE FROM funscript_mappings WHERE id = ?`).run(mappingId);
        if (Number(existing.isDefault || 0) === 1) {
            const replacement = db.prepare(`
                SELECT id
                FROM funscript_mappings
                WHERE video_id = ? AND axis = ?
                ORDER BY updated_at DESC
                LIMIT 1
            `).get(existing.videoId, existing.axis);
            if (replacement?.id) {
                setDefaultFunscriptMapping(replacement.id, { inTransaction: true });
            }
        }
        db.exec('COMMIT');
        addFunscriptHistory('unlink', {
            videoId: String(existing.videoId || ''),
            scriptPath: String(current?.scriptPath || ''),
            axis: String(existing.axis || ''),
            label: String(current?.label || ''),
            details: {
                wasDefault: Number(existing.isDefault || 0) === 1,
                videoTitle: String(videoIndex[String(existing.videoId || '')]?.title || ''),
                videoPath: String(videoIndex[String(existing.videoId || '')]?.filePath || ''),
            },
        });
        res.json({ success: true });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/funscripts/mapping/:id/preview', (req, res) => {
    const mappingId = String(req.params?.id || '').trim();
    if (!mappingId) return res.status(400).json({ error: 'Missing mapping id' });
    try {
        const row = db.prepare(`
            SELECT id, video_id AS videoId, script_path AS scriptPath, axis, label, is_default AS isDefault, enabled
            FROM funscript_mappings
            WHERE id = ?
        `).get(mappingId);
        if (!row) return res.status(404).json({ error: 'Mapping not found' });

        const parsed = parseFunscriptActionsFromFile(row.scriptPath);
        if (!parsed) {
            return res.json({
                mappingId,
                exists: false,
                axis: row.axis,
                label: row.label || '',
                isDefault: Number(row.isDefault || 0) === 1,
                enabled: Number(row.enabled || 0) === 1,
                actions: [],
                stats: { count: 0, durationMs: 0, minPos: 0, maxPos: 0, avgPos: 0 },
            });
        }

        return res.json({
            mappingId,
            exists: true,
            axis: row.axis,
            label: row.label || '',
            isDefault: Number(row.isDefault || 0) === 1,
            enabled: Number(row.enabled || 0) === 1,
            actions: parsed.actions,
            stats: parsed.stats,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/folder', (req, res) => {
    const { folderPath, tags } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: 'Missing folderPath' });
    try {
        const savedTags = setFolderTags(folderPath, tags);
        applyTagsToCaches({ folderPath, tags: savedTags });
        res.json({ success: true, tags: savedTags });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/video/:id', (req, res) => {
    const { tags, videoPath } = req.body || {};
    const video = videoIndex[req.params.id] || findVideoByPath(videoPath);
    const effectiveVideoPath = video?.filePath || (videoPath ? path.normalize(videoPath) : null);
    if (!effectiveVideoPath) return res.status(404).json({ error: 'Video not found' });
    try {
        const previousTags = normalizeTags(getVideoTags(effectiveVideoPath));
        const savedTags = setVideoTags(effectiveVideoPath, tags);
        if (video) video.tags = savedTags;
        applyTagsToCaches({ videoPath: effectiveVideoPath, tags: savedTags });
        syncSeriesFolderTagsForVideo(effectiveVideoPath, previousTags, savedTags);
        res.json({ success: true, tags: savedTags });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tags/video/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing video id' });
    const video = videoIndex[id];
    if (!video?.filePath) return res.status(404).json({ error: 'Video not found' });
    try {
        const tags = getVideoTags(video.filePath);
        if (video) video.tags = tags;
        applyTagsToCaches({ videoPath: video.filePath, tags });
        res.json({
            success: true,
            videoId: id,
            videoPath: video.filePath,
            tags,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tags/categories', (_req, res) => {
    try {
        const map = getTagCategoryMap();
        const categories = [...new Set(
            Object.values(map)
                .map(entry => normalizeTagCategoryName(entry?.category || ''))
                .filter(Boolean)
        )].sort((a, b) => a.localeCompare(b));
        res.json({ categories, map });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/categories/set', (req, res) => {
    const tagName = String(req.body?.tagName || '').trim();
    const category = normalizeTagCategoryName(req.body?.category || '');
    if (!tagName) return res.status(400).json({ error: 'Missing tagName' });
    try {
        const saved = setCategoryForTag(tagName, category);
        res.json({ success: true, tagName: saved.tagName, category: saved.category });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/categories/delete', (req, res) => {
    const category = normalizeTagCategoryName(req.body?.category || '');
    if (!category) return res.status(400).json({ error: 'Missing category' });
    try {
        const stmt = db.prepare(`
            DELETE FROM tag_categories
            WHERE lower(category) = lower(?)
        `);
        const result = stmt.run(category);
        res.json({ success: true, category, changedTags: Number(result?.changes || 0) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tags/manager', (req, res) => {
    try {
        const categoryMap = getTagCategoryMap();
        const rows = db.prepare(`
            SELECT item_type AS itemType, tags_json AS tagsJson
            FROM tags
        `).all();
        const stats = new Map();
        for (const row of rows) {
            let parsed = [];
            try {
                parsed = normalizeTags(JSON.parse(row.tagsJson));
            } catch {
                parsed = [];
            }
            const unique = new Set(parsed.map(tag => String(tag || '').trim().toLowerCase()).filter(Boolean));
            for (const key of unique) {
                const previous = stats.get(key) || {
                    name: parsed.find(tag => String(tag || '').trim().toLowerCase() === key) || key,
                    category: normalizeTagCategoryName(categoryMap[key]?.category || ''),
                    usageCount: 0,
                    videoCount: 0,
                    folderCount: 0,
                };
                previous.usageCount += 1;
                if (row.itemType === 'video') previous.videoCount += 1;
                if (row.itemType === 'folder') previous.folderCount += 1;
                stats.set(key, previous);
            }
        }
        for (const [key, entry] of Object.entries(categoryMap || {})) {
            if (!key || stats.has(key)) continue;
            stats.set(key, {
                name: String(entry?.tagName || key),
                category: normalizeTagCategoryName(entry?.category || ''),
                usageCount: 0,
                videoCount: 0,
                folderCount: 0,
            });
        }
        const tags = [...stats.values()].sort((a, b) => a.name.localeCompare(b.name));
        res.json(tags);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/manager/create', (req, res) => {
    const tagName = String(req.body?.tagName || '').trim();
    const category = normalizeTagCategoryName(req.body?.category || 'Misc');
    if (!tagName) return res.status(400).json({ error: 'Missing tagName' });
    try {
        const saved = setCategoryForTag(tagName, category);
        res.json({
            success: true,
            tagName: saved.tagName || tagName,
            category: saved.category || '',
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/manager/rename', (req, res) => {
    const fromTag = String(req.body?.fromTag || '').trim();
    const toTag = String(req.body?.toTag || '').trim();
    if (!fromTag || !toTag) return res.status(400).json({ error: 'Missing fromTag/toTag' });
    const fromLower = fromTag.toLowerCase();
    const toLower = toTag.toLowerCase();
    if (fromLower === toLower) return res.json({ success: true, changedItems: 0 });

    const rows = db.prepare(`
        SELECT item_key AS itemKey, item_type AS itemType, item_path AS itemPath, tags_json AS tagsJson
        FROM tags
    `).all();
    const updateRow = db.prepare(`UPDATE tags SET tags_json = ? WHERE item_key = ?`);
    let changedItems = 0;

    db.exec('BEGIN');
    try {
        for (const row of rows) {
            let parsed = [];
            try {
                parsed = normalizeTags(JSON.parse(row.tagsJson));
            } catch {
                parsed = [];
            }
            const hasFrom = parsed.some(tag => String(tag || '').trim().toLowerCase() === fromLower);
            if (!hasFrom) continue;
            const nextTags = replaceTagInList(parsed, fromLower, toTag);
            updateRow.run(JSON.stringify(nextTags), row.itemKey);
            applyTagsToCaches({
                folderPath: row.itemType === 'folder' ? row.itemPath : null,
                videoPath: row.itemType === 'video' ? row.itemPath : null,
                tags: nextTags,
            });
            changedItems += 1;
        }
        renameTagCategory(fromTag, toTag);
        db.exec('COMMIT');
        res.json({ success: true, changedItems });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/manager/merge', (req, res) => {
    const targetTag = String(req.body?.targetTag || '').trim();
    const sourceTagsInput = Array.isArray(req.body?.sourceTags) ? req.body.sourceTags : [];
    const sourceTags = normalizeTags(sourceTagsInput).filter(tag => tag.toLowerCase() !== targetTag.toLowerCase());
    if (!targetTag || sourceTags.length === 0) return res.status(400).json({ error: 'Missing targetTag/sourceTags' });
    const sourceLowerSet = new Set(sourceTags.map(tag => tag.toLowerCase()));
    const hasManualCategory = Object.prototype.hasOwnProperty.call(req.body || {}, 'resultCategory');
    const manualCategory = normalizeTagCategoryName(req.body?.resultCategory || '');

    const targetCategory = getCategoryForTag(targetTag);
    const sourceCategories = [...new Set(
        sourceTags
            .map((tag) => getCategoryForTag(tag))
            .filter(Boolean)
    )];
    const categoryConflict = !targetCategory && sourceCategories.length > 1;
    let resolvedCategory = targetCategory;
    if (!resolvedCategory && sourceCategories.length === 1) {
        resolvedCategory = sourceCategories[0];
    }
    if (hasManualCategory) {
        resolvedCategory = manualCategory;
    }

    const rows = db.prepare(`
        SELECT item_key AS itemKey, item_type AS itemType, item_path AS itemPath, tags_json AS tagsJson
        FROM tags
    `).all();
    const updateRow = db.prepare(`UPDATE tags SET tags_json = ? WHERE item_key = ?`);
    let changedItems = 0;

    db.exec('BEGIN');
    try {
        for (const row of rows) {
            let parsed = [];
            try {
                parsed = normalizeTags(JSON.parse(row.tagsJson));
            } catch {
                parsed = [];
            }
            const hasSource = parsed.some(tag => sourceLowerSet.has(String(tag || '').trim().toLowerCase()));
            if (!hasSource) continue;
            let nextTags = parsed;
            for (const sourceLower of sourceLowerSet) {
                nextTags = replaceTagInList(nextTags, sourceLower, targetTag);
            }
            updateRow.run(JSON.stringify(nextTags), row.itemKey);
            applyTagsToCaches({
                folderPath: row.itemType === 'folder' ? row.itemPath : null,
                videoPath: row.itemType === 'video' ? row.itemPath : null,
                tags: nextTags,
            });
            changedItems += 1;
        }
        for (const sourceTag of sourceTags) {
            const key = normalizeTagKey(sourceTag);
            if (key) db.prepare(`DELETE FROM tag_categories WHERE tag_key = ?`).run(key);
        }
        setCategoryForTag(targetTag, resolvedCategory || '');
        db.exec('COMMIT');
        res.json({
            success: true,
            changedItems,
            resultCategory: resolvedCategory || '',
            targetCategory,
            sourceCategories,
            categoryConflict,
        });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tags/manager/delete', (req, res) => {
    const tagsInput = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tagNames = normalizeTags(tagsInput);
    if (tagNames.length === 0) return res.status(400).json({ error: 'Missing tags' });
    const removeLowerSet = new Set(tagNames.map(tag => tag.toLowerCase()));

    const rows = db.prepare(`
        SELECT item_key AS itemKey, item_type AS itemType, item_path AS itemPath, tags_json AS tagsJson
        FROM tags
    `).all();
    const updateRow = db.prepare(`UPDATE tags SET tags_json = ? WHERE item_key = ?`);
    let changedItems = 0;

    db.exec('BEGIN');
    try {
        for (const row of rows) {
            let parsed = [];
            try {
                parsed = normalizeTags(JSON.parse(row.tagsJson));
            } catch {
                parsed = [];
            }
            const hasTarget = parsed.some(tag => removeLowerSet.has(String(tag || '').trim().toLowerCase()));
            if (!hasTarget) continue;
            const nextTags = removeTagFromList(parsed, removeLowerSet);
            updateRow.run(JSON.stringify(nextTags), row.itemKey);
            applyTagsToCaches({
                folderPath: row.itemType === 'folder' ? row.itemPath : null,
                videoPath: row.itemType === 'video' ? row.itemPath : null,
                tags: nextTags,
            });
            changedItems += 1;
        }
        for (const tagName of tagNames) {
            const key = normalizeTagKey(tagName);
            if (key) db.prepare(`DELETE FROM tag_categories WHERE tag_key = ?`).run(key);
        }
        db.exec('COMMIT');
        res.json({ success: true, changedItems });
    } catch (err) {
        db.exec('ROLLBACK');
        res.status(500).json({ error: err.message });
    }
});

function normalizeTmdbApplyType(type) {
    return type === 'movie' ? 'movie' : 'series';
}

function normalizeSearchPreferredType(type) {
    return type === 'movie' ? 'movie' : 'tv';
}

async function searchTmdbCandidates(query, preferredType, apiKey, limit = 6) {
    const q = encodeURIComponent(query);
    const searches = [
        tmdb.tmdbGet(`/search/tv?query=${q}&language=de-DE&include_adult=true`, apiKey).catch(() => ({ results: [] })),
        tmdb.tmdbGet(`/search/tv?query=${q}&language=en-US&include_adult=true`, apiKey).catch(() => ({ results: [] })),
        tmdb.tmdbGet(`/search/tv?query=${q}&include_adult=true`, apiKey).catch(() => ({ results: [] })),
        tmdb.tmdbGet(`/search/movie?query=${q}&language=de-DE&include_adult=true`, apiKey).catch(() => ({ results: [] })),
        tmdb.tmdbGet(`/search/movie?query=${q}&language=en-US&include_adult=true`, apiKey).catch(() => ({ results: [] })),
        tmdb.tmdbGet(`/search/movie?query=${q}&include_adult=true`, apiKey).catch(() => ({ results: [] })),
    ];
    const allRes = await Promise.all(searches);

    const seen = new Set();
    const merged = [];
    for (const r of allRes.flatMap(a => a.results || [])) {
        const mediaType = r.media_type || (r.title ? 'movie' : 'tv');
        const key = `${mediaType}_${r.id}`;
        if (!seen.has(key)) {
            seen.add(key);
            merged.push({ ...r, media_type: mediaType });
        }
    }

    merged.sort((a, b) => {
        if (a.media_type === preferredType && b.media_type !== preferredType) return -1;
        if (b.media_type === preferredType && a.media_type !== preferredType) return 1;
        return (b.popularity || 0) - (a.popularity || 0);
    });

    return merged.slice(0, limit);
}

async function applyTmdbMetadata({ tmdbId, type, folderPath, posterPath, backdropPath, titleOverride, apiKey }) {
    const normalizedType = normalizeTmdbApplyType(type);
    const details = normalizedType === 'movie'
        ? await tmdb.getMovieDetails(tmdbId, apiKey)
        : await tmdb.getSeriesDetails(tmdbId, apiKey);

    let title = details.title || details.name;
    if (titleOverride) {
        title = titleOverride;
    }

    const metadata = {
        tmdbId: details.id,
        title,
        originalTitle: details.original_title || details.original_name,
        overview: details.overview,
        releaseDate: details.release_date || details.first_air_date,
        voteAverage: details.vote_average,
        genres: (details.genres || []).map(g => g.name),
        posterPath: posterPath || details.poster_path,
        backdropPath: backdropPath || details.backdrop_path,
        numberOfSeasons: details.number_of_seasons,
        numberOfEpisodes: details.number_of_episodes,
        status: details.status,
        type: normalizedType,
        backdropIsLocal: false,
        fetchedAt: new Date().toISOString(),
    };

    if (metadata.posterPath) {
        try {
            const posterSavePath = getPosterPath(folderPath);
            await tmdb.downloadPoster(metadata.posterPath, posterSavePath);
            metadata.posterDownloaded = true;
        } catch {
            metadata.posterDownloaded = false;
        }
    }
    if (metadata.backdropPath) {
        try {
            const backdropSavePath = getBackdropPath(folderPath);
            await tmdb.downloadPoster(metadata.backdropPath, backdropSavePath, 'w1280');
            metadata.backdropIsLocal = true;
            metadata.backdropUpdatedAt = Date.now();
            metadata.backdropPath = null;
        } catch {
            metadata.backdropIsLocal = false;
        }
    }

    setMetadata(folderPath, metadata);
    applySeriesMetadataToCaches(folderPath, metadata, {
        hasPoster: hasPoster(folderPath),
        posterVersion: getPosterVersion(folderPath),
    });

    return metadata;
}

app.post('/api/tmdb/apply', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key nicht konfiguriert' });
    const { tmdbId, type, folderPath, posterPath, backdropPath, titleOverride } = req.body;
    try {
        const metadata = await applyTmdbMetadata({
            tmdbId,
            type,
            folderPath,
            posterPath,
            backdropPath,
            titleOverride,
            apiKey: settings.tmdbApiKey,
        });
        scheduleFullRescan('tmdb-apply');
        res.json({ success: true, metadata });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tmdb/batch-search', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key nicht konfiguriert' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const preferredType = normalizeSearchPreferredType(req.body?.type);
    if (items.length === 0) return res.status(400).json({ error: 'Keine Elemente angegeben' });

    const limited = items.slice(0, 100);
    const results = [];

    for (const item of limited) {
        const folderPath = item.folderPath;
        const query = (item.query || (folderPath ? path.basename(folderPath) : '')).trim();
        if (!folderPath || !query) {
            results.push({ folderPath, query, candidates: [], error: 'UngÃ¼ltige Eingabe' });
            continue;
        }

        try {
            const candidates = await searchTmdbCandidates(query, preferredType, settings.tmdbApiKey, 8);
            results.push({ folderPath, query, candidates });
        } catch (err) {
            results.push({ folderPath, query, candidates: [], error: err.message });
        }
    }

    res.json({ results });
});

app.post('/api/tmdb/batch-apply', async (req, res) => {
    const settings = loadSettings();
    if (!settings.tmdbApiKey) return res.status(400).json({ error: 'TMDB API Key nicht konfiguriert' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) return res.status(400).json({ error: 'Keine Elemente angegeben' });

    const limited = items.slice(0, 100);
    const results = [];

    for (const item of limited) {
        const { tmdbId, type, folderPath, posterPath, backdropPath, titleOverride } = item;
        if (!tmdbId || !folderPath) {
            results.push({ folderPath, success: false, error: 'tmdbId/folderPath fehlt' });
            continue;
        }
        try {
            const metadata = await applyTmdbMetadata({
                tmdbId,
                type,
                folderPath,
                posterPath,
                backdropPath,
                titleOverride,
                apiKey: settings.tmdbApiKey,
            });
            results.push({ folderPath, success: true, metadata });
        } catch (err) {
            results.push({ folderPath, success: false, error: err.message });
        }
    }

    scheduleFullRescan('tmdb-batch-apply', 800);
    const successCount = results.filter(r => r.success).length;
    res.json({
        successCount,
        failedCount: results.length - successCount,
        results,
    });
});

// â”€â”€ Settings â”€â”€

function getLibraryVideosByLibraryId(libraryId) {
    const settings = loadSettings();
    const isAll = String(libraryId || '') === ALL_LIBRARY_ID;
    const cache = isAll
        ? (isAllVideosLibraryEnabled(settings) ? getCombinedLibraryCache() : null)
        : libraryCache[String(libraryId || '')];
    if (!cache) return [];
    return Array.isArray(cache.videos) ? cache.videos : [];
}

async function resolveTpdbSearch({ video, itemType, query, year = '', useHash = true }) {
    const settings = loadSettings();
    const apiKey = String(settings?.tpdbApiKey || '').trim();
    if (!apiKey) throw new Error('ThePornDB API key is not configured');
    const itemTypeRaw = String(itemType || '').trim().toLowerCase();
    const types = itemTypeRaw === 'all'
        ? ['scenes', 'movies', 'jav']
        : [mapTpdbItemType(itemTypeRaw || 'scenes')];
    const rawParseTerm = String(query || video?.title || '').trim();
    const parseTerm = normalizeMetadataSearchTerm(rawParseTerm) || rawParseTerm;
    const hash = (useHash && video?.filePath) ? await computeOpenSubtitlesHash(video.filePath) : '';
    const merged = [];
    const seen = new Set();
    for (const type of types) {
        const endpoint = `/${type}?parse=${encodeURIComponent(parseTerm)}&hash=${encodeURIComponent(hash)}&year=${encodeURIComponent(String(year || ''))}`;
        const raw = await tpdbApiGet(endpoint, apiKey);
        const list = extractTpdbArray(raw);
        for (const row of list) {
            const normalized = normalizeTpdbSceneResult(row, type);
            if (!normalized?.id) continue;
            const key = `${type}:${String(normalized.id || '').trim().toLowerCase()}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(normalized);
        }
    }
    return merged;
}

async function resolveTpdbItemById({ itemType, itemId }) {
    const settings = loadSettings();
    const apiKey = String(settings?.tpdbApiKey || '').trim();
    if (!apiKey) throw new Error('ThePornDB API key is not configured');
    const type = mapTpdbItemType(itemType);
    const endpoint = `/${type}/${encodeURIComponent(String(itemId || ''))}`;
    const raw = await tpdbApiGet(endpoint, apiKey);
    const row = extractTpdbObject(raw);
    if (!row) throw new Error('No metadata found');
    return normalizeTpdbSceneResult(row, type);
}

async function resolveTpdbPerformerById(performerId) {
    const id = String(performerId || '').trim();
    if (!id) return null;
    const settings = loadSettings();
    const apiKey = String(settings?.tpdbApiKey || '').trim();
    if (!apiKey) return null;
    const raw = await tpdbApiGet(`/performers/${encodeURIComponent(id)}`, apiKey);
    const row = extractTpdbObject(raw);
    if (!row) return null;
    return normalizeTpdbPerformer(row);
}

async function resolveStashPerformerById(performerId) {
    const rawId = String(performerId || '').trim();
    const id = rawId.replace(/^stash:/i, '').trim();
    if (!id) return null;
    const settings = loadSettings();
    const apiKey = String(settings?.stashdbApiKey || '').trim();
    if (!apiKey) return null;
    const richQuery = `
        query FindPerformer($id: ID!) {
            findPerformer(id: $id) {
                id
                name
                disambiguation
                gender
                birth_date
                country
                age
                aliases
                band_size
                breast_type
                career_end_year
                career_start_year
                cup_size
                ethnicity
                eye_color
                hair_color
                height
                hip_size
                piercings { location description }
                tattoos { location description }
                waist_size
                images { url width height }
            }
        }
    `;
    const fallbackQuery = `
        query FindPerformer($id: ID!) {
            findPerformer(id: $id) {
                id
                name
                disambiguation
                gender
                birth_date
                country
                images { url width height }
            }
        }
    `;
    let data = await stashdbGraphql(richQuery, { id }, apiKey).catch(() => null);
    if (!data?.findPerformer) {
        data = await stashdbGraphql(fallbackQuery, { id }, apiKey).catch(() => null);
    }
    const row = data?.findPerformer || null;
    if (!row) return null;
    return normalizeStashPerformer(row);
}

async function resolveStashPerformerByName(nameInput) {
    const queryName = String(nameInput || '').trim();
    if (!queryName) return null;
    const settings = loadSettings();
    const apiKey = String(settings?.stashdbApiKey || '').trim();
    if (!apiKey) return null;
    const richQuery = `
        query SearchPerformer($term: String!, $limit: Int) {
            searchPerformer(term: $term, limit: $limit) {
                id
                name
                disambiguation
                gender
                birth_date
                country
                age
                aliases
                band_size
                breast_type
                career_end_year
                career_start_year
                cup_size
                ethnicity
                eye_color
                hair_color
                height
                hip_size
                piercings { location description }
                tattoos { location description }
                waist_size
                images { url width height }
            }
        }
    `;
    const fallbackQuery = `
        query SearchPerformer($term: String!, $limit: Int) {
            searchPerformer(term: $term, limit: $limit) {
                id
                name
                disambiguation
                gender
                birth_date
                country
                images { url width height }
            }
        }
    `;
    let data = await stashdbGraphql(richQuery, { term: queryName, limit: 20 }, apiKey).catch(() => null);
    if (!Array.isArray(data?.searchPerformer)) {
        data = await stashdbGraphql(fallbackQuery, { term: queryName, limit: 20 }, apiKey).catch(() => null);
    }
    const rows = Array.isArray(data?.searchPerformer) ? data.searchPerformer : [];
    if (rows.length === 0) return null;
    const qKey = normalizePersonKey(queryName);
    const exact = rows.filter((row) => normalizePersonKey(row?.name || '') === qKey);
    const picked = (exact.length > 0 ? exact : rows).sort((a, b) => {
        const aCount = Array.isArray(a?.images) ? a.images.length : 0;
        const bCount = Array.isArray(b?.images) ? b.images.length : 0;
        return bCount - aCount;
    })[0];
    if (!picked) return null;
    return normalizeStashPerformer(picked);
}

function mergePerformerMetadataWithPriority(base = {}, stash = null, tpdb = null) {
    const current = (base && typeof base === 'object') ? base : {};
    const stashMeta = (stash && typeof stash === 'object') ? stash : {};
    const tpdbMeta = (tpdb && typeof tpdb === 'object') ? tpdb : {};
    const pick = (...vals) => {
        for (const v of vals) {
            const s = String(v ?? '').trim();
            if (s) return s;
        }
        return '';
    };
    const ageFrom = [stashMeta?.age, current?.age, tpdbMeta?.age]
        .map((v) => Number(v || 0))
        .find((v) => Number.isFinite(v) && v > 0);
    return {
        ...current,
        name: pick(current?.name, stashMeta?.name, tpdbMeta?.name),
        disambiguation: pick(current?.disambiguation, stashMeta?.disambiguation, tpdbMeta?.disambiguation),
        imageUrl: pick(current?.imageUrl, stashMeta?.imageUrl, tpdbMeta?.imageUrl),
        faceUrl: pick(current?.faceUrl, stashMeta?.faceUrl, tpdbMeta?.faceUrl),
        selectedImageUrl: pick(current?.selectedImageUrl, stashMeta?.selectedImageUrl, tpdbMeta?.selectedImageUrl),
        bio: pick(current?.bio, stashMeta?.bio, tpdbMeta?.bio),
        birthdate: pick(stashMeta?.birthdate, current?.birthdate, tpdbMeta?.birthdate),
        birthplace: pick(stashMeta?.birthplace, current?.birthplace, tpdbMeta?.birthplace),
        nationality: pick(stashMeta?.nationality, current?.nationality, tpdbMeta?.nationality),
        gender: pick(stashMeta?.gender, current?.gender, tpdbMeta?.gender),
        age: Number.isFinite(ageFrom) ? ageFrom : null,
        raw: {
            ...(tpdbMeta?.raw && typeof tpdbMeta.raw === 'object' ? tpdbMeta.raw : {}),
            ...(current?.raw && typeof current.raw === 'object' ? current.raw : {}),
            ...(stashMeta?.raw && typeof stashMeta.raw === 'object' ? stashMeta.raw : {}),
            _glyphHydratedSources: {
                stashdb: !!stash,
                tpdb: !!tpdb,
            },
        },
    };
}

async function hydratePerformerMetadataByPriority(performerId, currentMeta = {}) {
    const pid = String(performerId || '').trim();
    const current = (currentMeta && typeof currentMeta === 'object') ? currentMeta : {};
    const currentName = String(current?.name || '').trim();
    let stash = null;
    let tpdb = null;

    try {
        if (pid.startsWith('stash:')) {
            stash = await resolveStashPerformerById(pid).catch(() => null);
        }
        if (!stash && currentName) {
            stash = await resolveStashPerformerByName(currentName).catch(() => null);
        }
    } catch { }

    try {
        if (pid.startsWith('name:')) {
            tpdb = await resolveTpdbPerformerByName(currentName).catch(() => null);
        } else if (!pid.startsWith('stash:')) {
            tpdb = await resolveTpdbPerformerById(pid).catch(() => null);
        }
        if (!tpdb && currentName) {
            tpdb = await resolveTpdbPerformerByName(currentName).catch(() => null);
        }
    } catch { }

    if (!stash && !tpdb) return null;
    return {
        ...mergePerformerMetadataWithPriority(current, stash, tpdb),
        id: pid || String(current?.id || ''),
    };
}

async function resolveTpdbPerformerByName(nameInput) {
    const query = String(nameInput || '').trim();
    if (!query) return null;
    const settings = loadSettings();
    const apiKey = String(settings?.tpdbApiKey || '').trim();
    if (!apiKey) return null;
    const raw = await tpdbApiGet(`/performers?q=${encodeURIComponent(query)}`, apiKey);
    const list = extractTpdbArray(raw);
    if (list.length === 0) return null;
    const qKey = normalizePersonKey(query);
    let picked = list[0];
    for (const row of list) {
        const n = normalizePersonKey(row?.name || '');
        if (n && n === qKey) { picked = row; break; }
    }
    const normalized = normalizeTpdbPerformer(picked);
    if (normalized?.id) {
        const hydrated = await resolveTpdbPerformerById(normalized.id).catch(() => null);
        return hydrated || normalized;
    }
    return normalized;
}

async function resolveTpdbPerformersByNameVariants(nameInput) {
    const query = String(nameInput || '').trim();
    if (!query) return [];
    const settings = loadSettings();
    const apiKey = String(settings?.tpdbApiKey || '').trim();
    if (!apiKey) return [];
    const raw = await tpdbApiGet(`/performers?q=${encodeURIComponent(query)}`, apiKey);
    const list = extractTpdbArray(raw);
    if (!Array.isArray(list) || list.length === 0) return [];
    const qKey = normalizePersonKey(query);
    let normalized = list
        .map((row) => normalizeTpdbPerformer(row))
        .filter((row) => row && (row.id || row.name));
    const exact = normalized.filter((row) => normalizePersonKey(row?.name || '') === qKey);
    if (exact.length > 0) normalized = exact;
    else normalized = normalized.slice(0, 1);
    return normalized;
}

function extractTpdbPerformerPageUrl(performer = {}) {
    const raw = performer?.raw && typeof performer.raw === 'object' ? performer.raw : {};
    const parent = raw?.parent && typeof raw.parent === 'object' ? raw.parent : {};
    const candidates = [
        performer?.sourceUrl,
        performer?.profileUrl,
        raw?.url,
        raw?.link,
        raw?.profile,
        raw?.profileUrl,
        raw?.sourceUrl,
        parent?.url,
        parent?.link,
        parent?.profile,
        parent?.profileUrl,
        parent?.sourceUrl,
    ].map((v) => String(v || '').trim()).filter(Boolean);
    for (const value of candidates) {
        const abs = toAbsoluteTpdbUrl(value);
        if (!abs) continue;
        try {
            const u = new URL(abs);
            if (String(u.hostname || '').toLowerCase().includes('theporndb.net') && /\/performers\//i.test(String(u.pathname || ''))) {
                return abs;
            }
        } catch { }
    }
    const slugGuess = String(raw?.slug || parent?.slug || performer?.slug || performer?.name || performer?.id || '').trim();
    if (slugGuess && !/^[0-9a-f-]{8,}$/i.test(slugGuess)) {
        const slug = slugifyStable(slugGuess);
        if (slug) return `${TPDB_WEB_BASE}/performers/${encodeURIComponent(slug)}`;
    }
    return '';
}

async function scrapeTpdbPerformerPagePosterUrls(performer = {}) {
    const pageUrl = extractTpdbPerformerPageUrl(performer);
    if (!pageUrl) return [];
    try {
        const res = await fetch(pageUrl, {
            headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': 'Glyph/0.3',
            },
        });
        if (!res.ok) return [];
        const html = await res.text();
        const matches = html.match(/https?:\/\/cdn\.theporndb\.net\/performer\/[^"\\\s<>]*\/poster\/[^"\\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"\\\s<>]*)?/gi) || [];
        const out = [];
        const seen = new Set();
        for (const rawUrl of matches) {
            const url = toAbsoluteTpdbUrl(rawUrl);
            if (!isAllowedPerformerImageUrl(url)) continue;
            if (url.toLowerCase().includes('/poster/c/')) continue;
            const key = canonicalizeImageUrl(url);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(url);
        }
        return out;
    } catch {
        return [];
    }
}

app.post('/api/tpdb/search', async (req, res) => {
    try {
        const itemTypeInput = String(req.body?.itemType || 'all').trim().toLowerCase();
        const itemType = itemTypeInput === 'all' ? 'all' : mapTpdbItemType(itemTypeInput || 'scenes');
        const settings = loadSettings();
        const stashApiConfigured = !!String(settings?.stashdbApiKey || '').trim();
        const videoId = String(req.body?.videoId || '').trim();
        const query = String(req.body?.query || '').trim();
        const urlInput = String(req.body?.url || '').trim();
        const video = videoId ? videoIndex[videoId] : null;
        const providerOrder = ['stashdb', 'tpdb'];
        addRuntimeLog('info', 'tpdb', 'TPDB search requested', {
            itemType,
            videoId,
            hasVideo: !!video,
            queryLength: query.length,
            hasUrl: !!urlInput,
            stashApiConfigured,
            providerOrder,
        });
        if (!video && !urlInput && !query) return res.status(400).json({ error: 'Missing video/query/url' });
        if (video) {
            const libraryType = String(video?.libraryType || '').toLowerCase();
            if (libraryType !== 'videos' && libraryType !== 'vr') {
                return res.status(400).json({ error: 'Metadata fetch is available for video/VR libraries only' });
            }
        }

        // Direct URL mode
        if (urlInput) {
            const stashParsed = parseStashSceneIdFromUrl(urlInput);
            if (stashParsed) {
                const detail = await resolveStashSceneById(stashParsed.itemId);
                if (!detail) return res.status(404).json({ error: 'StashDB scene not found' });
                addRuntimeLog('info', 'tpdb', 'Metadata search resolved by URL (stashdb)', {
                    itemId: stashParsed.itemId,
                    title: String(detail?.title || ''),
                });
                return res.json({ success: true, mode: 'url', provider: 'stashdb', results: [detail] });
            }
            const parsed = parseTpdbItemIdFromUrl(urlInput);
            if (!parsed || parsed.itemType === 'performers') {
                return res.status(400).json({ error: 'Invalid metadata URL (supported: StashDB scene URL or ThePornDB scene/movie/JAV URL)' });
            }
            const detail = await resolveTpdbItemById({ itemType: parsed.itemType, itemId: parsed.itemId });
            addRuntimeLog('info', 'tpdb', 'TPDB search resolved by URL', {
                itemType: parsed.itemType,
                itemId: parsed.itemId,
                title: String(detail?.title || ''),
            });
            return res.json({
                success: true,
                mode: 'url',
                provider: 'tpdb',
                results: [{ ...detail, provider: 'tpdb' }],
            });
        }

        // Provider pipeline: stashdb -> tpdb (global for video libraries)
        let stashResults = [];
        try {
            stashResults = await resolveStashSearch({
                video,
                query: String(query || video?.title || ''),
                useHash: true,
            });
            if (stashResults.length === 0 && video) {
                stashResults = await resolveStashSearch({
                    video,
                    query: String(query || video.title || ''),
                    useHash: false,
                });
            }
        } catch (err) {
            addRuntimeLog('warn', 'tpdb', 'StashDB search failed, fallback to TPDB', {
                videoId,
                error: String(err?.message || err || ''),
            });
            stashResults = [];
        }
        if (stashResults.length > 0) {
            addRuntimeLog('info', 'tpdb', 'Metadata search completed (stashdb)', {
                videoId,
                itemType,
                resultCount: stashResults.length,
            });
        }

        const year = video ? parseYearFromVideo(video) : '';
        let results = await resolveTpdbSearch({ video, itemType, query, year, useHash: true });
        // TPDB fallback: no hash in query path, title-only parse.
        if (results.length === 0 && video) {
            results = await resolveTpdbSearch({
                video,
                itemType,
                query: String(query || video.title || ''),
                year,
                useHash: false,
            });
        }
        // If TPDB found clean titles, retry stash with multiple candidate titles.
        if (Array.isArray(results) && results.length > 0 && stashResults.length === 0) {
            const titleCandidates = [...new Set(
                results
                    .map((r) => String(r?.title || '').trim())
                    .filter(Boolean)
            )].slice(0, 5);
            const stashById = new Map();
            for (const titleCandidate of titleCandidates) {
                try {
                    const stashRetry = await resolveStashSearch({
                        video,
                        query: titleCandidate,
                        useHash: false,
                    });
                    for (const row of (Array.isArray(stashRetry) ? stashRetry : [])) {
                        const id = String(row?.id || '').trim();
                        if (!id || stashById.has(id)) continue;
                        stashById.set(id, row);
                    }
                } catch { }
            }
            if (stashById.size > 0) {
                stashResults = [...stashById.values()];
                addRuntimeLog('info', 'tpdb', 'Metadata search completed (stashdb retries via TPDB titles)', {
                    videoId,
                    itemType,
                    titleCandidateCount: titleCandidates.length,
                    resultCount: stashResults.length,
                });
            }
        }
        results = (Array.isArray(results) ? results : []).map((row) => ({ ...row, provider: 'tpdb' }));
        const stashMapped = (Array.isArray(stashResults) ? stashResults : []).map((row) => ({ ...row, provider: 'stashdb' }));
        const combined = [...stashMapped, ...results];
        addRuntimeLog('info', 'tpdb', 'TPDB search completed', {
            videoId,
            itemType,
            stashCount: stashMapped.length,
            tpdbCount: results.length,
            resultCount: Array.isArray(combined) ? combined.length : 0,
        });
        return res.json({ success: true, mode: 'search', provider: 'mixed', results: combined });
    } catch (err) {
        addRuntimeLog('error', 'tpdb', 'TPDB search failed', {
            error: String(err?.message || err || ''),
        });
        return res.status(500).json({ error: err?.message || 'TPDB search failed' });
    }
});

app.post('/api/tpdb/apply', async (req, res) => {
    try {
        const videoId = String(req.body?.videoId || '').trim();
        const itemType = mapTpdbItemType(req.body?.itemType || 'scenes');
        const itemId = String(req.body?.itemId || '').trim();
        const urlInput = String(req.body?.url || '').trim();
        const providerHint = String(req.body?.provider || '').trim().toLowerCase();
        const video = videoIndex[videoId];
        if (!video?.filePath) return res.status(404).json({ error: 'Video not found' });
        {
            const libraryType = String(video?.libraryType || '').toLowerCase();
            if (libraryType !== 'videos' && libraryType !== 'vr') {
                return res.status(400).json({ error: 'Metadata fetch is available for video/VR libraries only' });
            }
        }
        addRuntimeLog('info', 'tpdb', 'TPDB apply requested', {
            videoId,
            itemType,
            hasItemId: !!itemId,
            hasUrl: !!urlInput,
            filePath: String(video?.filePath || ''),
            providerHint,
        });

        let provider = providerHint === 'stashdb' ? 'stashdb' : 'tpdb';
        let resolvedType = itemType;
        let resolvedId = itemId;
        let detail = null;

        const stashUrlParsed = urlInput ? parseStashSceneIdFromUrl(urlInput) : null;
        if (stashUrlParsed) {
            provider = 'stashdb';
            resolvedType = 'scene';
            resolvedId = stashUrlParsed.itemId;
        } else if (urlInput) {
            const parsed = parseTpdbItemIdFromUrl(urlInput);
            if (parsed) {
                provider = 'tpdb';
                resolvedType = mapTpdbItemType(parsed.itemType);
                resolvedId = parsed.itemId;
            }
        }

        if (provider === 'stashdb') {
            const stashId = String(resolvedId || '').replace(/^stash:/i, '').trim();
            if (!stashId) return res.status(400).json({ error: 'Missing itemId' });
            detail = await resolveStashSceneById(stashId);
            if (!detail) return res.status(404).json({ error: 'StashDB scene not found' });
            resolvedType = 'scene';
            resolvedId = stashId;
        } else {
            if ((!resolvedId || !resolvedType) && urlInput) {
                const parsed = parseTpdbItemIdFromUrl(urlInput);
                if (parsed) {
                    resolvedType = mapTpdbItemType(parsed.itemType);
                    resolvedId = parsed.itemId;
                }
            }
            if (!resolvedId) return res.status(400).json({ error: 'Missing itemId' });
            detail = await resolveTpdbItemById({ itemType: resolvedType, itemId: resolvedId });
        }

        const preferredThumbUrl = String(detail?.thumbUrl || detail?.posterUrl || '').trim();
        const metadataItemType = provider === 'stashdb'
            ? 'scene'
            : mapTpdbItemTypeLabel(detail?.itemType || resolvedType);
        const metadataItemId = provider === 'stashdb'
            ? String(resolvedId || '')
            : String(detail?.id || resolvedId || '');
        const meta = setTpdbVideoMetadata(video.filePath, {
            itemType: metadataItemType,
            itemId: metadataItemId,
            sourceUrl: detail?.sourceUrl || '',
            title: detail?.title || video.title || '',
            description: detail?.description || '',
            releaseDate: detail?.date || '',
            siteName: detail?.siteName || '',
            posterUrl: detail?.posterUrl || '',
            raw: {
                ...(detail?.raw || {}),
                _glyphThumbUrl: preferredThumbUrl,
                _glyphProvider: provider,
            },
        });

        const performers = Array.isArray(detail?.performers) ? detail.performers : [];
        const performerRefs = [];
        for (const performer of performers) {
            let sourcePerformer = performer;
            const performerName = String(
                (typeof performer === 'string' ? performer : performer?.name) || ''
            ).trim();
            try {
                if (provider !== 'stashdb' && performer?.id) {
                    const hydrated = await resolveTpdbPerformerById(performer.id);
                    if (hydrated) sourcePerformer = hydrated;
                }
                const normalizedSource = normalizeTpdbPerformer(sourcePerformer || {});
                if (provider !== 'stashdb' && (!normalizedSource.id || !normalizedSource.imageUrl || !normalizedSource.bio) && performerName) {
                    const byName = await resolveTpdbPerformerByName(performerName).catch(() => null);
                    if (byName) sourcePerformer = byName;
                }
            } catch { }
            const saved = setTpdbPerformer(sourcePerformer);
            if (saved?.id) performerRefs.push(saved);
        }
        setTpdbVideoPerformers(video.filePath, performerRefs);

        const thumbPath = getTpdbThumbPath(video.filePath);
        const legacyTpdbThumbPath = getLegacyTpdbThumbPath(video.filePath);
        const legacyThumbPath = getThumbPath(video.filePath);
        const legacyLegacyThumbPath = getLegacyThumbPath(video.filePath);
        const thumbCandidate = preferredThumbUrl;
        const posterCandidate = String(detail?.posterUrl || '').trim();
        const candidates = [...new Set([thumbCandidate, posterCandidate].filter(Boolean))];
        addRuntimeLog('info', 'tpdb', 'TPDB apply candidates prepared', {
            videoId,
            provider,
            resolvedType,
            resolvedId,
            performerCount: performerRefs.length,
            thumbCandidates: candidates.length,
        });
        let thumbnailUpdated = false;
        let thumbnailError = '';
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(thumbPath)) {
                    try { fs.rmSync(thumbPath, { force: true }); } catch { }
                }
                if (fs.existsSync(legacyThumbPath)) {
                    try { fs.rmSync(legacyThumbPath, { force: true }); } catch { }
                }
                if (fs.existsSync(legacyLegacyThumbPath)) {
                    try { fs.rmSync(legacyLegacyThumbPath, { force: true }); } catch { }
                }
                if (fs.existsSync(legacyTpdbThumbPath)) {
                    try { fs.rmSync(legacyTpdbThumbPath, { force: true }); } catch { }
                }
                await downloadImageToFile(candidate, thumbPath);
                thumbnailUpdated = hasValidThumbFile(thumbPath);
                if (thumbnailUpdated) {
                    writeThumbSource(thumbPath, `tpdb:${candidate}`);
                    break;
                }
            } catch (err) {
                thumbnailError = String(err?.message || '');
                addRuntimeLog('warn', 'tpdb', 'TPDB thumbnail candidate failed', {
                    videoId: video.id,
                    candidate,
                    error: thumbnailError,
                });
            }
        }

        syncTpdbVideoMetaIntoCaches(video.filePath);
        refreshVrMetaForPath(video.filePath);
        addRuntimeLog('info', 'tpdb', 'TPDB apply completed', {
            videoId,
            provider,
            title: String(meta?.title || ''),
            performerCount: performerRefs.length,
            thumbnailUpdated,
            thumbnailError: thumbnailUpdated ? '' : thumbnailError,
        });
        return res.json({
            success: true,
            provider,
            videoId: video.id,
            metadata: meta,
            performerCount: performerRefs.length,
            thumbnailUpdated,
            thumbnailError,
        });
    } catch (err) {
        addRuntimeLog('error', 'tpdb', 'TPDB apply failed', {
            error: String(err?.message || err || ''),
        });
        return res.status(500).json({ error: err?.message || 'TPDB apply failed' });
    }
});

function detectPerformerImageSource(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return 'other';
    try {
        const u = new URL(raw);
        const host = String(u.hostname || '').toLowerCase();
        if (host.endsWith('theporndb.net')) return 'tpdb';
        if (host.endsWith('stashdb.org') || host.includes('stashdb')) return 'stashdb';
    } catch { }
    return 'other';
}

function isAllowedPerformerImageUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return false;
    try {
        const u = new URL(raw);
        const pathname = String(u.pathname || '').toLowerCase();
        const protocolOk = /^https?:$/i.test(String(u.protocol || ''));
        if (!protocolOk) return false;
        const isImage = /\.(jpg|jpeg|png|webp)$/i.test(pathname);
        const source = detectPerformerImageSource(raw);
        if (source === 'tpdb') return isImage && pathname.includes('/performer/');
        if (source === 'stashdb') return isImage || pathname.includes('/images/');
        return false;
    } catch {
        return false;
    }
}

function scorePerformerImageUrl(value = '') {
    const u = String(value || '').toLowerCase();
    let score = 0;
    const source = detectPerformerImageSource(value);
    if (source === 'tpdb') score += 25;
    if (source === 'stashdb') score += 24;
    if (u.includes('cdn.theporndb.net')) score += 20;
    if (u.includes('thumb.theporndb.net')) score -= 15;
    if (u.includes('stashdb.org')) score += 18;
    if (u.includes('poster')) score += 8;
    if (u.includes('performer')) score += 6;
    if (u.includes('profile')) score += 4;
    if (u.includes('gallery')) score += 3;
    if (u.includes('thumb')) score -= 6;
    if (u.includes('small')) score -= 4;
    if (u.includes('avatar')) score -= 3;
    return score;
}

app.get('/api/tpdb/performers/:id/images', async (req, res) => {
    try {
        const performerId = String(req.params.id || '').trim();
        if (!performerId) return res.status(400).json({ error: 'Missing performer id' });
        let performer = tpdbPerformerById.get(performerId) || null;
        if (!performer) return res.status(404).json({ error: 'Performer not found' });
        const previousSelected = String(performer?.selectedImageUrl || '').trim();
        let canonicalPerformer = null;
        try {
            let hydrated = null;
            if (performerId.startsWith('name:')) hydrated = await resolveTpdbPerformerByName(performer?.name || '');
            else hydrated = await resolveTpdbPerformerById(performerId).catch(() => null);
            if (!hydrated && performer?.name) hydrated = await resolveTpdbPerformerByName(performer.name).catch(() => null);
            if (hydrated) {
                canonicalPerformer = hydrated;
                if (performerId.startsWith('name:')) {
                    performer = setTpdbPerformer({
                        ...hydrated,
                        id: performerId,
                        selectedImageUrl: previousSelected || hydrated?.selectedImageUrl || '',
                    }) || performer;
                }
            }
        } catch { }
        const selected = toAbsoluteTpdbUrl(performer?.selectedImageUrl || '');
        let combined = [...getTpdbPerformerImageCandidates(performer)];
        if (canonicalPerformer) combined.push(...getTpdbPerformerImageCandidates(canonicalPerformer));
        const stashCandidates = await resolveStashPerformerImageCandidates(performer).catch(() => []);
        if (Array.isArray(stashCandidates) && stashCandidates.length > 0) {
            combined.push(...stashCandidates);
        }
        if (performer?.name) {
            try {
                const variants = await resolveTpdbPerformersByNameVariants(performer.name);
                for (const variant of variants) combined.push(...getTpdbPerformerImageCandidates(variant));
            } catch { }
            try {
                const nameKey = normalizePersonKey(performer.name);
                if (nameKey) {
                    for (const p of tpdbPerformerById.values()) {
                        if (normalizePersonKey(p?.name || '') === nameKey) {
                            combined.push(...getTpdbPerformerImageCandidates(p));
                        }
                    }
                }
            } catch { }
        }
        const pagePosters = await scrapeTpdbPerformerPagePosterUrls(performer).catch(() => []);
        combined.push(...pagePosters);
        const seen = new Set();
        const selectedKey = canonicalizeImageUrl(selected);
        const images = combined
            .filter((u) => isAllowedPerformerImageUrl(u))
            .filter((u) => !isCroppedTpdbImageVariant(u))
            .filter((u) => {
                const key = canonicalizePerformerImageVisualKey(u) || canonicalizeImageUrl(u);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((a, b) => {
                const aKey = canonicalizeImageUrl(a);
                const bKey = canonicalizeImageUrl(b);
                const aSel = !!selectedKey && aKey === selectedKey;
                const bSel = !!selectedKey && bKey === selectedKey;
                if (aSel && !bSel) return -1;
                if (!aSel && bSel) return 1;
                return scorePerformerImageUrl(b) - scorePerformerImageUrl(a);
            })
            .slice(0, 200)
            .map((u) => ({
                url: u,
                source: detectPerformerImageSource(u),
                selected: !!selectedKey && canonicalizeImageUrl(u) === selectedKey,
            }));
        const groups = { stashdb: [], tpdb: [], other: [] };
        for (const item of images) {
            const source = String(item?.source || 'other');
            if (!groups[source]) groups[source] = [];
            groups[source].push(item);
        }
        addRuntimeLog('info', 'tpdb', 'TPDB performer images prepared', {
            performerId,
            totalCandidates: combined.length,
            totalImages: images.length,
            sources: {
                stashdb: Number(groups?.stashdb?.length || 0),
                tpdb: Number(groups?.tpdb?.length || 0),
                other: Number(groups?.other?.length || 0),
            },
        });
        return res.json({
            performerId,
            selectedImageUrl: selected,
            images,
            groups,
        });
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to load performer images' });
    }
});

app.post('/api/tpdb/performers/:id/image', async (req, res) => {
    try {
        const performerId = String(req.params.id || '').trim();
        const imageUrl = toAbsoluteTpdbUrl(req.body?.imageUrl || '');
        const imageData = String(req.body?.imageData || '').trim();
        if (!performerId) return res.status(400).json({ error: 'Missing performer id' });
        let performer = tpdbPerformerById.get(performerId) || null;
        if (!performer) return res.status(404).json({ error: 'Performer not found' });
        if (!imageUrl && !imageData) return res.status(400).json({ error: 'Missing imageUrl or imageData' });

        if (imageData) {
            const outPath = getTpdbPerformerImagePath(performerId);
            const base64 = imageData.replace(/^data:image\/[\w+.-]+;base64,/, '');
            const buffer = Buffer.from(base64, 'base64');
            if (!buffer || buffer.length < 32) {
                return res.status(400).json({ error: 'Invalid imageData' });
            }
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, buffer);
            performer = setTpdbPerformer({
                ...performer,
                selectedImageUrl: `local:${Date.now()}`,
                raw: performer?.raw || {},
            });
            addRuntimeLog('info', 'tpdb', 'TPDB performer image uploaded', { performerId });
            return res.json({
                ok: true,
                performerId,
                selectedImageUrl: String(performer?.selectedImageUrl || ''),
                imageUrl: `/api/tpdb/performers/${encodeURIComponent(performerId)}/image?v=${Number(performer?.updatedAt || Date.now())}`,
            });
        }

        const imageKey = canonicalizeImageUrl(imageUrl);
        if (!imageKey || !isAllowedPerformerImageUrl(imageUrl)) {
            return res.status(400).json({ error: 'Unsupported image URL' });
        }
        performer = setTpdbPerformer({ ...performer, selectedImageUrl: imageUrl, raw: performer?.raw || {} });
        await ensureTpdbPerformerImageById(performerId).catch(() => '');
        addRuntimeLog('info', 'tpdb', 'TPDB performer image selected', {
            performerId,
            selectedImageUrl: imageUrl,
        });
        return res.json({
            ok: true,
            performerId,
            selectedImageUrl: imageUrl,
            imageUrl: `/api/tpdb/performers/${encodeURIComponent(performerId)}/image?v=${Number(performer?.updatedAt || Date.now())}`,
        });
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to set performer image' });
    }
});

app.get('/api/tpdb/performers/:id/image', async (req, res) => {
    try {
        const performerId = String(req.params.id || '').trim();
        if (!performerId) return res.status(400).json({ error: 'Missing performer id' });
        let performer = tpdbPerformerById.get(performerId) || null;
        if (!performer) return res.status(404).json({ error: 'Performer not found' });
        if (!String(performer?.imageUrl || performer?.faceUrl || '').trim()) {
            try {
                let hydrated = null;
                if (performerId.startsWith('name:')) hydrated = await resolveTpdbPerformerByName(performer?.name || '');
                else hydrated = await resolveTpdbPerformerById(performerId);
                if (hydrated) performer = setTpdbPerformer(hydrated);
            } catch { }
        }
        const imagePath = await ensureTpdbPerformerImageById(performerId);
        if (imagePath && hasValidThumbFile(imagePath)) {
            res.setHeader('Cache-Control', 'no-store');
            return res.sendFile(imagePath);
        }
        const fallbackRemote = getTpdbPerformerImageCandidates(performer)[0] || '';
        if (fallbackRemote) return res.redirect(fallbackRemote);
        return res.status(404).json({ error: 'Performer image not available' });
    } catch (err) {
        return res.status(500).json({ error: err?.message || 'Failed to load performer image' });
    }
});

app.get('/api/libraries/:id/performers', async (req, res) => {
    try {
        const videos = getLibraryVideosByLibraryId(req.params.id);
        const byId = new Map();
        for (const video of videos || []) {
            const key = normalizeVideoPathKey(video?.filePath || '');
            if (!key) continue;
            let refs = tpdbVideoPerformersByKey.get(key) || [];
            if (refs.length === 0) {
                const meta = tpdbVideoMetaByKey.get(key);
                const rawPerformers = Array.isArray(meta?.raw?.performers) ? meta.raw.performers : [];
                if (rawPerformers.length > 0) {
                    refs = setTpdbVideoPerformers(video.filePath, rawPerformers) || [];
                }
            }
            for (const ref of refs) {
                const pid = String(ref?.id || '').trim();
                if (!pid) continue;
                if (!byId.has(pid)) {
                    const perfMeta = tpdbPerformerById.get(pid) || {};
                    byId.set(pid, {
                        id: pid,
                        name: String(ref?.name || perfMeta?.name || '').trim(),
                        imageUrl: '',
                        nationality: String(perfMeta?.nationality || '').trim(),
                        birthplace: String(perfMeta?.birthplace || '').trim(),
                        birthdate: String(perfMeta?.birthdate || '').trim(),
                        gender: String(perfMeta?.gender || '').trim(),
                        videoCount: 0,
                    });
                }
                byId.get(pid).videoCount += 1;
            }
        }

        const missingDetailIds = [...byId.keys()].filter((pid) => {
            const meta = tpdbPerformerById.get(pid);
            const missingImage = !String(meta?.imageUrl || meta?.faceUrl || '').trim();
            const missingOrigin = !String(meta?.birthplace || meta?.nationality || '').trim();
            const missingCore = !String(meta?.birthdate || '').trim() || !String(meta?.gender || '').trim();
            const rawMeta = meta?.raw && typeof meta.raw === 'object' ? meta.raw : {};
            const hasExtended = (
                Number(rawMeta?.career_start_year || rawMeta?.careerStartYear || 0) > 0 ||
                Number(rawMeta?.career_end_year || rawMeta?.careerEndYear || 0) > 0 ||
                Number(rawMeta?.height || rawMeta?.height_cm || rawMeta?.heightCm || 0) > 0 ||
                String(rawMeta?.band_size || rawMeta?.bandSize || '').trim() !== '' ||
                String(rawMeta?.cup_size || rawMeta?.cupSize || '').trim() !== '' ||
                Number(rawMeta?.waist_size || rawMeta?.waistSize || 0) > 0 ||
                Number(rawMeta?.hip_size || rawMeta?.hipSize || 0) > 0 ||
                String(rawMeta?.ethnicity || rawMeta?.ethnic || '').trim() !== '' ||
                String(rawMeta?.eye_color || rawMeta?.eyeColor || '').trim() !== '' ||
                String(rawMeta?.hair_color || rawMeta?.hairColor || '').trim() !== '' ||
                String(formatBodyModsValue(rawMeta?.tattoos || '')) !== '' ||
                String(formatBodyModsValue(rawMeta?.piercings || '')) !== '' ||
                (Array.isArray(rawMeta?.aliases) && rawMeta.aliases.length > 0)
            );
            return missingImage || missingOrigin || missingCore || !hasExtended;
        });
        if (missingDetailIds.length > 0) {
            const toHydrate = missingDetailIds.slice(0, 60);
            await Promise.allSettled(toHydrate.map(async (pid) => {
                const current = tpdbPerformerById.get(pid) || {};
                const hydrated = await hydratePerformerMetadataByPriority(pid, current).catch(() => null);
                if (hydrated) setTpdbPerformer(hydrated);
            }));
        }

        // Always attach performer image/meta fields for grid rendering,
        // even when no hydration pass was required.
        for (const [pid, row] of byId.entries()) {
            const perfMeta = tpdbPerformerById.get(pid) || {};
            row.imageUrl = `/api/tpdb/performers/${encodeURIComponent(pid)}/image?v=${Number(perfMeta?.updatedAt || Date.now())}`;
            row.nationality = String(perfMeta?.nationality || row.nationality || '').trim();
            row.birthplace = String(perfMeta?.birthplace || row.birthplace || '').trim();
            row.birthdate = String(perfMeta?.birthdate || row.birthdate || '').trim();
            row.gender = String(perfMeta?.gender || row.gender || '').trim();
        }

        const list = [...byId.values()]
            .filter((p) => !!p.id && !!p.name)
            .sort((a, b) => a.name.localeCompare(b.name));
        addRuntimeLog('info', 'tpdb', 'TPDB performers list loaded', {
            libraryId: String(req.params.id || ''),
            total: list.length,
        });
        return res.json({ performers: list, total: list.length });
    } catch (err) {
        addRuntimeLog('error', 'tpdb', 'TPDB performers list failed', {
            libraryId: String(req.params.id || ''),
            error: String(err?.message || err || ''),
        });
        return res.status(500).json({ error: err?.message || 'Failed to load performers' });
    }
});

app.get('/api/libraries/:id/performers/:performerId', async (req, res) => {
    try {
        const targetLang = normalizeUiLanguage(req.query?.lang || loadSettings()?.language || 'en');
        const performerId = String(req.params.performerId || '').trim();
        if (!performerId) return res.status(400).json({ error: 'Missing performerId' });
        let perfMeta = tpdbPerformerById.get(performerId);
        if (!perfMeta) return res.status(404).json({ error: 'Performer not found' });
        const hydrateRawMeta = perfMeta?.raw && typeof perfMeta.raw === 'object' ? perfMeta.raw : {};
        const hasExtendedStashMeta = (
            Number(hydrateRawMeta?.career_start_year || hydrateRawMeta?.careerStartYear || 0) > 0 ||
            Number(hydrateRawMeta?.career_end_year || hydrateRawMeta?.careerEndYear || 0) > 0 ||
            Number(hydrateRawMeta?.height || hydrateRawMeta?.height_cm || hydrateRawMeta?.heightCm || 0) > 0 ||
            String(hydrateRawMeta?.band_size || hydrateRawMeta?.bandSize || '').trim() !== '' ||
            String(hydrateRawMeta?.cup_size || hydrateRawMeta?.cupSize || '').trim() !== '' ||
            String(hydrateRawMeta?.ethnicity || hydrateRawMeta?.ethnic || '').trim() !== '' ||
            String(hydrateRawMeta?.eye_color || hydrateRawMeta?.eyeColor || '').trim() !== '' ||
            String(hydrateRawMeta?.hair_color || hydrateRawMeta?.hairColor || '').trim() !== '' ||
            String(hydrateRawMeta?.tattoos || '').trim() !== '' ||
            String(hydrateRawMeta?.piercings || '').trim() !== '' ||
            (Array.isArray(hydrateRawMeta?.aliases) && hydrateRawMeta.aliases.length > 0)
        );
        const shouldHydrate =
            !String(perfMeta?.imageUrl || '').trim() ||
            !String(perfMeta?.birthdate || '').trim() ||
            !String(perfMeta?.birthplace || '').trim() ||
            !String(perfMeta?.nationality || '').trim() ||
            !String(perfMeta?.gender || '').trim() ||
            !hasExtendedStashMeta;
        if (shouldHydrate) {
            try {
                const hydrated = await hydratePerformerMetadataByPriority(performerId, perfMeta).catch(() => null);
                if (hydrated) {
                    perfMeta = setTpdbPerformer(hydrated);
                }
            } catch { }
        }

        const computedAge = (() => {
            const explicit = Number(perfMeta?.age || perfMeta?.raw?.age || 0);
            if (Number.isFinite(explicit) && explicit > 0) return explicit;
            const d = String(perfMeta?.birthdate || '').trim();
            if (!d) return 0;
            const dt = new Date(d);
            if (!Number.isFinite(dt.getTime())) return 0;
            const now = new Date();
            let age = now.getFullYear() - dt.getFullYear();
            const m = now.getMonth() - dt.getMonth();
            if (m < 0 || (m === 0 && now.getDate() < dt.getDate())) age -= 1;
            return age > 0 ? age : 0;
        })();

        const rawMeta = perfMeta?.raw && typeof perfMeta.raw === 'object' ? perfMeta.raw : {};
        const toNum = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : 0;
        };
        const pick = (...vals) => {
            for (const val of vals) {
                const s = String(val ?? '').trim();
                if (s) return s;
            }
            return '';
        };
        const careerStartYear = toNum(rawMeta?.career_start_year || rawMeta?.careerStartYear || 0);
        const careerEndYear = toNum(rawMeta?.career_end_year || rawMeta?.careerEndYear || 0);
        const heightCm = toNum(rawMeta?.height || rawMeta?.height_cm || rawMeta?.heightCm || 0);
        const bandSize = pick(rawMeta?.band_size, rawMeta?.bandSize);
        const cupSize = pick(rawMeta?.cup_size, rawMeta?.cupSize);
        const waistSize = toNum(rawMeta?.waist_size || rawMeta?.waistSize || 0);
        const hipSize = toNum(rawMeta?.hip_size || rawMeta?.hipSize || 0);
        const computedMeasurements = (() => {
            const bust = `${bandSize}${cupSize}`.trim();
            if (!bust && !waistSize && !hipSize) return '';
            const parts = [];
            if (bust) parts.push(bust);
            if (waistSize > 0) parts.push(String(waistSize));
            if (hipSize > 0) parts.push(String(hipSize));
            return parts.join('-');
        })();
        const measurements = pick(rawMeta?.measurements, rawMeta?.measurement, computedMeasurements);
        const aliases = Array.isArray(rawMeta?.aliases)
            ? rawMeta.aliases.map((v) => String(v || '').trim()).filter(Boolean)
            : [];
        const tattoosText = formatBodyModsValue(rawMeta?.tattoos || perfMeta?.tattoos || '');
        const piercingsText = formatBodyModsValue(rawMeta?.piercings || perfMeta?.piercings || '');

        const videos = getLibraryVideosByLibraryId(req.params.id)
            .filter((video) => {
                const key = normalizeVideoPathKey(video?.filePath || '');
                const refs = tpdbVideoPerformersByKey.get(key) || [];
                return refs.some((ref) => String(ref?.id || '') === performerId);
            })
            .map((v) => ({
                id: v.id,
                title: v.title,
                fileName: v.fileName,
                extension: v.extension,
                size: v.size,
                modifiedAt: v.modifiedAt,
                hasFunscript: v.hasFunscript,
                durationSec: Number(v.durationSec || 0),
                filePath: v.filePath,
                hasAudio: typeof v.hasAudio === 'boolean'
                    ? v.hasAudio
                    : getIndexedHasAudio(v.filePath, Number(v.size || 0), Number(v.modifiedAt || 0)),
                libraryType: v.libraryType || 'videos',
                libraryId: String(v.libraryId || req.params.id || ''),
                isVr: !!v.isVr,
                vrProjection: normalizeVrProjection(v.vrProjection),
                vrStereoMode: normalizeVrStereoMode(v.vrStereoMode),
                hasThumbnail: hasAnyThumbForPath(v.filePath),
                axes: v.axes || [],
                isMultiAxis: v.isMultiAxis || false,
                tags: Array.isArray(v.tags) ? v.tags : [],
                performers: Array.isArray(v.performers) ? v.performers : [],
                isFavorite: getVideoIsFavorite(v, getVideoFolderMetadata(v)),
                tpdbItemType: String(v.tpdbItemType || ''),
                tpdbItemId: String(v.tpdbItemId || ''),
                thumbVersion: getVideoThumbVersion(v.filePath, Number(v.modifiedAt || 0)),
            }))
            .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));

        const performerPayload = {
                id: perfMeta.id,
                name: perfMeta.name,
                imageUrl: `/api/tpdb/performers/${encodeURIComponent(String(perfMeta.id || performerId))}/image?v=${Number(perfMeta?.updatedAt || Date.now())}`,
                bio: perfMeta.bio || '',
                age: computedAge || 0,
                birthdate: perfMeta.birthdate || '',
                birthplace: perfMeta.birthplace || '',
                nationality: perfMeta.nationality || '',
                gender: perfMeta.gender || '',
                careerStartYear: careerStartYear || 0,
                careerEndYear: careerEndYear || 0,
                heightCm: heightCm || 0,
                measurements,
                bandSize: bandSize || '',
                cupSize: cupSize || '',
                waistSize: waistSize || 0,
                hipSize: hipSize || 0,
                breastType: pick(rawMeta?.breast_type, rawMeta?.breastType),
                ethnicity: pick(rawMeta?.ethnicity, rawMeta?.ethnic),
                eyeColor: pick(rawMeta?.eye_color, rawMeta?.eyeColor),
                hairColor: pick(rawMeta?.hair_color, rawMeta?.hairColor),
                tattoos: tattoosText,
                piercings: piercingsText,
                aliases,
        };

        performerPayload.gender = await translatePerformerValue('gender', performerPayload.gender, targetLang);
        performerPayload.breastType = await translatePerformerValue('breastType', performerPayload.breastType, targetLang);
        performerPayload.ethnicity = await translatePerformerValue('ethnicity', performerPayload.ethnicity, targetLang);
        performerPayload.eyeColor = await translatePerformerValue('eyeColor', performerPayload.eyeColor, targetLang);
        performerPayload.hairColor = await translatePerformerValue('hairColor', performerPayload.hairColor, targetLang);

        if (targetLang !== 'en') {
            performerPayload.birthplace = await translatePerformerValue('birthplace', performerPayload.birthplace, targetLang);
            performerPayload.nationality = await translatePerformerValue('nationality', performerPayload.nationality, targetLang);
            performerPayload.tattoos = await translatePerformerValue('tattoos', performerPayload.tattoos, targetLang);
            performerPayload.piercings = await translatePerformerValue('piercings', performerPayload.piercings, targetLang);
        }

        return res.json({
            performer: performerPayload,
            videos,
        });
    } catch (err) {
        addRuntimeLog('error', 'tpdb', 'TPDB performer detail failed', {
            libraryId: String(req.params.id || ''),
            performerId: String(req.params.performerId || ''),
            error: String(err?.message || err || ''),
        });
        return res.status(500).json({ error: err?.message || 'Failed to load performer detail' });
    }
});

app.get('/api/settings', (req, res) => res.json(loadSettings()));

app.get('/api/system/backups', (req, res) => {
    try {
        res.json({
            backups: listDatabaseBackups(),
            dbPath: SQLITE_DB_PATH,
            backupDir: BACKUP_DIR,
            dataDir: DATA_DIR,
            operationRunning: backupOperationRunning === true,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/system/data-dir', (req, res) => {
    try {
        res.json({
            dataDir: DATA_DIR,
            defaultDataDir: DEFAULT_DATA_DIR,
            configPath: DATA_DIR_CONFIG_PATH,
            source: DATA_DIR_INFO.source,
            restartRequired: false,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/data-dir', (req, res) => {
    const requested = String(req.body?.dataDir || '').trim();
    if (!requested) return res.status(400).json({ error: 'Missing dataDir' });
    const migrateExisting = req.body?.migrateExisting !== false;
    try {
        const resolvedTarget = path.resolve(requested);
        if (!path.isAbsolute(resolvedTarget)) {
            return res.status(400).json({ error: 'dataDir must be an absolute path' });
        }
        if (!fs.existsSync(resolvedTarget)) fs.mkdirSync(resolvedTarget, { recursive: true });
        if (migrateExisting) migrateDataDirContents(resolvedTarget);
        saveDataDirConfig(resolvedTarget);
        addRuntimeLog('info', 'system', 'Data directory updated', {
            from: DATA_DIR,
            to: resolvedTarget,
            migrated: migrateExisting,
            restartRequired: true,
        });
        res.json({
            success: true,
            dataDir: resolvedTarget,
            restartRequired: true,
            migrated: migrateExisting,
        });
    } catch (err) {
        addRuntimeLog('error', 'system', 'Data directory update failed', { error: err?.message || String(err) });
        res.status(500).json({ error: err.message || 'Failed to update data directory' });
    }
});

app.post('/api/system/backups/create', (req, res) => {
    try {
        const backup = createDatabaseBackup('glyph-backup');
        res.json({ success: true, backup });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/backups/restore', (req, res) => {
    const fileName = String(req.body?.fileName || '').trim();
    if (!fileName) return res.status(400).json({ error: 'Missing backup file name' });
    try {
        const result = restoreDatabaseBackup(fileName);
        scheduleFullRescan('backup-restore', 300);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/system/backups/:fileName', (req, res) => {
    const safeName = path.basename(String(req.params.fileName || '').trim());
    if (!safeName || !/\.db$/i.test(safeName)) return res.status(400).json({ error: 'Invalid backup file name' });
    const filePath = path.join(BACKUP_DIR, safeName);
    try {
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Backup not found' });
        fs.rmSync(filePath, { force: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/watch-progress', (req, res) => {
    const limit = Number(req.query.limit || 20);
    res.json(listWatchProgress(limit));
});

app.post('/api/watch-progress', (req, res) => {
    const { videoId, positionSec, durationSec } = req.body || {};
    const id = String(videoId || '').trim();
    const pos = Number(positionSec || 0);
    const dur = Number(durationSec || 0);
    if (!id) return res.status(400).json({ error: 'videoId is required' });
    if (!Number.isFinite(pos) || pos <= 0) return res.status(400).json({ error: 'positionSec must be > 0' });
    if (!isContinueTrackingEnabledForVideoId(id)) {
        removeWatchProgress(id);
        return res.json({ ok: true, skipped: true, reason: 'library-tracking-disabled' });
    }
    upsertWatchProgress(id, pos, dur);
    return res.json({ ok: true });
});

app.delete('/api/watch-progress/:videoId', (req, res) => {
    removeWatchProgress(req.params.videoId);
    return res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
    const updated = { ...loadSettings(), ...req.body };
    saveSettings(updated);
    ensureAutoBackupTimer();
    runAutoBackupIfDue(false);
    refreshLibraryWatchers();
    res.json(updated);
});

app.post('/api/libraries', async (req, res) => {
    const { name, path: libPath, type } = req.body;
    const normalizedType = ['videos', 'series', 'vr'].includes(String(type || '').toLowerCase())
        ? String(type).toLowerCase()
        : 'videos';
    const settings = loadSettings();
    const newLib = { id: uuidv4(), name, path: libPath, type: normalizedType, showRecentAdded: true, trackContinueWatching: true };
    settings.libraries.push(newLib);
    saveSettings(settings);
    scheduleFullRescan('library-added', 120);
    res.json(newLib);
});

app.delete('/api/libraries/:id', async (req, res) => {
    const settings = loadSettings();
    const removeId = String(req.params.id || '');
    const removedLibrary = (settings.libraries || []).find(l => String(l.id) === removeId) || null;
    const cleanupGenerated = String(req.query.cleanupGenerated || req.body?.cleanupGenerated || '').toLowerCase();
    const shouldCleanupGenerated = cleanupGenerated === '1' || cleanupGenerated === 'true' || cleanupGenerated === 'yes';

    settings.libraries = settings.libraries.filter(l => String(l.id) !== removeId);
    saveSettings(settings);
    let cleanupStats = null;
    let metadataCleanupStats = null;
    if (removedLibrary) {
        metadataCleanupStats = cleanupFetchedMetadataForLibrary(removedLibrary, settings.libraries || []);
    }
    if (shouldCleanupGenerated && removedLibrary) {
        cleanupStats = cleanupGeneratedArtifactsForLibrary(removedLibrary, settings.libraries || []);
    }
    delete libraryCache[removeId];
    scheduleFullRescan('library-removed', 120);
    res.json({
        success: true,
        cleanupGenerated: shouldCleanupGenerated,
        cleanupStats,
        metadataCleanupStats,
    });
});

app.post('/api/scan', async (req, res) => {
    await scanAllLibraries();
    const total = Object.values(libraryCache).reduce((sum, c) => sum + c.videos.length, 0);
    res.json({ count: total });
});

// ── TheHandy – funscript upload proxy (avoids CORS from renderer) ──
app.post('/api/handy/upload-script', async (req, res) => {
    try {
        const funscriptJson = req.body?.script;
        if (!funscriptJson || !Array.isArray(funscriptJson.actions)) {
            return res.status(400).json({ error: 'Invalid funscript JSON (missing actions array)' });
        }

        const https = require('https');
        const url = 'https://www.handyfeeling.com/api/sync/upload';
        const boundary = `----GlyphBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const uploadName = `glyph-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}.funscript`;
        const scriptContent = JSON.stringify(funscriptJson);
        const multipartBody =
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="syncFile"; filename="${uploadName}"\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            `${scriptContent}\r\n` +
            `--${boundary}--\r\n`;
        const payload = Buffer.from(multipartBody, 'utf8');

        const result = await new Promise((resolve, reject) => {
            const reqOpts = {
                method: 'POST',
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'Content-Length': payload.length,
                    'Accept': 'application/json',
                },
            };

            const httpReq = https.request(url, reqOpts, (httpRes) => {
                let body = '';
                httpRes.on('data', (chunk) => { body += chunk; });
                httpRes.on('end', () => {
                    try {
                        const data = JSON.parse(body);
                        resolve(data);
                    } catch {
                        reject(new Error(`Handy upload returned non-JSON: ${body.slice(0, 500)}`));
                    }
                });
            });

            httpReq.on('error', reject);
            httpReq.write(payload);
            httpReq.end();
        });

        const scriptUrl = String(result?.url || result?.scriptUrl || result?.downloadUrl || '').trim();
        if (!scriptUrl) {
            return res.status(502).json({ error: 'Handy upload did not return a URL', detail: result });
        }

        addRuntimeLog('info', 'handy', 'Funscript uploaded to Handy servers', { ok: true });
        res.json({ url: scriptUrl });
    } catch (err) {
        console.error('[Handy] Upload proxy error:', err);
        addRuntimeLog('error', 'handy', 'Funscript upload failed', { error: err?.message || String(err) });
        res.status(500).json({ error: err.message || 'Upload failed' });
    }
});

purgeLegacyJsonFiles();
writeThemeCache(loadSettings().theme);
// scanAllLibraries removed from here to prevent blocking startup

const startServer = () => {
    const server = app.listen(PORT, () => {
        console.log(`Glyph server running on http://localhost:${PORT}`);
        const lanIps = getNetworkIpCandidates();
        if (lanIps.length > 0) {
            lanIps.forEach(ip => console.log(`  Network: http://${ip}:${PORT}`));
        }
        // Scan after server is listening so UI loads immediately
        scanAllLibraries();
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${PORT} already in use, assuming another server instance is running. Exiting child process.`);
            try { server.close(); } catch { }
            process.exit(0);
        } else {
            console.error('Server error:', err);
        }
    });
};

startServer();

module.exports = app;
