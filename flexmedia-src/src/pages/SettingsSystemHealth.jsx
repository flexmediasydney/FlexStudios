import React, { useState, useCallback, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, Clock, RefreshCw, 
  Zap, Database, Server, Wifi, WifiOff, Shield, Timer, ChevronDown,
  ChevronRight, ArrowLeft, Loader2, TrendingUp, AlertCircle, Heart
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function timeAgo(dateStr) {
  if (!dateStr) return "Never";
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getScoreGrade(score) {
  if (score >= 98) return { label: "OPERATIONAL", color: "text-emerald-400", bg: "bg-emerald-500/10", ring: "ring-emerald-500/30" };
  if (score >= 90) return { label: "DEGRADED", color: "text-amber-400", bg: "bg-amber-500/10", ring: "ring-amber-500/30" };
  if (score >= 70) return { label: "PARTIAL OUTAGE", color: "text-orange-400", bg: "bg-orange-500/10", ring: "ring-orange-500/30" };
  return { label: "MAJOR OUTAGE", color: "text-red-400", bg: "bg-red-500/10", ring: "ring-red-500/30" };
}

// ─── Status Indicator ─────────────────────────────────────────────────────────

function StatusDot({ status, size = "sm" }) {
  const sizeClass = size === "lg" ? "h-3 w-3" : "h-2 w-2";
  const colors = {
    alive: "bg-emerald-500",
    slow: "bg-amber-500",
    missing: "bg-red-500",
    stale: "bg-red-500 animate-pulse",
    unverified: "bg-yellow-400",
    error: "bg-red-500",
    pending: "bg-gray-400 animate-pulse",
  };
  return (
    <span className={cn("rounded-full inline-block flex-shrink-0", sizeClass, colors[status] || colors.pending)} />
  );
}

// ─── Score Ring ───────────────────────────────────────────────────────────────

function ScoreRing({ score, size = 140 }) {
  const radius = (size - 16) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const grade = getScoreGrade(score);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="currentColor"
          strokeWidth="6" className="text-gray-200 dark:text-gray-800" />
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
          strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset}
          className={cn("transition-all duration-1000 ease-out",
            score >= 98 ? "stroke-emerald-500" : score >= 90 ? "stroke-amber-500" : score >= 70 ? "stroke-orange-500" : "stroke-red-500"
          )} />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className={cn("text-3xl font-bold tabular-nums tracking-tight", grade.color)}>{score}</span>
        <span className="text-[10px] font-semibold text-muted-foreground tracking-widest uppercase">SCORE</span>
      </div>
    </div>
  );
}

// ─── Response Time Bar ────────────────────────────────────────────────────────

function ResponseBar({ ms, max = 5000 }) {
  const pct = Math.min(100, (ms / max) * 100);
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all duration-500",
          ms < 500 ? "bg-emerald-500" : ms < 1500 ? "bg-amber-500" : ms < 3000 ? "bg-orange-500" : "bg-red-500"
        )} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground font-medium w-12 text-right">{formatMs(ms)}</span>
    </div>
  );
}

// ─── Category Section ─────────────────────────────────────────────────────────

