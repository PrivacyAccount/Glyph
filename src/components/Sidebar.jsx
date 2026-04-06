import React, { useMemo, useState, useEffect } from 'react';
import { useI18n } from '../i18n';

const SIDEBAR_CONFIG_KEY = 'glyph_sidebar_config';
const DEFAULT_SIDEBAR_GROUPS = {
    favorites: true,
    funscript: true,
    audio: true,
    format: true,
    vrProjection: true,
    vrStereo: true,
    tags: true,
};

export const getSidebarConfig = () => {
    try {
        const raw = localStorage.getItem(SIDEBAR_CONFIG_KEY);
        if (!raw) return { ...DEFAULT_SIDEBAR_GROUPS };
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_SIDEBAR_GROUPS, ...parsed };
    } catch { return { ...DEFAULT_SIDEBAR_GROUPS }; }
};

export const saveSidebarConfig = (config) => {
    try { localStorage.setItem(SIDEBAR_CONFIG_KEY, JSON.stringify(config)); } catch { }
};

function Sidebar({
    filters,
    onFilterChange,
    extensions,
    tags = [],
    selectedTagFilters = [],
    onTagFilterToggle = () => { },
    onTagFilterClear = () => { },
    tagFilterMode = 'or',
    onTagFilterModeChange = () => { },
    isVrLibrary = false,
}) {
    const { t } = useI18n();
    const [sidebarConfig, setSidebarConfig] = useState(getSidebarConfig);

    useEffect(() => {
        const onChanged = () => setSidebarConfig(getSidebarConfig());
        window.addEventListener('glyph-sidebar-config-changed', onChanged);
        return () => window.removeEventListener('glyph-sidebar-config-changed', onChanged);
    }, []);
    const selectedSet = useMemo(() => new Set((selectedTagFilters || []).map((v) => String(v))), [selectedTagFilters]);
    const tagEntries = useMemo(() => (
        (tags || []).map((tag) => {
            if (typeof tag === 'string') return { name: tag, count: null, category: '' };
            return {
                name: String(tag?.name || ''),
                count: Number.isFinite(tag?.count) ? tag.count : null,
                category: String(tag?.category || '').trim(),
            };
        }).filter((tag) => tag.name)
    ), [tags]);
    const groupedTagEntries = useMemo(() => {
        const byCategory = new Map();
        for (const tag of tagEntries) {
            const category = String(tag.category || '').trim();
            const key = category || '__uncategorized__';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key).push(tag);
        }
        const groups = [...byCategory.entries()].map(([key, values]) => ({
            key,
            label: key === '__uncategorized__' ? t('uncategorized', 'Uncategorized') : key,
            tags: [...values].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        groups.sort((a, b) => {
            if (a.key === '__uncategorized__') return 1;
            if (b.key === '__uncategorized__') return -1;
            return a.label.localeCompare(b.label);
        });
        return groups;
    }, [tagEntries, t]);

    const applyFunscript = (nextFunscript) => {
        const value = String(nextFunscript || '');
        const next = { ...filters, funscript: value };
        // Multi-Axis implies funscript. Remove conflicting state.
        if ((value === 'no' || value === '') && String(filters?.multiaxis || '') === 'yes') {
            next.multiaxis = '';
        }
        onFilterChange(next);
    };

    const toggleMultiAxis = () => {
        const enabled = String(filters?.multiaxis || '') === 'yes';
        if (enabled) {
            onFilterChange({ ...filters, multiaxis: '' });
            return;
        }
        // Enabling multi-axis should enforce "with funscript"
        onFilterChange({ ...filters, multiaxis: 'yes', funscript: 'yes' });
    };

    return (
        <aside className="sidebar media-sidebar">
            <div className="sidebar-section">
                <h3 className="sidebar-heading">{t('sorting', 'Sortierung')}</h3>
                <div className="sidebar-options">
                    {[
                        { value: 'name', label: t('nameAZ', 'Name A-Z') },
                        { value: 'date', label: t('newestFirst', 'Erstellungsdatum') },
                        { value: 'size', label: t('size', 'GrÃ¶ÃŸe') },
                        { value: 'duration', label: t('duration', 'Dauer') },
                    ].map(opt => (
                        <button
                            key={opt.value}
                            className={`sidebar-option ${filters.sort === opt.value ? 'active' : ''}`}
                            onClick={() => onFilterChange({ ...filters, sort: opt.value })}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="sidebar-section">
                <h3 className="sidebar-heading">{t('orderLabel', 'Order')}</h3>
                <div className="sidebar-options">
                    <button
                        className={`sidebar-option ${(filters.sortOrder || 'asc') === 'asc' ? 'active' : ''}`}
                        onClick={() => onFilterChange({ ...filters, sortOrder: 'asc' })}
                    >
                        {t('sortAscending', 'Ascending')}
                    </button>
                    <button
                        className={`sidebar-option ${(filters.sortOrder || 'asc') === 'desc' ? 'active' : ''}`}
                        onClick={() => onFilterChange({ ...filters, sortOrder: 'desc' })}
                    >
                        {t('sortDescending', 'Descending')}
                    </button>
                </div>
            </div>

            {sidebarConfig.favorites && (
            <div className="sidebar-section">
                <h3 className="sidebar-heading">{t('favorites', 'Favoriten')}</h3>
                <div className="sidebar-options">
                    <button
                        className={`sidebar-option ${(filters.favorite || '') === '' ? 'active' : ''}`}
                        onClick={() => onFilterChange({ ...filters, favorite: '' })}
                    >
                        {t('all', 'Alle')}
                    </button>
                    <button
                        className={`sidebar-option ${(filters.favorite || '') === 'yes' ? 'active' : ''}`}
                        onClick={() => onFilterChange({ ...filters, favorite: 'yes' })}
                    >
                        {t('onlyFavorites', 'Nur Favoriten')}
                    </button>
                </div>
            </div>
            )}

            {sidebarConfig.funscript && (
            <div className="sidebar-section">
                <h3 className="sidebar-heading">Funscript</h3>
                <div className="sidebar-options">
                    {[
                        { value: '', label: t('all', 'Alle') },
                        { value: 'yes', label: t('withFunscript', 'Mit Funscript') },
                        { value: 'no', label: t('withoutFunscript', 'Ohne Funscript') },
                    ].map(opt => (
                        <button
                            key={opt.value}
                            className={`sidebar-option ${filters.funscript === opt.value ? 'active' : ''}`}
                            onClick={() => applyFunscript(opt.value)}
                        >
                            {opt.value === 'yes' && (
                                <span className="sidebar-dot" style={{ background: 'var(--accent-primary)' }} />
                            )}
                            {opt.value === 'no' && (
                                <span className="sidebar-dot" style={{ background: 'var(--text-muted)' }} />
                            )}
                            {opt.label}
                        </button>
                    ))}
                    <button
                        className={`sidebar-option ${(filters.multiaxis || '') === 'yes' ? 'active' : ''}`}
                        onClick={toggleMultiAxis}
                    >
                        <span className="sidebar-dot" style={{ background: (filters.multiaxis || '') === 'yes' ? '#f59e0b' : 'var(--text-muted)' }} />
                        Multi-Axis
                    </button>
                </div>
            </div>
            )}

            {sidebarConfig.audio && (
            <div className="sidebar-section">
                <h3 className="sidebar-heading">{t('audioTracks', 'Audio')}</h3>
                <div className="sidebar-options">
                    {[
                        { value: '', label: t('all', 'Alle') },
                        { value: 'yes', label: t('withAudio', 'Mit Audio') },
                        { value: 'no', label: t('withoutAudio', 'Ohne Audio') },
                    ].map(opt => (
                        <button
                            key={opt.value}
                            className={`sidebar-option ${(filters.audio || '') === opt.value ? 'active' : ''}`}
                            onClick={() => onFilterChange({ ...filters, audio: opt.value })}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>
            )}

            {isVrLibrary && sidebarConfig.vrProjection && (
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('vrProjection', 'VR Projektion')}</h3>
                    <div className="sidebar-options">
                        {[
                            { value: '', label: t('all', 'Alle') },
                            { value: '180', label: '180' },
                            { value: '360', label: '360' },
                            { value: 'unknown', label: t('unknown', 'Unbekannt') },
                        ].map(opt => (
                            <button
                                key={opt.value}
                                className={`sidebar-option ${(filters.vrProjection || '') === opt.value ? 'active' : ''}`}
                                onClick={() => onFilterChange({ ...filters, vrProjection: opt.value })}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {isVrLibrary && sidebarConfig.vrStereo && (
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('vrStereo', 'VR Stereo')}</h3>
                    <div className="sidebar-options">
                        {[
                            { value: '', label: t('all', 'Alle') },
                            { value: 'sbs', label: 'SBS' },
                            { value: 'ou', label: 'OU' },
                            { value: 'mono', label: 'Mono' },
                        ].map(opt => (
                            <button
                                key={opt.value}
                                className={`sidebar-option ${(filters.vrStereoMode || '') === opt.value ? 'active' : ''}`}
                                onClick={() => onFilterChange({ ...filters, vrStereoMode: opt.value })}
                            >
                                {opt.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {sidebarConfig.format && extensions.length > 1 && (
                <div className="sidebar-section">
                    <h3 className="sidebar-heading">{t('format', 'Format')}</h3>
                    <div className="sidebar-options">
                        <button
                            className={`sidebar-option ${!filters.extension ? 'active' : ''}`}
                            onClick={() => onFilterChange({ ...filters, extension: '' })}
                        >
                            {t('allFormats', 'Alle Formate')}
                        </button>
                        {extensions.map(ext => (
                            <button
                                key={ext}
                                className={`sidebar-option ${filters.extension === ext.replace('.', '') ? 'active' : ''}`}
                                onClick={() => onFilterChange({ ...filters, extension: ext.replace('.', '') })}
                            >
                                <span className="sidebar-ext-badge">{ext.replace('.', '').toUpperCase()}</span>
                                {ext.replace('.', '').toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {sidebarConfig.tags && (
            <div className="sidebar-section">
                <div className="sidebar-heading-row">
                    <h3 className="sidebar-heading" style={{ marginBottom: 0 }}>{t('tagsTitle', 'Tags')}</h3>
                    <div className="sidebar-tag-mode-toggle sidebar-tag-mode-inline">
                        <span className={`sidebar-tag-mode-label ${tagFilterMode === 'or' ? 'active' : ''}`}>OR</span>
                        <label className="settings-switch" title={tagFilterMode === 'and' ? 'AND' : 'OR'}>
                            <input
                                type="checkbox"
                                checked={tagFilterMode === 'and'}
                                onChange={(e) => onTagFilterModeChange(e.target.checked ? 'and' : 'or')}
                            />
                            <span className="settings-switch-track">
                                <span className="settings-switch-thumb" />
                            </span>
                        </label>
                        <span className={`sidebar-tag-mode-label ${tagFilterMode === 'and' ? 'active' : ''}`}>AND</span>
                    </div>
                </div>
                <div className="sidebar-options">
                    <button
                        className={`sidebar-option ${selectedSet.size === 0 ? 'active' : ''}`}
                        onClick={onTagFilterClear}
                    >
                        {t('allTags', 'Alle Tags')}
                    </button>
                    {groupedTagEntries.map(group => (
                        <React.Fragment key={group.key}>
                            <div className="sidebar-heading" style={{ marginTop: 8, marginBottom: 4 }}>{group.label}</div>
                            {group.tags.map((tag) => {
                                const isSelected = selectedSet.has(tag.name);
                                const isUnavailable = tag.count === 0 && !isSelected;
                                return (
                                <button
                                    key={tag.name}
                                    className={`sidebar-option ${isSelected ? 'active' : ''} ${isUnavailable ? 'unavailable' : ''}`}
                                    disabled={isUnavailable}
                                    onClick={() => onTagFilterToggle(tag.name)}
                                >
                                    <span>#{tag.name}</span>
                                    {tag.count !== null && (
                                        <span className="sidebar-count">{tag.count}</span>
                                    )}
                                </button>
                                );
                            })}
                        </React.Fragment>
                    ))}
                </div>
            </div>
            )}
        </aside>
    );
}

export default Sidebar;
    const applyFunscript = (nextFunscript) => {
        const value = String(nextFunscript || '');
        const next = { ...filters, funscript: value };
        // Multi-Axis always implies funscript=yes. Prevent conflicting states.
        if (value === 'no' && String(filters?.multiaxis || '') === 'yes') {
            next.multiaxis = '';
        }
        onFilterChange(next);
    };

    const toggleMultiAxis = () => {
        const currentlyOn = String(filters?.multiaxis || '') === 'yes';
        if (currentlyOn) {
            onFilterChange({ ...filters, multiaxis: '' });
            return;
        }
        // Enabling Multi-Axis forces "with funscript".
        onFilterChange({ ...filters, multiaxis: 'yes', funscript: 'yes' });
    };
