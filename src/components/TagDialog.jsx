import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function normalizeTags(tags) {
    const arr = Array.isArray(tags) ? tags : [];
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
        const value = String(raw || '').trim();
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}

function TagDialog({ title, initialTags, suggestions = [], onSave, onCancel }) {
    const { t } = useI18n();
    const [tags, setTags] = useState(() => normalizeTags(initialTags));
    const [input, setInput] = useState('');
    const [saving, setSaving] = useState(false);
    const [categories, setCategories] = useState([]);
    const [categoryMap, setCategoryMap] = useState({});
    const [selectedCategory, setSelectedCategory] = useState('');
    const [categorySuggestOpen, setCategorySuggestOpen] = useState(false);
    const [tagSuggestOpen, setTagSuggestOpen] = useState(false);


    useEffect(() => {
        setTags(normalizeTags(initialTags));
    }, [initialTags]);

    useEffect(() => {
        let cancelled = false;
        fetch('/api/tags/categories')
            .then(res => (res.ok ? res.json() : null))
            .then((data) => {
                if (cancelled || !data) return;
                const categoryValues = Array.isArray(data.categories)
                    ? data.categories.map(v => String(v || '').trim()).filter(Boolean)
                    : [];
                setCategories(categoryValues);
                setCategoryMap(data.map && typeof data.map === 'object' ? data.map : {});
            })
            .catch(() => { });
        return () => { cancelled = true; };
    }, []);

    const canAdd = useMemo(() => input.trim().length > 0, [input]);
    const suggestionOptions = useMemo(() => normalizeTags(suggestions), [suggestions]);
    const defaultCategoryOptions = useMemo(() => ([
        'Artist',
        'Studio',
        'Series',
        'Genre',
        'Misc',
    ]), []);
    const categoryOptions = useMemo(() => (
        [...new Set([...defaultCategoryOptions, ...categories])]
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
    ), [categories, defaultCategoryOptions]);
    const categorySuggestions = useMemo(() => {
        const q = String(selectedCategory || '').trim().toLowerCase();
        return categoryOptions
            .filter((cat) => !q || cat.toLowerCase().includes(q))
            .slice(0, 8);
    }, [categoryOptions, selectedCategory]);
    const resolveTagCategory = (tagName) => {
        const key = String(tagName || '').trim().toLowerCase();
        return String(categoryMap?.[key]?.category || '').trim();
    };
    const matchingSuggestions = useMemo(() => {
        const q = input.trim().toLowerCase();
        const selected = new Set(tags.map(tag => tag.toLowerCase()));
        let base = suggestionOptions
            .filter(tag => !selected.has(tag.toLowerCase()))
            .filter(tag => !q || tag.toLowerCase().includes(q));
        if (selectedCategory) {
            const wanted = String(selectedCategory).toLowerCase();
            base = base.filter(tag => resolveTagCategory(tag).toLowerCase() === wanted);
        }
        return base.slice(0, 12);
    }, [suggestionOptions, tags, input, selectedCategory, categoryMap]);

    const persistCategory = async (tagName, categoryValue) => {
        const tag = String(tagName || '').trim();
        const category = String(categoryValue || '').trim();
        if (!tag) return;
        try {
            await fetch('/api/tags/categories/set', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tagName: tag, category }),
            });
            const key = tag.toLowerCase();
            setCategoryMap(prev => ({ ...prev, [key]: { tagName: tag, category } }));
            if (category) {
                setCategories(prev => [...new Set([...prev, category])].sort((a, b) => a.localeCompare(b)));
            }
            window.dispatchEvent(new Event('tag-categories-changed'));
        } catch { }
    };

    const addTag = () => {
        const value = input.trim();
        if (!value) return;
        setTags(prev => normalizeTags([...prev, value]));
        const category = selectedCategory || resolveTagCategory(value);
        if (category) persistCategory(value, category);
        setInput('');
    };

    const addSuggestionTag = (value) => {
        const tag = String(value || '').trim();
        if (!tag) return;
        setTags(prev => normalizeTags([...prev, tag]));
        const category = selectedCategory || resolveTagCategory(tag);
        if (category) persistCategory(tag, category);
        setInput('');
        setTagSuggestOpen(false);
    };

    const removeTag = (tag) => {
        setTags(prev => prev.filter(tg => tg !== tag));
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const pending = input.trim();
            if (pending) {
                const category = selectedCategory || resolveTagCategory(pending);
                if (category) {
                    await persistCategory(pending, category);
                }
            }
            const finalTags = pending ? normalizeTags([...tags, pending]) : normalizeTags(tags);
            await onSave(finalTags);
        } finally {
            setSaving(false);
        }
    };

    useDialogHotkeys({
        open: true,
        onCancel,
        onConfirm: handleSave,
        canConfirm: !saving,
        allowEnterInInputs: false,
    });

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal tag-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2 className="modal-title">{title || t('editTags', 'Tags bearbeiten')}</h2>
                    <button className="modal-close" onClick={onCancel}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                </div>

                <div className="modal-body">
                    <div className="tag-dialog-input-row">
                        <div className="tag-manager-input-wrap">
                            <input
                                className="tag-manager-input"
                                type="text"
                                value={selectedCategory}
                                onChange={(e) => setSelectedCategory(e.target.value)}
                                onFocus={() => setCategorySuggestOpen(true)}
                                onBlur={() => setTimeout(() => setCategorySuggestOpen(false), 120)}
                                placeholder={t('tagCategoryInputHint', 'Type a new category or choose an existing one')}
                                title={t('tagCategoryInputHint', 'Type a new category or choose an existing one')}
                            />
                            <span className="tag-field-caret" aria-hidden="true" />
                            {categorySuggestOpen && categorySuggestions.length > 0 && (
                                <div className="tag-manager-suggest-list">
                                    {categorySuggestions.map((cat) => (
                                        <button
                                            key={cat}
                                            type="button"
                                            className="tag-manager-suggest-item"
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                setSelectedCategory(cat);
                                                setCategorySuggestOpen(false);
                                            }}
                                        >
                                            {cat}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className={`tag-manager-input-wrap ${tagSuggestOpen && matchingSuggestions.length > 0 ? 'open' : ''}`}>
                            <input
                                className="tag-manager-input"
                                type="text"
                                value={input}
                                onChange={(e) => setInput(e.target.value)}
                                onFocus={() => setTagSuggestOpen(true)}
                                onBlur={() => setTimeout(() => setTagSuggestOpen(false), 120)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        addTag();
                                    }
                                }}
                                placeholder={t('tagInputPlaceholder', 'Tag eingeben...')}
                            />
                            <span className="tag-field-caret" aria-hidden="true" />
                            {tagSuggestOpen && matchingSuggestions.length > 0 && (
                                <div className="tag-manager-suggest-list">
                                    {matchingSuggestions.map(tag => (
                                        <button
                                            key={tag}
                                            type="button"
                                            className="tag-manager-suggest-item"
                                            onMouseDown={(e) => {
                                                e.preventDefault();
                                                addSuggestionTag(tag);
                                            }}
                                        >
                                            {resolveTagCategory(tag) ? `[${resolveTagCategory(tag)}] ` : ''}{tag}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                        <button className="btn btn-secondary" onClick={addTag} disabled={!canAdd}>
                            {t('add', 'Hinzufuegen')}
                        </button>
                    </div>

                    {matchingSuggestions.length > 0 && (
                        <div className="tag-suggestion-list">
                            {matchingSuggestions.map(tag => (
                                <button
                                    key={tag}
                                    type="button"
                                    className="tag-suggestion-chip"
                                    onClick={() => {
                                        setTags(prev => normalizeTags([...prev, tag]));
                                        const category = selectedCategory || resolveTagCategory(tag);
                                        if (category) persistCategory(tag, category);
                                        setInput('');
                                    }}
                                >
                                    {resolveTagCategory(tag) ? `[${resolveTagCategory(tag)}] ` : ''}{tag}
                                </button>
                            ))}
                        </div>
                    )}

                    <div className="tag-chip-list">
                        {tags.length === 0 && (
                            <div className="tag-empty">{t('noTagsYet', 'Noch keine Tags')}</div>
                        )}
                        {tags.map(tag => (
                            <button key={tag} className="tag-chip" onClick={() => removeTag(tag)} title={t('removeTag', 'Tag entfernen')}>
                                <span>{resolveTagCategory(tag) ? `${resolveTagCategory(tag)}: ` : ''}{tag}</span>
                                <span className="tag-chip-x">x</span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="modal-footer">
                    <button className="btn btn-secondary" onClick={onCancel}>{t('cancel', 'Abbrechen')}</button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        {saving ? t('saving', 'Speichere...') : t('saveLabel', 'Speichern')}
                    </button>
                </div>
            </div>
        </div>
    );
}

export default TagDialog;
