import { useState } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { Camera, ChevronDown, ChevronRight, Download } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { toast } from "sonner";

export default function PackageSnapshotsPanel() {
  const [expanded, setExpanded] = useState({});
  const [creating, setCreating] = useState(false);
  const { data: snapshots, loading } = useEntityList("PackageSnapshot", "-created_date");

  const toggle = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  const handleManualSnapshot = async () => {
    setCreating(true);
    try {
      const user = await api.auth.me();
      const packages = await api.entities.Package.list();
      const now = new Date();
      const label = format(now, "MMMM yyyy") + " (Manual)";

      await api.entities.PackageSnapshot.create({
        snapshot_date: format(now, "yyyy-MM-dd"),
        snapshot_label: label,
        snapshot_type: "manual",
        total_entries: packages.length,
        data: packages,
        created_by_name: user?.full_name || user?.email || "Unknown"
      });
      toast.success("Snapshot created successfully");
    } catch {
      toast.error("Failed to create snapshot");
    } finally {
      setCreating(false);
    }
  };

  const handleExport = (snapshot) => {
    const json = JSON.stringify(snapshot.data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `packages-snapshot-${snapshot.snapshot_label}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading snapshots...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Point-in-time captures of all package pricing. Use these to audit or restore previous configurations.
        </p>
        <Button onClick={handleManualSnapshot} disabled={creating} size="sm" className="gap-2">
          <Camera className="h-4 w-4" />
          {creating ? "Creating..." : "Take Snapshot"}
        </Button>
      </div>

      {snapshots.length === 0 ? (
        <Card className="p-10 text-center">
          <Camera className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium">No snapshots yet</p>
          <p className="text-sm text-muted-foreground mt-1">Take your first snapshot to capture the current package pricing state.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {snapshots.map(snap => (
            <Card key={snap.id} className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <button onClick={() => toggle(snap.id)} className="text-muted-foreground hover:text-foreground">
                    {expanded[snap.id] ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{snap.snapshot_label}</span>
                      <Badge variant="outline" className="text-xs">
                        {snap.snapshot_type === "manual" ? "Manual" : "Monthly"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {snap.total_entries} packages
                      {snap.created_by_name && ` · by ${snap.created_by_name}`}
                      {snap.created_date && ` · ${fmtTimestampCustom(snap.created_date, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => handleExport(snap)} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Export
                </Button>
              </div>

              {expanded[snap.id] && snap.data?.length > 0 && (
                <div className="mt-4 border rounded-lg overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Products</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Standard</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Premium</th>
                        <th className="text-left px-3 py-2 font-medium text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snap.data.map((p, i) => (
                        <tr key={i} className={i < snap.data.length - 1 ? "border-b" : ""}>
                          <td className="px-3 py-2 font-medium">{p.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">{p.products?.length || 0} items</td>
                          <td className="px-3 py-2">${p.standard_tier?.package_price?.toFixed(2) || "0.00"}</td>
                          <td className="px-3 py-2">${p.premium_tier?.package_price?.toFixed(2) || "0.00"}</td>
                          <td className="px-3 py-2">
                            <span className={p.is_active ? "text-green-600" : "text-muted-foreground"}>
                              {p.is_active ? "Active" : "Inactive"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}