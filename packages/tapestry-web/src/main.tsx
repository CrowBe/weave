import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Host } from './host';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing root');
createRoot(root).render(
  <StrictMode>
    <Host />
  </StrictMode>,
);
