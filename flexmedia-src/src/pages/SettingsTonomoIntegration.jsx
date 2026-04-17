import { useState, useEffect, useCallback, useMemo } from "react";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Check, Clock, ExternalLink, RefreshCw, TrendingUp, CheckCircle2, Clock4, Activity, Loader2, ChevronLeft, ChevronRight, Filter, X, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { relativeTime, parseTS } from "@/components/tonomo/tonomoUtils";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { createPageUrl } from "@/utils";
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

export default function SettingsTonomoIntegration() {
  const { data: user } = useCurrentUser();
  const [copied, setCopied] = useState(false);
  const [showAutoApproveConfirm, setShowAutoApproveConfirm] = useState(false);
  const [nextTriggerSeconds, setNextTriggerSeconds] = useState(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (user && user.role !== "master_admin" && user.role !== "employee") {
      window.location.href = "/";
    }
  }, [user]);

  // Countdown timer for next scheduled processor trigger (every 5 minutes)
  useEffect(() => {
    const calculateNext = () => {
      const now = Date.now();
      const fiveMinutes = 5 * 60 * 1000;
      const lastRoundedTime = Math.floor(now / fiveMinutes) * fiveMinutes;
      const nextTrigger = lastRoundedTime + fiveMinutes;
      const secondsUntil = Math.floor((nextTrigger - now) / 1000);
      setNextTriggerSeconds(secondsUntil);
    };

    calculateNext();
    const interval = setInterval(calculateNext, 1000);
    return () => clearInterval(interval);
  }, []);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['tonomoSettings'],
    queryFn: async () => {
      const all = await api.entities.TonomoIntegrationSettings.list('-created_date', 1);
      if (all.length === 0) {
        return await api.entities.TonomoIntegrationSettings.create({
          auto_approve_enabled: false,
          urgent_review_hours: 24,
          auto_approve_on_imminent: true,
          imminent_threshold_hours: 2,
          business_calendar_id: 'info@flexstudios.app'
        });
      }
      return all[0];
    }
  });

  const { data: roleDefaults, isLoading: roleDefaultsLoading, error: roleDefaultsError } = useQuery({
    queryKey: ['tonomoRoleDefaults'],
    queryFn: async () => {
      try {
        const all = await api.entities.TonomoRoleDefaults.list('-created_date', 1);
        if (all.length === 0) {
          // Entity exists but no rows yet — create the first one
          return await api.entities.TonomoRoleDefaults.create({});
        }
        return all[0];
      } catch (err) {
        // Entity doesn't exist in schema yet — return null, don't crash
        console.warn('TonomoRoleDefaults entity not found. Create it in Base44 entity editor.', err?.message);
        return null;
      }
    },
    enabled: !isLoading,
    retry: false, // Don't retry — if entity is missing, retrying won't help
  });

  const roleDefaultsMutation = useMutation({
    mutationFn: async (updates) => {
      if (roleDefaults?.id) {
        return api.entities.TonomoRoleDefaults.update(roleDefaults.id, updates);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tonomoRoleDefaults'] });
      toast.success('Role defaults saved');
    },
    onError: (err) => toast.error(err?.message || "Operation failed"),
  });

  const { data: queue = [] } = useQuery({
    queryKey: ['settingsQueue'],
    queryFn: () => api.entities.TonomoProcessingQueue.list('-created_date', 200),
    refetchInterval: 10000,
  });

  const { data: queueStats } = useQuery({
    queryKey: ['tonomoQueueStats'],
    queryFn: async () => {
      const queue = await api.entities.TonomoProcessingQueue.list('-created_date', 500);
      return {
        pending: queue.filter(q => q.status === 'pending').length,
        failed: queue.filter(q => q.status === 'failed').length,
        dead_letter: queue.filter(q => q.status === 'dead_letter').length
      };
    },
    refetchInterval: 10000
  });

  const { data: auditCount } = useQuery({
    queryKey: ['tonomoAuditCount'],
    queryFn: async () => {
      const sydneyToday = new Date().toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" });
      const logs = await api.entities.TonomoAuditLog.list('-processed_at', 500);
      return logs.filter(l => {
        const d = parseTS(l.processed_at);
        return d && d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) === sydneyToday;
      }).length;
    },
    refetchInterval: 15000
  });

  const { data: mappingCoverage } = useQuery({
    queryKey: ['tonomoMappingCoverage'],
    queryFn: async () => {
      const all = await api.entities.TonomoMappingTable.list('-created_date', 500);
      const confirmed = all.filter(m => m.is_confirmed).length;
      return all.length > 0 ? Math.round((confirmed / all.length) * 100) : 0;
    },
    refetchInterval: 30000
  });

  const { data: bookingStats } = useQuery({
    queryKey: ['tonomoBookingStats'],
    queryFn: async () => {
      const now = new Date();
      const sydneyNow = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Sydney" }));
      const startOfWeek = new Date(sydneyNow);
      startOfWeek.setDate(sydneyNow.getDate() - sydneyNow.getDay());
      startOfWeek.setHours(0, 0, 0, 0);
      const startOfMonth = new Date(sydneyNow.getFullYear(), sydneyNow.getMonth(), 1);

      const allQueue = await api.entities.TonomoProcessingQueue.list('-created_date', 500);
      const allProjects = await api.entities.Project.list('-created_date', 500);
      const tonomoProjects = allProjects.filter(p => p.source === 'tonomo');

      // Filter by time periods
      const weekBookings = tonomoProjects.filter(p => {
        const d = parseTS(p.created_date);
        return d && d >= startOfWeek;
      });
      const monthBookings = tonomoProjects.filter(p => {
        const d = parseTS(p.created_date);
        return d && d >= startOfMonth;
      });

      // Auto-approved vs pending
      const autoApproved = tonomoProjects.filter(p => p.auto_approved === true).length;
      const pendingReview = tonomoProjects.filter(p => p.status === 'pending_review').length;

      // Processing times from completed queue items
      const completed = allQueue.filter(q => q.status === 'completed' && q.created_at && q.processed_at);
      let avgProcessingMs = 0;
      if (completed.length > 0) {
        const totalMs = completed.reduce((sum, q) => {
          const created = parseTS(q.created_at);
          const processed = parseTS(q.processed_at);
          return sum + (created && processed ? processed.getTime() - created.getTime() : 0);
        }, 0);
        avgProcessingMs = totalMs / completed.length;
      }

      // Success rate
      const totalProcessed = allQueue.filter(q => q.status === 'completed' || q.status === 'failed' || q.status === 'dead_letter').length;
      const successCount = allQueue.filter(q => q.status === 'completed').length;
      const successRate = totalProcessed > 0 ? Math.round((successCount / totalProcessed) * 100) : 100;

      return {
        weekCount: weekBookings.length,
        monthCount: monthBookings.length,
        autoApproved,
        pendingReview,
        avgProcessingMs,
        successRate,
      };
    },
    refetchInterval: 30000,
  });

  const { data: recentProcessing } = useQuery({
    queryKey: ['tonomoRecentProcessing'],
    queryFn: async () => {
      const queue = await api.entities.TonomoProcessingQueue.list('-processed_at', 50);
      const projectIds = queue.map(q => {
        const match = q.result_summary?.match(/Project (created|updated)/);
        return match ? q.order_id : null;
      }).filter(Boolean);
      
      const projects = projectIds.length > 0 
        ? await api.entities.Project.filter({ tonomo_order_id: { $in: projectIds } }, null, 100)
        : [];
      
      return queue.map(q => {
        const project = projects.find(p => p.tonomo_order_id === q.order_id);
        return { ...q, project };
      });
    },
    refetchInterval: 5000
  });

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      return await api.entities.TonomoIntegrationSettings.update(settings.id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tonomoSettings'] });
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(err?.message || "Operation failed"),
  });

  const processQueueMutation = useMutation({
    mutationFn: async () => {
      const res = await api.functions.invoke('processTonomoQueue', { triggered_by: 'manual' });
      return res.data || res;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['tonomoSettings'] });
      queryClient.invalidateQueries({ queryKey: ['tonomoQueueStats'] });
      queryClient.invalidateQueries({ queryKey: ['settingsQueue'] });
      toast.success(`Queue processed: ${data?.processed ?? 0} processed, ${data?.failed ?? 0} failed`);
      // Auto-clear the inline success/error message after 8 seconds
      setTimeout(() => processQueueMutation.reset(), 8000);
    },
    onError: (err) => {
      toast.error(err?.message || "Operation failed");
      setTimeout(() => processQueueMutation.reset(), 8000);
    },
  });

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const webhookUrl = `${supabaseUrl}/functions/v1/receiveTonomoWebhook`;

  const [testResult, setTestResult] = useState(null);
  const [isRetryingAll, setIsRetryingAll] = useState(false);
  const [isClearingLock, setIsClearingLock] = useState(false);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const testWebhookMutation = useMutation({
    mutationFn: async () => {
      setTestResult(null);
      const checks = { reachable: false, statusOk: false, responseValid: false, queued: false, latencyMs: 0, error: null };
      const testId = "test_" + Date.now();
      const testPayload = {
        action: "scheduled",
        orderId: testId,
        orderName: "Health Check — " + new Date().toISOString(),
        when: { start_time: Math.floor(Date.now() / 1000), end_time: Math.floor(Date.now() / 1000) + 3600 }
      };

      // Check 1: Is the endpoint reachable + response time
      const start = performance.now();
      let res;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testPayload),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        checks.reachable = true;
        checks.latencyMs = Math.round(performance.now() - start);
      } catch (err) {
        checks.error = err.name === 'AbortError' ? 'Timeout (>10s) — webhook is unresponsive' : (err.message || 'Network error');
        setTestResult(checks);
        throw new Error(checks.error);
      }

      // Check 2: HTTP status
      checks.statusOk = res.status >= 200 && res.status < 300;
      if (!checks.statusOk) {
        const body = await res.text().catch(() => '');
        checks.error = `HTTP ${res.status}: ${body.substring(0, 200)}`;
        setTestResult(checks);
        throw new Error(checks.error);
      }

      // Check 3: Valid JSON response
      let body;
      try {
        body = await res.json();
        checks.responseValid = true;
      } catch {
        checks.error = 'Invalid JSON response';
        setTestResult(checks);
        throw new Error(checks.error);
      }

      // Check 4: Was the webhook accepted?
      checks.queued = body?.received === true || body?.queued === true || body?.healthy === true || body?.status === 'queued' || body?.id != null || body?.log_id != null;
      if (!checks.queued) {
        checks.error = 'Webhook responded but did not confirm acceptance: ' + JSON.stringify(body).substring(0, 200);
      }

      setTestResult(checks);
      return checks;
    },
    onError: (err) => {
      toast.error('Webhook test failed: ' + err.message);
    },
    onSuccess: (checks) => {
      if (checks.queued) {
        toast.success(`Webhook healthy — ${checks.latencyMs}ms response`);
      } else {
        toast.warning('Webhook responded but may not be processing correctly');
      }
    },
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAutoApproveToggle = (enabled) => {
    if (enabled) {
      setShowAutoApproveConfirm(true);
    } else {
      updateMutation.mutate({ auto_approve_enabled: false });
    }
  };

  if (isLoading) return <div className="p-6">Loading integration settings...</div>;
  if (!settings) return <div className="p-6">No integration settings found. Please check your Tonomo configuration.</div>;

  return (
    <ErrorBoundary>
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Tonomo Integration</h1>
        <p className="text-muted-foreground mt-1">Configure webhook processing and auto-approval rules</p>
      </div>

      {bookingStats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Booking Stats
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-lg border p-4 text-center space-y-1">
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                  <Activity className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">This Week / Month</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  {bookingStats.weekCount} <span className="text-base text-muted-foreground font-normal">/</span> {bookingStats.monthCount}
                </p>
              </div>
              <div className="rounded-lg border p-4 text-center space-y-1">
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">Auto-approved / Pending</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  <span className="text-green-600">{bookingStats.autoApproved}</span>
                  <span className="text-base text-muted-foreground font-normal"> / </span>
                  <span className={bookingStats.pendingReview > 0 ? "text-amber-600" : ""}>{bookingStats.pendingReview}</span>
                </p>
              </div>
              <div className="rounded-lg border p-4 text-center space-y-1">
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                  <Clock4 className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">Avg Processing Time</p>
                </div>
                <p className="text-2xl font-bold tabular-nums">
                  {bookingStats.avgProcessingMs < 1000
                    ? `${Math.round(bookingStats.avgProcessingMs)}ms`
                    : bookingStats.avgProcessingMs < 60000
                    ? `${(bookingStats.avgProcessingMs / 1000).toFixed(1)}s`
                    : `${(bookingStats.avgProcessingMs / 60000).toFixed(1)}m`}
                </p>
              </div>
              <div className="rounded-lg border p-4 text-center space-y-1">
                <div className="flex items-center justify-center gap-1.5 text-muted-foreground">
                  <TrendingUp className="h-3.5 w-3.5" />
                  <p className="text-xs font-medium">Success Rate</p>
                </div>
                <p className={`text-2xl font-bold tabular-nums ${
                  bookingStats.successRate >= 95 ? 'text-green-600' :
                  bookingStats.successRate >= 80 ? 'text-amber-600' : 'text-red-600'
                }`}>
                  {bookingStats.successRate}%
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Connection Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">

          <div>
            <label className="text-sm font-medium mb-2 block">Webhook URL</label>
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={handleCopy} aria-label={copied ? "Copied" : "Copy webhook URL"}>
                {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          <BusinessCalendarField settings={settings} updateMutation={updateMutation} />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Auto-approve enabled</p>
              <p className="text-xs text-muted-foreground">Bypass manual review for full-confidence mappings</p>
            </div>
            <Switch
              checked={settings.auto_approve_enabled || false}
              onCheckedChange={handleAutoApproveToggle}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Auto-link calendar events</p>
              <p className="text-xs text-muted-foreground">
                Automatically link synced Google Calendar events to FlexStudios projects
                using the Tonomo Google Calendar event ID. Disable if you want all
                calendar linking to be manual only.
              </p>
            </div>
            <Switch
              checked={settings.auto_link_calendar_events !== false}
              onCheckedChange={(enabled) => updateMutation.mutate({ auto_link_calendar_events: enabled })}
            />
          </div>

          <NumericField
            label="Urgent review threshold (hours)"
            field="urgent_review_hours"
            defaultVal={24}
            settings={settings}
            updateMutation={updateMutation}
          />

          <NumericField
            label="Auto-approve imminent threshold (hours)"
            field="imminent_threshold_hours"
            defaultVal={2}
            settings={settings}
            updateMutation={updateMutation}
          />

          <div>
            <label className="text-sm font-medium mb-2 block">Processor version</label>
            <p className="text-sm text-muted-foreground">{settings.processor_version || "—"}</p>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Last heartbeat</label>
            <p className="text-sm text-muted-foreground">
              {settings.heartbeat_at ? relativeTime(parseTS(settings.heartbeat_at)) : "Never"}
            </p>
          </div>

          <div>
            <label className="text-sm font-medium mb-2 block">Next scheduled check</label>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {nextTriggerSeconds !== null && nextTriggerSeconds >= 0
                  ? `${Math.floor(nextTriggerSeconds / 60)}:${String(nextTriggerSeconds % 60).padStart(2, '0')}`
                  : "—"}
              </p>
            </div>
          </div>

          <div className="flex gap-3 flex-wrap items-start">
            <div>
              <Button onClick={() => testWebhookMutation.mutate()} disabled={testWebhookMutation.isPending}>
                {testWebhookMutation.isPending ? "Running 4 checks..." : "Test Webhook"}
              </Button>
              {testResult && (
                <div className="mt-2 space-y-1 text-xs">
                  <div className={testResult.reachable ? 'text-green-600' : 'text-red-600'}>
                    {testResult.reachable ? '✅' : '❌'} Reachable {testResult.latencyMs ? `(${testResult.latencyMs}ms)` : ''}
                  </div>
                  <div className={testResult.statusOk ? 'text-green-600' : 'text-red-600'}>
                    {testResult.statusOk ? '✅' : '❌'} HTTP Status OK
                  </div>
                  <div className={testResult.responseValid ? 'text-green-600' : 'text-red-600'}>
                    {testResult.responseValid ? '✅' : '❌'} Valid Response
                  </div>
                  <div className={testResult.queued ? 'text-green-600' : 'text-amber-600'}>
                    {testResult.queued ? '✅' : '⚠️'} Accepted
                  </div>
                  {testResult.error && (
                    <div className="text-red-600 mt-1 p-2 bg-red-50 rounded text-[11px] break-all">
                      {testResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div>
              <Button variant="outline" onClick={() => processQueueMutation.mutate()} disabled={processQueueMutation.isPending}>
                {processQueueMutation.isPending ? "Processing..." : "⚡ Process Queue Now"}
              </Button>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground"
                disabled={isClearingLock}
                onClick={async () => {
                  setIsClearingLock(true);
                  try {
                    const settingsRows = await api.entities.TonomoIntegrationSettings.list('-created_date', 1);
                    if (settingsRows?.[0]?.id) {
                      await api.entities.TonomoIntegrationSettings.update(settingsRows[0].id, { processing_lock_at: null });
                      toast.success('Lock cleared');
                      queryClient.invalidateQueries({ queryKey: ['tonomoSettings'] });
                    }
                  } catch (err) { toast.error('Failed: ' + (err?.message || 'unknown')); }
                  finally { setIsClearingLock(false); }
                }}>
                {isClearingLock ? '⏳ Clearing...' : '🔓 Clear Lock'}
              </Button>
              {processQueueMutation.isSuccess && (
                <p className="text-sm text-green-600 mt-1">
                  ✅ Done — {processQueueMutation.data?.processed ?? 0} processed, {processQueueMutation.data?.failed ?? 0} failed
                </p>
              )}
              {processQueueMutation.isError && <p className="text-sm text-red-600 mt-1">❌ Processor call failed</p>}
              <Button variant="outline" size="sm" className="ml-2"
                disabled={isDiagnosing}
                onClick={async () => {
                  setIsDiagnosing(true);
                  try {
                    const res = await api.functions.invoke('diagnoseTonomoProcessor', {});
                    // Diagnosis details available via browser DevTools network tab
                    const steps = res.data?.steps || res?.steps || [];
                    const failed = steps.filter(s => s.ok === false);
                    if (failed.length > 0) {
                      toast.error(`Diagnosis found ${failed.length} failures — check browser console (F12)`);
                    } else {
                      toast.success(`All ${steps.length} checks passed — check console for details`);
                    }
                  } catch (err) {
                    toast.error('Diagnosis failed: ' + (err?.message || 'unknown'));
                  } finally {
                    setIsDiagnosing(false);
                  }
                }}>
                {isDiagnosing ? '⏳ Diagnosing...' : '🔍 Diagnose'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Integration Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="text-center">
              <p className="text-2xl font-bold tabular-nums">{queueStats?.pending || 0}</p>
              <p className="text-xs text-muted-foreground">Pending</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600 tabular-nums">{queueStats?.failed || 0}</p>
              <p className="text-xs text-muted-foreground">Failed</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-amber-600 tabular-nums">{queueStats?.dead_letter || 0}</p>
              <p className="text-xs text-muted-foreground">Dead Letter</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold tabular-nums">{auditCount || 0}</p>
              <p className="text-xs text-muted-foreground">Audit entries today</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold tabular-nums">{mappingCoverage || 0}%</p>
              <p className="text-xs text-muted-foreground">Mapping coverage</p>
            </div>
          </div>
          {/* Failed queue items with error details — full server-side pagination */}
          <FailedQueueItems
            failedTotalsHint={(queueStats?.failed || 0) + (queueStats?.dead_letter || 0)}
          />

          <div className="border-t pt-4 mt-4">
            <p className="text-sm font-medium mb-3">Recent Calendar Link Activity</p>
            <CalendarLinkAuditMini />
          </div>
            <div className="pt-4 border-t mt-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                disabled={isRetryingAll}
                onClick={async () => {
                  setIsRetryingAll(true);
                  try {
                    const queue = await api.entities.TonomoProcessingQueue.list('-created_date', 500);
                    const stuck = queue.filter(q => q.status === 'failed' || q.status === 'dead_letter');
                    if (stuck.length === 0) { toast.info('No failed items to retry'); return; }
                    await Promise.all(stuck.map(q =>
                      api.entities.TonomoProcessingQueue.update(q.id, {
                        status: 'pending',
                        retry_count: 0,
                        error_message: null,
                      })
                    ));
                    toast.success(`Reset ${stuck.length} items for reprocessing`);
                    queryClient.invalidateQueries({ queryKey: ['settingsQueue'] });
                    queryClient.invalidateQueries({ queryKey: ['tonomoQueueStats'] });
                    api.functions.invoke('processTonomoQueue', { triggered_by: 'retry' }).catch(() => {});
                  } catch (err) {
                    toast.error(err?.message || 'Failed to reset queue items');
                  } finally {
                    setIsRetryingAll(false);
                  }
                }}
              >
                {isRetryingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {isRetryingAll ? 'Retrying...' : 'Retry all failed & dead letter items'}
              </Button>
            </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent Processing Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {!recentProcessing || recentProcessing.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No processing activity yet</p>
            ) : (
              recentProcessing.map(item => {
                const actionLabels = {
                  scheduled: 'New booking received',
                  rescheduled: 'Booking rescheduled',
                  changed: 'Booking details changed',
                  canceled: 'Booking cancelled',
                  booking_created_or_changed: 'Order updated',
                  booking_completed: 'Booking delivered',
                  new_customer: 'New customer registered'
                };
                const statusLabels = {
                  completed: 'Success',
                  failed: 'Failed',
                  dead_letter: 'Permanent Failure',
                  processing: 'Processing...',
                  superseded: 'Superseded',
                  pending: 'Queued'
                };
                
                return (
                  <div key={item.id} className="flex items-start justify-between p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded whitespace-nowrap ${
                          item.status === 'completed' ? 'bg-green-100 text-green-700' :
                          item.status === 'failed' ? 'bg-red-100 text-red-700' :
                          item.status === 'dead_letter' ? 'bg-amber-100 text-amber-700' :
                          item.status === 'processing' ? 'bg-blue-100 text-blue-700' :
                          item.status === 'superseded' ? 'bg-muted text-foreground/80' :
                          'bg-slate-100 text-slate-700'
                        }`}>
                          {statusLabels[item.status] || item.status}
                        </span>
                        <span className="text-sm font-medium">{actionLabels[item.action] || item.action}</span>
                      </div>
                      <p className="text-sm mt-1.5">
                        {item.result_summary || item.error_message || 'No details available'}
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        {item.project && (
                          <a 
                            href={createPageUrl('ProjectDetails') + '?id=' + item.project.id}
                            className="text-xs text-primary hover:underline flex items-center gap-1"
                          >
                            <ExternalLink className="h-3 w-3" />
                            View Project: {item.project.title}
                          </a>
                        )}
                        <a 
                          href={createPageUrl('TonomoPulse') + '?log=' + item.webhook_log_id}
                          className="text-xs text-muted-foreground hover:text-foreground hover:underline flex items-center gap-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Raw webhook
                        </a>
                      </div>
                    </div>
                    <div className="text-right ml-4 flex-shrink-0">
                      <p className="text-xs text-muted-foreground whitespace-nowrap">
                        {item.processed_at ? relativeTime(parseTS(item.processed_at)) : 
                         item.created_at ? relativeTime(parseTS(item.created_at)) : '—'}
                      </p>
                      {item.retry_count > 0 && (
                        <p className="text-xs text-amber-600 mt-1">Attempt {item.retry_count + 1}</p>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showAutoApproveConfirm} onOpenChange={setShowAutoApproveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enable Auto-Approve?</AlertDialogTitle>
            <AlertDialogDescription>
              Enabling auto-approve will bypass manual review for bookings with full mapping confidence. Are you sure?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              updateMutation.mutate({ auto_approve_enabled: true });
              setShowAutoApproveConfirm(false);
            }}>
              Enable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {roleDefaults && (
        <RoleDefaultsCard
          defaults={roleDefaults}
          onSave={(updates) => roleDefaultsMutation.mutate(updates)}
          isSaving={roleDefaultsMutation.isPending}
        />
      )}
    </div>
    </ErrorBoundary>
  );
}

function BusinessCalendarField({ settings, updateMutation }) {
  const [draft, setDraft] = useState(settings.business_calendar_id || '');
  const isDirty = draft !== (settings.business_calendar_id || '');
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium block">Tonomo Master Calendar</label>
      <p className="text-xs text-muted-foreground">
        The Google Calendar account Tonomo uses to create all booking events.
        Events synced from this account are automatically classified as Tonomo
        bookings. Update this if you change the master calendar in Tonomo.
      </p>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. info@flexstudios.app"
          className="font-mono text-sm"
        />
        <Button
          variant="outline" size="sm"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => updateMutation.mutate({ business_calendar_id: draft })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function NumericField({ label, field, defaultVal, settings, updateMutation }) {
  const [draft, setDraft] = useState(settings[field] ?? defaultVal);
  const isDirty = draft !== (settings[field] ?? defaultVal);
  return (
    <div>
      <label className="text-sm font-medium mb-2 block">{label}</label>
      <div className="flex gap-2">
        <Input
          type="number"
          value={draft}
          onChange={(e) => setDraft(parseInt(e.target.value) || defaultVal)}
          className="w-32"
        />
        <Button
          variant="outline" size="sm"
          disabled={!isDirty || updateMutation.isPending}
          onClick={() => updateMutation.mutate({ [field]: draft })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function CalendarLinkAuditMini() {
  const { data: logs = [] } = useQuery({
    queryKey: ['calendarLinkAudit'],
    queryFn: async () => {
      const all = await api.entities.TonomoAuditLog.list('-processed_at', 200);
      return all.filter(l => l.entity_type === 'CalendarLink').slice(0, 10);
    },
    refetchInterval: 30000,
  });

  if (logs.length === 0) {
    return <p className="text-xs text-muted-foreground">No calendar linking activity yet</p>;
  }

  const opColors = {
    linked: 'bg-green-100 text-green-700',
    retro_linked: 'bg-blue-100 text-blue-700',
    skipped_pending: 'bg-amber-100 text-amber-700',
    google_event_id_stored: 'bg-purple-100 text-purple-700',
    failed: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-1.5">
      {logs.map(log => (
        <div key={log.id} className="flex items-start gap-2 text-xs">
          <span className={`px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${opColors[log.operation] || 'bg-muted text-muted-foreground'}`}>
            {log.operation?.replace(/_/g, ' ')}
          </span>
          <span className="text-muted-foreground flex-1 line-clamp-1">{log.notes}</span>
          <span className="text-muted-foreground flex-shrink-0">{parseTS(log.processed_at) ? relativeTime(parseTS(log.processed_at)) : '—'}</span>
        </div>
      ))}
    </div>
  );
}

const FALLBACK_TIERS = [
  {
    key: 'owner_fallback_team_id',
    label: 'Project Owner',
    icon: '👑',
    covers: 'project_owner_id',
    desc: 'Team to assign as project owner when Tonomo doesn\'t resolve a lead. Usually your management or admin team.',
    teamFunction: 'management',
  },
  {
    key: 'photographer_fallback_team_id',
    label: 'Photographer',
    icon: '📷',
    covers: 'photographer_id',
    desc: 'Team to draw from for photographer when Tonomo resolves a person not yet mapped.',
    teamFunction: 'onsite',
  },
  {
    key: 'videographer_fallback_team_id',
    label: 'Videographer',
    icon: '🎬',
    covers: 'videographer_id',
    desc: 'Team to draw from for videographer when Tonomo resolves a person not yet mapped.',
    teamFunction: 'onsite',
  },
  {
    key: 'editing_fallback_team_id',
    label: 'Editors',
    icon: '🖼',
    covers: 'image_editor_id, video_editor_id, floorplan_editor_id, drone_editor_id',
    desc: 'Team to assign editing roles when not resolved from mappings. Specific editor slot is determined by services booked.',
    teamFunction: 'editing',
  },
];

function RoleDefaultsCard({ defaults, onSave, isSaving }) {
  const [localDefaults, setLocalDefaults] = useState(defaults);
  const isDirty = JSON.stringify(localDefaults) !== JSON.stringify(defaults);

  const { data: teams = [] } = useQuery({
    queryKey: ['internal-teams-for-defaults'],
    queryFn: () => api.entities.InternalTeam.list('-created_date', 100),
    staleTime: 5 * 60_000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-for-defaults'],
    queryFn: () => api.entities.User.list('-created_date', 500),
    staleTime: 5 * 60_000,
  });

  useEffect(() => { setLocalDefaults(defaults); }, [defaults]);

  const handleChange = (key, teamId) => {
    setLocalDefaults(prev => ({ ...prev, [key]: teamId || null }));
  };

  const handleSave = () => {
    onSave({
      owner_fallback_team_id:        localDefaults.owner_fallback_team_id        || null,
      photographer_fallback_team_id: localDefaults.photographer_fallback_team_id || null,
      videographer_fallback_team_id: localDefaults.videographer_fallback_team_id || null,
      editing_fallback_team_id:      localDefaults.editing_fallback_team_id      || null,
    });
  };

  const getTeamMembers = (teamId) =>
    users.filter(u => u.internal_team_id === teamId);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Fallback Role Assignments</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              When a Tonomo booking can't resolve a role from photographer mappings,
              these fallback teams are used. Set the team function in
              Settings → Teams to control which teams appear here.
              A human can reassign specific individuals after project approval.
            </p>
          </div>
          {isDirty && (
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save Changes'}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {FALLBACK_TIERS.map(tier => {
            const selectedTeamId = localDefaults[tier.key] || '';
            const selectedTeam = teams.find(t => t.id === selectedTeamId);
            const members = selectedTeamId ? getTeamMembers(selectedTeamId) : [];
            // Suggest teams whose function matches this tier
            const suggestedTeams = teams.filter(t => t.team_function === tier.teamFunction);
            const otherTeams = teams.filter(t => t.team_function !== tier.teamFunction);

            return (
              <div key={tier.key} className="rounded-lg border p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{tier.icon}</span>
                    <div>
                      <p className="font-medium text-sm">{tier.label}</p>
                      <p className="text-xs text-muted-foreground">Covers: {tier.covers}</p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 min-w-[200px]">
                    <select
                      value={selectedTeamId}
                      onChange={e => handleChange(tier.key, e.target.value)}
                      className="w-full border rounded-lg px-3 py-1.5 text-sm bg-background"
                    >
                      <option value="">No fallback team</option>
                      {suggestedTeams.length > 0 && (
                        <optgroup label="— Recommended">
                          {suggestedTeams.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                      {otherTeams.length > 0 && (
                        <optgroup label="— Other teams">
                          {otherTeams.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">{tier.desc}</p>

                {selectedTeam && (
                  <div className="flex items-center gap-2 pt-1">
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: selectedTeam.color || '#3b82f6' }}
                    />
                    <span className="text-xs text-muted-foreground">
                      {members.length} member{members.length !== 1 ? 's' : ''}
                      {members.length > 0 && ': ' + members.slice(0, 3).map(u => u.full_name || u.email).join(', ')}
                      {members.length > 3 && ` +${members.length - 3} more`}
                    </span>
                    {!selectedTeam.team_function && (
                      <span className="text-xs text-amber-600 ml-2">
                        ⚠ No function set — go to Settings → Teams to add one
                      </span>
                    )}
                  </div>
                )}

                {!selectedTeamId && (
                  <p className="text-xs text-amber-600">
                    ⚠ No fallback — role will remain unassigned if not resolved from mappings
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Failed Queue Items (audit-style, full server-side pagination) ───────────
// Replaces the prior `.slice(0, 20)` cap. Lets ops drill the full failed/dead-letter
// queue with status + time-window filters, page-size selector, and prev/next paging.
// 30s auto-refresh keeps it live during incident response.

const FAILED_PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const FAILED_TIME_WINDOWS = [
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time",      ms: null },
];

function FailedQueueItems({ failedTotalsHint = 0 }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all"); // all | failed | dead_letter
  const [timeWindow, setTimeWindow] = useState("7d");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [isRetryingPage, setIsRetryingPage] = useState(false);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [statusFilter, timeWindow, pageSize]);

  const fetchPage = useCallback(async () => {
    setError(null);
    try {
      let q = api._supabase
        .from("tonomo_processing_queue")
        .select(
          "id, action, order_id, event_id, status, retry_count, error_message, " +
          "result_summary, processed_at, last_failed_at, created_at, updated_at, processor_version",
          { count: "exact" }
        )
        .order("last_failed_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false });

      if (statusFilter === "all") {
        q = q.in("status", ["failed", "dead_letter"]);
      } else {
        q = q.eq("status", statusFilter);
      }

      const tw = FAILED_TIME_WINDOWS.find(t => t.value === timeWindow);
      if (tw && tw.ms != null) {
        q = q.gte("created_at", new Date(Date.now() - tw.ms).toISOString());
      }

      const from = page * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;
      setRows(data || []);
      setTotal(count || 0);
      setLastFetched(new Date());
    } catch (err) {
      setError(err?.message || "Fetch failed");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, timeWindow, page, pageSize]);

  useEffect(() => {
    setLoading(true);
    fetchPage();
  }, [fetchPage]);

  // Auto-refresh every 30s when enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { fetchPage(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchPage]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);
  const hasPrev = page > 0;
  const hasNext = (page + 1) < pageCount;
  const filterCount = (statusFilter !== "all" ? 1 : 0) + (timeWindow !== "7d" ? 1 : 0);

  const fmtRelative = useCallback((ts) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    const diff = Math.max(0, Date.now() - d.getTime());
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  }, []);

  // Retry the visible page only — re-queues each row by setting status back to pending.
  // The 30s auto-refresh + pulse to processTonomoQueue picks them up immediately.
  const retryVisible = useCallback(async () => {
    if (rows.length === 0) return;
    setIsRetryingPage(true);
    try {
      await Promise.all(rows.map(r =>
        api.entities.TonomoProcessingQueue.update(r.id, {
          status: 'pending',
          retry_count: 0,
          error_message: null,
        })
      ));
      toast.success(`Re-queued ${rows.length} item${rows.length === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({ queryKey: ['tonomoQueueStats'] });
      queryClient.invalidateQueries({ queryKey: ['settingsQueue'] });
      api.functions.invoke('processTonomoQueue', { triggered_by: 'retry' }).catch(() => {});
      setLoading(true);
      fetchPage();
    } catch (err) {
      toast.error(err?.message || 'Retry failed');
    } finally {
      setIsRetryingPage(false);
    }
  }, [rows, fetchPage, queryClient]);

  // Hide the entire card when nothing's failing — keeps the Settings page clean for healthy states
  if (total === 0 && !loading && !error && filterCount === 0 && failedTotalsHint === 0) {
    return null;
  }

  return (
    <Card className="mt-4">
      <CardHeader className="py-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            Failed Queue Items — Error Details
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {total.toLocaleString()} total
            </Badge>
            {filterCount > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-1">
                <Filter className="h-2.5 w-2.5" />
                {filterCount} filter{filterCount === 1 ? "" : "s"}
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {lastFetched && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtRelative(lastFetched)}
              </span>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Auto-refresh every 30s"
              />
              <span>Auto-refresh</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              onClick={() => { setLoading(true); fetchPage(); }}
              disabled={loading}
              title="Refresh now"
            >
              <Loader2 className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              onClick={retryVisible}
              disabled={isRetryingPage || loading || rows.length === 0}
              title="Re-queue all items shown on this page"
            >
              {isRetryingPage ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Retry page
            </Button>
          </div>
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Status
            </label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All (failed + dead letter)</SelectItem>
                <SelectItem value="failed">Failed only</SelectItem>
                <SelectItem value="dead_letter">Dead letter only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Time window
            </label>
            <Select value={timeWindow} onValueChange={setTimeWindow}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FAILED_TIME_WINDOWS.map(tw => (
                  <SelectItem key={tw.value} value={tw.value}>{tw.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Page size
            </label>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(parseInt(v, 10))}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FAILED_PAGE_SIZE_OPTIONS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {filterCount > 0 && (
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] gap-1"
              onClick={() => {
                setStatusFilter("all");
                setTimeWindow("7d");
              }}
            >
              <X className="h-3 w-3" />
              Reset filters
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-3 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">Failed to load queue</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</p>
            </div>
          </div>
        )}
        {!error && rows.length === 0 && !loading && (
          <p className="text-xs text-muted-foreground text-center py-6">
            {filterCount > 0
              ? "No items match the current filters."
              : "No failed or dead-letter items in this window. ✅"}
          </p>
        )}
        {rows.map(item => (
          <div key={item.id} className="text-xs border rounded p-2 bg-red-50/50 dark:bg-red-950/10">
            <div className="flex justify-between gap-2 items-start">
              <span className="font-semibold truncate">
                {item.action || 'unknown action'} — {item.order_id || 'no order'}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <Badge variant="outline" className="text-[9px]">
                  {item.status} (attempt {item.retry_count ?? 0})
                </Badge>
                <span className="text-[9px] text-muted-foreground tabular-nums">
                  {fmtRelative(item.last_failed_at || item.updated_at || item.created_at)}
                </span>
              </div>
            </div>
            <p className="text-red-700 dark:text-red-400 mt-1 font-mono break-all">
              {item.error_message || 'No error message'}
            </p>
          </div>
        ))}

        {/* Pagination footer */}
        {total > 0 && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/40">
            <p className="text-[10px] text-muted-foreground">
              Showing <span className="font-medium text-foreground tabular-nums">{showingFrom.toLocaleString()}</span>
              –<span className="font-medium text-foreground tabular-nums">{showingTo.toLocaleString()}</span>{" "}
              of <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span>{" "}
              · Page <span className="tabular-nums">{page + 1}</span> of <span className="tabular-nums">{pageCount}</span>
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 text-[10px]"
                disabled={!hasPrev || loading}
                onClick={() => setPage(p => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3 w-3" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 text-[10px]"
                disabled={!hasNext || loading}
                onClick={() => setPage(p => p + 1)}
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}