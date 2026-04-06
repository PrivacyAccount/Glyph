function createRuntimeLogger(limit = 800) {
    const max = Math.max(100, Number(limit) || 800);
    const entries = [];
    let nextId = 1;

    function add(level, area, message, meta = null) {
        const entry = {
            id: nextId++,
            ts: Date.now(),
            level: String(level || 'info'),
            area: String(area || 'system'),
            message: String(message || ''),
            meta: meta || undefined,
        };
        entries.push(entry);
        if (entries.length > max) entries.shift();
        return entry;
    }

    function read({ limit: readLimit = 200, level = '', area = '', q = '' } = {}) {
        const n = Math.max(1, Math.min(1000, Number(readLimit) || 200));
        const lv = String(level || '').trim().toLowerCase();
        const ar = String(area || '').trim().toLowerCase();
        const qq = String(q || '').trim().toLowerCase();

        let out = entries;
        if (lv) out = out.filter(l => String(l.level).toLowerCase() === lv);
        if (ar) out = out.filter(l => String(l.area).toLowerCase() === ar);
        if (qq) {
            out = out.filter((l) => {
                const m = `${l.message || ''} ${l.meta ? JSON.stringify(l.meta) : ''}`.toLowerCase();
                return m.includes(qq);
            });
        }
        return out.slice(-n).reverse();
    }

    function clear() {
        entries.length = 0;
    }

    return { add, read, clear };
}

module.exports = { createRuntimeLogger };
