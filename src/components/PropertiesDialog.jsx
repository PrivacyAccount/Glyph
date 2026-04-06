import React, { useState, useEffect } from 'react';
import { useI18n } from '../i18n';
import useDialogHotkeys from '../hooks/useDialogHotkeys';

function PropertiesDialog({ video, onClose }) {
    const { t } = useI18n();
    const [details, setDetails] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const videoId = video?.id;

    useDialogHotkeys({
        open: !!video,
        onCancel: onClose,
        onConfirm: onClose,
        canConfirm: true,
    });

    useEffect(() => {
        if (!videoId) return;

        const fetchDetails = async () => {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/videos/${videoId}/details`);
                if (!res.ok) throw new Error(t('detailsLoadError', 'Details konnten nicht geladen werden'));
                const data = await res.json();
                setDetails(data);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };

        fetchDetails();
    }, [videoId, t]);

    if (!video) return null;

    const formatSize = (bytes) => {
        if (!bytes) return t('unknown', 'Unbekannt');
        const mb = bytes / (1024 * 1024);
        if (mb > 1024) return `${(mb / 1024).toFixed(2)} GB`;
        return `${mb.toFixed(2)} MB`;
    };

    const formatDuration = (seconds) => {
        if (!seconds) return t('unknown', 'Unbekannt');
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    const formatBitrate = (bps) => {
        if (!bps) return t('unknown', 'Unbekannt');
        return `${(bps / 1000 / 1000).toFixed(1)} Mbps`;
    };

    return (
        <div className="properties-dialog-overlay" onClick={onClose}>
            <div className="properties-dialog" onClick={e => e.stopPropagation()}>
                <h3>{t('properties', 'Eigenschaften')}</h3>

                <div className="properties-content">
                    <div className="property-row">
                        <span className="property-label">{t('file', 'Datei')}:</span>
                        <span className="property-value" title={video.fileName || video.name}>{video.fileName || video.name}</span>
                    </div>

                    {loading && <div className="spinner"></div>}

                    {error && (
                        <div className="error-message">
                            {error}
                            <br />
                            <small style={{ opacity: 0.7 }}>{t('serverRestartHint', '(Wurde der Server neu gestartet?)')}</small>
                        </div>
                    )}

                    {details && (
                        <>
                            <div className="property-row">
                                <span className="property-label">{t('resolution', 'Aufloesung')}:</span>
                                <span className="property-value">{details.width} x {details.height}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('duration', 'Dauer')}:</span>
                                <span className="property-value">{formatDuration(details.duration)}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('size', 'Groesse')}:</span>
                                <span className="property-value">{formatSize(details.size)}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('bitrate', 'Bitrate')}:</span>
                                <span className="property-value">{formatBitrate(details.bit_rate)}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('codec', 'Codec')}:</span>
                                <span className="property-value">{details.codec_name}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('format', 'Format')}:</span>
                                <span className="property-value">{details.format_name}</span>
                            </div>
                            <div className="property-row">
                                <span className="property-label">{t('path', 'Pfad')}:</span>
                                <span className="property-value path-value" title={details.path}>{details.path}</span>
                            </div>
                        </>
                    )}
                </div>

                <div className="dialog-actions">
                    <button onClick={onClose} className="btn btn-secondary dialog-close-btn">{t('close', 'Schliessen')}</button>
                </div>
            </div>
            <style jsx>{`
                .properties-dialog-overlay {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0, 0, 0, 0.7);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    backdrop-filter: blur(5px);
                }
                .properties-dialog {
                    background: var(--bg-card);
                    padding: 24px;
                    border-radius: 12px;
                    width: 450px;
                    max-width: 90%;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    display: flex;
                    flex-direction: column;
                    border: 1px solid var(--border-subtle);
                    animation: dialogFadeIn 0.2s ease-out;
                }
                @keyframes dialogFadeIn {
                    from { transform: scale(0.95); opacity: 0; }
                    to { transform: scale(1); opacity: 1; }
                }
                .properties-dialog h3 {
                    margin: 0 0 20px 0;
                    font-size: 1.4rem;
                    color: var(--text-primary);
                }
                .property-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 10px 0;
                    border-bottom: 1px solid var(--border-subtle);
                }
                .property-row:last-child {
                    border-bottom: none;
                }
                .property-label {
                    color: var(--text-secondary);
                    font-weight: 500;
                }
                .property-value {
                    color: var(--text-primary);
                    text-align: right;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    max-width: 65%;
                    font-family: monospace;
                    font-size: 0.95rem;
                }
                .path-value {
                    font-size: 0.8em;
                    direction: rtl; 
                    text-align: left;
                    opacity: 0.7;
                }
                .properties-content {
                    margin-bottom: 24px;
                }
                .dialog-actions {
                    display: flex;
                    justify-content: flex-end;
                }
                .dialog-close-btn {
                    min-width: 100px;
                    justify-content: center;
                }
                .error-message {
                    color: #ff6b6b;
                    background: rgba(255,107,107,0.1);
                    padding: 10px;
                    border-radius: 4px;
                    text-align: center;
                }
            `}</style>
        </div>
    );
}

export default PropertiesDialog;
