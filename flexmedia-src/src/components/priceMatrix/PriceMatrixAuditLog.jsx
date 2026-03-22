import { useState, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { format, formatDistanceToNow, isToday, isYesterday, parseISO } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Search, Download, ChevronDown, ChevronRight,
  Plus, Pencil, Trash2, Building, User,
  ArrowRight, History, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIELD_LABELS = {
  product_pricing: "Product Pricing",
  package_pricing: "Package Pricing",
  blanket_discount: "Blanket Discount",
  use_default_pricing: "Pricing Mode",
  name: "Name",
  entity_name: "Entity Name",
  entity_type: "Entity Type",
  notes: "Notes",
  status: "Status",
};

const IGNORED_FIELDS = ["id", "created_at", "updated_at", "created_date", "updated_date"];

const ACTION_CONFIG = {
  create: { Icon: Plus, bg: "bg-green-100", text: "text-green-700", label: "Created" },
  update: { Icon: Pencil, bg: "bg-blue-100", text: "text-blue-700", label: "Updated" },
  delete: { Icon: Trash2, bg: "bg-red-100", text: "text-red-700", label: "Deleted" },
};

const FILTER_DEFS = [
  { key: "all", label: "All" },
  { key: "pricing", label: "Pricing" },
  { key: "discount", label: "Discounts" },
  { key: "mode", label: "Mode" },
];

const PRICING_FIELDS = new Set(["product_pricing", "package_pricing"]);
const DISCOUNT_FIELDS = new Set(["blanket_discount"]);
const MODE_FIELDS = new Set(["use_default_pricing"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseDate(raw) {
  if (!raw) return new Date(0);
  try {
    const fixed = fixTimestamp(raw);
    return typeof fixed === "string" ? parseISO(fixed) : new Date(fixed);
  } catch {
    return new Date(raw);
  }
}

function formatFieldValue(val) {
  if (val === null || val === undefined || val === "") return "(empty)";
  if (typeof val === "boolean") return val ? "Yes" : "No";
  if (Array.isArray(val)) return val.length > 0 ? val.join(", ") : "(empty)";
  if (typeof val === "string" && val.length > 80) return val.slice(0, 80) + "\u2026";
  return String(val);
}

function safeParse(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return null; }
}

function groupByDate(items) {
  const groups = {};
  for (const item of items) {
    const d = safeParseDate(item.created_date);
    let label;
    if (isToday(d)) label = "Today";
    else if (isYesterday(d)) label = "Yesterday";
    else label = format(d, "EEEE, d MMMM yyyy");
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }
  return Object.entries(groups);
}

function matchesFilter(log, filter) {
  if (filter === "all") return true;
  const fields = (log.changed_fields || []).map((c) => c.field);
  if (filter === "pricing") return fields.some((f) => PRICING_FIELDS.has(f));
  if (filter === "discount") return fields.some((f) => DISCOUNT_FIELDS.has(f));
  if (filter === "mode") return fields.some((f) => MODE_FIELDS.has(f));
  return true;
}

function matchesSearch(log, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const haystack = [log.user_name, log.user_email, log.entity_name, log.changes_summary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(q);
}

function countForFilter(logs, filter) {
  if (filter === "all") return logs.length;
  return logs.filter((l) => matchesFilter(l, filter)).length;
}

// ---------------------------------------------------------------------------
// JSONB Diff Renderers
// ---------------------------------------------------------------------------

function buildItemMap(arr, idKey) {
  const map = new Map();
  if (!Array.isArray(arr)) return map;
  for (const item of arr) {
    const key = item[idKey];
    if (key) map.set(key, item);
  }
  return map;
}

function PricingDiff({ oldValue, newValue, idKey, nameKey }) {
  const oldMap = buildItemMap(safeParse(oldValue), idKey);
  const newMap = buildItemMap(safeParse(newValue), idKey);

  if (oldMap.size === 0 && newMap.size === 0) {
    return <span className="text-xs text-muted-foreground italic">Unable to parse pricing data</span>;
  }

  const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
  const rows = [];

  for (const key of allKeys) {
    const oldItem = oldMap.get(key);
    const newItem = newMap.get(key);
    const name = newItem?.[nameKey] || oldItem?.[nameKey] || key;

    if (!oldItem && newItem) {
      rows.push(
        <div key={key} className="flex items-center gap-1.5 text-xs text-green-600">
          <Plus className="h-3 w-3 shrink-0" />
          <span className="font-medium">{name}</span>
          {newItem.standard_price != null && <span>Std ${newItem.standard_price}</span>}
        </div>
      );
    } else if (oldItem && !newItem) {
      rows.push(
        <div key={key} className="flex items-center gap-1.5 text-xs text-red-500 line-through">
          <Trash2 className="h-3 w-3 shrink-0" />
          <span>{name}</span>
          {oldItem.standard_price != null && <span>Std ${oldItem.standard_price}</span>}
        </div>
      );
    } else if (oldItem && newItem) {
      // Compare all numeric/boolean fields for changes
      const priceKeys = Object.keys(newItem).filter(
        (k) => k !== idKey && k !== nameKey && (typeof newItem[k] === "number" || typeof newItem[k] === "boolean" || typeof oldItem[k] === "number")
      );
      const changed = priceKeys.filter((k) => oldItem[k] !== newItem[k]);
      if (changed.length === 0) continue;

      rows.push(
        <div key={key} className="text-xs">
          <span className="font-medium text-foreground">{name}: </span>
          {changed.map((k, i) => (
            <span key={k} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground">, </span>}
              <span className="capitalize text-muted-foreground">{k.replace(/_/g, " ").replace("price", "").trim() || k}</span>
              <span className="text-red-500 line-through">${oldItem[k]}</span>
              <ArrowRight className="h-2.5 w-2.5 text-muted-foreground inline" />
              <span className="text-green-600 font-medium">${newItem[k]}</span>
            </span>
          ))}
        </div>
      );
    }
  }

  return rows.length > 0
    ? <div className="space-y-1">{rows}</div>
    : <span className="text-xs text-muted-foreground italic">No pricing differences detected</span>;
}

function DiscountDiff({ oldValue, newValue }) {
  const oldObj = safeParse(oldValue) || {};
  const newObj = safeParse(newValue) || {};
  const parts = [];

  if (oldObj.enabled !== newObj.enabled) {
    parts.push(
      <span key="enabled" className="text-xs">
        Discount {newObj.enabled ? (
          <span className="text-green-600 font-medium">enabled</span>
        ) : (
          <span className="text-red-500 font-medium">disabled</span>
        )}
      </span>
    );
  }
  if (oldObj.percent !== newObj.percent) {
    parts.push(
      <span key="percent" className="inline-flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">Percent</span>
        <span className="text-red-500 line-through">{oldObj.percent ?? 0}%</span>
        <ArrowRight className="h-2.5 w-2.5 text-muted-foreground inline" />
        <span className="text-green-600 font-medium">{newObj.percent ?? 0}%</span>
      </span>
    );
  }

  return parts.length > 0
    ? <div className="space-y-1">{parts}</div>
    : <span className="text-xs text-muted-foreground italic">No discount changes detected</span>;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FieldDiff({ change }) {
  const { field, old_value, new_value } = change;

  // JSONB pricing diffs
  if (field === "product_pricing") {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">{FIELD_LABELS[field]}</div>
        <PricingDiff oldValue={old_value} newValue={new_value} idKey="product_id" nameKey="product_name" />
      </div>
    );
  }
  if (field === "package_pricing") {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">{FIELD_LABELS[field]}</div>
        <PricingDiff oldValue={old_value} newValue={new_value} idKey="package_id" nameKey="package_name" />
      </div>
    );
  }
  if (field === "blanket_discount") {
    return (
      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">{FIELD_LABELS[field]}</div>
        <DiscountDiff oldValue={old_value} newValue={new_value} />
      </div>
    );
  }

  // Scalar diff
  return (
    <div className="flex items-start gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground shrink-0 w-28 text-right">
        {FIELD_LABELS[field] || field}
      </span>
      <span className="text-red-500/70 line-through truncate max-w-[140px]" title={formatFieldValue(old_value)}>
        {formatFieldValue(old_value)}
      </span>
      <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
      <span className="text-green-600 font-medium truncate max-w-[140px]" title={formatFieldValue(new_value)}>
        {formatFieldValue(new_value)}
      </span>
    </div>
  );
}

function AuditEntry({ log, isModuleView, expanded, onToggle }) {
  const config = ACTION_CONFIG[log.action] || ACTION_CONFIG.update;
  const { Icon: ActionIcon, bg, text } = config;
  const d = safeParseDate(log.created_date);
  const changes = (log.changed_fields || []).filter((c) => !IGNORED_FIELDS.includes(c.field));

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      <div
        className="flex items-start gap-3 p-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={onToggle}
      >
        {/* Action icon */}
        <div className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0 mt-0.5", bg, text)}>
          <ActionIcon className="h-3.5 w-3.5" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Line 1: user + entity badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm text-foreground">
              {log.user_name || log.user_email || "System"}
            </span>
            {isModuleView && log.entity_name && (
              <Badge variant="outline" className="text-[10px] h-5 flex items-center gap-1">
                {log.entity_type === "agency"
                  ? <Building className="h-3 w-3" />
                  : <User className="h-3 w-3" />}
                {log.entity_name}
              </Badge>
            )}
          </div>

          {/* Line 2: changes summary */}
          {log.changes_summary && (
            <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{log.changes_summary}</p>
          )}

          {/* Line 3: affected projects */}
          {log.affected_projects_count > 0 && (
            <div className="flex items-center gap-1 mt-1">
              <AlertTriangle className="h-3 w-3 text-amber-500" />
              <span className="text-xs text-amber-600 font-medium">
                Affected {log.affected_projects_count} project{log.affected_projects_count !== 1 ? "s" : ""}
              </span>
            </div>
          )}
        </div>

        {/* Right: relative time + chevron */}
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
          <span title={format(d, "dd MMM yyyy, h:mm a")}>
            {formatDistanceToNow(d, { addSuffix: true })}
          </span>
          {expanded
            ? <ChevronDown className="h-4 w-4" />
            : <ChevronRight className="h-4 w-4" />}
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t bg-muted/20 px-4 py-3">
          {changes.length > 0 ? (
            <div className="space-y-2.5">
              {changes.map((change, idx) => (
                <FieldDiff key={idx} change={change} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {log.action === "create"
                ? "Record created \u2014 no field-level diff available."
                : "No field-level diff available for this change."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV Export
// ---------------------------------------------------------------------------

function exportCSV(logs) {
  const header = ["Timestamp", "User", "Entity", "Action", "Summary", "Details"];
  const rows = logs.map((log) => {
    const d = safeParseDate(log.created_date);
    const ts = format(d, "yyyy-MM-dd HH:mm:ss");
    const details = (log.changed_fields || [])
      .map((c) => `${c.field}: ${formatFieldValue(c.old_value)} -> ${formatFieldValue(c.new_value)}`)
      .join("; ");
    return [ts, log.user_name || "System", log.entity_name || "", log.action || "", log.changes_summary || "", details];
  });

  const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [header.map(escape).join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "price-matrix-audit.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function PriceMatrixAuditLog({ priceMatrixId = null }) {
  const [expandedId, setExpandedId] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  const isModuleView = priceMatrixId === null;

  const filterFn = useMemo(
    () => (priceMatrixId ? (log) => log.price_matrix_id === priceMatrixId : null),
    [priceMatrixId]
  );

  const { data: rawLogs = [], loading } = useEntityList(
    "PriceMatrixAuditLog",
    "-created_date",
    priceMatrixId ? 50 : 200,
    filterFn
  );

  // Search-filtered logs (before category filter, so counts are based on search)
  const searchFiltered = useMemo(
    () => rawLogs.filter((l) => matchesSearch(l, search)),
    [rawLogs, search]
  );

  // Category-filtered logs
  const filteredLogs = useMemo(
    () => searchFiltered.filter((l) => matchesFilter(l, filter)),
    [searchFiltered, filter]
  );

  // Date-grouped
  const grouped = useMemo(() => groupByDate(filteredLogs), [filteredLogs]);

  // ----- Loading state -----
  if (loading) {
    return (
      <div className="p-6 space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  // ----- Empty state -----
  if (rawLogs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <History className="h-10 w-10 mb-3 opacity-30" />
        <p className="text-sm font-medium">No audit entries yet</p>
        <p className="text-xs mt-1">Changes will appear here after saving.</p>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", isModuleView ? "p-4 max-w-4xl" : "")}>
      {/* Header: search + export (module view only) */}
      {isModuleView && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or user..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={() => exportCSV(filteredLogs)}
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      )}

      {/* Filter pills (module view only) */}
      {isModuleView && (
        <div className="flex items-center gap-2 flex-wrap">
          {FILTER_DEFS.map(({ key, label }) => {
            const count = countForFilter(searchFiltered, key);
            const active = filter === key;
            return (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {label}
                <span className={cn(
                  "inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] px-1",
                  active ? "bg-background/20 text-background" : "bg-background text-foreground"
                )}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* No results after filtering */}
      {filteredLogs.length === 0 && rawLogs.length > 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Search className="h-8 w-8 mb-2 opacity-30" />
          <p className="text-sm">No entries match your filters.</p>
          <button
            onClick={() => { setSearch(""); setFilter("all"); }}
            className="text-xs text-primary hover:underline mt-1"
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Date-grouped timeline */}
      {grouped.map(([dateLabel, items]) => (
        <div key={dateLabel}>
          <div className="sticky top-0 z-10 bg-muted/30 px-3 py-1.5 rounded text-xs font-semibold uppercase text-muted-foreground mb-2">
            {dateLabel}
          </div>
          <div className="space-y-2">
            {items.map((log) => (
              <AuditEntry
                key={log.id}
                log={log}
                isModuleView={isModuleView}
                expanded={expandedId === log.id}
                onToggle={() => setExpandedId(expandedId === log.id ? null : log.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
