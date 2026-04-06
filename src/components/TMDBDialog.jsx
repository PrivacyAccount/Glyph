import React, { useState } from 'react';
import { useI18n } from '../i18n';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function TMDBDialog({ query, type, folderPath, onClose, onApplied }) {
    const { t } = useI18n();
    const [searchQuery, setSearchQuery] = useState(query || '');
    const [tmdbIdInput, setTmdbIdInput] = useState('');
    const [results, setResults] = useState([]);
    const [loading, setLoading] = useState(false);
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');
    const [searchType, setSearchType] = useState(type || 'tv');
    const [mode, setMode] = useState('search');
    const [step, setStep] = useState('search');

    const [selectedCandidate, setSelectedCandidate] = useState(null);
    const [images, setImages] = useState({ posters: [], backdrops: [] });
    const [selectedPoster, setSelectedPoster] = useState(null);
    const [selectedBackdrop, setSelectedBackdrop] = useState(null);
    const [titles, setTitles] = useState({});
    const [selectedTitle, setSelectedTitle] = useState('de');

    const folderName = folderPath ? folderPath.split(/[\\/]/).pop() : '';

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/tmdb/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: searchQuery, type: searchType }),
            });
            if (!res.ok) throw new Error(`${t('settingsServerError', 'Server-Fehler')}: ${res.status}`);
            const data = await res.json();
            if (data.error) {
                setError(data.error);
                return;
            }
            setResults(data.results || []);
            if ((data.results || []).length === 0) setError(t('noResults', 'Keine Ergebnisse gefunden.'));
        } catch (err) {
            setError(`${t('searchFailed', 'Suche fehlgeschlagen')}: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const handleIdSubmit = () => {
        const idNum = parseInt(tmdbIdInput.trim(), 10);
        if (!idNum) {
            setError(t('invalidTmdbId', 'Bitte eine gueltige TMDB-ID eingeben'));
            return;
        }
        handleSelectCandidate({ id: idNum, name: `TMDB-ID: ${idNum}`, title: `TMDB-ID: ${idNum}` });
    };

    const handleSelectCandidate = async (candidate) => {
        const candidateType = candidate.media_type === 'movie' ? 'movie' : (candidate.media_type === 'tv' ? 'tv' : searchType);
        if (candidateType !== searchType) setSearchType(candidateType);

        setSelectedCandidate(candidate);
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/tmdb/images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tmdbId: candidate.id, type: candidateType }),
            });
            if (!res.ok) {
                let msg = `${t('settingsServerError', 'Server-Fehler')}: ${res.status}`;
                try {
                    const j = await res.json();
                    msg = j.error || msg;
                } catch { }
                throw new Error(msg);
            }
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            setImages({ posters: data.posters || [], backdrops: data.backdrops || [] });
            setSelectedPoster(data.posters?.[0]?.file_path || null);
            setSelectedBackdrop(data.backdrops?.[0]?.file_path || null);
            setTitles(data.titles || {});
            setSelectedTitle((data.titles && data.titles.de) ? 'de' : 'local');
            setStep('images');
        } catch (err) {
            setError(`${t('imagesLoadFailed', 'Bilder konnten nicht geladen werden')}: ${err.message}`);
        } finally {
            setLoading(false);
        }
    };

    const getChosenTitle = () => {
        if (selectedTitle === 'local') return folderName;
        return titles[selectedTitle] || titles.de || folderName || '';
    };

    const handleFinalApply = async () => {
        if (!selectedCandidate) return;
        setApplying(true);
        setError('');
        try {
            const res = await fetch('/api/tmdb/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tmdbId: selectedCandidate.id,
                    type: searchType === 'tv' ? 'series' : 'movie',
                    folderPath,
                    posterPath: selectedPoster,
                    backdropPath: selectedBackdrop,
                    titleOverride: getChosenTitle(),
                }),
            });
            if (!res.ok) throw new Error(`${t('settingsServerError', 'Server-Fehler')}: ${res.status}`);
            const data = await res.json();
            if (data.error) {
                setError(data.error);
                return;
            }
            onApplied(data.metadata);
            onClose();
        } catch (err) {
            setError(t('errorPrefix', 'Fehler: ') + err.message);
        } finally {
            setApplying(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        if (mode === 'search') handleSearch();
        else handleIdSubmit();
    };

    const handleDialogConfirm = () => {
        if (step === 'images') {
            handleFinalApply();
            return;
        }
        if (mode === 'search') handleSearch();
        else handleIdSubmit();
    };

    useDialogHotkeys({
        open: true,
        onCancel: onClose,
        onConfirm: handleDialogConfirm,
        canConfirm: !(loading || applying),
        allowEnterInInputs: false,
    });

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal tmdb-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">TMDB {step === 'images' ? '- Images & Title' : ''}</h2>
                    <button className="modal-close" onClick={onClose}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
                    </button>
                </div>

                <div className="modal-body custom-scrollbar">
                    {step === 'search' && (
                        <>
                            <div className="tmdb-mode-toggle">
                                <button className={`tmdb-mode-btn ${mode === 'search' ? 'active' : ''}`} onClick={() => setMode('search')}>{t('searchByName', 'Name suchen')}</button>
                                <button className={`tmdb-mode-btn ${mode === 'id' ? 'active' : ''}`} onClick={() => setMode('id')}>{t('searchById', 'TMDB-ID')}</button>
                            </div>

                            <div className="tmdb-search-row">
                                <div className="tmdb-type-toggle">
                                    <button className={`tmdb-type-btn ${searchType === 'tv' ? 'active' : ''}`} onClick={() => setSearchType('tv')}>{t('seriesOne', 'Serie')}</button>
                                    <button className={`tmdb-type-btn ${searchType === 'movie' ? 'active' : ''}`} onClick={() => setSearchType('movie')}>Film</button>
                                </div>
                                {mode === 'search' ? (
                                    <>
                                        <div className="settings-search-wrap" style={{ flex: 1 }}>
                                            <input type="text" className="tmdb-search-input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('titleInputPlaceholder', 'Titel eingeben...')} autoFocus />
                                            {searchQuery ? (
                                                <button
                                                    type="button"
                                                    className="search-clear-btn compact"
                                                    onClick={() => setSearchQuery('')}
                                                    aria-label={t('clearSearch', 'Clear search')}
                                                    title={t('clearSearch', 'Clear search')}
                                                >
                                                    ×
                                                </button>
                                            ) : null}
                                        </div>
                                        <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>{loading ? t('loadingSearch', 'Suche...') : t('select', 'Auswaehlen')}</button>
                                    </>
                                ) : (
                                    <>
                                        <div className="settings-search-wrap" style={{ flex: 1 }}>
                                            <input type="number" className="tmdb-search-input" value={tmdbIdInput} onChange={e => setTmdbIdInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={t('idInputPlaceholder', 'z.B. 12345')} autoFocus />
                                            {tmdbIdInput ? (
                                                <button
                                                    type="button"
                                                    className="search-clear-btn compact"
                                                    onClick={() => setTmdbIdInput('')}
                                                    aria-label={t('clearSearch', 'Clear search')}
                                                    title={t('clearSearch', 'Clear search')}
                                                >
                                                    ×
                                                </button>
                                            ) : null}
                                        </div>
                                        <button className="btn btn-primary" onClick={handleIdSubmit} disabled={loading}>{loading ? t('loadingLoad', 'Lade...') : t('continueLabel', 'Weiter')}</button>
                                    </>
                                )}
                            </div>

                            {error && <div className="tmdb-error">{error}</div>}

                            <div className="tmdb-results">
                                {results.map(result => (
                                    <div key={`${result.media_type || 'x'}_${result.id}`} className="tmdb-result-card" onClick={() => handleSelectCandidate(result)}>
                                        <div className="tmdb-result-poster">
                                            {result.poster_path ? <img src={`https://image.tmdb.org/t/p/w185${result.poster_path}`} alt="" /> : <div className="tmdb-no-poster">{t('noPosterAvailable', 'Kein Poster')}</div>}
                                        </div>
                                        <div className="tmdb-result-info">
                                            <h3 className="tmdb-result-title">{result.name || result.title}</h3>
                                            <p className="tmdb-result-year">
                                                <span className={`tmdb-type-badge ${result.media_type === 'movie' ? 'movie' : 'tv'}`}>{result.media_type === 'movie' ? 'Film' : t('seriesOne', 'Serie')}</span>
                                                {' '}
                                                {(result.first_air_date || result.release_date || '').substring(0, 4)}
                                                {' | '}
                                                <span className="tmdb-id-label">ID: {result.id}</span>
                                            </p>
                                            <p className="tmdb-result-overview">
                                                {(result.overview || t('noDescription', 'Keine Beschreibung')).substring(0, 200)}
                                                {(result.overview || '').length > 200 ? '...' : ''}
                                            </p>
                                            <div className="tmdb-result-meta">
                                                <span className="tmdb-rating">* {(result.vote_average || 0).toFixed(1)}</span>
                                            </div>
                                        </div>
                                        <button className="btn btn-primary tmdb-apply-btn">{t('select', 'Auswaehlen')}</button>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}

                    {step === 'images' && (
                        <div className="tmdb-images-step">
                            {error && <div className="tmdb-error">{error}</div>}

                            <div className="tmdb-images-section">
                                <h3>{t('selectTitle', 'Titel waehlen')}</h3>
                                <div className="tmdb-title-options">
                                    {titles.de && (
                                        <label className={`tmdb-title-option ${selectedTitle === 'de' ? 'selected' : ''}`}>
                                            <input type="radio" name="titleLang" checked={selectedTitle === 'de'} onChange={() => setSelectedTitle('de')} />
                                            <span className="tmdb-title-lang">{t('german', 'Deutsch')}</span>
                                            <span className="tmdb-title-value">{titles.de}</span>
                                        </label>
                                    )}
                                    {titles.en && (
                                        <label className={`tmdb-title-option ${selectedTitle === 'en' ? 'selected' : ''}`}>
                                            <input type="radio" name="titleLang" checked={selectedTitle === 'en'} onChange={() => setSelectedTitle('en')} />
                                            <span className="tmdb-title-lang">{t('english', 'English')}</span>
                                            <span className="tmdb-title-value">{titles.en}</span>
                                        </label>
                                    )}
                                    {titles.ja && (
                                        <label className={`tmdb-title-option ${selectedTitle === 'ja' ? 'selected' : ''}`}>
                                            <input type="radio" name="titleLang" checked={selectedTitle === 'ja'} onChange={() => setSelectedTitle('ja')} />
                                            <span className="tmdb-title-lang">{t('japanese', 'Japanese')}</span>
                                            <span className="tmdb-title-value">{titles.ja}</span>
                                        </label>
                                    )}
                                    <label className={`tmdb-title-option ${selectedTitle === 'local' ? 'selected' : ''}`}>
                                        <input type="radio" name="titleLang" checked={selectedTitle === 'local'} onChange={() => setSelectedTitle('local')} />
                                        <span className="tmdb-title-lang">{t('folderName', 'Ordnername')}</span>
                                        <span className="tmdb-title-value">{folderName}</span>
                                    </label>
                                </div>
                            </div>

                            <div className="tmdb-images-section">
                                <h3>{t('selectPoster', 'Poster auswaehlen')} ({images.posters.length})</h3>
                                <div className="tmdb-image-grid posters">
                                    {images.posters.map(img => (
                                        <div key={img.file_path} className={`tmdb-image-card poster ${selectedPoster === img.file_path ? 'selected' : ''}`} onClick={() => setSelectedPoster(img.file_path)}>
                                            <img src={`https://image.tmdb.org/t/p/w185${img.file_path}`} alt="" loading="lazy" />
                                        </div>
                                    ))}
                                    {images.posters.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noPosterAvailablePlural', 'Keine Poster verfuegbar')}</p>}
                                </div>
                            </div>

                            <div className="tmdb-images-section">
                                <h3>{t('selectBackdrop', 'Backdrop auswaehlen')} ({images.backdrops.length})</h3>
                                <div className="tmdb-image-grid backdrops">
                                    {images.backdrops.map(img => (
                                        <div key={img.file_path} className={`tmdb-image-card backdrop ${selectedBackdrop === img.file_path ? 'selected' : ''}`} onClick={() => setSelectedBackdrop(img.file_path)}>
                                            <img src={`https://image.tmdb.org/t/p/w300${img.file_path}`} alt="" loading="lazy" />
                                        </div>
                                    ))}
                                    {images.backdrops.length === 0 && <p style={{ color: 'var(--text-muted)' }}>{t('noBackdropAvailablePlural', 'Keine Backdrops verfuegbar')}</p>}
                                </div>
                            </div>

                            <div className="tmdb-actions-footer">
                                <button className="btn btn-secondary" onClick={() => { setStep('search'); setError(''); }}>{t('back', 'Zurueck')}</button>
                                <button className="btn btn-primary" onClick={handleFinalApply} disabled={applying}>
                                    {applying ? t('saving', 'Speichere...') : t('saveAndApply', 'Speichern & Uebernehmen')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default TMDBDialog;
