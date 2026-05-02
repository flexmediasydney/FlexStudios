/**
 * CalibrationSessionsListTab — Wave 14
 *
 * Tab 1 of SettingsCalibrationSessions. Lists every calibration_sessions row,
 * most-recent first, with status pill + project count + click-to-detail.
 *
 * Spec: docs/design-specs/W14-calibration-session.md §5.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { GitCompare, ListChecks, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const STATUS_VARIANTS = {
  open: { label: "Draft", variant: "secondary" },
  editor_phase: { label: "Editor input", variant: "outline" },
  diff_phase: { label: "Running / awaiting review", variant: "default" },
  completed: { label: "Completed", variant: "secondary" },
  abandoned: { label: "Abandoned", variant: "destructive" },
};

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

export default function CalibrationSessionsListTab({ onSelectSession }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["calibration-sessions", "list"],
    queryFn: async () => {
      const rows = await api.entities.CalibrationSession.list("-started_at", 100);
      return rows;
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent
          className="p-4 text-sm text-destructive"
          data-testid="sessions-list-error"
        >
          Failed to load calibration sessions: {String(error?.message || error)}
        </CardContent>
      </Card>
    );
  }

  const rows = data || [];

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent
          className="p-6 text-sm text-muted-foreground"
          data-testid="empty-state-sessions"
        >
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 opacity-60" />
            No calibration sessions yet. Switch to the Stratification tab to
            preview a candidate set and create your first session.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2.5" data-testid="sessions-list">
      {rows.map((row) => {
        const sv = STATUS_VARIANTS[row.status] || {
          label: row.status,
          variant: "outline",
        };
        const projectCount = Array.isArray(row.selected_project_ids)
          ? row.selected_project_ids.length
          : 0;
        return (
          <Card
            key={row.id}
            data-testid={`session-row-${row.id}`}
            className="cursor-pointer hover:bg-muted/30 transition-colors"
            onClick={() => onSelectSession?.(row.id)}
          >
            <CardHeader className="p-3 pb-1.5">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="space-y-0.5 min-w-0">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <GitCompare className="h-3.5 w-3.5 text-emerald-600" />
                    <span className="truncate">{row.session_name || "Untitled session"}</span>
                    <Badge
                      variant={sv.variant}
                      className="text-[10px]"
                      data-testid={`session-status-${row.id}`}
                    >
                      {sv.label}
                    </Badge>
                  </CardTitle>
                  <CardDescription className="text-[11px]">
                    Started {fmtTime(row.started_at)} ·{" "}
                    <span className="tabular-nums">{projectCount}</span> projects
                    {row.engine_version && (
                      <>
                        {" "}
                        · engine{" "}
                        <span className="font-mono">{row.engine_version}</span>
                      </>
                    )}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid={`session-open-${row.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSession?.(row.id);
                  }}
                >
                  Open
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            </CardHeader>
            {row.notes && (
              <CardContent className="p-3 pt-1.5 text-xs text-muted-foreground">
                {row.notes}
              </CardContent>
            )}
          </Card>
        );
      })}
    </div>
  );
}
