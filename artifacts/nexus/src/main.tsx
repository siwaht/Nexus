import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';

import './index.css';

// Self-hosted split deployment: when the API lives on a different origin,
// set VITE_API_URL at build time so all generated API calls reach it
// (cookies travel cross-origin via credentials: 'include' + CORS).
const apiUrl = import.meta.env.VITE_API_URL;
if (apiUrl) setBaseUrl(apiUrl);

createRoot(document.getElementById('root')!).render(<App />);
