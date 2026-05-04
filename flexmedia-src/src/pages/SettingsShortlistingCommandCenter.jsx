/**
 * SettingsShortlistingCommandCenter — W11.6.21 + W11.6.21b + W11.6.23 +
 * W11.6.25 + W11.6.27 + W11.6.28 (Recipes consolidation) master_admin umbrella.
 *
 * Spec history:
 *   W11.6.21  — initial umbrella + 9 consolidated pages.
 *   W11.6.21b — folds in the remaining 9 shortlisting-engine settings pages.
 *   W11.6.23  — Architecture & Data Explorer tab.
 *   W11.6.25  — Slot Recipes editor tab.
 *   W11.6.27  — IA regroup. The flat 21-tab strip became unreadable. Tabs
 *               are now organised into 5 functional groups; the page renders
 *               a top group strip (5 buttons) plus a secondary strip for
 *               the active group's children. All existing tab keys / deep
 *               links / data-testids remain unchanged. A new placeholder
 *               `taxonomy_explorer` tab is registered under Vocabulary; the
 *               T1 agent owns the component implementation.
 *   W11.6.28  — Recipes Matrix consolidation. Joseph flagged the Slots /
 *               Slot Recipes / Standards triplet as confusing — operators
 *               had to think at engine-internal slot taxonomy level.
 *               Replaced with one tab ("recipes") backed by RecipeMatrixTab,
 *               a constraint-based gallery_positions matrix authoring UI.
 *               The legacy `slots` and `standards` tab keys are dropped
 *               from the IA but the underlying components stay in the
 *               codebase (in case of revert) and the slots editor is
 *               accessible via the Advanced expander inside the new tab.
 *
 * URL contract:
 *   /SettingsShortlistingCommandCenter[?tab=<key>]
 *   - Bare URL → Overview (Engine group active).
 *   - ?tab=<key> deep-links to that tab; the parent group is derived.
 *   - W11.6.28: ?tab=slots and ?tab=standards now redirect to ?tab=recipes
 *     (those keys are no longer in VALID_TABS).
 *
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Groups (5 total, 20 tabs after W11.6.28):
 *   1.  Engine       — overview, engine-settings, tiers, mappings, prompts
 *   2.  Recipes      — recipes (new RecipeMatrixTab; absorbs slots+standards)
 *   3.  Vocabulary   — taxonomy_explorer, registry, discovery, roomtypes, signals
 *   4.  Operations   — architecture, suggestions, overrides, overrides-admin,
 *                      rejection, vendor
 *   5.  Calibration  — calibration, calibration-ops, training
 *
 * Note on backward-compat & tests:
 *   The vitest suite asserts every active tab trigger (`data-testid=
 *   tab-<key>`) is present in the DOM at render time, regardless of which
 *   tab is active. Implementation: every tab trigger is rendered on every
 *   mount, but the secondary strip for inactive groups is visually hidden
 *   via `hidden` (display: none). This keeps the test contract intact and
 *   avoids any tab-key churn while delivering the cleaner IA.
 *   W11.6.28 dropped two trigger keys (`tab-slots`, `tab-standards`); the
 *   test contract was updated to match.
 *
 * Note on the two calibration tabs:
 *   `calibration` is the W14 50-project structured calibration session
 *   admin. `calibration-ops` is the older W6 quarterly accuracy benchmark
 *   page. Different surfaces, different RPCs, kept distinct.
 *
 * Note on the two override tabs:
 *   `overrides` is SettingsEngineOverridePatterns (engine-suggested override
 *   patterns admin). `overrides-admin` is SettingsShortlistingOverrides
 *   (older drag/swap analytics dashboard). Different surfaces, kept distinct.
 *
 * Style mirrors PulseMissedOpportunityCommandCenter (W15b.9).
 */
import React, { Suspense, lazy } from "react";
import { useSearchParams } from "react-router-dom";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  Activity,
  BookOpen,
  Boxes,
  Cog,
  Compass,
  Database,
  FileEdit,
  Gauge,
  GraduationCap,
  Home,
  Layers,
  ListChecks,
  Microscope,
  Network,
  ScanSearch,
  ShieldAlert,
  Shuffle,
  Signal as SignalIcon,
  Sliders,
  Sparkles,
  TrendingDown,
  Wrench,
} from "lucide-react";

// F-3B-006 — Default tab (overview) stays eager: operators land on it; lazy
// would create a flash on every Command Center entry. All other tab
// containers are split into their own chunks via React.lazy + Suspense
// (the page-level <Suspense fallback={<TabFallback />}> already exists
// around each TabsContent below, which gives us the loading skeleton).
import OverviewTab from "@/components/settings/shortlisting/OverviewTab";

