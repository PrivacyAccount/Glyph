import React, { useMemo, useState } from 'react';
import { useI18n } from '../i18n';

function TPDBDialog({ video, onClose, onApplied }) {
    const { t } = useI18n();
    const [query, setQuery] = useState(String(video?.title || ''));
    const [urlInput, setUrlInput] = useState('');
    const [results, setResults] = useState([]);
    const [selectedId, setSelectedId] = useState('');
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');

    const selected = useMemo(
        () => results.find((r) => String(r?.id || '') === String(selectedId || '')) || null,
        [results, selectedId],
    );

    const handleSearch = async () => {
        setLoading(true);
        setError('');
        setSelectedId('');
        try {
            const res = await fetch('/api/tpdb/search', {
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
            if (!res.ok) throw new Error(data?.error || 'TPDB search failed');
            const list = Array.isArray(data?.results) ? data.results : [];
            setResults(list);
            if (list.length > 0) setSelectedId(String(list[0].id || ''));
        } catch (err) {
            setResults([]);
            setError(String(err?.message || 'TPDB search failed'));
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
            const res = await fetch('/api/tpdb/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    videoId: video.id,
                    provider: selected?.provider || '',
                    itemType: selected?.itemType || 'scenes',
                    itemId: selected?.id || '',
                    url: urlInput || '',
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || 'TPDB apply failed');
            onApplied?.(data, selected);
            onClose?.();
        } catch (err) {
            setError(String(err?.message || 'TPDB apply failed'));
        } finally {
            setApplying(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal tpdb-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{t('fetchMetadata', 'Fetch metadata')}</h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                <div className="modal-body custom-scrollbar tpdb-modal-body">
                    <div className="tpdb-provider-hint">
                        {t('metadataProviderOrderHint', 'Provider order: StashDB first, ThePornDB fallback')}
                    </div>

                    <div className="tmdb-search-row">
                        <input
                            className="tmdb-search-input"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('tpdbQueryPlaceholder', 'Title search (fallback if hash misses)')}
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
                            placeholder={t('metadataUrlPlaceholder', 'Or paste URL (StashDB scene or ThePornDB scene/movie/jav)')}
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
                                const providerKey = String(r?.provider || '').toLowerCase();
                                const providerLabel = providerKey === 'stashdb'
                                    ? t('stashdbLabel', 'StashDB')
                                    : providerKey === 'tpdb'
                                        ? t('tpdbLabel', 'ThePornDB')
                                        : String(r?.provider || '').toUpperCase();
                                return (
                                    <button
                                        type="button"
                                        key={id}
                                        className={`tmdb-item tpdb-item ${active ? 'selected' : ''}`}
                                        onClick={() => setSelectedId(id)}
                                    >
                                        {providerLabel ? (
                                            <span className={`tpdb-item-provider-badge ${providerKey === 'stashdb' ? 'tpdb-item-provider-badge--stash' : providerKey === 'tpdb' ? 'tpdb-item-provider-badge--tpdb' : ''}`}>
                                                {providerLabel}
                                            </span>
                                        ) : null}
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
                    <button className="btn btn-secondary" onClick={onClose}>{t('cancel', 'Cancel')}</button>
                    <button className="btn btn-primary" onClick={handleApply} disabled={applying}>
                        {applying ? t('saving', 'Saving...') : t('apply', 'Apply')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default TPDBDialog;
