/**
 * LegacyImportColumnMapper.jsx
 *
 * Reusable column-mapping UI for the Legacy Import wizard (Step 2).
 * Left: detected source columns from the uploaded CSV/JSON (with sample values).
 * Right: dropdowns to map each target field to a source column.
 *
 * Features:
 *   - Auto-suggest mappings based on column header name similarity
 *   - Confidence badges per auto-suggested mapping
 *   - Date-format picker for completed_date
 *   - Save / load mapping templates to/from localStorage (keyed by filename hash)
 *
 * Props:
 *   sourceColumns  : string[]                  (detected headers)
 *   sampleRows     : object[]                  (first 20 rows of parsed data)
 *   mapping        : MappingState              (controlled)
 *   onChange       : (nextMapping) => void
 *   filenameHash   : string                    (for localStorage template keying)
 *
 * MappingState shape:
 *   {
 *     fields: { raw_address: "col_name", project_name: "col_name", ... },
 *     dateFormat: "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY" | "ISO",
 *     confidences: { raw_address: 0..1, ... }   // for auto-suggested mappings
 *   }
 */

import React, { useMemo, useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Wand2, Save, FolderOpen, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

// ── Target field definitions ────────────────────────────────────────────────

export const TARGET_FIELDS = [
  { key: "raw_address", label: "Raw address", required: true, hint: "e.g. '12 Main St, Bondi NSW 2026'" },
  { key: "project_name", label: "Project name", required: false, hint: "Freeform project or deal title" },
  { key: "completed_date", label: "Completed date", required: false, hint: "Date of deal completion", isDate: true },
  { key: "package_name_legacy", label: "Package (legacy)", required: false, hint: "Pipedrive package label" },
  { key: "products_legacy", label: "Products (legacy)", required: false, hint: "JSON column OR first of N line-item columns" },
  { key: "price", label: "Price", required: false, hint: "Numeric; stripped of currency symbols" },
  { key: "currency", label: "Currency", required: false, hint: "ISO code; defaults to AUD if empty" },
  { key: "agent_name", label: "Agent name", required: false, hint: "Sales agent / deal owner" },
  { key: "agency_name", label: "Agency name", required: false, hint: "Agent's agency / brand" },
  { key: "client_name", label: "Client name", required: false, hint: "Contact full name" },
  { key: "client_email", label: "Client email", required: false, hint: "Contact email" },
  { key: "client_phone", label: "Client phone", required: false, hint: "Contact phone" },
  { key: "external_id", label: "External ID", required: false, hint: "Pipedrive deal id (for idempotency)" },
];

export const DATE_FORMATS = [
  { value: "YYYY-MM-DD", label: "YYYY-MM-DD (ISO)" },
  { value: "DD/MM/YYYY", label: "DD/MM/YYYY (AU / UK)" },
  { value: "MM/DD/YYYY", label: "MM/DD/YYYY (US)" },
  { value: "DD-MM-YYYY", label: "DD-MM-YYYY" },
  { value: "ISO", label: "Auto-detect ISO-8601 / Date.parse()" },
];

// ── Auto-suggest heuristics ─────────────────────────────────────────────────

const SUGGESTION_PATTERNS = {
  raw_address: [
    /^(project[_\s-]*)?address/i,
    /^property[_\s-]*address/i,
    /^full[_\s-]*address/i,
    /address/i,
    /^location/i,
    /^street/i,
  ],
  project_name: [
    /^(deal|project|job)[_\s-]*(name|title)/i,
    /^title$/i,
    /^name$/i,
    /^subject/i,
  ],
  completed_date: [
    /won[_\s-]*(time|date|at)/i,
    /close[d]?[_\s-]*(date|at)/i,
    /complet(ed|ion)[_\s-]*(date|at)/i,
    /finish(ed)?[_\s-]*(date|at)/i,
    /^date$/i,
  ],
  package_name_legacy: [
    /package/i,
    /tier/i,
    /product[_\s-]*(type|line|category)/i,
  ],
  products_legacy: [
    /^products?$/i,
    /line[_\s-]*items?/i,
    /items?$/i,
    /services?/i,
  ],
  price: [
    /^value$/i,
    /^price$/i,
    /^amount$/i,
    /^total$/i,
    /deal[_\s-]*value/i,
  ],
  currency: [
    /^currency$/i,
    /^ccy$/i,
  ],
  agent_name: [
    /^(deal[_\s-]*)?owner[_\s-]*(name)?$/i,
    /^agent[_\s-]*name$/i,
    /^agent$/i,
    /^sales[_\s-]*rep/i,
    /^photographer$/i,
  ],
  agency_name: [
    /^agency[_\s-]*(name)?$/i,
    /^brand$/i,
    /^org(anisation|anization)?$/i,
    /^company$/i,
  ],
  client_name: [
    /^(primary[_\s-]*)?contact[_\s-]*(name|full[_\s-]*name)?$/i,
    /^client[_\s-]*name$/i,
    /^person/i,
  ],
  client_email: [
    /email/i,
  ],
  client_phone: [
    /phone/i,
    /^mobile$/i,
    /^tel(ephone)?$/i,
  ],
  external_id: [
    /^deal[_\s-]*id$/i,
    /^id$/i,
    /external[_\s-]*id/i,
    /pipedrive[_\s-]*id/i,
  ],
};

function normaliseHeader(s) {
  return String(s || "").trim().toLowerCase();
}

/**
 * Score how well a source column matches a target field.
 * Returns 0..1 confidence. Higher index in the pattern list = lower confidence.
 */
function scoreMatch(sourceCol, targetKey) {
  const patterns = SUGGESTION_PATTERNS[targetKey];
  if (!patterns) return 0;
  const norm = normaliseHeader(sourceCol);
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(norm)) {
      // First pattern = 1.0, decays by 0.15 per rank down, floor 0.4
      return Math.max(0.4, 1.0 - i * 0.15);
    }
  }
  return 0;
}

