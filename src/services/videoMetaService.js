const MAX_FUNSCRIPT_CACHE = 2000;
const MAX_DETAILS_CACHE = 2000;
const MAX_FUNSCRIPT_CONCURRENCY = 4;
const MAX_DETAILS_CONCURRENCY = 4;

function createLruMap(limit) {
    const map = new Map();
    return {
        get(key) {
            if (!map.has(key)) return undefined;
            const value = map.get(key);
            map.delete(key);
            map.set(key, value);
            return value;
        },
        set(key, value) {
            if (map.has(key)) map.delete(key);
            map.set(key, value);
            if (map.size > limit) {
                const first = map.keys().next();
                if (!first.done) map.delete(first.value);
            }
        },
    };
}

function createQueuedFetcher(maxConcurrent, worker) {
    const queue = [];
    let running = 0;
    let seq = 0;
    const ABORT_ERR = () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        return err;
    };

    const runNext = () => {
        if (running >= maxConcurrent) return;
        let next = null;
        if (queue.length > 0) {
            let bestIdx = 0;
            for (let i = 1; i < queue.length; i += 1) {
                const a = queue[i];
                const b = queue[bestIdx];
                if ((a.priority || 0) > (b.priority || 0)) {
                    bestIdx = i;
                } else if ((a.priority || 0) === (b.priority || 0) && (a.seq || 0) < (b.seq || 0)) {
                    bestIdx = i;
                }
            }
            next = queue.splice(bestIdx, 1)[0];
        }
        if (!next) return;
        if (next.signal?.aborted) {
            next.cleanup?.();
            next.reject(ABORT_ERR());
            setTimeout(runNext, 0);
            return;
        }
        running += 1;
        worker(next.key, next.signal)
            .then((value) => next.resolve(value))
            .catch((err) => next.reject(err))
            .finally(() => {
                next.cleanup?.();
                running = Math.max(0, running - 1);
                runNext();
            });
    };

    return (key, signal = null, priority = 0) => new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(ABORT_ERR());
            return;
        }
        const item = { key, signal, priority: Number(priority || 0), seq: seq++, resolve, reject, cleanup: null };
        if (signal) {
            const onAbort = () => {
                const idx = queue.indexOf(item);
                if (idx >= 0) {
                    queue.splice(idx, 1);
                    reject(ABORT_ERR());
                }
            };
            signal.addEventListener('abort', onAbort, { once: true });
            item.cleanup = () => {
                try { signal.removeEventListener('abort', onAbort); } catch { }
            };
        }
        queue.push(item);
        runNext();
    });
}

const funscriptCache = createLruMap(MAX_FUNSCRIPT_CACHE);
const funscriptInFlight = new Map();
const funscriptQueueFetch = createQueuedFetcher(MAX_FUNSCRIPT_CONCURRENCY, async (videoId, signal) => {
    const res = await fetch(`/api/videos/${videoId}/funscript`, signal ? { signal } : undefined);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const actions = Array.isArray(data?.actions) ? data.actions : null;
    return actions && actions.length > 1 ? actions : null;
});

export function fetchVideoFunscriptActions(videoId, options = {}) {
    const id = String(videoId || '').trim();
    const signal = options?.signal || null;
    const priority = Number(options?.priority || 0);
    if (!id) return Promise.resolve(null);
    const cached = funscriptCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!signal) {
        const inFlight = funscriptInFlight.get(id);
        if (inFlight) return inFlight;
    }
    const pending = funscriptQueueFetch(id, signal, priority)
        .then((actions) => {
            funscriptCache.set(id, actions || null);
            return actions || null;
        })
        .catch((err) => {
            if (err?.name === 'AbortError') throw err;
            return null;
        })
        .finally(() => {
            if (!signal) funscriptInFlight.delete(id);
        });
    if (!signal) funscriptInFlight.set(id, pending);
    return pending;
}

const detailsCache = createLruMap(MAX_DETAILS_CACHE);
const detailsInFlight = new Map();
const detailsQueueFetch = createQueuedFetcher(MAX_DETAILS_CONCURRENCY, async (videoId, signal) => {
    const res = await fetch(`/api/videos/${videoId}/details`, signal ? { signal } : undefined);
    if (!res.ok) return null;
    return res.json().catch(() => null);
});

export function fetchVideoDetails(videoId, options = {}) {
    const id = String(videoId || '').trim();
    const signal = options?.signal || null;
    const priority = Number(options?.priority || 0);
    if (!id) return Promise.resolve(null);
    const cached = detailsCache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!signal) {
        const inFlight = detailsInFlight.get(id);
        if (inFlight) return inFlight;
    }
    const pending = detailsQueueFetch(id, signal, priority)
        .then((details) => {
            detailsCache.set(id, details || null);
            return details || null;
        })
        .catch((err) => {
            if (err?.name === 'AbortError') throw err;
            return null;
        })
        .finally(() => {
            if (!signal) detailsInFlight.delete(id);
        });
    if (!signal) detailsInFlight.set(id, pending);
    return pending;
}