const SettingsTierConfigs = lazy(() => import("@/pages/SettingsTierConfigs"));
const SettingsPackageTierMapping = lazy(() =>
  import("@/pages/SettingsPackageTierMapping"),
);
// W11.6.28: kept for revert under an underscore-prefixed alias so the
// linter accepts the parked lazy import. The legacy slots editor is
// still mounted by the Advanced expander inside RecipeMatrixTab via its
// own lazy import.
const _SettingsShortlistingSlots_parked = lazy(() =>
  import("@/pages/SettingsShortlistingSlots"),
);
const SettingsObjectRegistry = lazy(() =>
  import("@/pages/SettingsObjectRegistry"),
);
const SettingsAISuggestions = lazy(() =>
  import("@/pages/SettingsAISuggestions"),
);
const SettingsRejectionReasonsDashboard = lazy(() =>
  import("@/pages/SettingsRejectionReasonsDashboard"),
);
const SettingsCalibrationSessions = lazy(() =>
  import("@/pages/SettingsCalibrationSessions"),
);
const SettingsEngineOverridePatterns = lazy(() =>
  import("@/pages/SettingsEngineOverridePatterns"),
);
const SettingsObjectRegistryDiscovery = lazy(() =>
  import("@/pages/SettingsObjectRegistryDiscovery"),
);
const SettingsShortlistingRoomTypes = lazy(() =>
  import("@/pages/SettingsShortlistingRoomTypes"),
);
// W11.6.28: kept for revert under an underscore-prefixed alias.
const _SettingsShortlistingStandards_parked = lazy(() =>
  import("@/pages/SettingsShortlistingStandards"),
);
const SettingsShortlistingSignals = lazy(() =>
  import("@/pages/SettingsShortlistingSignals"),
);
const ShortlistingCalibration = lazy(() =>
  import("@/pages/ShortlistingCalibration"),
);
const SettingsShortlistingTraining = lazy(() =>
  import("@/pages/SettingsShortlistingTraining"),
);
const SettingsShortlistingOverrides = lazy(() =>
  import("@/pages/SettingsShortlistingOverrides"),
);
const SettingsShortlistingPrompts = lazy(() =>
  import("@/pages/SettingsShortlistingPrompts"),
);
const SettingsEngineSettings = lazy(() =>
  import("@/pages/SettingsEngineSettings"),
);
const SettingsVendorComparison = lazy(() =>
  import("@/pages/SettingsVendorComparison"),
);
const ArchitectureTab = lazy(() =>
  import("@/components/settings/architecture/ArchitectureTab"),
);
// W11.6.28: SlotRecipesTab is superseded by RecipeMatrixTab. The old
// component stays in the codebase (no longer imported here) for revert.
const RecipeMatrixTab = lazy(() =>
  import("@/components/settings/shortlisting/RecipeMatrixTab"),
);
// W11.6.27 — Taxonomy Explorer (T1 agent ships the real component;
// a placeholder lives at the same path so this lazy import never breaks
// the bundle build).
const TaxonomyExplorerTab = lazy(() =>
  import("@/components/settings/shortlisting/TaxonomyExplorerTab"),
);

// ── Tab metadata ──────────────────────────────────────────────────────────
//
// VALID_TABS lists every tab key in declaration order. Order matters for
// iterating in tests; do NOT reshuffle existing keys. New keys append.
//
// TAB_LABELS / TAB_ICONS map keys to UI metadata.
//
// GROUPS defines the IA: each group has a key, a label, an icon, and an
// ordered list of tab keys. The first key in the first group's tabs is
// the global default landing tab (overview).
export const VALID_TABS = [
  // — W11.6.21 (initial 10) ——————————————————————————————————————————————
  "overview",
  "tiers",
  "mappings",
  // W11.6.28: 'slots' removed (folded into the recipes matrix; legacy
  // editor reachable from the Advanced expander inside the new tab).
  "registry",
  "suggestions",
  "rejection",
  "calibration",
  "overrides",
  "discovery",
  // — W11.6.21b (added 9) ————————————————————————————————————————————————
  "roomtypes",
  // W11.6.28: 'standards' removed (per-tier targets now live as the
  // 'Tier defaults' row of the Recipes matrix).
  "signals",
  "calibration-ops",
  "training",
  "overrides-admin",
  "prompts",
  "engine-settings",
  "vendor",
  // — W11.6.23 (added 1) —————————————————————————————————————————————————
  "architecture",
  // — W11.6.25 / W11.6.28 — single Recipes tab —————————————————————————
  "recipes",
  // — W11.6.27 (added 1) —————————————————————————————————————————————————
  "taxonomy_explorer",
];

