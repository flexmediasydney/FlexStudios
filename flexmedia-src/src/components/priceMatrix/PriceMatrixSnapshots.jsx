import React, { useState, useMemo } from "react";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow, parseISO } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Database,
  Camera,
  Download,
  GitCompareArrows,
  ChevronDown,
  ChevronRight,
  Trash2,
  Building,
  User,
  X,
  Plus,
  Minus,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeDate(value) {
  if (!value) return null;
  try {
    const fixed = fixTimestamp(value);
    return parseISO(fixed);
  } catch {
    return null;
  }
}

function fmtDate(value, pattern = "dd MMM yyyy") {
  const d = safeDate(value);
  return d ? format(d, pattern) : "";
}

function fmtRelative(value) {
  const d = safeDate(value);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : "";
}

function compositeKey(entry) {
  return `${entry.entity_type}:${entry.entity_id}`;
}

function pricingModeLabel(entry) {
  if (entry.use_default_pricing) return "Default";
  if (entry.blanket_discount?.enabled) return "Blanket";
  return "Custom";
}

function pricingModeBadge(entry) {
  const mode = pricingModeLabel(entry);
  if (mode === "Default")
    return <Badge variant="outline" className="text-xs">Default</Badge>;
  if (mode === "Blanket")
    return <Badge className="text-xs bg-amber-100 text-amber-800 hover:bg-amber-100">Blanket</Badge>;
  return <Badge className="text-xs bg-blue-100 text-blue-800 hover:bg-blue-100">Custom</Badge>;
}

function entityTypeLabel(type) {
  if (!type) return "Organisation";
  const t = type.toLowerCase();
  if (t === "building" || t === "agency" || t === "organisation") return "Organisation";
  return "People";
}

