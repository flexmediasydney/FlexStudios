import { QueryClient } from '@tanstack/react-query';

export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3 * 60 * 1000,       // Keep fresh for 3 minutes
      gcTime: 10 * 60 * 1000,         // Cache for 10 minutes
      refetchOnMount: 'stale',
      refetchOnWindowFocus: 'stale',
      refetchOnReconnect: 'stale',
      retry: 2,
      retryDelay: 1000,
    },
    mutations: {
      throwOnError: false,
      retry: 1,
      retryDelay: 1000,
    },
  },
});