// W11.6.28: tab keys that the URL still accepts but redirect to a
// canonical replacement. Lets old deep-links keep working.
const TAB_REDIRECTS = {
  slots: "recipes",
  standards: "recipes",
};

const TAB_LABELS = {
  overview: "Overview",
  tiers: "Tiers",
  mappings: "Packages",
  registry: "Object Registry",
  suggestions: "AI Suggestions",
  rejection: "Rejection",
  calibration: "Calibration",
  overrides: "Override Patterns",
  discovery: "Object Discovery",
  roomtypes: "Room Types",
  signals: "Signals",
  "calibration-ops": "Calibration Ops",
  training: "Training",
  "overrides-admin": "Overrides Admin",
  prompts: "Prompts",
  "engine-settings": "Engine Settings",
  vendor: "Vendor Comparison",
  architecture: "Architecture",
  recipes: "Recipes",
  taxonomy_explorer: "Taxonomy Explorer",
};

const TAB_ICONS = {
  overview: Activity,
  tiers: Sliders,
  mappings: Layers,
  registry: Database,
  suggestions: Sparkles,
  rejection: TrendingDown,
  calibration: Gauge,
  overrides: ShieldAlert,
  discovery: ScanSearch,
  roomtypes: Home,
  signals: SignalIcon,
  "calibration-ops": Microscope,
  training: GraduationCap,
  "overrides-admin": Wrench,
  prompts: FileEdit,
  "engine-settings": Cog,
  vendor: Shuffle,
  architecture: Network,
  recipes: ListChecks,
  taxonomy_explorer: Compass,
};

// ── Group definitions (W11.6.27) ──────────────────────────────────────────
// Five functional groups. Each tab key appears exactly once across all
// groups. Order inside each group is the visual order in the secondary
// strip.
export const GROUPS = [
  {
    key: "engine",
    label: "Engine",
    icon: Cog,
    blurb: "Run-the-engine settings — KPIs, weights, packages, prompts.",
    tabs: ["overview", "engine-settings", "tiers", "mappings", "prompts"],
  },
  {
    key: "slots",
    label: "Recipes",
    icon: ListChecks,
    blurb:
      "Constraint-based gallery_positions matrix. Author per-package × tier recipes; legacy slot templates live under the Advanced expander.",
    tabs: ["recipes"],
  },
  {
    key: "vocabulary",
    label: "Vocabulary",
    icon: BookOpen,
    blurb: "Taxonomy, object registry, room types, and signal library.",
    tabs: [
      "taxonomy_explorer",
      "registry",
      "discovery",
      "roomtypes",
      "signals",
    ],
  },
  {
    key: "operations",
    label: "Operations",
    icon: Boxes,
    blurb:
      "Architecture, AI suggestions, overrides, rejection telemetry, vendor A/B.",
    tabs: [
      "architecture",
      "suggestions",
      "overrides",
      "overrides-admin",
      "rejection",
      "vendor",
    ],
  },
  {
    key: "calibration",
    label: "Calibration",
    icon: Microscope,
    blurb: "Structured calibration sessions, quarterly benchmarks, training.",
    tabs: ["calibration", "calibration-ops", "training"],
  },
];

// Reverse lookup: tab key → group key. Built once at module load.
const TAB_TO_GROUP = (() => {
  const map = {};
  for (const g of GROUPS) {
    for (const t of g.tabs) map[t] = g.key;
  }
  return map;
})();

/**
 * Pure helper: pick the active tab from a URL query value.
 * Exported for tests — accepts unknown user input and returns a guaranteed
 * valid key from VALID_TABS, defaulting to 'overview'.
 *
 * W11.6.28: legacy `slots` and `standards` deep-links redirect to the
 * consolidated `recipes` tab.
 */
export function resolveActiveTab(rawTab) {
  if (typeof rawTab !== "string") return "overview";
  if (TAB_REDIRECTS[rawTab]) return TAB_REDIRECTS[rawTab];
  return VALID_TABS.includes(rawTab) ? rawTab : "overview";
}

/**
 * Pure helper: derive the active group key from the active tab.
 * Exported for tests. Falls back to the first group ('engine') if the tab
 * is not in any group (shouldn't happen but defensive).
 */
export function resolveActiveGroup(activeTab) {
  return TAB_TO_GROUP[activeTab] || GROUPS[0].key;
}

/**
 * @param {object} props
 * @param {boolean} [props.embedded] — when true, render without the
 *   page-level wrapper/title.  Used when this is mounted as the
 *   "Settings" subtab inside the unified ShortlistingCommandCenter.
 */
