import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import InteractionFormDialog from './InteractionFormDialog';
import InteractionCard from './InteractionCard';

export default function InteractionLogPanel({ prospect, interactions = [], entityType = 'Agent', onCreated }) {
  const [showNewInteractionDialog, setShowNewInteractionDialog] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Interaction History</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {interactions.length} touchpoint{interactions.length !== 1 ? 's' : ''} recorded
          </p>
        </div>
        <Button
          onClick={() => setShowNewInteractionDialog(true)}
          className="gap-2"
        >
          <Plus className="h-4 w-4" />
          Log Interaction
        </Button>
      </div>

      {interactions.length === 0 ? (
        <Card className="p-12 text-center">
          <p className="text-muted-foreground mb-4">No interactions logged yet</p>
          <Button
            variant="outline"
            onClick={() => setShowNewInteractionDialog(true)}
          >
            Log First Interaction
          </Button>
        </Card>
      ) : (
        <div className="space-y-3">
          {interactions.map(interaction => (
            <InteractionCard key={interaction.id} interaction={interaction} />
          ))}
        </div>
      )}

      <InteractionFormDialog
        open={showNewInteractionDialog}
        onOpenChange={setShowNewInteractionDialog}
        prospect={prospect}
        entityType={entityType}
        entityId={prospect?.id}
        onSuccess={onCreated}
      />
    </div>
  );
}