import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
// NEW-FU-34: top-level error boundary so a descendant throw during render
// shows a recovery surface instead of unmounting the whole React tree
// (which used to leave the user with a blank white page).
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
