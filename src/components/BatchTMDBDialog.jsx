import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import AppDropdown from './AppDropdown';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function keyForCandidate(candidate) {
    return `${candidate.media_type || 'tv'}_${candidate.id}`;
}

function formatCandidateLabel(candidate) {
    const title = candidate.name || candidate.title || `ID ${candidate.id}`;
    const year = (candidate.first_air_date || candidate.release_date || '').substring(0, 4) || '----';
    const kind = candidate.media_type === 'movie' ? 'Film' : 'Serie';
    const rating = Number(candidate.vote_average || 0).toFixed(1);
    return `${title} (${year}) | ${kind} | rating ${rating}`;
}

function BatchTMDBDialog({ folders, onClose, onApplied }) {
    const { t } = useI18n();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');
    const [summary, setSummary] = useState(null);

    const localizeServerError = (message) => {
        const text = String(message || '');
        if (!text) return text;
        if (/TMDB API Key/i.test(text) && /(konfiguriert|configured|missing)/i.test(text)) {
            return t('tmdbApiKeyNotConfigured', 'TMDB API Key nicht konfiguriert');
        }
        return text;
    };

    useEffect(() => {
        const initialRows = (folders || []).map(folder => {
            const query = folder.metadata?.title || folder.name;
            return {
                folderPath: folder.path,
                folderName: folder.metadata?.title || folder.name,
                query,
                candidates: [],
                selected: '',
                skip: false,
                error: '',
                optionsOpen: false,
                optionsLoading: false,
                optionsLoaded: false,
                optionsError: '',
                posters: [],
                selectedPoster: null,
                backdrops: [],
                selectedBackdrop: null,
                titles: {},
                selectedTitle: 'local',
            };
        });
        setRows(initialRows);
    }, [folders]);

    const activeCount = useMemo(
        () => rows.filter(r => !r.skip && r.selected).length,
        [rows]
    );

    useEffect(() => {
        if (rows.length === 0) return;
        const loadCandidates = async () => {
            setLoading(true);
            setError('');
            try {
                const payload = {
                    type: 'series',
                    items: rows.map(r => ({ folderPath: r.folderPath, query: r.query })),
                };
                const res = await fetch('/api/tmdb/batch-search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(localizeServerError(data.error || `${t('settingsServerError', 'Server-Fehler')}: ${res.status}`));

                const byPath = new Map((data.results || []).map(item => [item.folderPath, item]));
                setRows(prev => prev.map(row => {
                    const result = byPath.get(row.folderPath);
                    if (!result) return { ...row, error: t('noResponse', 'Keine Antwort'), candidates: [], selected: '' };
                    const candidates = result.candidates || [];
                    return {
                        ...row,
                        candidates,
                        selected: candidates[0] ? keyForCandidate(candidates[0]) : '',
                        error: localizeServerError(result.error) || (candidates.length === 0 ? t('noMatches', 'Keine Treffer') : ''),
                        optionsLoaded: false,
                        optionsError: '',
                        posters: [],
                        selectedPoster: null,
                        backdrops: [],
                        selectedBackdrop: null,
                        titles: {},
                        selectedTitle: 'local',
                    };
                }));
            } catch (err) {
                setError(localizeServerError(err.message));
            } finally {
                setLoading(false);
            }
        };
        loadCandidates();
    }, [rows.length]);

    const loadRowOptions = async (row) => {
        if (!row.selected) return;
        const candidate = row.candidates.find(c => keyForCandidate(c) === row.selected);
        if (!candidate) return;

        setRows(prev => prev.map(r => (
            r.folderPath === row.folderPath
                ? { ...r, optionsLoading: true, optionsError: '' }
                : r
        )));

        try {
            const res = await fetch('/api/tmdb/images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tmdbId: candidate.id,
                    type: candidate.media_type === 'movie' ? 'movie' : 'tv',
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(localizeServerError(data.error || `${t('settingsServerError', 'Server-Fehler')}: ${res.status}`));

            const titles = data.titles || {};
            let selectedTitle = 'local';
            if (titles.de) selectedTitle = 'de';
            else if (titles.en) selectedTitle = 'en';
            else if (titles.ja) selectedTitle = 'ja';

            setRows(prev => prev.map(r => {
                if (r.folderPath !== row.folderPath) return r;
                return {
                    ...r,
                    optionsLoading: false,
                    optionsLoaded: true,
                    optionsError: '',
                    titles,
                    posters: data.posters || [],
                    selectedPoster: data.posters?.[0]?.file_path || null,
                    backdrops: data.backdrops || [],
                    selectedBackdrop: data.backdrops?.[0]?.file_path || null,
                    selectedTitle,
                };
            }));
        } catch (err) {
            setRows(prev => prev.map(r => (
                r.folderPath === row.folderPath
                    ? { ...r, optionsLoading: false, optionsLoaded: false, optionsError: localizeServerError(err.message) }
                    : r
            )));
        }
    };

    const getTitleOverride = (row) => {
        if (row.selectedTitle === 'local') return row.folderName;
        if (row.selectedTitle === 'de' && row.titles?.de) return row.titles.de;
        if (row.selectedTitle === 'en' && row.titles?.en) return row.titles.en;
        if (row.selectedTitle === 'ja' && row.titles?.ja) return row.titles.ja;
        return row.folderName;
    };

    const handleApplyAll = async () => {
        const selectedItems = rows
            .filter(row => !row.skip && row.selected)
            .map(row => {
                const candidate = row.candidates.find(c => keyForCandidate(c) === row.selected);
                if (!candidate) return null;
                return {
                    folderPath: row.folderPath,
                    tmdbId: candidate.id,
                    type: candidate.media_type === 'movie' ? 'movie' : 'series',
                    posterPath: row.selectedPoster || undefined,
                    backdropPath: row.selectedBackdrop || undefined,
                    titleOverride: getTitleOverride(row),
                };
            })
            .filter(Boolean);

        if (selectedItems.length === 0) {
            setError(t('invalidSelectionEntries', 'Keine gueltigen Auswahl-Eintraege vorhanden.'));
            return;
        }

        setApplying(true);
        setError('');
        setSummary(null);
        try {
            const res = await fetch('/api/tmdb/batch-apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: selectedItems }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(localizeServerError(data.error || `${t('settingsServerError', 'Server-Fehler')}: ${res.status}`));
            setSummary({ successCount: data.successCount || 0, failedCount: data.failedCount || 0 });
            if (onApplied) onApplied(data);
            if ((data.failedCount || 0) === 0) {
                onClose();
            }
        } catch (err) {
            setError(localizeServerError(err.message));
        } finally {
            setApplying(false);
        }
    };


    useDialogHotkeys({
        open: true,
        onCancel: onClose,
        onConfirm: handleApplyAll,
        canConfirm: !(applying || loading || activeCount === 0),
        allowEnterInInputs: false,
    });

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal tmdb-modal batch-tmdb-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{t('batchMetadata', 'Batch-Metadaten')}</h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="modal-body custom-scrollbar">
                    <p className="batch-tmdb-hint">
                        {t('batchSelection', 'Auswahl')}: {rows.length} {t('foldersWord', 'Ordner')} | {t('applyCount', 'Uebernehmen')}: {activeCount}
                    </p>
                    {loading && <div className="tmdb-hint">{t('searchingCandidates', 'Suche Kandidaten...')}</div>}
                    {error && <div className="tmdb-error">{error}</div>}
                    {summary && (
                        <div className="tmdb-hint">
                            {t('done', 'Fertig')}: {summary.successCount} {t('successfully', 'erfolgreich')}, {summary.failedCount} {t('failed', 'fehlgeschlagen')}.
                        </div>
                    )}

                    <div className="batch-tmdb-list">
                        {rows.map(row => (
                            <div key={row.folderPath} className={`batch-tmdb-row ${row.skip ? 'skip' : ''}`}>
                                <div className="batch-tmdb-row-head">
                                    <label className="batch-tmdb-skip">
                                        <input
                                            type="checkbox"
                                            checked={row.skip}
                                            onChange={e => {
                                                const next = e.target.checked;
                                                setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, skip: next } : r));
                                            }}
                                        />
                                        {t('skip', 'Skip')}
                                    </label>
                                    <span className="batch-tmdb-folder" title={row.folderPath}>{row.folderName}</span>
                                </div>
                                <div className="batch-tmdb-row-body">
                                    <AppDropdown
                                        className="batch-tmdb-select"
                                        value={row.selected}
                                        disabled={row.skip || row.candidates.length === 0}
                                        usePortal={true}
                                        portalOffset={0}
                                        placeholder={t('noMatches', 'Keine Treffer')}
                                        options={row.candidates.map((candidate) => ({
                                            value: keyForCandidate(candidate),
                                            label: formatCandidateLabel(candidate),
                                        }))}
                                        onChange={(val) => {
                                            setRows(prev => prev.map(r => (
                                                r.folderPath === row.folderPath
                                                    ? {
                                                        ...r,
                                                        selected: val,
                                                        optionsLoaded: false,
                                                        optionsError: '',
                                                        posters: [],
                                                        selectedPoster: null,
                                                        backdrops: [],
                                                        selectedBackdrop: null,
                                                        titles: {},
                                                        selectedTitle: 'local',
                                                    }
                                                    : r
                                            )));
                                        }}
                                    />
                                    {row.error && <span className="batch-tmdb-row-error">{row.error}</span>}
                                    <div className="batch-tmdb-actions">
                                        <button
                                            className="btn btn-secondary"
                                            disabled={row.skip || !row.selected || row.optionsLoading}
                                            onClick={() => {
                                                const nextOpen = !row.optionsOpen;
                                                setRows(prev => prev.map(r => (
                                                    r.folderPath === row.folderPath
                                                        ? { ...r, optionsOpen: nextOpen }
                                                        : r
                                                )));
                                                if (nextOpen && !row.optionsLoaded) {
                                                    loadRowOptions(row);
                                                }
                                            }}
                                        >
                                            {row.optionsOpen ? t('hideOptions', 'Optionen ausblenden') : t('configureNamePoster', 'Name/Poster konfigurieren')}
                                        </button>
                                    </div>
                                    {row.optionsOpen && (
                                        <div className="batch-tmdb-options">
                                            {row.optionsLoading && <div className="tmdb-hint">{t('loadingOptions', 'Lade Optionen...')}</div>}
                                            {row.optionsError && <div className="tmdb-error">{row.optionsError}</div>}
                                            {!row.optionsLoading && !row.optionsError && (
                                                <>
                                                    <div className="batch-title-options">
                                                        <label className="batch-title-option">
                                                            <input
                                                                type="radio"
                                                                name={`title-${row.folderPath}`}
                                                                checked={row.selectedTitle === 'local'}
                                                                onChange={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedTitle: 'local' } : r))}
                                                            />
                                                            <span>{t('folderName', 'Ordnername')}: {row.folderName}</span>
                                                        </label>
                                                        {row.titles?.de && (
                                                            <label className="batch-title-option">
                                                                <input
                                                                    type="radio"
                                                                    name={`title-${row.folderPath}`}
                                                                    checked={row.selectedTitle === 'de'}
                                                                    onChange={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedTitle: 'de' } : r))}
                                                                />
                                                                <span>{t('german', 'Deutsch')}: {row.titles.de}</span>
                                                            </label>
                                                        )}
                                                        {row.titles?.en && (
                                                            <label className="batch-title-option">
                                                                <input
                                                                    type="radio"
                                                                    name={`title-${row.folderPath}`}
                                                                    checked={row.selectedTitle === 'en'}
                                                                    onChange={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedTitle: 'en' } : r))}
                                                                />
                                                                <span>{t('english', 'English')}: {row.titles.en}</span>
                                                            </label>
                                                        )}
                                                        {row.titles?.ja && (
                                                            <label className="batch-title-option">
                                                                <input
                                                                    type="radio"
                                                                    name={`title-${row.folderPath}`}
                                                                    checked={row.selectedTitle === 'ja'}
                                                                    onChange={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedTitle: 'ja' } : r))}
                                                                />
                                                                <span>{t('japanese', 'Japanese')}: {row.titles.ja}</span>
                                                            </label>
                                                        )}
                                                    </div>
                                                    <div className="batch-poster-grid">
                                                        {row.posters.length === 0 && (
                                                            <div className="batch-tmdb-row-error">{t('noPosterFound', 'Keine Poster gefunden')}</div>
                                                        )}
                                                        {row.posters.map(img => (
                                                            <button
                                                                key={img.file_path}
                                                                type="button"
                                                                className={`batch-poster-card ${row.selectedPoster === img.file_path ? 'selected' : ''}`}
                                                                onClick={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedPoster: img.file_path } : r))}
                                                            >
                                                                <img src={`https://image.tmdb.org/t/p/w185${img.file_path}`} alt="" loading="lazy" />
                                                            </button>
                                                        ))}
                                                    </div>
                                                    <div className="batch-backdrop-grid">
                                                        {row.backdrops.length === 0 && (
                                                            <div className="batch-tmdb-row-error">{t('noBackdropFound', 'Keine Backdrops gefunden')}</div>
                                                        )}
                                                        {row.backdrops.map(img => (
                                                            <button
                                                                key={img.file_path}
                                                                type="button"
                                                                className={`batch-backdrop-card ${row.selectedBackdrop === img.file_path ? 'selected' : ''}`}
                                                                onClick={() => setRows(prev => prev.map(r => r.folderPath === row.folderPath ? { ...r, selectedBackdrop: img.file_path } : r))}
                                                            >
                                                                <img src={`https://image.tmdb.org/t/p/w300${img.file_path}`} alt="" loading="lazy" />
                                                            </button>
                                                        ))}
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onClose}>{t('cancel', 'Abbrechen')}</button>
                    <button className="btn btn-primary" onClick={handleApplyAll} disabled={applying || loading || activeCount === 0}>
                        {applying ? t('applyRunning', 'Uebernehme...') : `${t('applyAll', 'Alle uebernehmen')} (${activeCount})`}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default BatchTMDBDialog;







