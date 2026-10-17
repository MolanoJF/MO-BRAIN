import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { watchSystemTheme } from './theme.ts';
import './styles.css';

watchSystemTheme();
createRoot(document.getElementById('root')!).render(<App />);
