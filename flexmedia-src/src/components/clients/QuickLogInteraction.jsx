import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { retryWithBackoff, isTransientError } from "@/lib/networkResilience";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { MessageSquarePlus, Phone, Mail, Video, Coffee, Pencil, Send } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const QUICK_TYPES = [
  { id: "Phone Call", icon: Phone, color: "text-green-600 hover:bg-green-50" },
  { id: "Email Sent", icon: Mail, color: "text-blue-600 hover:bg-blue-50" },
  { id: "Meeting", icon: Video, color: "text-purple-600 hover:bg-purple-50" },
  { id: "Note Added", icon: Pencil, color: "text-amber-600 hover:bg-amber-50" },
  { id: "LinkedIn Message", icon: Coffee, color: "text-cyan-600 hover:bg-cyan-50" },
];

/**
 * QuickLogInteraction — a compact popover for logging interactions directly from a contact card.
 *
 * Props:
 *   agent         — the agent object { id, name, relationship_state }
 *   onLogged      — optional callback after successful log
 *   triggerSize   — "sm" | "icon" — controls the trigger button style
 */
export default function QuickLogInteraction({ agent, onLogged, triggerSize = "sm" }) {
  const { data: user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [selectedType, setSelectedType] = useState(null);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setSelectedType(null);
    setSummary("");
  };

  const handleSubmit = async () => {
    if (!selectedType || !summary.trim()) return;
    setLoading(true);
    try {
      await retryWithBackoff(
        () => api.entities.InteractionLog.create({
          entity_type: "Agent",
          entity_id: agent.id,
          entity_name: agent.name || "Unknown",
          interaction_type: selectedType,
          date_time: new Date().toISOString(),
          summary: summary.trim(),
          details: "",
          user_id: user?.id,
          user_name: user?.full_name,
          sentiment: "Neutral",
          relationship_state_at_time: agent.relationship_state || "Active",
        }),
        { maxRetries: 2, onRetry: (err, attempt) => toast.info(`Retrying (${attempt}/2)...`) }
      );

      // Update last_contacted_at
      api.entities.Agent.update(agent.id, {
        last_contacted_at: new Date().toISOString(),
      }).catch(() => {});

      // BUG FIX: The parent pages use useEntitiesData (custom cache), not
      // react-query. Invalidating react-query keys was a no-op.
      await refetchEntityList("InteractionLog");
      await refetchEntityList("Agent");
      toast.success("Interaction logged");
      reset();
      setOpen(false);
      if (onLogged) onLogged();
    } catch (err) {
      const hint = isTransientError(err) ? ' — check your connection and try again' : '';
      toast.error((err.message || "Failed to log interaction") + hint);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <PopoverTrigger asChild>
        {triggerSize === "icon" ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 p-0"
            title="Log interaction"
            onClick={(e) => e.stopPropagation()}
          >
            <MessageSquarePlus className="h-3.5 w-3.5 text-muted-foreground hover:text-primary" />
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2 gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <MessageSquarePlus className="h-3 w-3" />
            Log
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">
            Quick log for {agent.name}
          </p>

          {/* Type selection */}
          <div className="flex gap-1">
            {QUICK_TYPES.map((t) => {
              const Icon = t.icon;
              const isSelected = selectedType === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedType(t.id)}
                  title={t.id}
                  className={cn(
                    "flex items-center justify-center w-10 h-8 rounded-md border transition-all",
                    isSelected
                      ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                      : "border-border",
                    t.color
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>

          {/* Summary + submit */}
          <div className="flex gap-1.5">
            <Input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleSubmit(); } }}
              placeholder={selectedType ? `${selectedType} summary...` : "Select type first..."}
              className="h-8 text-xs flex-1"
              disabled={!selectedType}
              maxLength={200}
            />
            <Button
              size="sm"
              className="h-8 px-2.5"
              onClick={handleSubmit}
              disabled={loading || !selectedType || !summary.trim()}
              title="Submit interaction"
              aria-label="Submit interaction"
            >
              {loading ? (
                <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full" />
              ) : (
                <Send className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
