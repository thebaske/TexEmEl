import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './ui/styles/global.css';
import './ui/styles/editor.css';
import './core/engine/css/engine.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
