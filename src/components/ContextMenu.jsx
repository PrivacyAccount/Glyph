import React, { useEffect, useRef } from 'react';

function ContextMenu({ x, y, items, onClose }) {
    const menuRef = useRef(null);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                onClose();
            }
        };
        const handleEscape = (e) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [onClose]);

    // Adjust position to stay within viewport
    useEffect(() => {
        if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const el = menuRef.current;
            if (rect.right > window.innerWidth) {
                el.style.left = `${window.innerWidth - rect.width - 8}px`;
            }
            if (rect.bottom > window.innerHeight) {
                el.style.top = `${window.innerHeight - rect.height - 8}px`;
            }
        }
    }, [x, y]);

    return (
        <div className="context-menu" ref={menuRef} style={{ left: x, top: y }}>
            {items.map((item, i) => {
                if (item.separator) {
                    return <div key={i} className="context-menu-separator" />;
                }
                return (
                    <button
                        key={i}
                        className="context-menu-item"
                        onClick={() => {
                            item.onClick();
                            onClose();
                        }}
                    >
                        {item.icon && <span className="context-menu-icon">{item.icon}</span>}
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

export default ContextMenu;
