const HOTKEYS_STORAGE_KEY = 'glyph_settings';

export const DEFAULT_HOTKEYS = {
    goHome: { code: 'Digit1', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    goPlaylists: { code: 'Digit3', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    goBack: { code: 'KeyB', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    toggleDevicePanel: { code: 'KeyD', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    openSettings: { code: 'Comma', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    openDashboard: { code: 'KeyG', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    openTagManager: { code: 'KeyT', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    openFunscriptManager: { code: 'KeyF', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
    openPlaylistManager: { code: 'KeyP', ctrl: false, alt: true, shift: false, meta: false, enabled: true },
};

const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const normalizeBinding = (binding, fallback) => {
    const source = isPlainObject(binding) ? binding : {};
    const fb = isPlainObject(fallback) ? fallback : {};
    const code = String(source.code || fb.code || '').trim();
    if (!code) return null;
    return {
        code,
        ctrl: Boolean(source.ctrl),
        alt: Boolean(source.alt),
        shift: Boolean(source.shift),
        meta: Boolean(source.meta),
        enabled: source.enabled === false ? false : true,
    };
};

export function normalizeHotkeys(candidate) {
    const src = isPlainObject(candidate) ? candidate : {};
    const out = {};
    for (const key of Object.keys(DEFAULT_HOTKEYS)) {
        out[key] = normalizeBinding(src[key], DEFAULT_HOTKEYS[key]) || DEFAULT_HOTKEYS[key];
    }
    return out;
}

export function getHotkeys() {
    try {
        const raw = window?.localStorage?.getItem(HOTKEYS_STORAGE_KEY) || '{}';
        const parsed = JSON.parse(raw);
        return normalizeHotkeys(parsed?.hotkeys);
    } catch {
        return normalizeHotkeys(null);
    }
}

export function hotkeyId(binding) {
    if (!binding || !binding.code || binding.enabled === false) return '';
    return [
        binding.ctrl ? '1' : '0',
        binding.alt ? '1' : '0',
        binding.shift ? '1' : '0',
        binding.meta ? '1' : '0',
        binding.code,
    ].join(':');
}

export function eventToBinding(event) {
    const code = String(event?.code || '').trim();
    if (!code) return null;
    if (code === 'ShiftLeft' || code === 'ShiftRight' || code === 'ControlLeft' || code === 'ControlRight' || code === 'AltLeft' || code === 'AltRight' || code === 'MetaLeft' || code === 'MetaRight') return null;
    return {
        code,
        ctrl: Boolean(event?.ctrlKey),
        alt: Boolean(event?.altKey),
        shift: Boolean(event?.shiftKey),
        meta: Boolean(event?.metaKey),
    };
}

export function eventMatchesHotkey(event, binding) {
    if (!event || !binding || !binding.code || binding.enabled === false) return false;
    return String(event.code || '') === String(binding.code)
        && Boolean(event.ctrlKey) === Boolean(binding.ctrl)
        && Boolean(event.altKey) === Boolean(binding.alt)
        && Boolean(event.shiftKey) === Boolean(binding.shift)
        && Boolean(event.metaKey) === Boolean(binding.meta);
}

const codeLabel = (code) => {
    if (!code) return '';
    if (code === 'Space') return 'Space';
    if (code.startsWith('Key')) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
    return code;
};

export function hotkeyToLabel(binding) {
    if (!binding || !binding.code) return '-';
    const parts = [];
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.alt) parts.push('Alt');
    if (binding.shift) parts.push('Shift');
    if (binding.meta) parts.push('Meta');
    parts.push(codeLabel(binding.code));
    return parts.join(' + ');
}
