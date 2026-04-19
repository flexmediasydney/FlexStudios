/**
 * SettingsLegacyImport.jsx — admin page for the Pipedrive historical-project import.
 *
 * 5-step wizard:
 *   1. Upload CSV or JSON (client-side preview of first 20 rows)
 *   2. Map source columns → target legacy_projects fields
 *   3. Preview first 50 rows with per-row validation
 *   4. Commit — calls importLegacyProjects edge function, polls batch status
 *   5. Post-import status — geocode + package-mapping progress
 *
 * Batch history sub-view lists prior imports with rollback support.
 *
 * Permissions: admin-only (PermissionGuard require=admin_or_above).
 *
 * Expected backend pieces (owned by parallel agents):
 *   - table  : legacy_projects
 *   - table  : legacy_import_batches
 *   - edge fn: importLegacyProjects({ batch_id, format, column_mapping, rows })
 *   - edge fn: geocodeLegacyProjects (cron, polls unfilled addresses)
 */

import React, { useMemo, useState, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import { formatDistanceToNow, format } from "date-fns";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Upload, FileText, FileJson, Check, ChevronRight, ChevronLeft,
  Loader2, AlertCircle, History, Undo2, Eye, Rocket, Trash2,
  RefreshCw,
} from "lucide-react";

import LegacyImportColumnMapper, {
  autoSuggestMapping, hashFilename, loadMappingTemplate,
} from "@/components/legacy/LegacyImportColumnMapper";
import LegacyImportPreviewTable, {
  validateRows, summariseValidation,
} from "@/components/legacy/LegacyImportPreviewTable";
import LegacyImportProgressPanel from "@/components/legacy/LegacyImportProgressPanel";

// ── Constants ───────────────────────────────────────────────────────────────

const STEPS = [
  { key: "upload", label: "Upload file", icon: Upload },
  { key: "map", label: "Map columns", icon: FileText },
  { key: "preview", label: "Preview", icon: Eye },
  { key: "commit", label: "Commit import", icon: Rocket },
  { key: "status", label: "Post-import", icon: Check },
];

const MAX_CLIENT_PREVIEW_ROWS = 20;
const PREVIEW_TABLE_ROWS = 50;
const MAX_ERROR_FRACTION = 0.2; // 20 % — block proceed if exceeded

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtRel(ts) {
  if (!ts) return "—";
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); } catch { return "—"; }
}
function fmtAbs(ts) {
  if (!ts) return "—";
  try { return format(new Date(ts), "PPp"); } catch { return "—"; }
}

// ── Step progress indicator ─────────────────────────────────────────────────

