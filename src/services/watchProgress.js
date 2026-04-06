const SETTINGS_KEY = 'glyph_settings';
const PROGRESS_KEY = 'glyph_watch_progress_v1';
const PLAYBACK_META_KEY = 'glyph_playback_meta_v1';
const PROGRESS_CHANGED_EVENT = 'watch-progress-changed';
const SETTINGS_CHANGED_EVENT = 'glyph-settings-changed';
const MIN_PROGRESS_SECONDS = 1;
const COMPLETE_REMAINING_SECONDS = 15;
const MAX_PROGRESS_ITEMS = 100;
const MAX_META_ITEMS = 200;

function isBrowser() {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readJson(key, fallback = {}) {
    if (!isBrowser()) return fallback;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function writeJson(key, value) {
    if (!isBrowser()) return;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch { }
}

function normalizeVideoId(videoId) {
    if (videoId === null || videoId === undefined) return '';
    const id = String(videoId).trim();
    return id;
}

function clampSeconds(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return n;
}

function normalizeTagList(tags) {
    if (!Array.isArray(tags)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of tags) {
        const tag = String(raw || '').trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

function normalizeVideoMeta(video) {
    if (!video || typeof video !== 'object') return null;
    const id = normalizeVideoId(video.id);
    if (!id) return null;
    return {
        id,
        title: String(video.title || '').trim() || `Video ${id}`,
        filePath: String(video.filePath || video.path || '').trim(),
        tags: normalizeTagList(video.tags),
        performers: Array.isArray(video.performers) ? video.performers : [],
        size: Number(video.size || 0) || 0,
        modifiedAt: Number(video.modifiedAt || 0) || 0,
        hasThumbnail: !!video.hasThumbnail,
        hasFunscript: !!video.hasFunscript,
        isMultiAxis: !!video.isMultiAxis,
        axes: Array.isArray(video.axes) ? video.axes : [],
        extension: String(video.extension || '').trim(),
        libraryId: String(video.libraryId || '').trim(),
        libraryType: String(video.libraryType || '').trim(),
    };
}

function readProgressMap() {
    return readJson(PROGRESS_KEY, {});
}

function writeProgressMap(map) {
    writeJson(PROGRESS_KEY, map);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(PROGRESS_CHANGED_EVENT));
    }
}

async function postServerProgress({ videoId, positionSec, durationSec }) {
    if (typeof fetch !== 'function') return;
    try {
        await fetch('/api/watch-progress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ videoId, positionSec, durationSec }),
        });
    } catch { }
}

async function deleteServerProgress(videoId) {
    if (typeof fetch !== 'function') return;
    try {
        await fetch(`/api/watch-progress/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    } catch { }
}

function readPlaybackMetaMap() {
    return readJson(PLAYBACK_META_KEY, {});
}

function writePlaybackMetaMap(map) {
    writeJson(PLAYBACK_META_KEY, map);
}

function pruneByUpdatedAt(map, maxCount) {
    const entries = Object.entries(map || {});
    if (entries.length <= maxCount) return map;
    entries.sort((a, b) => (Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0)));
    return Object.fromEntries(entries.slice(0, maxCount));
}

function isCompleted(positionSec, durationSec) {
    if (durationSec <= 0) return false;
    const remaining = durationSec - positionSec;
    return remaining <= COMPLETE_REMAINING_SECONDS;
}

export function isContinueWatchingEnabled() {
    const settings = readJson(SETTINGS_KEY, {});
    return settings.continueWatching !== false;
}

export function setContinueWatchingEnabled(enabled) {
    if (!isBrowser()) return;
    const settings = readJson(SETTINGS_KEY, {});
    settings.continueWatching = !!enabled;
    writeJson(SETTINGS_KEY, settings);
    window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

export function rememberPlaybackVideo(video) {
    const meta = normalizeVideoMeta(video);
    if (!meta) return;
    const map = readPlaybackMetaMap();
    map[meta.id] = {
        ...meta,
        updatedAt: Date.now(),
    };
    writePlaybackMetaMap(pruneByUpdatedAt(map, MAX_META_ITEMS));
}

export function getRememberedPlaybackVideo(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) return null;
    const map = readPlaybackMetaMap();
    const value = map[id];
    return value && typeof value === 'object' ? value : null;
}

export function saveWatchProgress({ videoId, positionSec, durationSec, videoMeta = null }) {
    const id = normalizeVideoId(videoId);
    if (!id) return;

    const progressSec = clampSeconds(positionSec);
    const totalSec = clampSeconds(durationSec);

    const map = readProgressMap();
    if (progressSec < MIN_PROGRESS_SECONDS) {
        return;
    }
    if (isCompleted(progressSec, totalSec)) {
        if (map[id]) {
            delete map[id];
            writeProgressMap(map);
        }
        deleteServerProgress(id);
        return;
    }

    const rememberedMeta = getRememberedPlaybackVideo(id) || {};
    const incomingMeta = normalizeVideoMeta(videoMeta) || {};
    const prev = map[id] && typeof map[id] === 'object' ? map[id] : {};

    const next = {
        id,
        title: incomingMeta.title || rememberedMeta.title || prev.title || `Video ${id}`,
        filePath: incomingMeta.filePath || rememberedMeta.filePath || prev.filePath || '',
        tags: incomingMeta.tags || rememberedMeta.tags || prev.tags || [],
        performers: incomingMeta.performers || rememberedMeta.performers || prev.performers || [],
        size: incomingMeta.size || rememberedMeta.size || prev.size || 0,
        modifiedAt: incomingMeta.modifiedAt || rememberedMeta.modifiedAt || prev.modifiedAt || 0,
        hasThumbnail: incomingMeta.hasThumbnail ?? rememberedMeta.hasThumbnail ?? prev.hasThumbnail ?? false,
        hasFunscript: incomingMeta.hasFunscript ?? rememberedMeta.hasFunscript ?? prev.hasFunscript ?? false,
        isMultiAxis: incomingMeta.isMultiAxis ?? rememberedMeta.isMultiAxis ?? prev.isMultiAxis ?? false,
        axes: incomingMeta.axes || rememberedMeta.axes || prev.axes || [],
        extension: incomingMeta.extension || rememberedMeta.extension || prev.extension || '',
        libraryId: incomingMeta.libraryId || rememberedMeta.libraryId || prev.libraryId || '',
        libraryType: incomingMeta.libraryType || rememberedMeta.libraryType || prev.libraryType || '',
        lastPositionSec: progressSec,
        durationSec: totalSec || prev.durationSec || 0,
        updatedAt: Date.now(),
    };

    map[id] = next;
    writeProgressMap(pruneByUpdatedAt(map, MAX_PROGRESS_ITEMS));
    postServerProgress({ videoId: id, positionSec: progressSec, durationSec: totalSec });
}

export function clearWatchProgress(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) return;
    const map = readProgressMap();
    if (map[id]) {
        delete map[id];
        writeProgressMap(map);
    }
    deleteServerProgress(id);
}

export function restoreWatchProgress(entry) {
    if (!entry || typeof entry !== 'object') return;
    const id = normalizeVideoId(entry.id);
    if (!id) return;
    const positionSec = clampSeconds(entry.lastPositionSec ?? entry.positionSec ?? entry._resumeFromSec ?? 0);
    const durationSec = clampSeconds(entry.durationSec ?? entry._durationSec ?? 0);
    if (positionSec < MIN_PROGRESS_SECONDS) return;
    saveWatchProgress({
        videoId: id,
        positionSec,
        durationSec,
        videoMeta: {
            ...entry,
            id,
            title: entry.title || `Video ${id}`,
            filePath: entry.filePath || '',
            tags: normalizeTagList(entry.tags),
            libraryId: entry.libraryId || '',
            libraryType: entry.libraryType || '',
        },
    });
}

export function getResumePosition(videoId) {
    const id = normalizeVideoId(videoId);
    if (!id) return 0;
    const map = readProgressMap();
    const entry = map[id];
    const position = clampSeconds(entry?.lastPositionSec);
    return position >= MIN_PROGRESS_SECONDS ? position : 0;
}

export function getContinueWatchingList(limit = 20) {
    const n = Number(limit);
    const safeLimit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
    const map = readProgressMap();
    const fromProgress = Object.values(map)
        .filter((entry) => clampSeconds(entry?.lastPositionSec) >= MIN_PROGRESS_SECONDS)
        .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
        .slice(0, safeLimit);
    return fromProgress;
}

function applyAllowedLibraryFilter(items, allowedLibraryIds) {
    if (!allowedLibraryIds || allowedLibraryIds.size === 0) return items;
    return (items || []).filter((item) => {
        const libId = String(item?.libraryId || '').trim();
        if (!libId) return false;
        return allowedLibraryIds.has(libId);
    });
}

export async function fetchContinueWatchingList(limit = 20, options = {}) {
    const allowedLibraryIds = options?.allowedLibraryIds instanceof Set ? options.allowedLibraryIds : null;
    const localItems = applyAllowedLibraryFilter(getContinueWatchingList(limit), allowedLibraryIds);
    if (typeof fetch !== 'function') return localItems;
    const n = Number(limit);
    const safeLimit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
    try {
        const res = await fetch(`/api/watch-progress?limit=${safeLimit}`);
        if (!res.ok) return localItems;
        const data = await res.json();
        const serverItems = Array.isArray(data) ? data : [];
        if (serverItems.length === 0) return localItems;

        const mergedMap = new Map();
        for (const item of localItems) {
            const id = normalizeVideoId(item?.id);
            if (!id) continue;
            mergedMap.set(id, item);
        }
        for (const item of serverItems) {
            const id = normalizeVideoId(item?.id);
            if (!id) continue;
            const prev = mergedMap.get(id);
            if (!prev) {
                mergedMap.set(id, item);
                continue;
            }
            const prevPos = Number(prev?.lastPositionSec || 0);
            const nextPos = Number(item?.lastPositionSec || 0);
            if (nextPos > prevPos + 0.5) {
                mergedMap.set(id, item);
                continue;
            }
            if (prevPos > nextPos + 0.5) {
                continue;
            }
            const prevTs = Number(prev?.updatedAt || 0);
            const nextTs = Number(item?.updatedAt || 0);
            const preferred = nextTs >= prevTs ? item : prev;
            const fallback = preferred === item ? prev : item;
            const preferredTags = normalizeTagList(preferred?.tags);
            const fallbackTags = normalizeTagList(fallback?.tags);
            const mergedTags = preferredTags.length > 0 ? preferredTags : fallbackTags;
            const preferredPerformers = Array.isArray(preferred?.performers) ? preferred.performers : [];
            const fallbackPerformers = Array.isArray(fallback?.performers) ? fallback.performers : [];
            const mergedPerformers = preferredPerformers.length > 0 ? preferredPerformers : fallbackPerformers;
            mergedMap.set(id, { ...preferred, tags: mergedTags, performers: mergedPerformers });
        }

        const merged = Array.from(mergedMap.values())
            .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
            .slice(0, safeLimit);
        return applyAllowedLibraryFilter(merged, allowedLibraryIds);
    } catch {
        return localItems;
    }
}

export const watchProgressEvents = {
    changed: PROGRESS_CHANGED_EVENT,
    settingsChanged: SETTINGS_CHANGED_EVENT,
};
