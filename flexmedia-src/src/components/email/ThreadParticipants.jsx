import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export default function ThreadParticipants({ thread }) {
  const { participants, messageCount } = useMemo(() => {
    if (!thread?.messages || thread.messages.length === 0) {
      return { participants: [], messageCount: 0 };
    }

    // Collect all unique senders and recipients
    const senderSet = new Set();
    
    thread.messages.forEach(msg => {
      if (msg.from) {
        senderSet.add(msg.from);
      }
      if (msg.to) {
        msg.to.forEach(email => senderSet.add(email));
      }
    });

    // Get unique participants with their display names
    const participantMap = new Map();
    thread.messages.forEach(msg => {
      if (msg.from && !participantMap.has(msg.from)) {
        participantMap.set(msg.from, msg.from_name || msg.from.split('@')[0]);
      }
    });

    // Sort and format participants for display
    const sortedParticipants = Array.from(participantMap.entries())
      .map(([email, name]) => ({
        email,
        displayName: name.includes(' ') ? name : name.charAt(0).toUpperCase() + name.slice(1)
      }))
      .slice(0, 3); // Show max 3 participants

    return {
      participants: sortedParticipants,
      messageCount: thread.messages.length,
      allParticipants: Array.from(participantMap.entries())
    };
  }, [thread]);

  if (messageCount === 0) return null;

  const isChain = messageCount > 1;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1 text-sm">
            <span className="text-foreground">
              {participants
                .slice(0, 2)
                .map(p => p.displayName)
                .join(', ')}
              {participants.length > 2 && ', ...'}
            </span>
            {isChain && (
              <span className="font-semibold text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full whitespace-nowrap">
                {messageCount}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <div className="space-y-1 text-xs">
            {participants.map(p => (
              <p key={p.email}>{p.displayName}</p>
            ))}
            {isChain && <p className="text-muted-foreground pt-1 border-t mt-1">{messageCount} messages</p>}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}