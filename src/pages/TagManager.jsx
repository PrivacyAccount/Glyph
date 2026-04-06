import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import AppDropdown from '../components/AppDropdown';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function TagManager() {
    const { t } = useI18n();
    const [tags, setTags] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [renameDrafts, setRenameDrafts] = useState({});
    const [mergeSource, setMergeSource] = useState([]);
    const [mergeTarget, setMergeTarget] = useState('');
    const [mergeConfirmCategory, setMergeConfirmCategory] = useState('');
    const [mergeConfirmMode, setMergeConfirmMode] = useState('target');
    const [mergeConfirmSourceCategory, setMergeConfirmSourceCategory] = useState('');
    const [busyAction, setBusyAction] = useState('');
    const [toast, setToast] = useState(null);
    const [confirmDialog, setConfirmDialog] = useState(null);
    const [mergeSuggestOpen, setMergeSuggestOpen] = useState(false);
    const [renameSuggestOpenFor, setRenameSuggestOpenFor] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('');
    const [categoryDrafts, setCategoryDrafts] = useState({});
    const [categorySuggestOpenFor, setCategorySuggestOpenFor] = useState('');
    const [createTagName, setCreateTagName] = useState('');
    const [createCategory, setCreateCategory] = useState('');
    const [createCategorySuggestOpen, setCreateCategorySuggestOpen] = useState(false);
    const [activeTab, setActiveTab] = useState('create');

    const showToast = (message, type = 'success') => {
        setToast({ message, type });
        setTimeout(() => setToast(null), 2800);
    };

    const loadTags = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/tags/manager');
            const data = await res.json();
            setTags(Array.isArray(data) ? data : []);
            setCategoryDrafts({});
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadTags();
    }, []);

    const filteredTags = useMemo(() => {
        const q = search.trim().toLowerCase();
        return tags
            .filter((tag) => {
                const nameOk = !q || String(tag.name || '').toLowerCase().includes(q);
                const category = String(tag.category || '').trim();
                const categoryOk = !categoryFilter || category.toLowerCase() === String(categoryFilter).toLowerCase();
                return nameOk && categoryOk;
            })
            .sort((a, b) => {
                const ca = String(a.category || '').trim();
                const cb = String(b.category || '').trim();
                if (!ca && cb) return 1;
                if (ca && !cb) return -1;
                const catCmp = ca.localeCompare(cb);
                if (catCmp !== 0) return catCmp;
                return String(a.name || '').localeCompare(String(b.name || ''));
            });
    }, [tags, search, categoryFilter]);

    const knownTags = useMemo(() => tags.map((tag) => String(tag.name || '')).filter(Boolean), [tags]);
    const knownCategories = useMemo(() => (
        [...new Set(tags.map((tag) => String(tag.category || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b))
    ), [tags]);
    const defaultCategoryOptions = useMemo(() => ([
        'Artist',
        'Studio',
        'Series',
        'Genre',
        'Misc',
    ]), []);
    const allCategoryOptions = useMemo(() => (
        [...new Set([...defaultCategoryOptions, ...knownCategories])]
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
    ), [defaultCategoryOptions, knownCategories]);
    const createCategorySuggestions = useMemo(() => {
        const q = String(createCategory || '').trim().toLowerCase();
        return allCategoryOptions
            .filter((cat) => !q || cat.toLowerCase().includes(q))
            .slice(0, 8);
    }, [allCategoryOptions, createCategory]);
    const tagCategoryLookup = useMemo(() => {
        const map = {};
        for (const item of tags) {
            const name = String(item?.name || '').trim().toLowerCase();
            if (!name) continue;
            map[name] = String(item?.category || '').trim();
        }
        return map;
    }, [tags]);
    const mergeTargetCategory = useMemo(() => (
        String(tagCategoryLookup[String(mergeTarget || '').trim().toLowerCase()] || '').trim()
    ), [mergeTarget, tagCategoryLookup]);
    const mergeSourceCategories = useMemo(() => (
        [...new Set(
            mergeSource
                .map((name) => String(tagCategoryLookup[String(name || '').trim().toLowerCase()] || '').trim())
                .filter(Boolean)
        )]
    ), [mergeSource, tagCategoryLookup]);
    const mergeSuggestions = useMemo(() => {
        const q = String(mergeTarget || '').trim().toLowerCase();
        return knownTags
            .filter((tag) => !q || tag.toLowerCase().includes(q))
            .slice(0, 8);
    }, [knownTags, mergeTarget]);

    const handleRename = async (tagName) => {
        const toTag = String(renameDrafts[tagName] || '').trim();
        if (!toTag || toTag.toLowerCase() === String(tagName).toLowerCase()) return;
        setBusyAction(`rename:${tagName}`);
        try {
            const res = await fetch('/api/tags/manager/rename', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fromTag: tagName, toTag }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || t('settingsServerError', 'Server-Fehler'));
            setRenameDrafts((prev) => ({ ...prev, [tagName]: '' }));
            setMergeSource((prev) => prev.filter((tag) => tag.toLowerCase() !== String(tagName).toLowerCase()));
            if (mergeTarget.toLowerCase() === String(tagName).toLowerCase()) setMergeTarget(toTag);
            await loadTags();
            showToast(`${data.changedItems || 0} ${t('tagItemsUpdated', 'Eintr\u00E4ge aktualisiert')}`, 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const executeDelete = async (tagName) => {
        setBusyAction(`delete:${tagName}`);
        try {
            const res = await fetch('/api/tags/manager/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tags: [tagName] }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || t('settingsServerError', 'Server-Fehler'));
            setMergeSource((prev) => prev.filter((tag) => tag.toLowerCase() !== String(tagName).toLowerCase()));
            if (mergeTarget.toLowerCase() === String(tagName).toLowerCase()) setMergeTarget('');
            await loadTags();
            showToast(`${data.changedItems || 0} ${t('tagItemsUpdated', 'Eintr\u00E4ge aktualisiert')}`, 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const executeMerge = async (resultCategoryOverride) => {
        const targetTag = String(mergeTarget || '').trim();
        const normalizedSources = [...new Set(mergeSource.map((tag) => String(tag || '').trim()).filter(Boolean))];
        if (!targetTag || normalizedSources.length === 0) return;
        setBusyAction('merge');
        try {
            const payload = { sourceTags: normalizedSources, targetTag };
            if (typeof resultCategoryOverride !== 'undefined') {
                payload.resultCategory = String(resultCategoryOverride || '').trim();
            }
            const res = await fetch('/api/tags/manager/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data?.error || t('settingsServerError', 'Server-Fehler'));
            setMergeSource([]);
            setMergeTarget('');
            setMergeConfirmCategory('');
            setMergeConfirmMode('target');
            setMergeConfirmSourceCategory('');
            await loadTags();
            showToast(`${data.changedItems || 0} ${t('tagItemsUpdated', 'Eintr\u00E4ge aktualisiert')}`, 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + err.message, 'error');
        } finally {
            setBusyAction('');
        }
    };

    const toggleMergeSource = (name) => {
        const key = String(name || '').toLowerCase();
        setMergeSource((prev) => (
            prev.some((tag) => String(tag).toLowerCase() === key)
                ? prev.filter((tag) => String(tag).toLowerCase() !== key)
                : [...prev, name]
        ));
    };

    const openDeleteConfirm = (tagName) => {
        setConfirmDialog({
            title: t('tagDeleteConfirmTitle', 'Tag l\u00F6schen?'),
            message: `${t('tagDeleteConfirmText', 'Dieses Tag wird von allen Eintr\u00E4gen entfernt')}: #${tagName}`,
            confirmLabel: t('remove', 'Entfernen'),
            danger: true,
            onConfirm: () => executeDelete(tagName),
        });
    };

    const openMergeConfirm = () => {
        const targetTag = String(mergeTarget || '').trim();
        const normalizedSources = [...new Set(mergeSource.map((tag) => String(tag || '').trim()).filter(Boolean))];
        if (!targetTag || normalizedSources.length === 0) return;
        const defaultMode = mergeTargetCategory ? 'target' : 'source';
        const defaultSourceCategory = mergeSourceCategories[0] || '';
        const defaultCategory = defaultMode === 'target' ? mergeTargetCategory : defaultSourceCategory;
        setMergeConfirmMode(defaultMode);
        setMergeConfirmSourceCategory(defaultSourceCategory);
        setMergeConfirmCategory(defaultCategory);
        setConfirmDialog({
            title: t('tagMergeConfirmTitle', 'Tags zusammenf\u00FChren?'),
            message: `${normalizedSources.join(', ')} ${t('tagMergeInto', 'werden zusammengef\u00FChrt in')} #${targetTag}`,
            confirmLabel: t('tagMergeAction', 'Zusammenf\u00FChren'),
            danger: false,
            type: 'merge',
            targetCategory: mergeTargetCategory,
            sourceCategories: mergeSourceCategories,
            onConfirm: null,
        });
    };

    const handleConfirmDialog = async () => {
        if (!confirmDialog) return;
        const dialog = confirmDialog;
        setConfirmDialog(null);
        if (dialog.type === 'merge') {
            await executeMerge(mergeConfirmCategory);
            return;
        }
        const action = dialog.onConfirm;
        if (typeof action === 'function') await action();
    };

    useDialogHotkeys({
        open: !!confirmDialog,
        onCancel: () => setConfirmDialog(null),
        onConfirm: handleConfirmDialog,
        canConfirm: !!confirmDialog,
        allowEnterInInputs: false,
    });

    const createTag = async () => {
        const tagName = String(createTagName || '').trim();
        const category = String(createCategory || '').trim();
        if (!tagName) return;
        setBusyAction('create');
        try {
            const res = await fetch('/api/tags/manager/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tagName, category }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('settingsServerError', 'Server-Fehler'));
            setCreateTagName('');
            setCreateCategory('');
            await loadTags();
            window.dispatchEvent(new Event('tag-categories-changed'));
            showToast(t('saved', 'Gespeichert'), 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        } finally {
            setBusyAction('');
        }
    };

    const saveTagCategory = async (tagName, category) => {
        try {
            const res = await fetch('/api/tags/categories/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tagName, category }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || t('settingsServerError', 'Server-Fehler'));
            setTags(prev => prev.map((item) => (
                String(item.name || '').toLowerCase() === String(tagName || '').toLowerCase()
                    ? { ...item, category: String(category || '').trim() }
                    : item
            )));
            setCategoryDrafts((prev) => ({ ...prev, [tagName]: String(category || '').trim() }));
            window.dispatchEvent(new Event('tag-categories-changed'));
            showToast(t('saved', 'Gespeichert'), 'success');
        } catch (err) {
            showToast(t('errorPrefix', 'Fehler: ') + (err.message || ''), 'error');
        }
    };
    const commitTagCategory = (tagName) => {
        const current = String(
            tags.find((item) => String(item.name || '').toLowerCase() === String(tagName || '').toLowerCase())?.category || ''
        ).trim();
        const next = String(categoryDrafts[tagName] || '').trim();
        if (next === current) return;
        saveTagCategory(tagName, next);
    };

    return (
        <div className="settings-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">{t('tagManagerTitle', 'Tag-Manager')}</h1>
                    <p className="page-subtitle">{t('tagManagerSubtitle', 'Tags umbenennen, zusammenf\u00FChren, l\u00F6schen und Nutzung sehen')}</p>
                </div>
            </div>

            <div className="settings-section tag-manager-toolbar">
                <div className="settings-input-row">
                    <div className="settings-search-wrap">
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={t('searchTagsPlaceholder', 'Tags suchen...')}
                        />
                        {search ? (
                            <button
                                type="button"
                                className="search-clear-btn compact"
                                onClick={() => setSearch('')}
                                aria-label={t('clearSearch', 'Clear search')}
                                title={t('clearSearch', 'Clear search')}
                            >
                                ×
                            </button>
                        ) : null}
                    </div>
                    <AppDropdown
                        className="tag-manager-select"
                        value={categoryFilter}
                        usePortal={true}
                        portalOffset={0}
                        onChange={setCategoryFilter}
                        options={[
                            { value: '', label: t('allCategories', 'All categories') },
                            ...knownCategories.map((cat) => ({ value: cat, label: cat })),
                        ]}
                    />
                </div>
                <div className="funscript-manager-tabbar-wrap">
                    <div className="funscript-manager-tabs" role="tablist" aria-label={t('tagManagerTabsAria', 'Tag manager tabs')}>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'create'}
                            className={`funscript-manager-tab ${activeTab === 'create' ? 'active' : ''}`}
                            onClick={() => setActiveTab('create')}
                        >
                            {t('tagManagerTabCreate', 'Create tag')}
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'merge'}
                            className={`funscript-manager-tab ${activeTab === 'merge' ? 'active' : ''}`}
                            onClick={() => setActiveTab('merge')}
                        >
                            {t('tagManagerTabMerge', 'Merge tags')}
                        </button>
                    </div>
                </div>
                {activeTab === 'merge' && (
                    <>
                        <div className="tag-merge-row">
                            <AppDropdown
                                className="tag-manager-select"
                                value=""
                                usePortal={true}
                                portalOffset={0}
                                placeholder={t('tagMergeAddSource', 'Quell-Tag hinzufuegen...')}
                                onChange={(val) => {
                                    if (val) toggleMergeSource(val);
                                }}
                                options={knownTags
                                    .filter((tag) => !mergeSource.some((selected) => selected.toLowerCase() === tag.toLowerCase()))
                                    .map((tag) => ({ value: tag, label: tag }))}
                            />
                            <div className={`tag-manager-input-wrap ${mergeSuggestOpen ? 'open' : ''}`}>
                                <input
                                    className="tag-manager-input"
                                    type="text"
                                    value={mergeTarget}
                                    onChange={(e) => setMergeTarget(e.target.value)}
                                    onFocus={() => setMergeSuggestOpen(true)}
                                    onBlur={() => setTimeout(() => setMergeSuggestOpen(false), 120)}
                                    placeholder={t('tagMergeTarget', 'Ziel-Tag')}
                                />
                                <span className="tag-field-caret" aria-hidden="true" />
                                {mergeSuggestOpen && mergeSuggestions.length > 0 && (
                                    <div className="tag-manager-suggest-list">
                                        {mergeSuggestions.map((tag) => (
                                            <button
                                                key={tag}
                                                type="button"
                                                className="tag-manager-suggest-item"
                                                onMouseDown={(e) => {
                                                    e.preventDefault();
                                                    setMergeTarget(tag);
                                                    setMergeSuggestOpen(false);
                                                }}
                                            >
                                                {tag}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <button className="btn btn-primary" onClick={openMergeConfirm} disabled={busyAction === 'merge' || !mergeTarget || mergeSource.length === 0}>
                                {busyAction === 'merge' ? t('saving', 'Speichere...') : t('tagMergeAction', 'Zusammenf\u00FChren')}
                            </button>
                        </div>
                        {mergeSource.length > 0 && (
                            <div className="tag-chip-list">
                                {mergeSource.map((tag) => (
                                    <button key={tag} className="tag-chip" onClick={() => toggleMergeSource(tag)}>
                                        <span>{tag}</span>
                                        <span className="tag-chip-x">x</span>
                                    </button>
                                ))}
                            </div>
                        )}
                    </>
                )}
                {activeTab === 'create' && (
                    <div className="tag-merge-row tag-create-row">
                        <input
                            className="tag-manager-input"
                            type="text"
                            value={createTagName}
                            onChange={(e) => setCreateTagName(e.target.value)}
                            placeholder={t('tagCreateName', 'Create tag...')}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    createTag();
                                }
                            }}
                        />
                        <div className={`tag-manager-input-wrap ${createCategorySuggestOpen ? 'open' : ''}`}>
                            <input
                                className="tag-manager-input"
                                type="text"
                                value={createCategory}
                                onChange={(e) => setCreateCategory(e.target.value)}
                                onFocus={() => setCreateCategorySuggestOpen(true)}
                                onBlur={() => setTimeout(() => setCreateCategorySuggestOpen(false), 120)}
                                placeholder={t('tagCategoryInputHint', 'Type or choose category')}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        createTag();
                                    }
                                }}
                            />
                            <span className="tag-field-caret" aria-hidden="true" />
                            {createCategorySuggestOpen && createCategorySuggestions.length > 0 && (
                                <div className="tag-manager-suggest-list">
                                    {createCategorySuggestions.map((cat) => (
                                        <button
                                            key={cat}
                                            type="button"
                                            className="tag-manager-suggest-item"
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                setCreateCategory(cat);
                                                setCreateCategorySuggestOpen(false);
                                            }}
                                        >
                                            {cat}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button
                            className="btn btn-primary"
                            onClick={createTag}
                            disabled={busyAction === 'create' || !String(createTagName || '').trim()}
                        >
                            {busyAction === 'create' ? t('saving', 'Speichere...') : t('tagCreateAction', 'Create')}
                        </button>
                    </div>
                )}
            </div>

            <div className="settings-section tag-manager-list">
                {loading ? (
                    <div className="tag-empty">{t('loadingLoad', 'Lade...')}</div>
                ) : filteredTags.length === 0 ? (
                    <div className="tag-empty">{t('noTagsYet', 'Noch keine Tags')}</div>
                ) : (
                    filteredTags.map((tag) => {
                        const tagName = String(tag.name || '');
                        const isRenaming = busyAction === `rename:${tagName}`;
                        const isDeleting = busyAction === `delete:${tagName}`;
                        const mergeChecked = mergeSource.some((item) => item.toLowerCase() === tagName.toLowerCase());
                        return (
                            <div key={tagName} className={`tag-manager-item ${activeTab === 'create' ? 'no-select' : ''}`}>
                                {activeTab === 'merge' && (
                                    <label className="tag-manager-check">
                                        <input
                                            type="checkbox"
                                            checked={mergeChecked}
                                            onChange={() => toggleMergeSource(tagName)}
                                        />
                                        <span />
                                    </label>
                                )}
                                <div className="tag-manager-main">
                                    <div className="tag-manager-name">#{tagName}</div>
                                    <div className="tag-manager-counts">
                                        <span>{t('category', 'Category')}:</span>
                                        <div className={`tag-manager-input-wrap ${categorySuggestOpenFor === tagName ? 'open' : ''}`}>
                                            <input
                                                className="tag-manager-input"
                                                type="text"
                                                value={Object.prototype.hasOwnProperty.call(categoryDrafts, tagName)
                                                    ? String(categoryDrafts[tagName] || '')
                                                    : String(tag.category || '')}
                                                onChange={(e) => {
                                                    const value = e.target.value;
                                                    setCategoryDrafts((prev) => ({ ...prev, [tagName]: value }));
                                                }}
                                                onFocus={() => setCategorySuggestOpenFor(tagName)}
                                                onBlur={() => {
                                                    setTimeout(() => setCategorySuggestOpenFor(''), 120);
                                                    commitTagCategory(tagName);
                                                }}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        e.preventDefault();
                                                        commitTagCategory(tagName);
                                                    }
                                                }}
                                                placeholder={t('tagCategoryInputHint', 'Type or choose category')}
                                            />
                                            <span className="tag-field-caret" aria-hidden="true" />
                                            {categorySuggestOpenFor === tagName && (
                                                <div className="tag-manager-suggest-list">
                                                    {[...new Set(['Artist', 'Studio', 'Series', 'Genre', 'Misc', ...knownCategories])]
                                                        .filter(Boolean)
                                                        .sort((a, b) => a.localeCompare(b))
                                                        .filter((cat) => {
                                                            const q = String(
                                                                Object.prototype.hasOwnProperty.call(categoryDrafts, tagName)
                                                                    ? categoryDrafts[tagName]
                                                                    : String(tag.category || '')
                                                            ).trim().toLowerCase();
                                                            return !q || cat.toLowerCase().includes(q);
                                                        })
                                                        .slice(0, 8)
                                                        .map((cat) => (
                                                            <button
                                                                key={cat}
                                                                type="button"
                                                                className="tag-manager-suggest-item"
                                                                onMouseDown={(e) => {
                                                                    e.preventDefault();
                                                                    setCategoryDrafts((prev) => ({ ...prev, [tagName]: cat }));
                                                                    setCategorySuggestOpenFor('');
                                                                    saveTagCategory(tagName, cat);
                                                                }}
                                                            >
                                                                {cat}
                                                            </button>
                                                        ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    <div className="tag-manager-counts">
                                        <span className="sidebar-count">{tag.usageCount || 0}</span>
                                        <span>{t('tagUsageTotal', 'gesamt')}</span>
                                        <span className="sidebar-count">{tag.videoCount || 0}</span>
                                        <span>{t('videosLabel', 'Videos')}</span>
                                        <span className="sidebar-count">{tag.folderCount || 0}</span>
                                        <span>{t('seriesLabel', 'Serien')}</span>
                                    </div>
                                </div>
                                <div className="tag-manager-actions">
                                    <div className={`tag-manager-input-wrap ${renameSuggestOpenFor === tagName ? 'open' : ''}`}>
                                        <input
                                            className="tag-manager-input"
                                            type="text"
                                            value={renameDrafts[tagName] || ''}
                                            onChange={(e) => setRenameDrafts((prev) => ({ ...prev, [tagName]: e.target.value }))}
                                            onFocus={() => setRenameSuggestOpenFor(tagName)}
                                            onBlur={() => setTimeout(() => setRenameSuggestOpenFor(''), 120)}
                                            placeholder={t('tagRenamePlaceholder', 'Neuer Name')}
                                        />
                                        {renameSuggestOpenFor === tagName && (
                                            <div className="tag-manager-suggest-list">
                                                {knownTags
                                                    .filter((name) => name.toLowerCase() !== tagName.toLowerCase())
                                                    .filter((name) => {
                                                        const q = String(renameDrafts[tagName] || '').trim().toLowerCase();
                                                        return !q || name.toLowerCase().includes(q);
                                                    })
                                                    .slice(0, 8)
                                                    .map((name) => (
                                                        <button
                                                            key={name}
                                                            type="button"
                                                            className="tag-manager-suggest-item"
                                                            onMouseDown={(e) => {
                                                                e.preventDefault();
                                                                setRenameDrafts((prev) => ({ ...prev, [tagName]: name }));
                                                                setRenameSuggestOpenFor('');
                                                            }}
                                                        >
                                                            {name}
                                                        </button>
                                                    ))}
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => handleRename(tagName)}
                                        disabled={isRenaming || !(renameDrafts[tagName] || '').trim()}
                                    >
                                        {isRenaming ? t('saving', 'Speichere...') : t('tagRenameAction', 'Umbenennen')}
                                    </button>
                                    <button className="btn btn-danger tag-manager-remove-btn" onClick={() => openDeleteConfirm(tagName)} disabled={isDeleting}>
                                        {isDeleting ? t('saving', 'Speichere...') : t('remove', 'Entfernen')}
                                    </button>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {confirmDialog && (
                <div className="modal-overlay" onClick={() => setConfirmDialog(null)}>
                    <div className="modal tag-manager-confirm-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="modal-header">
                            <h2 className="modal-title">{confirmDialog.title}</h2>
                            <button className="modal-close" onClick={() => setConfirmDialog(null)} title={t('close', 'Schlie\u00DFen')}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <line x1="18" y1="6" x2="6" y2="18" />
                                    <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        </div>
                        <div className="modal-body">
                            <p className="tag-manager-confirm-text">{confirmDialog.message}</p>
                            {confirmDialog.type === 'merge' && (
                                <div className="tag-manager-confirm-merge-category">
                                    <label className="tag-merge-category-option">
                                        <input
                                            type="radio"
                                            name="merge-confirm-category-mode"
                                            checked={mergeConfirmMode === 'target'}
                                            onChange={() => {
                                                setMergeConfirmMode('target');
                                                setMergeConfirmCategory(String(confirmDialog.targetCategory || '').trim());
                                            }}
                                        />
                                        <span>
                                            {t('tagMergeUseTargetCategory', 'Use target category')}: {String(confirmDialog.targetCategory || '').trim() || t('none', 'None')}
                                        </span>
                                    </label>
                                    <label className="tag-merge-category-option">
                                        <input
                                            type="radio"
                                            name="merge-confirm-category-mode"
                                            checked={mergeConfirmMode === 'source'}
                                            onChange={() => {
                                                const sourceCat = mergeConfirmSourceCategory || String(confirmDialog.sourceCategories?.[0] || '').trim();
                                                setMergeConfirmMode('source');
                                                setMergeConfirmSourceCategory(sourceCat);
                                                setMergeConfirmCategory(sourceCat);
                                            }}
                                        />
                                        <span>{t('tagMergeUseSourceCategory', 'Use source category')}</span>
                                    </label>
                                    {mergeConfirmMode === 'source' && (
                                        <div className="tag-manager-confirm-merge-row">
                                            <span>{t('category', 'Category')}</span>
                                            <AppDropdown
                                                className="tag-manager-select"
                                                value={mergeConfirmSourceCategory}
                                                usePortal={true}
                                                portalOffset={0}
                                                onChange={(val) => {
                                                    setMergeConfirmSourceCategory(val);
                                                    setMergeConfirmCategory(val);
                                                }}
                                                options={[
                                                    { value: '', label: t('none', 'None') },
                                                    ...(Array.isArray(confirmDialog.sourceCategories)
                                                        ? confirmDialog.sourceCategories.map((cat) => ({ value: cat, label: cat }))
                                                        : []),
                                                ]}
                                            />
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setConfirmDialog(null)}>
                                {t('cancel', 'Abbrechen')}
                            </button>
                            <button
                                className={`btn ${confirmDialog.danger ? 'btn-danger' : 'btn-primary'}`}
                                onClick={handleConfirmDialog}
                            >
                                {confirmDialog.confirmLabel}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
    );
}

export default TagManager;





