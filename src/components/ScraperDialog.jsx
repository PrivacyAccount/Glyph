import React, { useState } from 'react';
import { useI18n } from '../i18n';

function ScraperDialog({ video, onClose, onApplied }) {
    const { t } = useI18n();
    const [provider, setProvider] = useState('tpdb');
    const [query, setQuery] = useState(String(video?.title || ''));
    const [urlInput, setUrlInput] = useState('');
    const [results, setResults] = useState([]);
    const [selectedId, setSelectedId] = useState('');
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');

    const selected = results.find((r) => String(r?.id || '') === String(selectedId || '')) || null;

    const providerEndpoints = {
        tpdb: { search: '/api/tpdb/search', apply: '/api/tpdb/apply' },
        fc2: { search: '/api/scraper/fc2/search', apply: '/api/scraper/fc2/apply' },
        javpop: { search: '/api/scraper/javpop/search', apply: '/api/scraper/javpop/apply' },
    };

    const providerLabels = {
        tpdb: t('tpdbLabel', 'ThePornDB') + ' / StashDB',
        fc2: 'FC2',
        javpop: 'JAVPop',
    };

    const providerHints = {
        tpdb: t('metadataProviderOrderHint', 'Provider order: StashDB first, ThePornDB fallback'),
        fc2: t('fc2ProviderHint', 'Parse metadata from adult.fc2.com (Cloudflare protected)'),
        javpop: t('javpopProviderHint', 'Parse metadata from javpop.com (Cloudflare protected)'),
    };

    const urlPlaceholders = {
        tpdb: t('metadataUrlPlaceholder', 'Or paste URL (StashDB scene or ThePornDB scene/movie/jav)'),
        fc2: t('fc2UrlPlaceholder', 'Paste FC2 content URL (e.g., https://adult.fc2.com/content/...)'),
        javpop: t('javpopUrlPlaceholder', 'Paste JAVPop post URL (e.g., https://javpop.com/...)'),
    };

    const handleSearch = async () => {
        setLoading(true);
        setError('');
        setSelectedId('');
        setResults([]);
        try {
            const endpoint = providerEndpoints[provider];
            const res = await fetch(endpoint.search, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: video?.id || '',
                    itemType: 'all',
                    query: query || '',
                    url: urlInput || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Search failed');
            const list = Array.isArray(data?.results) ? data.results : [];
            setResults(list);
            if (list.length > 0) setSelectedId(String(list[0].id || ''));
        } catch (err) {
            setError(String(err?.message || 'Search failed'));
        } finally {
            setLoading(false);
        }
    };

    const handleApply = async () => {
        if (!video?.id) return;
        if (!selected && !urlInput.trim()) {
            setError(t('selectSearchResult', 'Please select a search result first.'));
            return;
        }
        setApplying(true);
        setError('');
        try {
            const endpoint = providerEndpoints[provider];
            const res = await fetch(endpoint.apply, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: video.id,
                    provider: selected?.provider || provider,
                    itemType: selected?.itemType || 'scenes',
                    itemId: selected?.id || '',
                    url: urlInput || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'Apply failed');
            onApplied?.(data, selected);
            onClose?.();
        } catch (err) {
            setError(String(err?.message || 'Apply failed'));
        } finally {
            setApplying(false);
        }
    };

    const getProviderBadgeClass = (prov) => {
        const key = String(prov || '').toLowerCase();
        if (key === 'stashdb') return 'tpdb-item-provider-badge--stash';
        if (key === 'tpdb' || key === 'theporndb') return 'tpdb-item-provider-badge--tpdb';
        if (key === 'fc2') return 'tpdb-item-provider-badge--fc2';
        if (key === 'javpop') return 'tpdb-item-provider-badge--javpop';
        return '';
    };

    const getProviderLabel = (prov) => {
        const key = String(prov || '').toLowerCase();
        if (key === 'stashdb') return t('stashdbLabel', 'StashDB');
        if (key === 'tpdb' || key === 'theporndb') return t('tpdbLabel', 'ThePornDB');
        if (key === 'fc2') return 'FC2';
        if (key === 'javpop') return 'JAVPop';
        return String(prov || '').toUpperCase();
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal tpdb-modal scraper-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{t('fetchMetadata', 'Fetch metadata')}</h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="modal-body custom-scrollbar tpdb-modal-body">
                    <div className="scraper-provider-tabs">
                        {Object.keys(providerEndpoints).map((prov) => (
                            <button
                                key={prov}
                                type="button"
                                className={`scraper-provider-tab ${provider === prov ? 'active' : ''}`}
                                onClick={() => {
                                    setProvider(prov);
                                    setResults([]);
                                    setSelectedId('');
                                    setError('');
                                }}
                            >
                                {providerLabels[prov]}
                            </button>
                        ))}
                    </div>

                    <div className="tpdb-provider-hint">{providerHints[provider]}</div>

                    <div className="tmdb-search-row">
                        <input
                            className="tmdb-search-input"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('tpdbQueryPlaceholder', 'Title search')}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        />
                        <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>
                            {loading ? t('searching', 'Searching...') : t('search', 'Search')}
                        </button>
                    </div>

                    <div className="tmdb-search-row">
                        <input
                            className="tmdb-search-input"
                            value={urlInput}
                            onChange={(e) => setUrlInput(e.target.value)}
                            placeholder={urlPlaceholders[provider]}
                            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                        />
                    </div>

                    {error ? <div className="tmdb-error">{error}</div> : null}

                    <div className="tmdb-list tpdb-list">
                        {results.length === 0 ? (
                            <div className="tmdb-empty">{t('noResults', 'No results')}</div>
                        ) : (
                            results.map((r) => {
                                const id = String(r?.id || '');
                                const active = String(selectedId || '') === id;
                                const provKey = String(r?.provider || provider).toLowerCase();
                                return (
                                    <button
                                        type="button"
                                        key={id || Math.random()}
                                        className={`tmdb-item tpdb-item ${active ? 'selected' : ''}`}
                                        onClick={() => setSelectedId(id)}
                                    >
                                        <span className={`tpdb-item-provider-badge ${getProviderBadgeClass(r?.provider)}`}>
                                            {getProviderLabel(r?.provider)}
                                        </span>
                                        <div className="tmdb-item-poster-wrap tpdb-item-poster-wrap">
                                            {(r?.thumbUrl || r?.posterUrl) ? (
                                                <img
                                                    src={r?.thumbUrl || r?.posterUrl}
                                                    alt={r.title || id}
                                                    className="tmdb-item-poster tpdb-item-poster"
                                                    loading="lazy"
                                                />
                                            ) : null}
                                        </div>
                                        <div className="tmdb-item-info tpdb-item-info">
                                            <div className="tmdb-item-title tpdb-item-title">{r?.title || id}</div>
                                            <div className="tmdb-item-meta tpdb-item-meta">
                                                <span>{String(r?.itemType || '')}</span>
                                                {r?.date ? <span>{r.date}</span> : null}
                                                {r?.siteName ? <span>{r.siteName}</span> : null}
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onClose}>
                        {t('cancel', 'Cancel')}
                    </button>
                    <button className="btn btn-primary" onClick={handleApply} disabled={applying}>
                        {applying ? t('saving', 'Saving...') : t('apply', 'Apply')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default ScraperDialog;
