/**
 * SettingsShortlistingCommandCenter — Wave 11.6.21 master_admin umbrella.
 *
 * Spec: W11.6.21. Consolidates 9 scattered shortlisting settings pages
 * under one tabbed admin surface, plus a new Overview KPI tab.
 *
 * URL:        /SettingsShortlistingCommandCenter[?tab=<key>]
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Tabs:
 *   1. overview  — engine-wide KPIs (NEW; W11.6.21).
 *   2. tiers     — SettingsTierConfigs (W8).
 *   3. mappings  — SettingsPackageTierMapping (W7.7).
 *   4. slots     — SettingsShortlistingSlots (W7.7).
 *   5. registry  — SettingsObjectRegistry (W12.B).
 *   6. suggestions — SettingsAISuggestions (W12.7-W12.8).
 *   7. rejection — SettingsRejectionReasonsDashboard (W11.6).
 *   8. calibration — SettingsCalibrationSessions (W14).
 *   9. overrides — SettingsEngineOverridePatterns (W11.6.10).
 *  10. discovery — SettingsObjectRegistryDiscovery (W12 / W11.6.11).
 *
 * Hard-cut policy (per spec):
 *   The old standalone routes for tabs 2-10 are REMOVED from pages.config.js
 *   + Layout.jsx + routeAccess.jsx — visiting /SettingsObjectRegistry now
 *   404s. Internal Link references have been redirected to ?tab=<key> on
 *   this page.
 *
 * Tab implementation: each existing settings page is mounted as-is. They
 * already manage their own ?tab= query state for sub-tabs (e.g. Object
 * Registry has its own browse/queue/normalisation), and they read
 * useSearchParams independently — when our top-level tab toggles, the
 * unmounted page's local sub-tab state is naturally torn down. We picked
 * top-level keys that don't collide with any existing sub-tab name.
 *
 * Style mirrors PulseMissedOpportunityCommandCenter (W15b.9).
 */
import React, { Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Activity,
  Database,
  Gauge,
  Layers,
  ListChecks,
  ScanSearch,
  Sparkles,
  TrendingDown,
  Sliders,
  ShieldAlert,
} from "lucide-react";

import OverviewTab from "@/components/settings/shortlisting/OverviewTab";
import SettingsTierConfigs from "@/pages/SettingsTierConfigs";
import SettingsPackageTierMapping from "@/pages/SettingsPackageTierMapping";
import SettingsShortlistingSlots from "@/pages/SettingsShortlistingSlots";
import SettingsObjectRegistry from "@/pages/SettingsObjectRegistry";
import SettingsAISuggestions from "@/pages/SettingsAISuggestions";
import SettingsRejectionReasonsDashboard from "@/pages/SettingsRejectionReasonsDashboard";
import SettingsCalibrationSessions from "@/pages/SettingsCalibrationSessions";
import SettingsEngineOverridePatterns from "@/pages/SettingsEngineOverridePatterns";
import SettingsObjectRegistryDiscovery from "@/pages/SettingsObjectRegistryDiscovery";

// Tab keys (URL query value `?tab=<key>`). Default = overview.
export const VALID_TABS = [
  "overview",
  "tiers",
  "mappings",
  "slots",
  "registry",
  "suggestions",
  "rejection",
  "calibration",
  "overrides",
  "discovery",
];

const TAB_LABELS = {
  overview: "Overview",
  tiers: "Tiers",
  mappings: "Packages",
  slots: "Slots",
  registry: "Object Registry",
  suggestions: "AI Suggestions",
  rejection: "Rejection",
  calibration: "Calibration",
  overrides: "Override Patterns",
  discovery: "Object Discovery",
};

const TAB_ICONS = {
  overview: Activity,
  tiers: Sliders,
  mappings: Layers,
  slots: ListChecks,
  registry: Database,
  suggestions: Sparkles,
  rejection: TrendingDown,
  calibration: Gauge,
  overrides: ShieldAlert,
  discovery: ScanSearch,
};

/**
 * Pure helper: pick the active tab from a URL query value.
 * Exported for tests — accepts unknown user input and returns a guaranteed
 * valid key from VALID_TABS, defaulting to 'overview'.
 */
export function resolveActiveTab(rawTab) {
  if (typeof rawTab !== "string") return "overview";
  return VALID_TABS.includes(rawTab) ? rawTab : "overview";
}

export default function SettingsShortlistingCommandCenter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab = resolveActiveTab(rawTab);

  const handleTabChange = (value) => {
    const next = new URLSearchParams(searchParams);
    // When switching the umbrella tab, drop any legacy sub-tab params from
    // a previous page (each consolidated page reads ?tab= for its OWN sub
    // navigation, but on tab switch we want the new page's default).
    if (value === "overview") {
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
        data-testid="settings-shortlisting-command-center"
      >
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-blue-600" />
            Shortlisting Command Center
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Wave 11.6.21 — single owner control surface for the shortlisting
            engine. Engine KPIs, tier weights, package mappings, slot taxonomy,
            object registry, AI suggestions, rejection-reason analytics,
            calibration sessions, override patterns, and the discovery queue
            all live here.
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="space-y-3"
        >
          <TabsList
            className="h-auto flex flex-wrap"
            data-testid="shortlisting-cc-tabs"
          >
            {VALID_TABS.map((key) => {
              const Icon = TAB_ICONS[key] || Activity;
              return (
                <TabsTrigger
                  key={key}
                  value={key}
                  className="gap-2 text-xs"
                  data-testid={`tab-${key}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {TAB_LABELS[key]}
                </TabsTrigger>
              );
            })}
          </TabsList>

          <TabsContent value="overview" className="mt-0">
            <OverviewTab />
          </TabsContent>

          {/* Each consolidated page is mounted directly. They each carry */}
          {/* their own internal PermissionGuard which is fine — the outer */}
          {/* guard already passed master_admin so the inner guard short- */}
          {/* circuits without re-rendering the lockout panel. */}
          <TabsContent value="tiers" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsTierConfigs />
            </Suspense>
          </TabsContent>

          <TabsContent value="mappings" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsPackageTierMapping />
            </Suspense>
          </TabsContent>

          <TabsContent value="slots" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingSlots />
            </Suspense>
          </TabsContent>

          <TabsContent value="registry" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsObjectRegistry />
            </Suspense>
          </TabsContent>

          <TabsContent value="suggestions" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsAISuggestions />
            </Suspense>
          </TabsContent>

          <TabsContent value="rejection" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsRejectionReasonsDashboard />
            </Suspense>
          </TabsContent>

          <TabsContent value="calibration" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsCalibrationSessions />
            </Suspense>
          </TabsContent>

          <TabsContent value="overrides" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsEngineOverridePatterns />
            </Suspense>
          </TabsContent>

          <TabsContent value="discovery" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsObjectRegistryDiscovery />
            </Suspense>
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}

function TabFallback() {
  return (
    <div
      className="rounded-md border border-border p-6 text-sm text-muted-foreground"
      data-testid="tab-fallback"
    >
      Loading…
    </div>
  );
}
