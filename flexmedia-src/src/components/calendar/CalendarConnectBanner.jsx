import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { useCalendarConnect } from './useCalendarConnect';
import { Calendar, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

const DISMISS_KEY = '_calendar_prompt_dismissed';
const DISMISS_DAYS = 30;

export default function CalendarConnectBanner() {
  const { data: user } = useCurrentUser();
  const { connect, connecting } = useCalendarConnect();
  const [dismissed, setDismissed] = useState(false);

  // Check if user has @flexmedia.sydney email
  const isFlexEmail = user?.email?.endsWith('@flexmedia.sydney');

  // Check if dismissed recently
  useEffect(() => {
    const dismissedAt = localStorage.getItem(DISMISS_KEY);
    if (dismissedAt && Date.now() - Number(dismissedAt) < DISMISS_DAYS * 86400000) {
      setDismissed(true);
    }
  }, []);

  // Check if user already has a calendar connection
  const { data: connections = [] } = useQuery({
    queryKey: ['calendar-connections-check'],
    queryFn: () => api.entities.CalendarConnection.filter({ created_by: user?.email }),
    enabled: !!isFlexEmail && !dismissed,
    staleTime: 5 * 60 * 1000,
  });

  const hasConnection = connections.length > 0;

  if (!isFlexEmail || dismissed || hasConnection) return null;

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDismissed(true);
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-blue-700 dark:text-blue-300">
        <Calendar className="h-4 w-4 flex-shrink-0" />
        <span>Connect your FlexMedia calendar for automatic scheduling</span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={connect} disabled={connecting} className="h-7 text-xs">
          {connecting ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Connecting...</> : 'Connect Now'}
        </Button>
        <button onClick={handleDismiss} className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-200 cursor-pointer transition-colors" title="Dismiss for 30 days" aria-label="Dismiss calendar connection banner">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
