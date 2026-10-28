import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installAssetRecovery } from './lib/asset-recovery';
import './index.css';

installAssetRecovery();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
