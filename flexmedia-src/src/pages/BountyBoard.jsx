import { Trophy } from "lucide-react";

export default function BountyBoard() {
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold">Bounty Board</h1>
        <p className="text-muted-foreground mt-2">Community bounties and tasks.</p>
      </div>

      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 dark:bg-amber-950/30 flex items-center justify-center mb-5">
          <Trophy className="h-8 w-8 text-amber-500" />
        </div>
        <h2 className="text-lg font-semibold mb-1">Coming Soon</h2>
        <p className="text-sm text-muted-foreground max-w-sm">
          Post and track bounties for community contributions. This feature is under development.
        </p>
      </div>
    </div>
  );
}