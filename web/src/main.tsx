import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './lib/toast';
import { ApiError } from './lib/api';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/layout.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => {
        // Never retry a refusal — it will be refused again, and the person is
        // left waiting for an answer the server already gave.
        if (error instanceof ApiError && (error.isAuth || error.isForbidden || error.status < 500)) return false;
        return count < 2;
      },
    },
    mutations: { retry: false },
  },
});

// Apply the saved theme before first paint so nothing flashes white at night.
const saved = localStorage.getItem('huerex.theme');
if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
