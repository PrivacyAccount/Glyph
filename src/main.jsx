import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import './styles/feature-misc.css';
import './styles/modern-theme.css';
import './styles/settings.css';
import './styles/dashboard.css';
import './styles/home.css';
import './styles/library.css';
import { I18nProvider } from './i18n';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <I18nProvider>
            <App />
        </I18nProvider>
    </React.StrictMode>
);





