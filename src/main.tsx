import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary.tsx';
import { AuthProvider } from './contexts/AuthContext.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <AuthProvider>
      <App />
    </AuthProvider>
  </AppErrorBoundary>
);
