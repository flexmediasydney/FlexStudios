import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { format } from "date-fns";
import { Camera, Calendar, Database, ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export default function PriceMatrixSnapshots() {
  const queryClient = useQueryClient();
  const [expandedSnapshot, setExpandedSnapshot] = useState(null);

  const { data: snapshots = [], loading: isLoading } = useEntityList("PriceMatrixSnapshot", "-snapshot_date", 24);

  const createSnapshotMutation = useMutation({
    mutationFn: () => api.functions.invoke("generateMonthlyPriceMatrixSnapshots", {}),
    onSuccess: () => {
      toast.success("Snapshot created successfully");
      queryClient.invalidateQueries({ queryKey: ["price-matrix-snapshots"] });
    },
    onError: () => toast.error("Failed to create snapshot")
  });

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Loading snapshots...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            Monthly snapshots capture the full price matrix state. Auto-generated on the 1st of each month.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => createSnapshotMutation.mutate()}
          disabled={createSnapshotMutation.isPending}
        >
          <Camera className="h-4 w-4 mr-1" />
          {createSnapshotMutation.isPending ? "Capturing..." : "Capture Now"}
        </Button>
      </div>

      {snapshots.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground border rounded-lg">
          No snapshots yet. Snapshots are taken on the 1st of each month or manually.
        </div>
      ) : (
        <div className="space-y-2">
          {snapshots.map((snapshot) => (
            <div key={snapshot.id} className="border rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-3 p-3 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => setExpandedSnapshot(expandedSnapshot === snapshot.id ? null : snapshot.id)}
              >
                <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <Database className="h-4 w-4 text-blue-600" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{snapshot.snapshot_label}</span>
                    <Badge variant={snapshot.snapshot_type === "manual" ? "secondary" : "outline"} className="text-xs">
                      {snapshot.snapshot_type === "manual" ? "Manual" : "Auto"}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {snapshot.snapshot_date ? format(new Date(snapshot.snapshot_date), "dd MMM yyyy") : ""}
                    </span>
                    <span>{snapshot.total_entries} entries</span>
                    {snapshot.created_by_name && <span>by {snapshot.created_by_name}</span>}
                  </div>
                </div>
                {expandedSnapshot === snapshot.id ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </div>

              {expandedSnapshot === snapshot.id && snapshot.data?.length > 0 && (
                <div className="border-t bg-muted/20 p-3">
                  <div className="text-xs font-medium text-muted-foreground mb-2">Snapshot Contents:</div>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {snapshot.data.map((entry, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs p-2 bg-white rounded border">
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground capitalize">{entry.entity_type}</span>
                          <span className="font-medium">{entry.entity_name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {entry.use_default_pricing ? (
                            <Badge variant="secondary" className="text-xs">Default</Badge>
                          ) : entry.blanket_discount?.enabled ? (
                            <Badge className="text-xs bg-amber-100 text-amber-800">
                              {entry.blanket_discount.product_percent}% off
                            </Badge>
                          ) : (
                            <Badge className="text-xs">Custom</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}