/**
 * Produce an auto-suggested mapping given a list of detected source columns.
 * Resolves conflicts (same column suggested for two targets) by keeping the
 * higher-scoring target.
 */
export function autoSuggestMapping(sourceColumns) {
  const fields = {};
  const confidences = {};
  // Per-target best candidate
  for (const tgt of TARGET_FIELDS) {
    let bestCol = null;
    let bestScore = 0;
    for (const col of sourceColumns) {
      const s = scoreMatch(col, tgt.key);
      if (s > bestScore) {
        bestScore = s;
        bestCol = col;
      }
    }
    if (bestCol && bestScore > 0) {
      fields[tgt.key] = bestCol;
      confidences[tgt.key] = bestScore;
    }
  }

  // Resolve conflicts: a column can only map to one target. Keep the
  // higher-confidence mapping.
  const byCol = {};
  for (const [tgtKey, col] of Object.entries(fields)) {
    const prev = byCol[col];
    if (!prev || confidences[tgtKey] > confidences[prev]) {
      if (prev) {
        delete fields[prev];
        delete confidences[prev];
      }
      byCol[col] = tgtKey;
    } else {
      delete fields[tgtKey];
      delete confidences[tgtKey];
    }
  }
  return { fields, confidences };
}

// ── localStorage template helpers ───────────────────────────────────────────

const STORAGE_PREFIX = "flexstudios.legacyImport.mapping.";

function templateKey(hash) {
  return `${STORAGE_PREFIX}${hash || "default"}`;
}

export function loadMappingTemplate(hash) {
  try {
    const raw = localStorage.getItem(templateKey(hash));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveMappingTemplate(hash, mapping) {
  try {
    localStorage.setItem(templateKey(hash), JSON.stringify(mapping));
    return true;
  } catch {
    return false;
  }
}

export function listMappingTemplates() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(STORAGE_PREFIX)) {
      out.push(k.slice(STORAGE_PREFIX.length));
    }
  }
  return out;
}

// ── Utility: hash filename for template keying ──────────────────────────────

export function hashFilename(filename) {
  const s = String(filename || "unknown");
  // Simple DJB2 hash — good enough for localStorage keying
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return `h${Math.abs(hash).toString(36)}`;
}

// ── Confidence chip ─────────────────────────────────────────────────────────

