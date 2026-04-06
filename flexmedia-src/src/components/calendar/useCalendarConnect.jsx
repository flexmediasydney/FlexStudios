import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useCalendarConnect() {
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();

  const connect = useCallback(async () => {
    setConnecting(true);
    try {
      const result = await api.functions.invoke('getGoogleCalendarOAuthUrl', {});
      const authUrl = result?.data?.authUrl || result?.authUrl;
      if (!authUrl) { toast.error('Failed to get auth URL'); setConnecting(false); return; }

      const popup = window.open(authUrl, 'Google Calendar Authorization', 'width=600,height=700,scrollbars=yes');

      const handleMessage = (event) => {
        if (event.data?.type === 'calendar_auth_success') {
          toast.success(`Calendar connected: ${event.data.email}`);
          queryClient.invalidateQueries({ queryKey: ['calendar-connections'] });
          setConnecting(false);
          window.removeEventListener('message', handleMessage);
        } else if (event.data?.type === 'calendar_auth_error') {
          toast.error(event.data.error || 'Calendar connection failed');
          setConnecting(false);
          window.removeEventListener('message', handleMessage);
        }
      };
      window.addEventListener('message', handleMessage);

      // Cleanup if popup closed without completing
      const pollTimer = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollTimer);
          setConnecting(false);
          window.removeEventListener('message', handleMessage);
        }
      }, 500);
    } catch (err) {
      toast.error('Failed to start calendar connection');
      setConnecting(false);
    }
  }, [queryClient]);

  return { connect, connecting };
}
