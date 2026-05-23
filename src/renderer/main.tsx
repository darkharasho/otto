import '@fontsource/plus-jakarta-sans/400.css';
import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsApp } from './SettingsApp';
import { OverlayApp } from './OverlayApp';
import './index.css';

const hash = window.location.hash;
const isSettings = hash === '#settings';
const isOverlay = hash === '#overlay';

if (isSettings) {
  // Esc closes the settings window — matches its native dialog feel.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });
}

const root = createRoot(document.getElementById('root')!);
root.render(isSettings ? <SettingsApp /> : isOverlay ? <OverlayApp /> : <App />);
