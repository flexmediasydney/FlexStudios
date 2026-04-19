/**
 * LegacyImportProgressPanel.jsx
 *
 * Post-import progress cards (Step 5). Polls the legacy_import_batches row
 * every 10 s to show async geocoding + package-mapping progress.
 *
 * Props:
 *   batchId : string   (uuid of legacy_import_batches row)
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import {
  CheckCircle2, MapPin, Package, Database, ArrowRight, Loader2, Info,
} from "lucide-react";

function ProgressCard({ icon: Icon, title, current, total, tone = "default", suffix = "" }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const toneClasses = {
    default: "text-foreground",
    success: "text-emerald-600",
    info: "text-blue-600",
    warn: "text-amber-600",
  };
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className={`rounded-md bg-muted p-2 ${toneClasses[tone]}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="text-xs font-semibold">{title}</div>
        </div>
        <div className="flex items-baseline gap-2 mb-2">
          <span className="text-2xl font-bold tabular-nums">{current.toLocaleString()}</span>
          <span className="text-sm text-muted-foreground">/ {total.toLocaleString()} {suffix}</span>
        </div>
        <Progress value={pct} />
        <div className="text-[11px] text-muted-foreground mt-1 tabular-nums">{pct}%</div>
      </CardContent>
    </Card>
  );
}

export default function LegacyImportProgressPanel({ batchId }) {
  const { data: batch, isLoading } = useQuery({
    queryKey: ["legacy_import_batch", batchId],
    queryFn: () => api.entities.LegacyImportBatch.get(batchId),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    enabled: !!batchId,
  });

  if (!batchId) {
    return (
      <div className="text-sm text-muted-foreground flex items-center gap-2">
        <Info className="h-4 w-4" /> No batch id — nothing to show.
      </div>
    );
  }
  if (isLoading || !batch) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading batch status…
      </div>
    );
  }

  const imported = batch.rows_imported || 0;
  const geocoded = batch.rows_geocoded || 0;
  const mapped = batch.rows_package_mapped || 0;
  const errors = batch.rows_errored || 0;
  const status = batch.status || "unknown";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <Badge className="text-[11px]" variant={status === "completed" ? "default" : status === "rolled_back" ? "destructive" : "secondary"}>
          Batch status: {status}
        </Badge>
        {errors > 0 && (
          <Badge variant="destructive" className="text-[11px]">
            {errors} row errors
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Source: <code className="text-[11px]">{batch.source}</code>
        </span>
        <span className="text-xs text-muted-foreground">
          Batch id: <code className="text-[11px]">{String(batch.id).slice(0, 8)}…</code>
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ProgressCard
          icon={Database}
          title="Rows imported"
          current={imported}
          total={imported}
          tone="success"
          suffix="rows"
        />
        <ProgressCard
          icon={MapPin}
          title="Addresses geocoded"
          current={geocoded}
          total={imported}
          tone="info"
          suffix="rows"
        />
        <ProgressCard
          icon={Package}
          title="Packages mapped"
          current={mapped}
          total={imported}
          tone="warn"
          suffix="rows"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link to={createPageUrl("SettingsDataConsistency")}>
            Go to Data Consistency
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={createPageUrl("SettingsLegacyPackageMapping")}>
            Review package mappings
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to={createPageUrl("SoldWithFlex")}>
            View Market Share
            <ArrowRight className="h-4 w-4 ml-1.5" />
          </Link>
        </Button>
      </div>

      {status === "completed" && geocoded >= imported && mapped >= imported && (
        <div className="rounded-lg border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 border p-4 flex items-start gap-3">
          <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5" />
          <div>
            <div className="font-semibold text-emerald-800 dark:text-emerald-300 text-sm">
              Batch fully processed
            </div>
            <div className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
              All rows geocoded and package-mapped. The Market Share tab should reflect the new captures.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