export default function SettingsShortlistingCommandCenter({ embedded = false } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const activeTab = resolveActiveTab(rawTab);
  const activeGroupKey = resolveActiveGroup(activeTab);

  const handleTabChange = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "overview") {
      next.delete("tab");
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  // Switching groups: jump to the group's first tab. We never persist a
  // "group" param in the URL — the active tab is the source of truth, and
  // the group is derived from it. Sharing a deep link to ?tab=foo always
  // implies the right group.
  const handleGroupChange = (groupKey) => {
    const group = GROUPS.find((g) => g.key === groupKey);
    if (!group) return;
    const firstTab = group.tabs[0];
    handleTabChange(firstTab);
  };

  const activeGroup = GROUPS.find((g) => g.key === activeGroupKey) || GROUPS[0];

  return (
    <PermissionGuard require={["master_admin"]}>
      <div
        className={
          embedded
            ? "space-y-4"
            : "p-6 space-y-4 max-w-7xl mx-auto"
        }
        data-testid="settings-shortlisting-command-center"
      >
        {/* 2026-05-05 — when embedded inside the unified ShortlistingCommandCenter
            (as the Settings tab), the parent renders the page-level title.
            Skip the duplicate header. */}
        {!embedded ? (
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-blue-600" />
              Shortlisting Command Center
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              All shortlisting-engine controls, organised into five functional
              groups: Engine, Recipes, Vocabulary, Operations, and Calibration.
              Pick a group above, then drill into the tab you need.
            </p>
          </div>
        ) : null}

        {/* ── Group strip (top-level IA) ─────────────────────────────── */}
        <div
          className="flex flex-wrap gap-2 border-b border-border pb-3"
          role="tablist"
          aria-label="Shortlisting Command Center groups"
          data-testid="shortlisting-cc-groups"
        >
          {GROUPS.map((g) => {
            const Icon = g.icon;
            const isActive = g.key === activeGroupKey;
            return (
              <button
                key={g.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`group-strip-${g.key}`}
                onClick={() => handleGroupChange(g.key)}
                data-testid={`group-${g.key}`}
                data-active={isActive ? "true" : "false"}
                className={cn(
                  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-all",
                  "border",
                  isActive
                    ? "bg-blue-600 text-white border-blue-600 shadow-sm"
                    : "bg-background text-foreground border-border hover:bg-muted/60",
                )}
              >
                <Icon className="h-4 w-4" />
                {g.label}
              </button>
            );
          })}
        </div>

        {/* Active-group blurb (small contextual hint). */}
        <p
          className="text-xs text-muted-foreground -mt-1"
          data-testid="active-group-blurb"
        >
          {activeGroup.blurb}
        </p>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="space-y-3"
        >
          {/* ── Secondary strip — one TabsList per group ─────────────────
              The active group's list is shown; inactive groups are hidden
              via the `hidden` class (display: none) so their TabsTrigger
              elements remain in the DOM. This preserves the data-testid
              contract used by the vitest suite (which asserts every
              `tab-<key>` testId is present at render). */}
          {GROUPS.map((g) => {
            const isActive = g.key === activeGroupKey;
            return (
              <TabsList
                key={g.key}
                id={`group-strip-${g.key}`}
                data-testid={
                  isActive
                    ? "shortlisting-cc-tabs"
                    : `shortlisting-cc-tabs-${g.key}`
                }
                data-group={g.key}
                className={cn(
                  "h-auto flex flex-wrap",
                  isActive ? "" : "hidden",
                )}
              >
                {g.tabs.map((key) => {
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
            );
          })}

          {/* ── Tab content — Overview eager, all others lazy ─────────── */}
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

          {/* W11.6.28: 'slots' is no longer wired to a tab content panel.
              Old deep-links (?tab=slots) redirect to ?tab=recipes via
              resolveActiveTab → TAB_REDIRECTS. The legacy
              SettingsShortlistingSlots component stays available via the
              Advanced expander inside RecipeMatrixTab for the rare
              template-authoring use case. */}

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

          <TabsContent value="roomtypes" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <SettingsShortlistingRoomTypes />
            </Suspense>
          </TabsContent>

          {/* W11.6.28: 'standards' (per-tier targets) is folded into the
              RecipeMatrixTab as the 'Tier defaults' row. The legacy
              SettingsShortlistingStandards component stays in the
              codebase but is not wired into the IA. Old deep-links
              redirect via TAB_REDIRECTS. */}

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

          <TabsContent value="architecture" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <ArchitectureTab />
            </Suspense>
          </TabsContent>

          <TabsContent value="recipes" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <RecipeMatrixTab />
            </Suspense>
          </TabsContent>

          <TabsContent value="taxonomy_explorer" className="mt-0">
            <Suspense fallback={<TabFallback />}>
              <TaxonomyExplorerTab />
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
