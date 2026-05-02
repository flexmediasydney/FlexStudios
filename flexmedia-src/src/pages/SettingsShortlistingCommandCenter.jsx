/**
 * SettingsShortlistingCommandCenter — W11.6.21 + W11.6.21b + W11.6.23 master_admin umbrella.
 *
 * Spec history:
 *   W11.6.21  — initial umbrella + 9 consolidated pages (Overview NEW, plus
 *               tiers/mappings/slots/registry/suggestions/rejection/
 *               calibration/overrides/discovery).
 *   W11.6.21b — folds in the remaining 9 shortlisting-engine settings pages
 *               that were left standalone in the W11.6.21 sweep:
 *               room types, standards, signals, calibration-ops, training,
 *               overrides-admin, prompts, engine-settings, vendor.
 *   W11.6.23  — 20th tab "Architecture" — read-only data-explorer view
 *               surfacing layer counts, slot coverage matrix, and
 *               heuristic slot-shape suggestions (split / deletion_candidate /
 *               new_slot_needed). Powered by RPC
 *               shortlisting_architecture_kpis (mig 421).
 *
 * URL:        /SettingsShortlistingCommandCenter[?tab=<key>]
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Tabs (20 total):
 *   1.  overview        — engine-wide KPIs (W11.6.21).
 *   2.  tiers           — SettingsTierConfigs (W8).
 *   3.  mappings        — SettingsPackageTierMapping (W7.7).
 *   4.  slots           — SettingsShortlistingSlots (W7.7).
 *   5.  registry        — SettingsObjectRegistry (W12.B).
 *   6.  suggestions     — SettingsAISuggestions (W12.7-W12.8).
 *   7.  rejection       — SettingsRejectionReasonsDashboard (W11.6).
 *   8.  calibration     — SettingsCalibrationSessions (W14).
 *   9.  overrides       — SettingsEngineOverridePatterns (W11.6.10).
 *  10.  discovery       — SettingsObjectRegistryDiscovery (W12 / W11.6.11).
 *  11.  roomtypes       — SettingsShortlistingRoomTypes (W11.6.7).        [W11.6.21b]
 *  12.  standards       — SettingsShortlistingStandards (W6 P7).          [W11.6.21b]
 *  13.  signals         — SettingsShortlistingSignals (W6 P7).            [W11.6.21b]
 *  14.  calibration-ops — ShortlistingCalibration (W6 P8 quarterly bench).[W11.6.21b]
 *  15.  training        — SettingsShortlistingTraining (W6 P8).           [W11.6.21b]
 *  16.  overrides-admin — SettingsShortlistingOverrides (W6 P8).          [W11.6.21b]
 *  17.  prompts         — SettingsShortlistingPrompts (W6 P8).            [W11.6.21b]
 *  18.  engine-settings — SettingsEngineSettings (W7.7).                  [W11.6.21b]
 *  19.  vendor          — SettingsVendorComparison (W11.8).               [W11.6.21b]
 *  20.  architecture    — ArchitectureTab (W11.6.23).                     [W11.6.23]
 *
 * Note on the two calibration tabs:
 *   `calibration` is the W14 50-project structured calibration session
 *   admin (`calibration_sessions` entity).
 *   `calibration-ops` is the older W6 quarterly accuracy benchmark page
 *   that operates on `shortlisting_benchmark_results` + the holdout set on
 *   `shortlisting_rounds.is_benchmark`. Both belong here — they're
 *   complementary instruments, not duplicates.
 *
 * Note on the two override tabs:
 *   `overrides` is SettingsEngineOverridePatterns (the W11.6.10 admin for
 *   engine-suggested override patterns).
 *   `overrides-admin` is SettingsShortlistingOverrides (the older W6 P8
 *   aggregated drag/swap analytics dashboard with a recalibration hint
 *   panel). Different surfaces, different RPCs, kept distinct.
 *
 * Hard-cut policy (per spec):
 *   The old standalone routes are REMOVED from pages.config.js + Layout.jsx
 *   + routeAccess.jsx — visiting them now 404s. Internal Link references
 *   have been redirected to ?tab=<key> on this page.
 *
 * Tab implementation: each existing settings page is mounted as-is. They
 * already manage their own ?tab= query state for sub-tabs (e.g. Object
 * Registry has its own browse/queue/normalisation), and they read
 * useSearchParams independently — when our top-level tab toggles, the
 * unmounted page's local sub-tab state is naturally torn down. We picked
 * top-level keys that don't collide with any existing sub-tab name.
 *
 * Layout: single horizontal `flex flex-wrap` strip (Option A from spec).
 * 19 tabs wrap to 2-3 rows on a max-w-7xl container; readable + simple.
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
  Cog,
  Database,
  FileEdit,
  Gauge,
  GraduationCap,
  Home,
  Layers,
  ListChecks,
  Microscope,
  Network,
  Ruler,
  ScanSearch,
  ShieldAlert,
  Shuffle,
  Signal as SignalIcon,
  Sliders,
  Sparkles,
  TrendingDown,
  Wrench,
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
// W11.6.21b — second consolidation wave.
import SettingsShortlistingRoomTypes from "@/pages/SettingsShortlistingRoomTypes";
import SettingsShortlistingStandards from "@/pages/SettingsShortlistingStandards";
import SettingsShortlistingSignals from "@/pages/SettingsShortlistingSignals";
import ShortlistingCalibration from "@/pages/ShortlistingCalibration";
import SettingsShortlistingTraining from "@/pages/SettingsShortlistingTraining";
import SettingsShortlistingOverrides from "@/pages/SettingsShortlistingOverrides";
import SettingsShortlistingPrompts from "@/pages/SettingsShortlistingPrompts";
import SettingsEngineSettings from "@/pages/SettingsEngineSettings";
import SettingsVendorComparison from "@/pages/SettingsVendorComparison";
// W11.6.23 — Architecture & Data Explorer tab.
import ArchitectureTab from "@/components/settings/architecture/ArchitectureTab";

// Tab keys (URL query value `?tab=<key>`). Default = overview.
export const VALID_TABS = [
  // — W11.6.21 (initial 10) ——————————————————————————————————————————————
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
  // — W11.6.21b (added 9) ————————————————————————————————————————————————
  "roomtypes",
  "standards",
  "signals",
  "calibration-ops",
  "training",
  "overrides-admin",
  "prompts",
  "engine-settings",
  "vendor",
  // — W11.6.23 (added 1) —————————————————————————————————————————————————
  "architecture",
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
  // W11.6.21b — explicitly disambiguated labels for the two
  // calibration / two override tabs.
  roomtypes: "Room Types",
  standards: "Standards",
  signals: "Signals",
  "calibration-ops": "Calibration Ops",
  training: "Training",
  "overrides-admin": "Overrides Admin",
  prompts: "Prompts",
  "engine-settings": "Engine Settings",
  vendor: "Vendor Comparison",
  // W11.6.23
  architecture: "Architecture",
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
  roomtypes: Home,
  standards: Ruler,
  signals: SignalIcon,
  "calibration-ops": Microscope,
  training: GraduationCap,
  "overrides-admin": Wrench,
  prompts: FileEdit,
  "engine-settings": Cog,
  vendor: Shuffle,
  // W11.6.23
  architecture: Network,
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
            All shortlisting-engine controls — engine KPIs, tier weights,
            package mappings, slot taxonomy, room types, standards, signals,
            prompts, training, calibration, override patterns, object
            registry, AI suggestions, rejection-reason analytics, engine
            settings, vendor A/B comparison, and the data-explorer
            architecture view.
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

          {/* — W11.6.21b — second consolidation wave —————————————————————— */}
          <TabsContent value="roomtypes" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingRoomTypes />
            </Suspense>
          </TabsContent>

          <TabsContent value="standards" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingStandards />
            </Suspense>
          </TabsContent>

          <TabsContent value="signals" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingSignals />
            </Suspense>
          </TabsContent>

          <TabsContent value="calibration-ops" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <ShortlistingCalibration />
            </Suspense>
          </TabsContent>

          <TabsContent value="training" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingTraining />
            </Suspense>
          </TabsContent>

          <TabsContent value="overrides-admin" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingOverrides />
            </Suspense>
          </TabsContent>

          <TabsContent value="prompts" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingPrompts />
            </Suspense>
          </TabsContent>

          <TabsContent value="engine-settings" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsEngineSettings />
            </Suspense>
          </TabsContent>

          <TabsContent value="vendor" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsVendorComparison />
            </Suspense>
          </TabsContent>

          {/* — W11.6.23 — Architecture & Data Explorer ————————————————— */}
          <TabsContent value="architecture" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <ArchitectureTab />
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
