import React from 'react';
import { AppProvider, useApp } from './context/AppContext.jsx';
import LoginPage     from './pages/LoginPage.jsx';
import SchedulerPage from './pages/SchedulerPage.jsx';
import './index.css';

function AppInner() {
  const { token } = useApp();
  return token ? <SchedulerPage /> : <LoginPage />;
}

export default function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
