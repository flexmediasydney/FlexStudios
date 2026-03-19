import { useState, useEffect } from "react";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Copy, Check, Clock, ExternalLink, RefreshCw } from "lucide-react";
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
      const all = await base44.entities.TonomoIntegrationSettings.list('-created_date', 1);
      if (all.length === 0) {
        return await base44.entities.TonomoIntegrationSettings.create({
          auto_approve_enabled: false,
          urgent_review_hours: 24,
          auto_approve_on_imminent: true,
          imminent_threshold_hours: 2,
          business_calendar_id: 'info@flexmedia.sydney'
        });
      }
      return all[0];
    }
  });

  const { data: roleDefaults, isLoading: roleDefaultsLoading, error: roleDefaultsError } = useQuery({
    queryKey: ['tonomoRoleDefaults'],
    queryFn: async () => {
      try {
        const all = await base44.entities.TonomoRoleDefaults.list('-created_date', 1);
        if (all.length === 0) {
          // Entity exists but no rows yet — create the first one
          return await base44.entities.TonomoRoleDefaults.create({});
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
        return base44.entities.TonomoRoleDefaults.update(roleDefaults.id, updates);
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
    queryFn: () => base44.entities.TonomoProcessingQueue.list('-created_date', 200),
    refetchInterval: 10000,
  });

  const { data: queueStats } = useQuery({
    queryKey: ['tonomoQueueStats'],
    queryFn: async () => {
      const queue = await base44.entities.TonomoProcessingQueue.list('-created_date', 500);
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
      const logs = await base44.entities.TonomoAuditLog.list('-processed_at', 500);
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
      const all = await base44.entities.TonomoMappingTable.list('-created_date', 500);
      const confirmed = all.filter(m => m.is_confirmed).length;
      return all.length > 0 ? Math.round((confirmed / all.length) * 100) : 0;
    },
    refetchInterval: 30000
  });

  const { data: recentProcessing } = useQuery({
    queryKey: ['tonomoRecentProcessing'],
    queryFn: async () => {
      const queue = await base44.entities.TonomoProcessingQueue.list('-processed_at', 50);
      const projectIds = queue.map(q => {
        const match = q.result_summary?.match(/Project (created|updated)/);
        return match ? q.order_id : null;
      }).filter(Boolean);
      
      const projects = projectIds.length > 0 
        ? await base44.entities.Project.filter({ tonomo_order_id: { $in: projectIds } }, null, 100)
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
      return await base44.entities.TonomoIntegrationSettings.update(settings.id, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tonomoSettings'] });
    },
    onError: (err) => toast.error(err?.message || "Operation failed"),
  });

  const processQueueMutation = useMutation({
    mutationFn: async () => {
      const res = await base44.functions.invoke('processTonomoQueue', { triggered_by: 'manual' });
      return res.data || res;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tonomoSettings'] });
      queryClient.invalidateQueries({ queryKey: ['tonomoQueueStats'] });
    },
    onError: (err) => toast.error(err?.message || "Operation failed"),
  });

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const webhookUrl = `${supabaseUrl}/functions/v1/receiveTonomoWebhook`;

  const testWebhookMutation = useMutation({
    mutationFn: async () => {
      const testPayload = {
        action: "scheduled",
        orderId: "test_" + Date.now(),
        orderName: "Test Order",
        when: { start_time: Math.floor(Date.now() / 1000), end_time: Math.floor(Date.now() / 1000) + 3600 }
      };
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testPayload)
      });
      return await res.json();
    }
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

  if (isLoading) return <div className="p-6">Loading...</div>;
  if (!settings) return <div className="p-6">No settings found</div>;

  return (
    <ErrorBoundary>
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Tonomo Integration</h1>
        <p className="text-muted-foreground mt-1">Configure webhook processing and auto-approval rules</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connection Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">

          <div>
            <label className="text-sm font-medium mb-2 block">Webhook URL</label>
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={handleCopy}>
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
                {testWebhookMutation.isPending ? "Testing..." : "Test Webhook"}
              </Button>
              {testWebhookMutation.isSuccess && <p className="text-sm text-green-600 mt-1">✅ Test successful</p>}
              {testWebhookMutation.isError && <p className="text-sm text-red-600 mt-1">❌ Test failed</p>}
            </div>
            <div>
              <Button variant="outline" onClick={() => processQueueMutation.mutate()} disabled={processQueueMutation.isPending}>
                {processQueueMutation.isPending ? "Processing..." : "⚡ Process Queue Now"}
              </Button>
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground"
                onClick={async () => {
                  try {
                    const settings = await base44.entities.TonomoIntegrationSettings.list('-created_date', 1);
                    if (settings?.[0]?.id) {
                      await base44.entities.TonomoIntegrationSettings.update(settings[0].id, { processing_lock_at: null });
                      toast.success('Lock cleared');
                    }
                  } catch (err) { toast.error('Failed: ' + (err?.message || 'unknown')); }
                }}>
                🔓 Clear Lock
              </Button>
              {processQueueMutation.isSuccess && (
                <p className="text-sm text-green-600 mt-1">
                  ✅ Done — {processQueueMutation.data?.processed ?? 0} processed, {processQueueMutation.data?.failed ?? 0} failed
                </p>
              )}
              {processQueueMutation.isError && <p className="text-sm text-red-600 mt-1">❌ Processor call failed</p>}
              <Button variant="outline" size="sm" className="ml-2"
                onClick={async () => {
                  try {
                    const res = await base44.functions.invoke('diagnoseTonomoProcessor', {});
                    console.log('DIAGNOSIS:', JSON.stringify(res.data || res, null, 2));
                    const steps = res.data?.steps || res?.steps || [];
                    const failed = steps.filter(s => s.ok === false);
                    if (failed.length > 0) {
                      toast.error(`Diagnosis found ${failed.length} failures — check browser console (F12)`);
                    } else {
                      toast.success(`All ${steps.length} checks passed — check console for details`);
                    }
                    // Also show in an alert for visibility
                    alert(JSON.stringify(steps, null, 2));
                  } catch (err) {
                    toast.error('Diagnosis failed: ' + (err?.message || 'unknown'));
                    alert('Diagnosis error: ' + (err?.message || 'unknown'));
                  }
                }}>
                🔍 Diagnose
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
              <p className="text-2xl font-bold">{queueStats?.pending || 0}</p>
              <p className="text-xs text-muted-foreground">Pending</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-red-600">{queueStats?.failed || 0}</p>
              <p className="text-xs text-muted-foreground">Failed</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold text-amber-600">{queueStats?.dead_letter || 0}</p>
              <p className="text-xs text-muted-foreground">Dead Letter</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center">
              <p className="text-2xl font-bold">{auditCount || 0}</p>
              <p className="text-xs text-muted-foreground">Audit entries today</p>
            </div>
            <div className="text-center">
              <p className="text-2xl font-bold">{mappingCoverage || 0}%</p>
              <p className="text-xs text-muted-foreground">Mapping coverage</p>
            </div>
          </div>
          {/* Failed queue items with error details */}
          {queue.filter(q => q.status === 'failed' || q.status === 'dead_letter').length > 0 && (
            <Card className="mt-4">
              <CardHeader className="py-3">
                <CardTitle className="text-sm">Failed Queue Items — Error Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 max-h-60 overflow-y-auto">
                {queue.filter(q => q.status === 'failed' || q.status === 'dead_letter').slice(0, 20).map(item => (
                  <div key={item.id} className="text-xs border rounded p-2 bg-red-50/50">
                    <div className="flex justify-between">
                      <span className="font-semibold">{item.action} — {item.order_id || 'no order'}</span>
                      <Badge variant="outline" className="text-[9px]">{item.status} (attempt {item.retry_count})</Badge>
                    </div>
                    <p className="text-red-700 mt-1 font-mono break-all">{item.error_message || 'No error message'}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          <div className="border-t pt-4 mt-4">
            <p className="text-sm font-medium mb-3">Recent Calendar Link Activity</p>
            <CalendarLinkAuditMini />
          </div>
            <div className="pt-4 border-t mt-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-2"
                onClick={async () => {
                  try {
                    const queue = await base44.entities.TonomoProcessingQueue.list('-created_date', 500);
                    const stuck = queue.filter(q => q.status === 'failed' || q.status === 'dead_letter');
                    if (stuck.length === 0) { toast.info('No failed items to retry'); return; }
                    await Promise.all(stuck.map(q =>
                      base44.entities.TonomoProcessingQueue.update(q.id, {
                        status: 'pending',
                        retry_count: 0,
                        error_message: null,
                      })
                    ));
                    toast.success(`Reset ${stuck.length} items for reprocessing`);
                    // Trigger processor
                    base44.functions.invoke('processTonomoQueue', { triggered_by: 'retry' }).catch(() => {});
                  } catch (err) {
                    toast.error(err?.message || 'Failed to reset queue items');
                  }
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Retry all failed &amp; dead letter items
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
                          item.status === 'superseded' ? 'bg-gray-100 text-gray-700' :
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
          placeholder="e.g. info@flexmedia.sydney"
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
      const all = await base44.entities.TonomoAuditLog.list('-processed_at', 200);
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
    key: 'onsite_fallback_team_id',
    label: 'Photographer / Videographer',
    icon: '📷',
    covers: 'photographer_id, videographer_id',
    desc: 'Team to draw from for onsite staff when Tonomo resolves a person not yet mapped. Booking type determines whether they\'re assigned as photographer or videographer.',
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
    queryFn: () => base44.entities.InternalTeam.list('-created_date', 100),
    staleTime: 5 * 60_000,
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-for-defaults'],
    queryFn: () => base44.entities.User.list('-created_date', 500),
    staleTime: 5 * 60_000,
  });

  useEffect(() => { setLocalDefaults(defaults); }, [defaults]);

  const handleChange = (key, teamId) => {
    setLocalDefaults(prev => ({ ...prev, [key]: teamId || null }));
  };

  const handleSave = () => {
    onSave({
      owner_fallback_team_id:   localDefaults.owner_fallback_team_id   || null,
      onsite_fallback_team_id:  localDefaults.onsite_fallback_team_id  || null,
      editing_fallback_team_id: localDefaults.editing_fallback_team_id || null,
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