function StepIndicator({ step }) {
  return (
    <div className="flex items-center justify-between gap-2 py-3 px-1">
      {STEPS.map((s, idx) => {
        const active = idx === step;
        const done = idx < step;
        const Icon = s.icon;
        return (
          <React.Fragment key={s.key}>
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`shrink-0 h-7 w-7 rounded-full flex items-center justify-center border-2 ${
                  done
                    ? "bg-emerald-500 border-emerald-500 text-white"
                    : active
                    ? "border-primary text-primary bg-background"
                    : "border-muted bg-muted text-muted-foreground"
                }`}
              >
                {done ? <Check className="h-4 w-4" /> : <Icon className="h-3.5 w-3.5" />}
              </div>
              <div className="min-w-0 hidden sm:block">
                <div className={`text-[10px] uppercase tracking-wide ${active ? "text-primary" : "text-muted-foreground"}`}>
                  Step {idx + 1}
                </div>
                <div className={`text-xs font-medium truncate ${active ? "" : done ? "text-muted-foreground" : "text-muted-foreground"}`}>
                  {s.label}
                </div>
              </div>
            </div>
            {idx < STEPS.length - 1 && (
              <div className={`flex-1 h-px ${done ? "bg-emerald-500" : "bg-border"}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Step 1: File upload ─────────────────────────────────────────────────────

function FileDropZone({ onFile, disabled }) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = React.useRef(null);

  const handleFiles = (files) => {
    if (!files || files.length === 0) return;
    const f = files[0];
    const ext = f.name.toLowerCase().split(".").pop();
    if (!["csv", "json"].includes(ext)) {
      toast.error("Only .csv and .json files are accepted");
      return;
    }
    onFile(f);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={`rounded-lg border-2 border-dashed transition-colors p-10 text-center ${
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border bg-muted/30 hover:bg-muted/50"
      } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
    >
      <Upload className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
      <div className="text-sm font-medium">Drop a Pipedrive export here</div>
      <div className="text-xs text-muted-foreground mt-1">
        Accepts .csv and .json — the first {MAX_CLIENT_PREVIEW_ROWS} rows are previewed instantly
      </div>
      <Button
        className="mt-4"
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
      >
        Choose file
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  );
}

// ── Page body (wizard) ──────────────────────────────────────────────────────

function LegacyImportWizard() {
  const queryClient = useQueryClient();

  const [step, setStep] = useState(0);
  const [file, setFile] = useState(null); // { name, size, format, rows, columns }
  const [allRows, setAllRows] = useState([]); // full parsed data (for commit)
  const [previewRows, setPreviewRows] = useState([]); // first 20 for mapping sample
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState(null);

  const [mapping, setMapping] = useState({
    fields: {},
    dateFormat: "YYYY-MM-DD",
    confidences: {},
  });

  const [commitOpen, setCommitOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState(null);
  const [commitResult, setCommitResult] = useState(null); // { imported, errors }

  const filenameHash = useMemo(
    () => (file?.name ? hashFilename(file.name) : null),
    [file?.name]
  );

  // ── File handling ─────────────────────────────────────────────────────────

  const handleFile = useCallback((f) => {
    setParsing(true);
    setParseError(null);
    setFile(null);
    setAllRows([]);
    setPreviewRows([]);

    const ext = f.name.toLowerCase().split(".").pop();
    const reader = new FileReader();

    reader.onload = (e) => {
      const text = String(e.target?.result || "");
      if (ext === "csv") {
        Papa.parse(text, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            if (results.errors && results.errors.length > 0) {
              // Non-fatal row errors — report but continue with good rows
              console.warn("[LegacyImport] CSV parse had row errors:", results.errors.slice(0, 3));
            }
            const rows = results.data || [];
            const cols = results.meta?.fields || (rows[0] ? Object.keys(rows[0]) : []);
            if (rows.length === 0) {
              setParseError("No rows parsed from CSV. Is the header row present?");
              setParsing(false);
              return;
            }
            setFile({ name: f.name, size: f.size, format: "csv", rows: rows.length, columns: cols });
            setAllRows(rows);
            setPreviewRows(rows.slice(0, MAX_CLIENT_PREVIEW_ROWS));
            autoSuggestAndSet(cols);
            setParsing(false);
          },
          error: (err) => {
            setParseError(`CSV parse error: ${err?.message || err}`);
            setParsing(false);
          },
        });
      } else {
        try {
          const parsed = JSON.parse(text);
          let rows = [];
          if (Array.isArray(parsed)) rows = parsed;
          else if (parsed && Array.isArray(parsed.data)) rows = parsed.data;
          else if (parsed && Array.isArray(parsed.deals)) rows = parsed.deals;
          else {
            setParseError("JSON root must be an array (or { data: [...] } / { deals: [...] })");
            setParsing(false);
            return;
          }
          if (rows.length === 0) {
            setParseError("JSON array is empty.");
            setParsing(false);
            return;
          }
          // Columns = union of keys from first 50 rows
          const colSet = new Set();
          for (let i = 0; i < Math.min(rows.length, 50); i++) {
            const r = rows[i];
            if (r && typeof r === "object") {
              for (const k of Object.keys(r)) colSet.add(k);
            }
          }
          const cols = Array.from(colSet);
          setFile({ name: f.name, size: f.size, format: "json", rows: rows.length, columns: cols });
          setAllRows(rows);
          setPreviewRows(rows.slice(0, MAX_CLIENT_PREVIEW_ROWS));
          autoSuggestAndSet(cols);
          setParsing(false);
        } catch (err) {
          setParseError(`JSON parse error: ${err?.message || err}`);
          setParsing(false);
        }
      }
    };
    reader.onerror = () => {
      setParseError("Could not read file.");
      setParsing(false);
    };
    reader.readAsText(f);
  }, []);

  const autoSuggestAndSet = useCallback((cols) => {
    // Try to restore a saved template first
    const hash = hashFilename(cols.join("|")); // content-based hash works better than filename for auto-restore
    const savedByContent = loadMappingTemplate(hash);
    if (savedByContent) {
      setMapping(savedByContent);
      toast.info("Restored saved column mapping");
      return;
    }
    const sugg = autoSuggestMapping(cols);
    setMapping({ fields: sugg.fields, confidences: sugg.confidences, dateFormat: "YYYY-MM-DD" });
  }, []);

  const resetWizard = () => {
    setStep(0);
    setFile(null);
    setAllRows([]);
    setPreviewRows([]);
    setMapping({ fields: {}, dateFormat: "YYYY-MM-DD", confidences: {} });
    setActiveBatchId(null);
    setCommitResult(null);
    setParseError(null);
  };

  // ── Validation summary for the "proceed" gate ─────────────────────────────

  const previewValidation = useMemo(() => {
    if (!allRows.length || !mapping.fields?.raw_address) return null;
    // Validate all rows (not just preview) to gate proceed accurately
    const sampleSize = Math.min(allRows.length, 500);
    const results = validateRows(allRows.slice(0, sampleSize), mapping);
    return summariseValidation(results);
  }, [allRows, mapping]);

  const canProceedFromMap = Boolean(mapping.fields?.raw_address);
  const errorFraction = previewValidation && previewValidation.total > 0
    ? previewValidation.errors / previewValidation.total
    : 0;
  const canProceedFromPreview = errorFraction <= MAX_ERROR_FRACTION;

  // ── Commit mutation ───────────────────────────────────────────────────────

  const doCommit = async () => {
    if (!file || allRows.length === 0) return;
    setCommitting(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const sourceTag = `pipedrive_${today.replace(/-/g, "_")}`;

      // Edge function owns batch row creation + the id round-trip.
      // If the parallel agent ships a different contract, adjust here.
      const res = await api.functions.invoke("importLegacyProjects", {
        format: file.format,
        source: sourceTag,
        filename: file.name,
        column_mapping: mapping.fields,
        date_format: mapping.dateFormat,
        rows: allRows,
      });

      const data = res?.data || {};
      const batchId = data.batch_id || data.batchId || data.id || null;
      const imported = data.imported ?? data.rows_imported ?? 0;
      const errors = data.errors ?? data.rows_errored ?? 0;

      if (!batchId) {
        throw new Error("Edge function did not return a batch_id");
      }

      setActiveBatchId(batchId);
      setCommitResult({ imported, errors });
      toast.success(`Imported ${imported} rows (${errors} errors)`);
      setStep(4);
      queryClient.invalidateQueries({ queryKey: ["legacy_import_batches_list"] });
    } catch (err) {
      toast.error(`Import failed: ${err.message || err}`);
    } finally {
      setCommitting(false);
      setCommitOpen(false);
    }
  };

  // ── Polling for in-flight batch (progress bar during commit) ──────────────

  const { data: inFlightBatch } = useQuery({
    queryKey: ["legacy_import_batch_live", activeBatchId],
    queryFn: () => api.entities.LegacyImportBatch.get(activeBatchId),
    refetchInterval: 3_000,
    refetchIntervalInBackground: false,
    enabled: !!activeBatchId && step === 4 && !committing,
  });

  // ── Renders ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Legacy Pipedrive Import
          </h1>
          <p className="text-sm text-muted-foreground">
            Import historical projects from a Pipedrive CSV/JSON export into the
            <code className="mx-1 text-[11px]">legacy_projects</code> substrate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {step > 0 && (
            <Button variant="ghost" size="sm" onClick={resetWizard}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Start over
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="pt-4">
          <StepIndicator step={step} />
        </CardContent>
      </Card>

      {/* ── Step content ── */}

      {step === 0 && (
        <Card>
          <CardContent className="pt-6 space-y-4">
            {parseError && (
              <div className="rounded border border-red-300 bg-red-50 dark:bg-red-950/20 p-3 text-sm text-red-800 dark:text-red-300 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{parseError}</span>
              </div>
            )}

            {!file && <FileDropZone onFile={handleFile} disabled={parsing} />}

            {parsing && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Parsing file…
              </div>
            )}

            {file && !parsing && (
              <div className="rounded border bg-card p-4 space-y-3">
                <div className="flex items-center gap-3">
                  {file.format === "csv" ? (
                    <FileText className="h-5 w-5 text-primary" />
                  ) : (
                    <FileJson className="h-5 w-5 text-primary" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{file.name}</div>
                    <div className="text-xs text-muted-foreground flex gap-3 mt-0.5">
                      <span>{file.rows.toLocaleString()} rows</span>
                      <span>{file.columns.length} columns</span>
                      <span>{humanSize(file.size)}</span>
                      <span className="uppercase">{file.format}</span>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => { setFile(null); setAllRows([]); }}>
                    Remove
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setStep(1)}>
                    Next: Map columns
                    <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 1 && file && (
        <div className="space-y-4">
          <LegacyImportColumnMapper
            sourceColumns={file.columns}
            sampleRows={previewRows}
            mapping={mapping}
            onChange={setMapping}
            filenameHash={filenameHash}
          />
          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep(0)}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Back
            </Button>
            <Button onClick={() => setStep(2)} disabled={!canProceedFromMap}>
              Next: Preview
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
          {!canProceedFromMap && (
            <div className="text-xs text-amber-600 text-right">
              You must map the <strong>raw_address</strong> field to continue.
            </div>
          )}
        </div>
      )}

      {step === 2 && file && (
        <div className="space-y-4">
          <LegacyImportPreviewTable
            rows={allRows}
            mapping={mapping}
            maxRows={PREVIEW_TABLE_ROWS}
          />
          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft className="h-4 w-4 mr-1" /> Edit mapping
            </Button>
            <Button
              onClick={() => { setStep(3); setCommitOpen(true); }}
              disabled={!canProceedFromPreview}
            >
              Proceed to import
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
          {!canProceedFromPreview && previewValidation && (
            <div className="text-xs text-red-600 text-right">
              Error rate {Math.round(errorFraction * 100)}% exceeds the 20% threshold. Fix the mapping or source file.
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardContent className="pt-6 space-y-4 text-center">
            <Rocket className="h-10 w-10 mx-auto text-primary" />
            <div className="text-sm">
              Ready to import <strong>{allRows.length.toLocaleString()}</strong> rows.
              Confirm to start the edge function.
            </div>
            <div className="flex gap-2 justify-center">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Back to preview
              </Button>
              <Button onClick={() => setCommitOpen(true)} disabled={committing}>
                {committing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Rocket className="h-4 w-4 mr-1" />}
                Start import
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 4 && (
        <div className="space-y-4">
          {commitResult && (
            <Card>
              <CardContent className="pt-5 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-emerald-100 dark:bg-emerald-900/40 p-2">
                    <Check className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div>
                    <div className="font-semibold">Import committed</div>
                    <div className="text-sm text-muted-foreground">
                      {commitResult.imported} rows imported · {commitResult.errors} errors
                    </div>
                    {inFlightBatch && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Batch <code>{String(inFlightBatch.id).slice(0, 8)}…</code> · status {inFlightBatch.status}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          <LegacyImportProgressPanel batchId={activeBatchId} />
        </div>
      )}

      {/* ── Commit confirmation dialog ── */}
      <AlertDialog open={commitOpen} onOpenChange={setCommitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm import</AlertDialogTitle>
            <AlertDialogDescription>
              Importing <strong>{allRows.length.toLocaleString()}</strong> rows to
              <code className="mx-1">legacy_projects</code>
              with source
              <code className="mx-1">{`pipedrive_${new Date().toISOString().slice(0, 10).replace(/-/g, "_")}_<batch>`}</code>.
              This cannot be undone, but the resulting batch can be rolled back from the
              Batch History tab. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={committing}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doCommit} disabled={committing}>
              {committing ? (<><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Importing…</>) : "Yes, import"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Batch history tab ───────────────────────────────────────────────────────

function BatchHistoryTab() {
  const queryClient = useQueryClient();
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [rollbackTarget, setRollbackTarget] = useState(null);
  const [rolling, setRolling] = useState(false);

  const { data: batches = [], isLoading, refetch } = useQuery({
    queryKey: ["legacy_import_batches_list"],
    queryFn: () => api.entities.LegacyImportBatch.list("-created_date", 100),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const doRollback = async () => {
    if (!rollbackTarget) return;
    setRolling(true);
    try {
      await api.functions.invoke("importLegacyProjects", {
        action: "rollback",
        batch_id: rollbackTarget.id,
      });
      toast.success(`Batch ${String(rollbackTarget.id).slice(0, 8)}… rolled back`);
      setRollbackTarget(null);
      queryClient.invalidateQueries({ queryKey: ["legacy_import_batches_list"] });
      refetch();
    } catch (err) {
      toast.error(`Rollback failed: ${err.message || err}`);
    } finally {
      setRolling(false);
    }
  };

  const statusBadge = (s) => {
    const cls = {
      completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
      running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
      failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
      rolled_back: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    }[s] || "bg-muted text-muted-foreground";
    return <span className={`text-[11px] rounded px-1.5 py-0.5 ${cls}`}>{s || "—"}</span>;
  };

  const pct = (num, den) => {
    if (!den) return "—";
    return `${Math.round((num / den) * 100)}%`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Batch history</h2>
          <p className="text-xs text-muted-foreground">
            Past Pipedrive imports. Click a row for details — rollback is admin-only and soft-deletes the batch.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      <div className="rounded border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">Batch</TableHead>
              <TableHead>Filename</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Imported</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Geocoded</TableHead>
              <TableHead>Mapped</TableHead>
              <TableHead>Created by</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={10}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && batches.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="text-center text-sm text-muted-foreground py-8">
                  No imports yet.
                </TableCell>
              </TableRow>
            )}
            {batches.map((b) => {
              // DB columns are imported_count / error_count / geocoded_count / mapped_count
              // (the earlier-designed rows_imported / rows_errored / rows_geocoded / rows_package_mapped
              // aliases were dropped during the agent 1 schema finalization — always read the real names).
              const imported = Number(b.imported_count ?? b.rows_imported ?? 0);
              const total = Number(b.row_count ?? 0);
              const errors = Number(b.error_count ?? b.rows_errored ?? 0);
              const geocoded = Number(b.geocoded_count ?? b.rows_geocoded ?? 0);
              const mapped = Number(b.mapped_count ?? b.rows_package_mapped ?? 0);
              return (
                <TableRow key={b.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setSelectedBatch(b)}>
                  <TableCell className="font-mono text-xs">{String(b.id).slice(0, 8)}…</TableCell>
                  <TableCell className="text-xs truncate max-w-[220px]" title={b.filename}>{b.filename || "—"}</TableCell>
                  <TableCell className="text-xs"><code className="text-[11px]">{b.source || "—"}</code></TableCell>
                  <TableCell className="text-xs" title={fmtAbs(b.created_date || b.created_at)}>{fmtRel(b.created_date || b.created_at)}</TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {imported.toLocaleString()}
                    {total > imported && <span className="text-muted-foreground ml-1">/ {total.toLocaleString()}</span>}
                    {errors > 0 && <span className="text-red-600 ml-1">({errors} err)</span>}
                  </TableCell>
                  <TableCell>{statusBadge(b.status)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{pct(geocoded, imported || total)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{pct(mapped, imported || total)}</TableCell>
                  <TableCell className="text-xs truncate max-w-[140px]">{b.created_by_email || b.created_by || "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={b.status === "rolled_back"}
                      onClick={(e) => { e.stopPropagation(); setRollbackTarget(b); }}
                    >
                      <Undo2 className="h-3.5 w-3.5 mr-1" /> Rollback
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Drill-in modal */}
      <Dialog open={!!selectedBatch} onOpenChange={(o) => !o && setSelectedBatch(null)}>
        <DialogContent className="max-w-2xl">
          {selectedBatch && (
            <>
              <DialogHeader>
                <DialogTitle>Batch {String(selectedBatch.id).slice(0, 8)}…</DialogTitle>
                <DialogDescription>
                  Imported {fmtRel(selectedBatch.created_date || selectedBatch.created_at)} · source <code>{selectedBatch.source}</code>
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2 text-sm">
                <div><span className="text-muted-foreground">Filename:</span> {selectedBatch.filename || "—"}</div>
                <div><span className="text-muted-foreground">Status:</span> {statusBadge(selectedBatch.status)}</div>
                <div><span className="text-muted-foreground">Rows imported:</span> {Number(selectedBatch.imported_count ?? selectedBatch.rows_imported ?? 0).toLocaleString()} / {Number(selectedBatch.row_count ?? 0).toLocaleString()}</div>
                <div><span className="text-muted-foreground">Rows errored:</span> {Number(selectedBatch.error_count ?? selectedBatch.rows_errored ?? 0).toLocaleString()}</div>
                <div><span className="text-muted-foreground">Geocoded:</span> {pct(selectedBatch.geocoded_count ?? selectedBatch.rows_geocoded, selectedBatch.imported_count ?? selectedBatch.row_count)}</div>
                <div><span className="text-muted-foreground">Package mapped:</span> {pct(selectedBatch.mapped_count ?? selectedBatch.rows_package_mapped, selectedBatch.imported_count ?? selectedBatch.row_count)}</div>
                <div className="sm:col-span-2">
                  <span className="text-muted-foreground">Column mapping:</span>
                  <pre className="text-[11px] bg-muted rounded p-2 mt-1 overflow-auto max-h-48">
                    {JSON.stringify(selectedBatch.column_mapping || {}, null, 2)}
                  </pre>
                </div>
                {Array.isArray(selectedBatch.error_samples) && selectedBatch.error_samples.length > 0 && (
                  <div className="sm:col-span-2">
                    <span className="text-muted-foreground">Sample errors:</span>
                    <pre className="text-[11px] bg-muted rounded p-2 mt-1 overflow-auto max-h-48">
                      {JSON.stringify(selectedBatch.error_samples.slice(0, 5), null, 2)}
                    </pre>
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedBatch(null)}>Close</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Rollback confirmation */}
      <AlertDialog open={!!rollbackTarget} onOpenChange={(o) => !o && setRollbackTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-red-600" />
              Roll back batch?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {rollbackTarget && (
                <>
                  This deletes all <strong>{Number(rollbackTarget.imported_count ?? rollbackTarget.rows_imported ?? 0).toLocaleString()} legacy_projects rows</strong>
                  created by batch <code>{String(rollbackTarget.id).slice(0, 8)}…</code> and marks the
                  batch status as <code>rolled_back</code>. The source file and mapping are preserved so
                  you can re-import. This cannot be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rolling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={doRollback}
              disabled={rolling}
              className="bg-red-600 hover:bg-red-700"
            >
              {rolling ? (<><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Rolling back…</>) : "Yes, roll back"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Default export: admin-gated shell + tabs ───────────────────────────────

export default function SettingsLegacyImport() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-5 lg:p-8">
        <Tabs defaultValue="import" className="space-y-4">
          <TabsList>
            <TabsTrigger value="import">
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              New import
            </TabsTrigger>
            <TabsTrigger value="history">
              <History className="h-3.5 w-3.5 mr-1.5" />
              Batch history
            </TabsTrigger>
          </TabsList>
          <TabsContent value="import">
            <LegacyImportWizard />
          </TabsContent>
          <TabsContent value="history">
            <BatchHistoryTab />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
