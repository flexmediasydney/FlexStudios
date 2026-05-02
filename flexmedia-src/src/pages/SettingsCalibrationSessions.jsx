/**
 * SettingsCalibrationSessions — Wave 14 master_admin admin page for the
 * 50-project structured calibration session.
 *
 * URL:        /SettingsCalibrationSessions
 * Permission: master_admin only (gated via PermissionGuard + routeAccess).
 *
 * Three tabs:
 *   1. Sessions        — list calibration_sessions rows with status. Click
 *                        through to detail view.
 *   2. Detail          — for a single session: stratification summary,
 *                        editor-shortlist progress, "Run AI Batch" button,
 *                        editor-vs-AI disagreement diff table.
 *   3. Stratification  — preview before creating: pick days_back, see the
 *                        candidate distribution by tier × suburb × project_type,
 *                        save as a new session.
 *
 * Spec: docs/design-specs/W14-calibration-session.md
 * Migration: 407_w14_calibration_session.sql
 *
 * Style mirrors SettingsObjectRegistry / SettingsAISuggestions: slate cards,
 * tabular-nums, compact type, no animation. Tabs primitive from shadcn/ui.
 */

import { useSearchParams } from "react-router-dom";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ListChecks, Layers, GitCompare } from "lucide-react";
import CalibrationSessionsListTab from "@/components/settings/calibration/CalibrationSessionsListTab";
import CalibrationSessionDetailTab from "@/components/settings/calibration/CalibrationSessionDetailTab";
import CalibrationStratificationTab from "@/components/settings/calibration/CalibrationStratificationTab";

const VALID_TABS = ["sessions", "detail", "stratification"];

export default function SettingsCalibrationSessions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  const sessionParam = searchParams.get("session_id");
  // If a session_id is present in the query, treat the active tab as detail
  // unless the caller explicitly asked for sessions / stratification.
  const activeTab = VALID_TABS.includes(rawTab)
    ? rawTab
    : sessionParam
      ? "detail"
      : "sessions";

  const handleTabChange = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === "sessions") {
      next.delete("tab");
      // Leave session_id alone — caller may still want to deep-link back.
    } else {
      next.set("tab", value);
    }
    setSearchParams(next, { replace: true });
  };

  const handleSelectSession = (sessionId) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "detail");
    next.set("session_id", sessionId);
    setSearchParams(next, { replace: true });
  };

  return (
    <PermissionGuard require={["master_admin"]}>
      <div
        className="p-6 space-y-3 max-w-7xl mx-auto"
        data-testid="settings-calibration-sessions-page"
      >
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <GitCompare className="h-5 w-5 text-emerald-600" />
            Calibration Sessions
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Wave 14 — orchestrate the 50-project structured calibration that
            captures editor-vs-AI ground-truth disagreements. The diffs tune
            tier weights, populate few-shot examples, and validate the
            suggestion engine. ~$1.50 / 25 editor hours per session; runs at
            most annually unless major engine changes warrant a refresh.
          </p>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="space-y-3"
        >
          <TabsList
            className="h-auto"
            data-testid="calibration-sessions-tabs"
          >
            <TabsTrigger
              value="sessions"
              className="gap-2 text-xs"
              data-testid="tab-sessions"
            >
              <ListChecks className="h-3.5 w-3.5" />
              Sessions
            </TabsTrigger>
            <TabsTrigger
              value="detail"
              className="gap-2 text-xs"
              data-testid="tab-detail"
              disabled={!sessionParam}
            >
              <GitCompare className="h-3.5 w-3.5" />
              Detail
            </TabsTrigger>
            <TabsTrigger
              value="stratification"
              className="gap-2 text-xs"
              data-testid="tab-stratification"
            >
              <Layers className="h-3.5 w-3.5" />
              Stratification
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sessions" className="mt-0">
            <CalibrationSessionsListTab onSelectSession={handleSelectSession} />
          </TabsContent>

          <TabsContent value="detail" className="mt-0">
            <CalibrationSessionDetailTab sessionId={sessionParam} />
          </TabsContent>

          <TabsContent value="stratification" className="mt-0">
            <CalibrationStratificationTab onSessionCreated={handleSelectSession} />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
