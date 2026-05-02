/**
 * SettingsAISuggestions — Wave 12.7-12.8 master_admin review surface for the
 * shortlisting AI-suggestion engine.
 *
 * URL:        /SettingsAISuggestions
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Two tabs:
 *   1. Slot suggestions      — pending shortlisting_slot_suggestions rows
 *      ranked by evidence_round_count. Approve / Reject / Merge actions.
 *   2. Room-type suggestions — pending shortlisting_room_type_suggestions
 *      rows ranked by evidence_count. Approve / Reject actions.
 *
 * "Run engine now" button at the top fires the
 * shortlisting-suggestion-engine edge fn manually. No autonomous cron.
 *
 * Style mirrors SettingsObjectRegistry — slate-tinted cards, tabular-nums.
 */

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Sparkles, Activity, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import AISlotSuggestionsTab from "@/components/settings/AISlotSuggestionsTab";
import AIRoomTypeSuggestionsTab from "@/components/settings/AIRoomTypeSuggestionsTab";

const VALID_TABS = ["slots", "room_types"];

export default function SettingsAISuggestions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(rawTab) ? rawTab : "slots";
  const [lastRunSummary, setLastRunSummary] = useState(null);
  const qc = useQueryClient();

  const runEngine = useMutation({
    mutationFn: async () => {
      const result = await api.functions.invoke("shortlisting-suggestion-engine", {
        days_back: 90,
        cluster_days_back: 120,
        dry_run: false,
      });
      return result?.data ?? result;
    },
    onSuccess: (resp) => {
      const slot = resp?.upserts?.slot_suggestions ?? 0;
      const rt = resp?.upserts?.room_type_suggestions ?? 0;
      setLastRunSummary({
        elapsed_ms: resp?.elapsed_ms ?? 0,
        slot,
        rt,
        slot_total: resp?.slot_suggestions?.length ?? 0,
        rt_total: resp?.room_type_suggestions?.length ?? 0,
      });
      qc.invalidateQueries({ queryKey: ["ai-slot-suggestions"] });
      qc.invalidateQueries({ queryKey: ["ai-room-type-suggestions"] });
      toast.success(
        `Engine ran: ${slot} slot upserts, ${rt} room-type upserts (${resp?.elapsed_ms ?? "?"}ms).`,
      );
    },
    onError: (err) => {
      toast.error(`Engine failed: ${err?.message || err}`);
    },
  });

  const handleTabChange = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "slots") {
      next.delete("tab");
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <PermissionGuard require={["master_admin"]}>
      <div
        className="p-6 space-y-3 max-w-7xl mx-auto"
        data-testid="settings-ai-suggestions-page"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-violet-600" />
              AI Suggestions
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Wave 12.7-12.8 — engine telemetry rolled up into reviewable slot
              and room-type suggestions. Approve to extend the canonical
              taxonomy; reject when noise; merge into an existing definition
              when the proposal is a synonym. No autonomous cron — fire the
              engine manually.
            </p>
          </div>
          <Button
            onClick={() => runEngine.mutate()}
            disabled={runEngine.isPending}
            size="sm"
            data-testid="run-engine-button"
            className="shrink-0"
          >
            {runEngine.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Activity className="h-3.5 w-3.5 mr-1.5" />
            )}
            Run engine now
          </Button>
        </div>

        {lastRunSummary && (
          <div
            className="text-xs rounded border bg-muted/40 p-2.5 text-muted-foreground"
            data-testid="last-run-summary"
          >
            Last run: {lastRunSummary.slot_total} slot proposals (
            {lastRunSummary.slot} upserts) · {lastRunSummary.rt_total} room-type
            proposals ({lastRunSummary.rt} upserts) ·{" "}
            <span className="tabular-nums">{lastRunSummary.elapsed_ms}ms</span>.
          </div>
        )}

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="space-y-3"
        >
          <TabsList className="h-auto" data-testid="ai-suggestions-tabs">
            <TabsTrigger
              value="slots"
              className="gap-2 text-xs"
              data-testid="tab-slots"
            >
              <Layers className="h-3.5 w-3.5" />
              Slot suggestions
            </TabsTrigger>
            <TabsTrigger
              value="room_types"
              className="gap-2 text-xs"
              data-testid="tab-room-types"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Room-type suggestions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="slots" className="mt-0">
            <AISlotSuggestionsTab />
          </TabsContent>

          <TabsContent value="room_types" className="mt-0">
            <AIRoomTypeSuggestionsTab />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