function entityTypeIcon(type) {
  const label = entityTypeLabel(type);
  if (label === "Organisation")
    return <Building className="h-3.5 w-3.5 text-muted-foreground" />;
  return <User className="h-3.5 w-3.5 text-muted-foreground" />;
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

function computeComparison(dataA, dataB) {
  if (!dataA || !dataB) return null;

  const mapA = new Map();
  const mapB = new Map();
  for (const entry of dataA) mapA.set(compositeKey(entry), entry);
  for (const entry of dataB) mapB.set(compositeKey(entry), entry);

  const added = [];
  const removed = [];
  const changed = [];

  // Added: in B but not A
  for (const [key, entryB] of mapB) {
    if (!mapA.has(key)) added.push(entryB);
  }

  // Removed: in A but not B
  for (const [key, entryA] of mapA) {
    if (!mapB.has(key)) removed.push(entryA);
  }

  // Changed: in both but different
  for (const [key, entryA] of mapA) {
    const entryB = mapB.get(key);
    if (!entryB) continue;

    const diffs = [];

    if (Boolean(entryA.use_default_pricing) !== Boolean(entryB.use_default_pricing)) {
      diffs.push({
        field: "Pricing Mode",
        from: pricingModeLabel(entryA),
        to: pricingModeLabel(entryB),
      });
    }

    if (Boolean(entryA.blanket_discount?.enabled) !== Boolean(entryB.blanket_discount?.enabled)) {
      if (!diffs.find((d) => d.field === "Pricing Mode")) {
        diffs.push({
          field: "Pricing Mode",
          from: pricingModeLabel(entryA),
          to: pricingModeLabel(entryB),
        });
      }
    }

    const blankProdA = entryA.blanket_discount?.product_percent ?? 0;
    const blankProdB = entryB.blanket_discount?.product_percent ?? 0;
    if (blankProdA !== blankProdB) {
      diffs.push({
        field: "Blanket (Products)",
        from: `${blankProdA}%`,
        to: `${blankProdB}%`,
      });
    }

    const blankPkgA = entryA.blanket_discount?.package_percent ?? 0;
    const blankPkgB = entryB.blanket_discount?.package_percent ?? 0;
    if (blankPkgA !== blankPkgB) {
      diffs.push({
        field: "Blanket (Packages)",
        from: `${blankPkgA}%`,
        to: `${blankPkgB}%`,
      });
    }

    const prodOverA = Array.isArray(entryA.product_pricing) ? entryA.product_pricing.length : 0;
    const prodOverB = Array.isArray(entryB.product_pricing) ? entryB.product_pricing.length : 0;
    if (prodOverA !== prodOverB) {
      diffs.push({ field: "Product Overrides", from: String(prodOverA), to: String(prodOverB) });
    }

    const pkgOverA = Array.isArray(entryA.package_pricing) ? entryA.package_pricing.length : 0;
    const pkgOverB = Array.isArray(entryB.package_pricing) ? entryB.package_pricing.length : 0;
    if (pkgOverA !== pkgOverB) {
      diffs.push({ field: "Package Overrides", from: String(pkgOverA), to: String(pkgOverB) });
    }

    if (diffs.length > 0) {
      changed.push({ entry: entryB, name: entryB.entity_name || entryA.entity_name, diffs });
    }
  }

  return { added, removed, changed };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PriceMatrixSnapshots() {
  const { data: snapshots = [], loading: isLoading } = useEntityList(
    "PriceMatrixSnapshot",
    "-snapshot_date",
    50
  );

  // State
  const [expandedSnapshot, setExpandedSnapshot] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedForCompare, setSelectedForCompare] = useState([]);
  const [showComparison, setShowComparison] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [expandedEntity, setExpandedEntity] = useState(null);

  // Mutations
  const createSnapshotMutation = useMutation({
    mutationFn: () => api.functions.invoke("generateMonthlyPriceMatrixSnapshots", {}),
    onSuccess: () => {
      toast.success("Snapshot captured successfully");
      refetchEntityList("PriceMatrixSnapshot");
    },
    onError: () => toast.error("Failed to capture snapshot"),
  });

  const deleteSnapshotMutation = useMutation({
    mutationFn: (id) => api.entities.PriceMatrixSnapshot.delete(id),
    onSuccess: () => {
      toast.success("Snapshot deleted");
      refetchEntityList("PriceMatrixSnapshot");
      if (selectedForCompare.includes(deletingId)) {
        setSelectedForCompare((prev) => prev.filter((sid) => sid !== deletingId));
      }
      if (expandedSnapshot === deletingId) setExpandedSnapshot(null);
      setDeletingId(null);
    },
    onError: () => {
      toast.error("Failed to delete snapshot");
      setDeletingId(null);
    },
  });

  // Derived
  const snapshotMap = useMemo(() => {
    const m = new Map();
    for (const s of snapshots) m.set(s.id, s);
    return m;
  }, [snapshots]);

  const expandedData = expandedSnapshot ? snapshotMap.get(expandedSnapshot) : null;

  const comparisonResult = useMemo(() => {
    if (!showComparison || selectedForCompare.length !== 2) return null;
    const a = snapshotMap.get(selectedForCompare[0]);
    const b = snapshotMap.get(selectedForCompare[1]);
    if (!a?.data || !b?.data) return null;
    return computeComparison(a.data, b.data);
  }, [showComparison, selectedForCompare, snapshotMap]);

  // Handlers
  const toggleCompareMode = () => {
    setCompareMode((prev) => !prev);
    setSelectedForCompare([]);
    setShowComparison(false);
  };

  const toggleCompareSelection = (id) => {
    setSelectedForCompare((prev) => {
      if (prev.includes(id)) return prev.filter((sid) => sid !== id);
      if (prev.length >= 2) return prev;
      return [...prev, id];
    });
    setShowComparison(false);
  };

  const handleExport = (snapshot) => {
    const json = JSON.stringify(snapshot.data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `price-matrix-snapshot-${snapshot.snapshot_label || snapshot.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Loading
  if (isLoading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading snapshots...
      </div>
    );
  }

  // Empty state
  if (snapshots.length === 0) {
    return (
      <div className="space-y-4">
        <HeaderBar
          compareMode={compareMode}
          toggleCompareMode={toggleCompareMode}
          onCapture={() => createSnapshotMutation.mutate()}
          capturing={createSnapshotMutation.isPending}
          expandedData={null}
          onExport={() => {}}
          snapshotCount={0}
        />
        <div className="py-12 text-center border rounded-lg bg-muted/10">
          <Database className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-medium text-sm">No snapshots yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Capture your first snapshot to start tracking pricing history.
          </p>
        </div>
      </div>
    );
  }

  const deletingSnapshot = deletingId ? snapshotMap.get(deletingId) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <HeaderBar
        compareMode={compareMode}
        toggleCompareMode={toggleCompareMode}
        onCapture={() => createSnapshotMutation.mutate()}
        capturing={createSnapshotMutation.isPending}
        expandedData={expandedData}
        onExport={() => expandedData && handleExport(expandedData)}
        snapshotCount={snapshots.length}
      />

      {/* Mini-timeline */}
      {snapshots.length >= 2 && <MiniTimeline snapshots={snapshots} />}

      {/* Compare selection bar */}
      {compareMode && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center gap-2 text-sm text-blue-800">
            <GitCompareArrows className="h-4 w-4" />
            <span>
              Select 2 snapshots to compare{" "}
              <span className="font-medium">({selectedForCompare.length}/2 selected)</span>
            </span>
          </div>
          <Button
            size="sm"
            disabled={selectedForCompare.length !== 2}
            onClick={() => setShowComparison(true)}
          >
            Compare Selected
          </Button>
        </div>
      )}

      {/* Comparison result panel */}
      {showComparison && comparisonResult && (
        <ComparisonPanel
          result={comparisonResult}
          labelA={snapshotMap.get(selectedForCompare[0])?.snapshot_label || "Snapshot A"}
          labelB={snapshotMap.get(selectedForCompare[1])?.snapshot_label || "Snapshot B"}
          onClose={() => setShowComparison(false)}
        />
      )}

      {/* Snapshot list */}
      <div className="space-y-2">
        {snapshots.map((snapshot) => {
          const isExpanded = expandedSnapshot === snapshot.id;
          const isSelected = selectedForCompare.includes(snapshot.id);

          return (
            <div key={snapshot.id} className="border rounded-lg overflow-hidden">
              {/* Card header */}
              <div className="flex items-center gap-3 p-3 hover:bg-muted/30 transition-colors">
                {compareMode && (
                  <button
                    onClick={() => toggleCompareSelection(snapshot.id)}
                    className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                      isSelected
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/40 hover:border-primary"
                    }`}
                  >
                    {isSelected && (
                      <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                )}

                <div
                  className="flex items-center gap-3 flex-1 cursor-pointer"
                  onClick={() => {
                    if (!compareMode) {
                      setExpandedSnapshot(isExpanded ? null : snapshot.id);
                    }
                  }}
                >
                  <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <Database className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {snapshot.snapshot_label}
                      </span>
                      <Badge
                        variant={snapshot.snapshot_type === "manual" ? "secondary" : "outline"}
                        className="text-xs"
                      >
                        {snapshot.snapshot_type === "manual" ? "Manual" : "Auto"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      <span>{fmtDate(snapshot.snapshot_date)}</span>
                      <span>{snapshot.total_entries ?? snapshot.data?.length ?? 0} entries</span>
                      {snapshot.created_by_name && <span>by {snapshot.created_by_name}</span>}
                      {snapshot.snapshot_date && (
                        <span className="hidden sm:inline">{fmtRelative(snapshot.snapshot_date)}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingId(snapshot.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                  {!compareMode && (
                    <button
                      onClick={() => setExpandedSnapshot(isExpanded ? null : snapshot.id)}
                      className="p-1 text-muted-foreground hover:text-foreground"
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded detail table */}
              {isExpanded && !compareMode && snapshot.data?.length > 0 && (
                <div className="border-t bg-muted/10">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/40">
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                            Entity Name
                          </th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                            Type
                          </th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                            Pricing Mode
                          </th>
                          <th className="text-center px-3 py-2 font-medium text-muted-foreground">
                            Product Overrides
                          </th>
                          <th className="text-center px-3 py-2 font-medium text-muted-foreground">
                            Package Overrides
                          </th>
                          <th className="text-center px-3 py-2 font-medium text-muted-foreground">
                            Blanket %
                          </th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">
                            Last Modified
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.data.map((entry, idx) => {
                          const prods = Array.isArray(entry.product_pricing) ? entry.product_pricing : [];
                          const pkgs = Array.isArray(entry.package_pricing) ? entry.package_pricing : [];
                          const blanketProd = entry.blanket_discount?.product_percent ?? 0;
                          const blanketPkg = entry.blanket_discount?.package_percent ?? 0;
                          const blanketDisplay = blanketProd || blanketPkg ? `${blanketProd}% / ${blanketPkg}%` : "\u2014";
                          const entryKey = `${snapshot.id}-${idx}`;
                          const isEntryExpanded = expandedEntity === entryKey;

                          return (
                            <React.Fragment key={idx}>
                              <tr
                                className={cn("cursor-pointer hover:bg-muted/30", idx < snapshot.data.length - 1 && !isEntryExpanded && "border-b")}
                                onClick={() => setExpandedEntity(isEntryExpanded ? null : entryKey)}
                              >
                                <td className="px-3 py-2 font-medium">
                                  <div className="flex items-center gap-1.5">
                                    {isEntryExpanded ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                                    {entry.entity_name || "\u2014"}
                                  </div>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex items-center gap-1.5">
                                    {entityTypeIcon(entry.entity_type)}
                                    <span className="text-muted-foreground">{entityTypeLabel(entry.entity_type)}</span>
                                  </div>
                                </td>
                                <td className="px-3 py-2">{pricingModeBadge(entry)}</td>
                                <td className="px-3 py-2 text-center">{prods.length}</td>
                                <td className="px-3 py-2 text-center">{pkgs.length}</td>
                                <td className="px-3 py-2 text-center">{blanketDisplay}</td>
                                <td className="px-3 py-2 text-muted-foreground">
                                  {fmtDate(entry.updated_at || entry.created_at, "dd MMM yyyy HH:mm")}
                                </td>
                              </tr>
                              {isEntryExpanded && (
                                <tr className="border-b">
                                  <td colSpan={7} className="p-0">
                                    <div className="bg-muted/10 px-6 py-3 space-y-3">
                                      {/* Product line items */}
                                      {prods.length > 0 && (
                                        <div>
                                          <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">Product Pricing</div>
                                          <table className="w-full text-[11px]">
                                            <thead>
                                              <tr className="text-muted-foreground border-b">
                                                <th className="text-left py-1 pr-3 font-medium">Product</th>
                                                <th className="text-center py-1 px-2 font-medium">Override</th>
                                                <th className="text-right py-1 px-2 font-medium">Std Base</th>
                                                <th className="text-right py-1 px-2 font-medium">Std Unit</th>
                                                <th className="text-right py-1 px-2 font-medium">Prm Base</th>
                                                <th className="text-right py-1 px-2 font-medium">Prm Unit</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {prods.map((p, pi) => (
                                                <tr key={pi} className={pi < prods.length - 1 ? "border-b border-dashed" : ""}>
                                                  <td className="py-1 pr-3 font-medium">{p.product_name || p.product_id?.slice(0, 8)}</td>
                                                  <td className="py-1 px-2 text-center">
                                                    {p.override_enabled ? <Badge className="text-[9px] h-4 bg-blue-100 text-blue-700">Yes</Badge> : <span className="text-muted-foreground">No</span>}
                                                  </td>
                                                  <td className="py-1 px-2 text-right">${p.standard_base ?? 0}</td>
                                                  <td className="py-1 px-2 text-right">${p.standard_unit ?? 0}</td>
                                                  <td className="py-1 px-2 text-right">${p.premium_base ?? 0}</td>
                                                  <td className="py-1 px-2 text-right">${p.premium_unit ?? 0}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                      {/* Package line items */}
                                      {pkgs.length > 0 && (
                                        <div>
                                          <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1.5">Package Pricing</div>
                                          <table className="w-full text-[11px]">
                                            <thead>
                                              <tr className="text-muted-foreground border-b">
                                                <th className="text-left py-1 pr-3 font-medium">Package</th>
                                                <th className="text-center py-1 px-2 font-medium">Override</th>
                                                <th className="text-right py-1 px-2 font-medium">Std Price</th>
                                                <th className="text-right py-1 px-2 font-medium">Prm Price</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {pkgs.map((p, pi) => (
                                                <tr key={pi} className={pi < pkgs.length - 1 ? "border-b border-dashed" : ""}>
                                                  <td className="py-1 pr-3 font-medium">{p.package_name || p.package_id?.slice(0, 8)}</td>
                                                  <td className="py-1 px-2 text-center">
                                                    {p.override_enabled ? <Badge className="text-[9px] h-4 bg-blue-100 text-blue-700">Yes</Badge> : <span className="text-muted-foreground">No</span>}
                                                  </td>
                                                  <td className="py-1 px-2 text-right">${p.standard_price ?? 0}</td>
                                                  <td className="py-1 px-2 text-right">${p.premium_price ?? 0}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      )}
                                      {/* Blanket discount detail */}
                                      {entry.blanket_discount?.enabled && (
                                        <div>
                                          <div className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Blanket Discount</div>
                                          <div className="flex gap-4 text-[11px]">
                                            <span>Products: <strong>{entry.blanket_discount.product_percent}%</strong></span>
                                            <span>Packages: <strong>{entry.blanket_discount.package_percent}%</strong></span>
                                          </div>
                                        </div>
                                      )}
                                      {prods.length === 0 && pkgs.length === 0 && !entry.blanket_discount?.enabled && (
                                        <p className="text-[11px] text-muted-foreground italic">Using master default pricing — no overrides or discounts configured.</p>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </React.Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {isExpanded && !compareMode && (!snapshot.data || snapshot.data.length === 0) && (
                <div className="border-t p-4 text-center text-xs text-muted-foreground">
                  This snapshot contains no entries.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deletingId} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete snapshot?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground">
                {deletingSnapshot?.snapshot_label || "this snapshot"}
              </span>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deletingId && deleteSnapshotMutation.mutate(deletingId)}
              disabled={deleteSnapshotMutation.isPending}
            >
              {deleteSnapshotMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HeaderBar({
  compareMode,
  toggleCompareMode,
  onCapture,
  capturing,
  expandedData,
  onExport,
  snapshotCount,
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Monthly snapshots capture the full price matrix state. Auto-generated on the 1st of each month.
      </p>
      <div className="flex items-center gap-2 flex-shrink-0">
        {snapshotCount >= 2 && (
          <Button
            size="sm"
            variant={compareMode ? "default" : "outline"}
            onClick={toggleCompareMode}
          >
            <GitCompareArrows className="h-4 w-4 mr-1.5" />
            Compare
          </Button>
        )}
        {expandedData && (
          <Button size="sm" variant="outline" onClick={onExport}>
            <Download className="h-4 w-4 mr-1.5" />
            Export JSON
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onCapture} disabled={capturing}>
          <Camera className="h-4 w-4 mr-1.5" />
          {capturing ? "Capturing..." : "Capture Now"}
        </Button>
      </div>
    </div>
  );
}

function MiniTimeline({ snapshots }) {
  return (
    <div className="flex items-center gap-0 px-2 py-3">
      {snapshots.map((snap, idx) => {
        const isManual = snap.snapshot_type === "manual";
        return (
          <div key={snap.id} className="flex items-center">
            <div className="group relative">
              <div
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-transform group-hover:scale-150 ${
                  isManual ? "bg-purple-500" : "bg-blue-500"
                }`}
              />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-popover text-popover-foreground border rounded shadow-md text-xs whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-10">
                {snap.snapshot_label}
              </div>
            </div>
            {idx < snapshots.length - 1 && (
              <div className="h-px w-4 sm:w-6 bg-border flex-shrink-0" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function ComparisonPanel({ result, labelA, labelB, onClose }) {
  const { added, removed, changed } = result;
  const totalChanges = added.length + removed.length + changed.length;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/40 border-b">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitCompareArrows className="h-4 w-4" />
          <span>
            Comparing: <span className="text-primary">{labelA}</span> vs{" "}
            <span className="text-primary">{labelB}</span>
          </span>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-4 px-4 py-2.5 border-b text-xs font-medium">
        <span className="flex items-center gap-1 text-green-700">
          <Plus className="h-3 w-3" /> {added.length} added
        </span>
        <span className="flex items-center gap-1 text-red-700">
          <Minus className="h-3 w-3" /> {removed.length} removed
        </span>
        <span className="flex items-center gap-1 text-amber-700">
          <ArrowRight className="h-3 w-3" /> {changed.length} changed
        </span>
      </div>

      {totalChanges === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          No differences found between these snapshots.
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y">
          {/* Added */}
          {added.length > 0 && (
            <div className="bg-green-50 border-l-4 border-green-500">
              <div className="px-4 py-2 text-xs font-semibold text-green-800 border-b border-green-200">
                Added ({added.length})
              </div>
              <div className="divide-y divide-green-200">
                {added.map((entry, i) => (
                  <div key={i} className="px-4 py-2 flex items-center gap-2 text-xs">
                    <Plus className="h-3 w-3 text-green-600 flex-shrink-0" />
                    <span className="font-medium">{entry.entity_name}</span>
                    <span className="text-green-700">{entityTypeLabel(entry.entity_type)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Removed */}
          {removed.length > 0 && (
            <div className="bg-red-50 border-l-4 border-red-500">
              <div className="px-4 py-2 text-xs font-semibold text-red-800 border-b border-red-200">
                Removed ({removed.length})
              </div>
              <div className="divide-y divide-red-200">
                {removed.map((entry, i) => (
                  <div key={i} className="px-4 py-2 flex items-center gap-2 text-xs">
                    <Minus className="h-3 w-3 text-red-600 flex-shrink-0" />
                    <span className="font-medium">{entry.entity_name}</span>
                    <span className="text-red-700">{entityTypeLabel(entry.entity_type)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Changed */}
          {changed.length > 0 && (
            <div className="bg-amber-50 border-l-4 border-amber-500">
              <div className="px-4 py-2 text-xs font-semibold text-amber-800 border-b border-amber-200">
                Changed ({changed.length})
              </div>
              <div className="divide-y divide-amber-200">
                {changed.map((item, i) => (
                  <div key={i} className="px-4 py-2.5">
                    <div className="font-medium text-xs mb-1">{item.name}</div>
                    <div className="space-y-0.5">
                      {item.diffs.map((diff, j) => (
                        <div
                          key={j}
                          className="flex items-center gap-1.5 text-xs text-amber-800"
                        >
                          <ArrowRight className="h-3 w-3 flex-shrink-0" />
                          <span className="text-muted-foreground">{diff.field}:</span>
                          <span className="line-through opacity-60">{diff.from}</span>
                          <ArrowRight className="h-2.5 w-2.5" />
                          <span className="font-medium">{diff.to}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
