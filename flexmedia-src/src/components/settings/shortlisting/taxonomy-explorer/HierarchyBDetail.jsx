/**
 * HierarchyBDetail — right-column detail panel for a selected
 * Hierarchy B value (e.g. space_type='master_bedroom').
 *
 * Shows:
 *   - axis + value
 *   - n_compositions count
 *   - eligible slots whose eligible_<axis> array contains this value
 *   - recent sample classifications (mig 441: with source attribution)
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

export default function HierarchyBDetail({ selected, query }) {
  if (!selected) {
    return (
      <Card data-testid="taxonomy-b-detail-empty">
        <CardContent className="p-6 text-xs text-muted-foreground flex items-center gap-2">
          <Eye className="h-4 w-4 flex-shrink-0" />
          Click a value in any axis card to see slot eligibility and recent
          sample classifications.
        </CardContent>
      </Card>
    );
  }

  if (query.isLoading) {
    return (
      <Skeleton className="h-64 w-full" data-testid="taxonomy-b-detail-skeleton" />
    );
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

  const data = query.data || {};
  const eligibleSlots = data.eligible_slots || [];
  const samples = data.samples || [];

  return (
    <div className="space-y-3" data-testid="taxonomy-b-detail">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="font-mono truncate">
              {selected.axis} · {selected.value}
            </span>
            <Badge variant="secondary" className="text-[10px]">
              {data.n_compositions ?? 0} compositions
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-2">
          <div>
            <div className="text-muted-foreground text-[11px] mb-1">
              Eligible for slots
            </div>
            <div className="flex flex-wrap gap-1">
              {eligibleSlots.length === 0 ? (
                <span className="text-muted-foreground italic">
                  No active slot definition lists this value as eligible.
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent samples</CardTitle>
        </CardHeader>
        <CardContent className="text-xs">
          <ObservationsPanel
            rows={samples}
            totalCount={data.n_compositions ?? samples.length}
            emptyMessage="No sample classifications yet."
            testId="taxonomy-b-samples"
          />
        </CardContent>
      </Card>
    </div>
  );
}