function CategorySection({ name, functions, expanded, onToggle }) {
  const aliveCount = functions.filter(f => f.status === "alive").length;
  const slowCount = functions.filter(f => f.status === "slow").length;
  const deadCount = functions.filter(f => f.status === "missing").length;
  const allGood = deadCount === 0 && slowCount === 0;
  const avgMs = functions.length > 0
    ? Math.round(functions.reduce((s, f) => s + (f.response_ms || 0), 0) / functions.length)
    : 0;

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden transition-all",
      deadCount > 0 ? "border-red-200 bg-red-50/30 dark:border-red-900 dark:bg-red-950/20" :
      slowCount > 0 ? "border-amber-200 bg-amber-50/20 dark:border-amber-900 dark:bg-amber-950/10" :
      "border-border"
    )}>
      <button onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left">
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{name}</span>
            {allGood ? (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-emerald-50 text-emerald-700 border-emerald-200">
                {aliveCount}/{functions.length} OK
              </Badge>
            ) : deadCount > 0 ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                {deadCount} MISSING
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-50 text-amber-700 border-amber-200">
                {slowCount} SLOW
              </Badge>
            )}
          </div>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">avg {formatMs(avgMs)}</span>
      </button>

      {expanded && (
        <div className="border-t divide-y">
          {functions.map(fn => (
            <div key={fn.function} className={cn(
              "flex items-center gap-3 px-4 py-2.5 text-sm",
              fn.status === "missing" && "bg-red-50/50 dark:bg-red-950/30"
            )}>
              <StatusDot status={fn.status} />
              <span className={cn("flex-1 font-mono text-xs",
                fn.status === "missing" ? "text-red-700 font-semibold" : "text-foreground"
              )}>
                {fn.function}
              </span>
              {fn.status === "missing" ? (
                <span className="text-xs font-semibold text-red-600 uppercase tracking-wide">NOT DEPLOYED</span>
              ) : fn.status === "stale" ? (
                <span className="text-xs font-semibold text-red-600">STALE CODE — {fn.detail}</span>
              ) : fn.status === "unverified" ? (
                <div className="flex items-center gap-2">
                  <ResponseBar ms={fn.response_ms} />
                  <span className="text-[10px] text-yellow-600 font-medium">unverified</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <ResponseBar ms={fn.response_ms} />
                  {fn.version_actual && <span className="text-[10px] text-emerald-600 font-mono">{fn.version_actual}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, variant = "default" }) {
  const colors = {
    default: "text-foreground",
    success: "text-emerald-600",
    warning: "text-amber-600",
    danger: "text-red-600",
  };
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border bg-card">
      <div className={cn("p-2 rounded-md bg-muted/50")}>
        <Icon className={cn("h-4 w-4", colors[variant])} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground font-medium">{label}</p>
        <p className={cn("text-lg font-bold tabular-nums leading-tight", colors[variant])}>{value}</p>
        {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Issue Row ────────────────────────────────────────────────────────────────

function IssueRow({ severity, title, count, detail }) {
  if (count === 0) return null;
  const colors = {
    critical: { bg: "bg-red-50", border: "border-red-200", icon: XCircle, iconColor: "text-red-500" },
    warning: { bg: "bg-amber-50", border: "border-amber-200", icon: AlertTriangle, iconColor: "text-amber-500" },
    info: { bg: "bg-blue-50", border: "border-blue-200", icon: AlertCircle, iconColor: "text-blue-500" },
  };
  const c = colors[severity] || colors.info;
  return (
    <div className={cn("flex items-start gap-3 p-3 rounded-lg border", c.bg, c.border)}>
      <c.icon className={cn("h-4 w-4 mt-0.5 flex-shrink-0", c.iconColor)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{count}</Badge>
        </div>
        {detail && <p className="text-xs text-muted-foreground mt-0.5">{detail}</p>}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsSystemHealth() {
  const [diagnostics, setDiagnostics] = useState(null);
  const [running, setRunning] = useState(false);
  const [includeDataIntegrity, setIncludeDataIntegrity] = useState(true);
  const [includeSmokeTests, setIncludeSmokeTests] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState(new Set());
  const [elapsedMs, setElapsedMs] = useState(null);
  const tickRef = useRef(null);
  const startRef = useRef(null);

  // BUG FIX: clear diagnostic elapsed-time interval on unmount so it doesn't
  // keep ticking (and calling setState) after navigating away mid-diagnostic.
  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  const toggleCategory = useCallback((name) => {
    setExpandedCategories(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }, []);

  const expandAll = () => {
    if (!diagnostics?.results) return;
    const cats = new Set(diagnostics.results.map(r => r.category));
    setExpandedCategories(cats);
  };

  const collapseAll = () => setExpandedCategories(new Set());

  const runDiagnostic = async () => {
    setRunning(true);
    setDiagnostics(null);
    setElapsedMs(0);
    startRef.current = Date.now();
    tickRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, 100);

    try {
      const response = await api.functions.invoke("healthCheckFunctions", {
        include_data_integrity: includeDataIntegrity,
        include_smoke_tests: includeSmokeTests,
      });
      const data = response?.data || response;
      setDiagnostics(data);

      if (data.summary?.dead > 0) {
        toast.error(`${data.summary.dead} function(s) are MISSING! Check the results below.`);
      } else if (data.summary?.slow > 0) {
        toast.warning(`All functions deployed. ${data.summary.slow} running slow.`);
      } else {
        toast.success("All systems operational.");
      }

      // Auto-expand categories with issues
      const problemCats = new Set();
      (data.results || []).forEach(r => {
        if (r.status === "missing" || r.status === "slow") problemCats.add(r.category);
      });
      if (problemCats.size > 0) {
        setExpandedCategories(problemCats);
      }
    } catch (err) {
      toast.error(`Diagnostic failed: ${err?.message || "Unknown error"}`);
      setDiagnostics({ error: err?.message });
    } finally {
      clearInterval(tickRef.current);
      setElapsedMs(Date.now() - startRef.current);
      setRunning(false);
    }
  };

  // Group results by category
  const grouped = {};
  (diagnostics?.results || []).forEach(r => {
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  });

  const summary = diagnostics?.summary;
  const data = diagnostics?.data_integrity;
  const grade = summary ? getScoreGrade(summary.score) : null;
  const hasIssues = data?.issues && Object.values(data.issues).some(v => typeof v === "number" && v > 0);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <a href={createPageUrl("Settings")} className="text-muted-foreground hover:text-foreground transition-colors">
                <ArrowLeft className="h-5 w-5" />
              </a>
              <h1 className="text-2xl font-bold tracking-tight">System Diagnostics</h1>
            </div>
            <p className="text-sm text-muted-foreground ml-8">
              Comprehensive health check of all backend functions, integrations, and data integrity.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Switch checked={includeDataIntegrity} onCheckedChange={setIncludeDataIntegrity} id="data-check" />
                <label htmlFor="data-check" className="text-xs text-muted-foreground cursor-pointer">Data audit</label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={includeSmokeTests} onCheckedChange={setIncludeSmokeTests} id="smoke-check" />
                <label htmlFor="smoke-check" className="text-xs text-muted-foreground cursor-pointer">Smoke tests</label>
              </div>
            </div>
            <Button onClick={runDiagnostic} disabled={running} className="gap-2 shadow-sm min-w-[180px]">
              {running ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Running... {elapsedMs != null ? `(${(elapsedMs / 1000).toFixed(1)}s)` : ""}</>
              ) : (
                <><Activity className="h-4 w-4" /> Run Full Diagnostic</>
              )}
            </Button>
          </div>
        </div>

        {/* Running indicator */}
        {running && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Pinging {Object.values(diagnostics?.categories || {}).flat().length || "~45"} backend functions...</span>
            </div>
            <Progress value={undefined} className="h-1" />
          </div>
        )}

        {/* Results */}
        {diagnostics && !diagnostics.error && (
          <>
            {/* Score + Summary Strip */}
            <Card className={cn("overflow-hidden", grade.ring, "ring-1")}>
              <CardContent className="p-0">
                <div className="flex flex-col md:flex-row items-center gap-6 p-6">
                  {/* Score ring */}
                  <ScoreRing score={summary.score} />

                  {/* Status label */}
                  <div className="flex-1 text-center md:text-left">
                    <div className={cn("inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-bold tracking-widest uppercase", grade.bg, grade.color)}>
                      {summary.dead > 0 ? <XCircle className="h-3.5 w-3.5" /> : summary.slow > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <Heart className="h-3.5 w-3.5" />}
                      {grade.label}
                    </div>
                    <p className="text-sm text-muted-foreground mt-2">
                      Checked {summary.total_checked} functions in {formatMs(elapsedMs)}.
                      {diagnostics.checked_at && <span className="ml-1">Last run: {timeAgo(diagnostics.checked_at)}</span>}
                    </p>
                  </div>

                  {/* Quick stats */}
                  <div className="grid grid-cols-4 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-emerald-600">{summary.alive}</p>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Alive</p>
                    </div>
                    <div>
                      <p className={cn("text-2xl font-bold tabular-nums", summary.slow > 0 ? "text-amber-600" : "text-muted-foreground")}>{summary.slow}</p>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Slow</p>
                    </div>
                    <div>
                      <p className={cn("text-2xl font-bold tabular-nums", summary.stale > 0 ? "text-red-600" : "text-muted-foreground")}>{summary.stale || 0}</p>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Stale</p>
                    </div>
                    <div>
                      <p className={cn("text-2xl font-bold tabular-nums", summary.dead > 0 ? "text-red-600" : "text-muted-foreground")}>{summary.dead}</p>
                      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Missing</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Function Health Grid */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  Backend Functions
                </h2>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" className="text-xs h-7" onClick={expandAll}>Expand All</Button>
                  <Button variant="ghost" size="sm" className="text-xs h-7" onClick={collapseAll}>Collapse All</Button>
                </div>
              </div>
              <div className="space-y-2">
                {Object.entries(grouped).map(([category, fns]) => (
                  <CategorySection
                    key={category}
                    name={category}
                    functions={fns}
                    expanded={expandedCategories.has(category)}
                    onToggle={() => toggleCategory(category)}
                  />
                ))}
              </div>
            </div>

            {/* Data Integrity Section */}
            {data && !data.error && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                {/* Entity Counts */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      Entity Counts
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-2">
                      <StatCard icon={TrendingUp} label="Active Projects" value={data.counts.active_projects} sub={`${data.counts.total_projects} total`} />
                      <StatCard icon={CheckCircle2} label="Active Tasks" value={data.counts.active_tasks} sub={`${data.counts.total_tasks} total`} />
                      <StatCard icon={Zap} label="Products" value={data.counts.total_products} />
                      <StatCard icon={Zap} label="Packages" value={data.counts.total_packages} />
                      <StatCard icon={Timer} label="Time Logs" value={data.counts.total_time_logs} />
                      <StatCard icon={Activity} label="Effort Records" value={data.counts.total_efforts} />
                    </div>
                  </CardContent>
                </Card>

                {/* Issues & Warnings */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="h-4 w-4 text-muted-foreground" />
                      Data Integrity
                      {!hasIssues && (
                        <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                          ALL CLEAR
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <IssueRow severity="critical" title="Projects missing tasks"
                      count={data.issues.projects_missing_tasks}
                      detail={data.issues.projects_missing_tasks_list?.map(p => p.title || p.id).slice(0, 3).join(", ")} />
                    <IssueRow severity="warning" title="Orphaned tasks (closed projects)"
                      count={data.issues.orphaned_tasks}
                      detail="Tasks on delivered/cancelled projects that should be cleaned up" />
                    <IssueRow severity="warning" title="Stale timers (>10h running)"
                      count={data.issues.stale_timers}
                      detail={data.issues.stale_timer_details?.map(t => `${t.user_name} (${t.hours_running}h)`).join(", ")} />
                    <IssueRow severity="info" title="Running timers"
                      count={data.issues.running_timers} />
                    <IssueRow severity="info" title="Stale pricing (needs recalc)"
                      count={data.issues.stale_pricing_projects} />
                    <IssueRow severity="info" title="Deleted-task time logs"
                      count={data.issues.deleted_task_logs}
                      detail="Time logs from deleted tasks — excluded from effort totals" />
                    {!hasIssues && (
                      <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-700">
                        <CheckCircle2 className="h-4 w-4" />
                        <span className="font-medium">No data integrity issues detected.</span>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Tonomo Integration */}
                {data.tonomo && (
                  <Card className="lg:col-span-2">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Wifi className="h-4 w-4 text-muted-foreground" />
                        Tonomo Integration
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="p-3 rounded-lg border bg-card">
                          <p className="text-xs text-muted-foreground font-medium">Last Webhook</p>
                          <p className="text-sm font-semibold mt-1">{timeAgo(data.tonomo.last_webhook_at)}</p>
                          <p className="text-[10px] text-muted-foreground">{data.tonomo.last_webhook_action || "—"}</p>
                        </div>
                        <div className="p-3 rounded-lg border bg-card">
                          <p className="text-xs text-muted-foreground font-medium">Last Queue Item</p>
                          <p className="text-sm font-semibold mt-1">{timeAgo(data.tonomo.last_queue_at)}</p>
                          <p className="text-[10px] text-muted-foreground">{data.tonomo.last_queue_status || "—"}</p>
                        </div>
                        <div className="p-3 rounded-lg border bg-card">
                          <p className="text-xs text-muted-foreground font-medium">Webhook Status</p>
                          <div className="flex items-center gap-1.5 mt-1">
                            {data.tonomo.last_webhook_at &&
                              (Date.now() - new Date(data.tonomo.last_webhook_at).getTime()) < 86400000 ? (
                              <><StatusDot status="alive" /> <span className="text-sm font-semibold text-emerald-600">Active</span></>
                            ) : (
                              <><StatusDot status="missing" /> <span className="text-sm font-semibold text-red-600">No recent activity</span></>
                            )}
                          </div>
                        </div>
                        <div className="p-3 rounded-lg border bg-card">
                          <p className="text-xs text-muted-foreground font-medium">Quick Links</p>
                          <div className="flex flex-col gap-1 mt-1">
                            <a href={createPageUrl("TonomoPulse")} className="text-xs text-primary hover:underline">Tonomo Pulse →</a>
                            <a href={createPageUrl("SettingsTonomoIntegration")} className="text-xs text-primary hover:underline">Integration Settings →</a>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            )}

            {/* Smoke Tests */}
            {diagnostics?.smoke_tests && diagnostics.smoke_tests.length > 0 && (
              <Card className="lg:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Zap className="h-4 w-4 text-muted-foreground" />
                    Functional Smoke Tests
                    {diagnostics.smoke_tests.every(t => t.status === 'pass') ? (
                      <Badge variant="outline" className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">ALL PASS</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">
                        {diagnostics.smoke_tests.filter(t => t.status !== 'pass').length} FAILED
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {diagnostics.smoke_tests.map((test, i) => (
                    <div key={i} className={cn(
                      "flex items-center gap-3 p-3 rounded-lg border",
                      test.status === 'pass' ? "bg-emerald-50/50 border-emerald-200" :
                      test.status === 'error' ? "bg-red-50/50 border-red-200" :
                      "bg-amber-50/50 border-amber-200"
                    )}>
                      {test.status === 'pass' ? <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" /> :
                       test.status === 'error' ? <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" /> :
                       <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium">{test.test}</span>
                        {test.detail && <p className="text-xs text-muted-foreground mt-0.5">{test.detail}</p>}
                      </div>
                      {test.elapsed_ms && <span className="text-xs text-muted-foreground tabular-nums">{formatMs(test.elapsed_ms)}</span>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {data?.error && (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="p-4">
                  <p className="text-sm text-amber-800">
                    <AlertTriangle className="h-4 w-4 inline mr-1.5" />
                    Data integrity check failed: {data.error}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Error state */}
        {diagnostics?.error && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="p-6 text-center">
              <XCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
              <p className="font-semibold text-red-800">Diagnostic Failed</p>
              <p className="text-sm text-red-600 mt-1">{diagnostics.error}</p>
              <p className="text-xs text-red-500 mt-2">
                If this persists, the <code className="bg-red-100 px-1 py-0.5 rounded">healthCheckFunctions</code> backend function may not be deployed.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Empty state */}
        {!diagnostics && !running && (
          <Card className="border-dashed">
            <CardContent className="p-12 text-center">
              <Activity className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-muted-foreground">Ready to diagnose</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                Click "Run Full Diagnostic" to ping all backend functions, check data integrity, and verify integration health.
                This typically takes 15–30 seconds.
              </p>
              <Button onClick={runDiagnostic} className="mt-6 gap-2">
                <Activity className="h-4 w-4" /> Run Full Diagnostic
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </PermissionGuard>
  );
}