function ConfidenceBadge({ score }) {
  if (!score) return null;
  const pct = Math.round(score * 100);
  const tone =
    score >= 0.8 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
    : score >= 0.6 ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
    : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}>
      <Wand2 className="h-2.5 w-2.5" />
      {pct}%
    </span>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export default function LegacyImportColumnMapper({
  sourceColumns = [],
  sampleRows = [],
  mapping,
  onChange,
  filenameHash,
}) {
  const [templates, setTemplates] = useState([]);

  useEffect(() => {
    setTemplates(listMappingTemplates());
  }, []);

  const sampleFor = useCallback((col) => {
    if (!col) return "";
    const firstNonEmpty = sampleRows.find(r => r && r[col] != null && String(r[col]).trim() !== "");
    if (!firstNonEmpty) return "";
    const v = firstNonEmpty[col];
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  }, [sampleRows]);

  const runAutoSuggest = () => {
    const { fields, confidences } = autoSuggestMapping(sourceColumns);
    onChange({
      ...mapping,
      fields: { ...fields },
      confidences: { ...confidences },
    });
    const matched = Object.keys(fields).length;
    toast.success(`Auto-matched ${matched} of ${TARGET_FIELDS.length} fields`);
  };

  const handleSaveTemplate = () => {
    const ok = saveMappingTemplate(filenameHash, mapping);
    if (ok) {
      toast.success("Mapping saved for future Pipedrive exports with similar filenames");
      setTemplates(listMappingTemplates());
    } else {
      toast.error("Could not save mapping (localStorage unavailable?)");
    }
  };

  const handleLoadTemplate = () => {
    const tpl = loadMappingTemplate(filenameHash);
    if (!tpl) {
      toast.error("No saved mapping for this filename");
      return;
    }
    onChange(tpl);
    toast.success("Mapping restored");
  };

  const setField = (targetKey, sourceCol) => {
    const nextFields = { ...(mapping.fields || {}) };
    const nextConf = { ...(mapping.confidences || {}) };
    if (!sourceCol || sourceCol === "__none__") {
      delete nextFields[targetKey];
    } else {
      nextFields[targetKey] = sourceCol;
    }
    // Once user touches a field, drop the auto-confidence badge
    delete nextConf[targetKey];
    onChange({ ...mapping, fields: nextFields, confidences: nextConf });
  };

  const setDateFormat = (fmt) => {
    onChange({ ...mapping, dateFormat: fmt });
  };

  const totalMapped = Object.keys(mapping?.fields || {}).length;
  const hasTemplate = filenameHash && templates.includes(filenameHash);

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* Left: detected source columns */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center justify-between">
            <span>Detected source columns</span>
            <Badge variant="secondary">{sourceColumns.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[420px]">
            <div className="px-4 py-2 space-y-1.5">
              {sourceColumns.length === 0 && (
                <div className="text-xs text-muted-foreground py-6 text-center">
                  No columns detected yet — upload a file first.
                </div>
              )}
              {sourceColumns.map((col) => {
                const usedBy = Object.entries(mapping?.fields || {})
                  .filter(([, v]) => v === col)
                  .map(([k]) => k);
                return (
                  <div
                    key={col}
                    className={`rounded border px-2 py-1.5 text-xs ${
                      usedBy.length ? "border-emerald-400/60 bg-emerald-50/50 dark:bg-emerald-950/20" : "border-border"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate" title={col}>{col}</span>
                      {usedBy.length > 0 && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          <Check className="h-2.5 w-2.5 mr-0.5" />
                          {usedBy.length}
                        </Badge>
                      )}
                    </div>
                    {sampleFor(col) && (
                      <div className="text-muted-foreground text-[11px] mt-0.5 truncate" title={sampleFor(col)}>
                        e.g. {sampleFor(col)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Right: target-field mapping dropdowns */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-sm font-semibold">
              Map to target fields
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {totalMapped} of {TARGET_FIELDS.length} mapped
              </span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={runAutoSuggest}>
                <Wand2 className="h-3.5 w-3.5 mr-1.5" />
                Auto-suggest
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleLoadTemplate}
                disabled={!hasTemplate}
                title={hasTemplate ? "Load saved mapping" : "No saved mapping for this filename"}
              >
                <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                Load
              </Button>
              <Button variant="outline" size="sm" onClick={handleSaveTemplate}>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                Save as template
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {TARGET_FIELDS.map((tgt) => {
            const current = mapping?.fields?.[tgt.key] || "";
            const conf = mapping?.confidences?.[tgt.key];
            const isMissingRequired = tgt.required && !current;
            return (
              <div key={tgt.key} className="grid grid-cols-[200px_1fr] items-start gap-3">
                <div className="pt-2">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs font-medium">{tgt.label}</Label>
                    {tgt.required && (
                      <span className="text-[10px] text-red-500 font-semibold">required</span>
                    )}
                    <ConfidenceBadge score={conf} />
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{tgt.hint}</p>
                </div>
                <div className="space-y-1.5">
                  <Select
                    value={current || "__none__"}
                    onValueChange={(v) => setField(tgt.key, v)}
                  >
                    <SelectTrigger className={isMissingRequired ? "border-red-400" : ""}>
                      <SelectValue placeholder="Select source column…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— not mapped —</SelectItem>
                      {sourceColumns.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {isMissingRequired && (
                    <div className="text-[11px] text-red-600 dark:text-red-400 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Required — rows without this will be rejected
                    </div>
                  )}
                  {tgt.isDate && current && (
                    <div className="flex items-center gap-2 pt-1">
                      <Label className="text-[11px] text-muted-foreground shrink-0">Date format:</Label>
                      <Select
                        value={mapping?.dateFormat || "YYYY-MM-DD"}
                        onValueChange={setDateFormat}
                      >
                        <SelectTrigger className="h-7 text-xs w-[220px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DATE_FORMATS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
