/**
 * HierarchyADetail — right-column detail panel for a selected
 * object_registry node.
 *
 * Shows the full row, slot eligibility (signal_room_type → slots), and the
 * recent classifications referencing this canonical_id via observed_objects.
 *
 * Mig 441: each observation row now carries full source attribution. Rendering
 * is delegated to ObservationsPanel — same control pattern is reused on the
 * Hierarchy B side.
 */

import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Eye } from "lucide-react";
import ObservationsPanel from "./ObservationsPanel.jsx";

export default function HierarchyADetail({ selected, query }) {
  if (!selected) {
    return (
      <Card data-testid="taxonomy-a-detail-empty">
        <CardContent className="p-6 text-xs text-muted-foreground flex items-center gap-2">
          <Eye className="h-4 w-4 flex-shrink-0" />
          Select a leaf in the tree to inspect its detail, sample
          observations, and slot eligibility.
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return <Skeleton className="h-64 w-full" data-testid="taxonomy-a-detail-skeleton" />;
  }

  if (query.error) {
    return (
      <Card>
        <CardContent className="p-3 text-xs text-amber-700 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <div>
            <p className="font-semibold">Detail fetch failed</p>
            <p className="text-muted-foreground">
              {query.error?.message || "RPC failed"}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;
  if (!data || data.found === false) {
    return (
      <Card>
        <CardContent className="p-3 text-xs text-muted-foreground">
          No active object found for canonical_id <code>{selected}</code>.
        </CardContent>
      </Card>
    );
  }

  const node = data.node || {};
  const eligibleSlots = data.eligible_slots || [];
  const observations = data.observations || [];

  return (
    <div className="space-y-3" data-testid="taxonomy-a-detail">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between gap-2">
            <span className="font-mono truncate">{node.canonical_id}</span>
            {node.auto_promoted && (
              <Badge variant="outline" className="text-[10px]">
                auto-promoted
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {node.display_name && (
            <div>
              <span className="text-muted-foreground">Display name: </span>
              <span className="font-medium">{node.display_name}</span>
            </div>
          )}
          {node.description && (
            <div className="text-muted-foreground italic">
              {node.description}
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1">
            <KV label="market_frequency" value={node.market_frequency} />
            <KV label="signal_confidence" value={node.signal_confidence} />
            <KV label="signal_room_type" value={node.signal_room_type} />
            <KV label="status" value={node.status} />
            <KV
              label="first_observed_at"
              value={fmtDate(node.first_observed_at)}
            />
            <KV
              label="last_observed_at"
              value={fmtDate(node.last_observed_at)}
            />
          </div>

          <div className="pt-2 border-t">
            <div className="text-muted-foreground text-[11px] mb-1">
              Hierarchy path
            </div>
            <div className="flex flex-wrap gap-1">
              {[
                node.level_0_class,
                node.level_1_functional,
                node.level_2_material,
                node.level_3_specific,
                node.level_4_detail,
              ]
                .filter(Boolean)
                .map((p, i) => (
                  <Badge
                    key={`${i}:${p}`}
                    variant="outline"
                    className="text-[10px] font-mono"
                  >
                    {p}
                  </Badge>
                ))}
            </div>
          </div>

          {Array.isArray(node.aliases) && node.aliases.length > 0 && (
            <div className="pt-2 border-t">
              <div className="text-muted-foreground text-[11px] mb-1">
                Aliases
              </div>
              <div className="flex flex-wrap gap-1">
                {node.aliases.map((a) => (
                  <Badge
                    key={`alias:${a}`}
                    variant="secondary"
                    className="text-[10px]"
                  >
                    {a}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span>Cross-references</span>
            <span className="text-xs font-normal text-muted-foreground">
              {data.observation_count ?? 0} classifications
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div>
            <div className="text-muted-foreground text-[11px] mb-1">
              Eligible for slots
            </div>
            <div className="flex flex-wrap gap-1">
              {eligibleSlots.length === 0 ? (
                <span className="text-muted-foreground italic">
                  No slot directly eligible via signal_room_type.
                </span>
              ) : (
                eligibleSlots.map((s) => (
                  <Badge
                    key={`slot:${s}`}
                    variant="outline"
                    className="text-[10px] font-mono"
                  >
                    {s}
                  </Badge>
                ))
              )}
            </div>
          </div>

          <div className="pt-2 border-t">
            <div className="text-muted-foreground text-[11px] mb-1">
              Recent observations
            </div>
            <ObservationsPanel
              rows={observations}
              totalCount={data.observation_count ?? observations.length}
              emptyMessage="No classifications reference this canonical_id yet."
              testId="taxonomy-a-observations"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function KV({ label, value }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono truncate">
        {value === null || value === undefined || value === "" ? (
          <span className="text-muted-foreground italic">—</span>
        ) : (
          String(value)
        )}
      </span>
    </div>
  );
}

function fmtDate(v) {
  if (!v) return "";
  try {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    return d.toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return v;
  }
}
