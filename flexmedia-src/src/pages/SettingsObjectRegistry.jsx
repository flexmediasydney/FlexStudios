/**
 * SettingsObjectRegistry — Wave 12.B master_admin curation surface for the
 * canonical object registry.
 *
 * URL:        /SettingsObjectRegistry
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Three tabs:
 *   1. Browse           — list object_registry rows + expand for raw observations.
 *   2. Discovery queue  — curate object_registry_candidates (approve/reject/merge/defer).
 *   3. Normalisation    — read-only stats: cluster rate, top candidates, backfill button.
 *
 * Style mirrors PulseMissedOpportunityCommandCenter: slate-tinted cards,
 * tabular-nums, compact type, no animation. Tabs primitive from shadcn/ui.
 *
 * Distinct from /SettingsObjectRegistryDiscovery (W11.6.11) which is the
 * narrower discovery-queue surface for slot suggestions + object candidates.
 * W12.B is the full registry curation surface with the canonical browse view.
 */

import { useSearchParams } from "react-router-dom";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Database, Sparkles, Activity } from "lucide-react";
import ObjectRegistryBrowseTab from "@/components/settings/ObjectRegistryBrowseTab";
import ObjectRegistryDiscoveryQueueTab from "@/components/settings/ObjectRegistryDiscoveryQueueTab";
import ObjectRegistryNormalisationTab from "@/components/settings/ObjectRegistryNormalisationTab";

const VALID_TABS = ["browse", "queue", "normalisation"];

export default function SettingsObjectRegistry() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(rawTab) ? rawTab : "browse";

  const handleTabChange = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "browse") {
      next.delete("tab");
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 space-y-3 max-w-7xl mx-auto" data-testid="settings-object-registry-page">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-600" />
            Object Registry
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Wave 12.B — owner curation of the canonical object registry. Browse
            the active taxonomy, review the discovery queue, and monitor
            normalisation health. Decisions feed back into Stage 1 grounding via
            the canonical feature registry block.
          </p>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-3">
          <TabsList className="h-auto" data-testid="object-registry-tabs">
            <TabsTrigger value="browse" className="gap-2 text-xs" data-testid="tab-browse">
              <Database className="h-3.5 w-3.5" />
              Browse
            </TabsTrigger>
            <TabsTrigger value="queue" className="gap-2 text-xs" data-testid="tab-queue">
              <Sparkles className="h-3.5 w-3.5" />
              Discovery Queue
            </TabsTrigger>
            <TabsTrigger value="normalisation" className="gap-2 text-xs" data-testid="tab-normalisation">
              <Activity className="h-3.5 w-3.5" />
              Normalisation
            </TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="mt-0">
            <ObjectRegistryBrowseTab />
          </TabsContent>

          <TabsContent value="queue" className="mt-0">
            <ObjectRegistryDiscoveryQueueTab />
          </TabsContent>

          <TabsContent value="normalisation" className="mt-0">
            <ObjectRegistryNormalisationTab />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
