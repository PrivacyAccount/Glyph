import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

function AppDropdown({
    value,
    options = [],
    onChange,
    placeholder = '',
    disabled = false,
    className = '',
    menuClassName = '',
    itemClassName = '',
    ariaLabel = '',
    openUpward = false,
    usePortal = false,
    portalOffset = 6,
}) {
    const rootRef = useRef(null);
    const menuRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [portalStyle, setPortalStyle] = useState(null);
    const [portalOpenUpward, setPortalOpenUpward] = useState(false);

    const normalizedOptions = useMemo(() => (
        (Array.isArray(options) ? options : []).map((opt) => ({
            value: String(opt?.value ?? ''),
            label: String(opt?.label ?? ''),
        }))
    ), [options]);

    const selected = normalizedOptions.find((opt) => opt.value === String(value ?? ''));
    const displayLabel = selected?.label || placeholder || '';

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
            const target = event.target;
            const inTrigger = rootRef.current?.contains(target);
            const inMenu = menuRef.current?.contains(target);
            if (!inTrigger && !inMenu) setOpen(false);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    useLayoutEffect(() => {
        if (!open || !usePortal) return undefined;
        const update = () => {
            const trigger = rootRef.current?.querySelector('.app-dropdown-trigger');
            if (!trigger) return;
            const rect = trigger.getBoundingClientRect();
            const offset = Number.isFinite(Number(portalOffset)) ? Number(portalOffset) : 6;
            const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 800;
            const availableBelow = Math.max(0, viewportHeight - rect.bottom - offset - 8);
            const availableAbove = Math.max(0, rect.top - offset - 8);
            const shouldOpenUpward = openUpward === true;
            const effectiveSpace = shouldOpenUpward ? availableAbove : availableBelow;
            const maxHeight = Math.max(80, Math.min(320, effectiveSpace));
            const top = shouldOpenUpward ? rect.top - offset : rect.bottom + offset;
            setPortalOpenUpward(shouldOpenUpward);
            setPortalStyle({
                left: `${rect.left}px`,
                top: `${top}px`,
                width: `${rect.width}px`,
                maxHeight: `${maxHeight}px`,
                transform: shouldOpenUpward ? 'translateY(-100%)' : 'none',
            });
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
            window.removeEventListener('resize', update);
            window.removeEventListener('scroll', update, true);
        };
    }, [open, usePortal, openUpward]);

    useEffect(() => {
        if (!open) {
            setPortalStyle(null);
            setPortalOpenUpward(false);
        }
    }, [open]);

    const menuUpward = usePortal ? portalOpenUpward : openUpward;

    const menu = (
        <div
            ref={menuRef}
            className={`app-dropdown-menu ${menuUpward ? 'upward' : ''} ${usePortal ? 'portal' : ''} ${menuClassName}`.trim()}
            style={usePortal ? portalStyle || undefined : undefined}
            onWheel={(event) => {
                // Keep wheel scrolling inside the dropdown menu and avoid scrolling parent containers (modals/lists).
                event.stopPropagation();
            }}
        >
            {normalizedOptions.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    className={`app-dropdown-item ${itemClassName} ${String(opt.value) === String(value ?? '') ? 'active' : ''}`.trim()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                        onChange?.(opt.value);
                        setOpen(false);
                    }}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );

    return (
        <div ref={rootRef} className={`app-dropdown ${open ? 'open' : ''} ${menuUpward ? 'upward' : ''} ${className}`.trim()}>
            <button
                type="button"
                className={`app-dropdown-trigger ${open ? 'open' : ''}`.trim()}
                aria-label={ariaLabel || placeholder || 'Dropdown'}
                aria-expanded={open}
                onClick={() => {
                    if (disabled) return;
                    setOpen((prev) => !prev);
                }}
                disabled={disabled}
            >
                <span className="app-dropdown-label">{displayLabel}</span>
                <span className="app-dropdown-caret" aria-hidden="true" />
            </button>
            {open && !disabled && (usePortal ? (portalStyle ? createPortal(menu, document.body) : null) : menu)}
        </div>
    );
}

export default AppDropdown;
