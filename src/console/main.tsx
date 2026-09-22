import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { watchSystemTheme } from './theme.ts';
import './styles.css';

// The theme class is already on <html> — `index.html` sets it inline, before
// first paint, so there is no white flash. This only subscribes to the two
// ways the answer can change afterwards: the OS flipping while `system` is
// selected, and another tab picking a theme.
watchSystemTheme();

createRoot(document.getElementById('root')!).render(<App />);
