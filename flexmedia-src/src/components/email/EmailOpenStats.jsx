import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { Eye, Users } from 'lucide-react';
import { format } from 'date-fns';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export default function EmailOpenStats({ messageId }) {
  const { data: activities = [], isLoading } = useQuery({
    queryKey: ['email-opens', messageId],
    queryFn: async () => {
      const allActivities = await api.entities.EmailActivity.filter(
        { email_message_id: messageId, action_type: 'opened' },
        '-created_date'
      );
      return allActivities;
    },
    enabled: !!messageId,
    staleTime: 30000
  });

  if (isLoading) {
    return null;
  }

  const uniqueOpeners = new Set(activities.map(a => a.performed_by));
  const totalOpens = activities.length;
  const lastOpen = activities[0]?.created_date;

  return (
    <div className="flex items-center gap-4 text-sm p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-900/30">
      {/* Opens count */}
      <div className="flex items-center gap-2">
        <Eye className="h-4 w-4 text-blue-600" />
        <div>
          <p className="font-semibold text-foreground">{totalOpens}</p>
          <p className="text-xs text-muted-foreground">opens</p>
        </div>
      </div>

      {/* Unique opens */}
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-blue-600" />
        <div>
          <p className="font-semibold text-foreground">{uniqueOpeners.size}</p>
          <p className="text-xs text-muted-foreground">unique</p>
        </div>
      </div>

      {/* Last opened */}
      {lastOpen && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-xs text-muted-foreground cursor-help">
                Last opened {format(new Date(lastOpen), 'MMM d')}
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {format(new Date(lastOpen), 'PPpp')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Opener list */}
      {uniqueOpeners.size > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="ml-auto text-xs text-muted-foreground cursor-help hover:text-foreground">
                View opens
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-sm">
              <div className="text-xs space-y-1">
                {Array.from(uniqueOpeners)
                  .slice(0, 5)
                  .map(openerId => {
                    const opener = activities.find(a => a.performed_by === openerId);
                    return (
                      <p key={openerId}>
                        {opener?.performed_by_name || 'Unknown'} · {format(new Date(opener?.created_date), 'MMM d, h:mm a')}
                      </p>
                    );
                  })}
                {uniqueOpeners.size > 5 && <p className="text-muted-foreground">+{uniqueOpeners.size - 5} more</p>}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}