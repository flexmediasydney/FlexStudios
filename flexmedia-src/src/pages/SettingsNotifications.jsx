import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Bell, Settings, History, ChevronDown, ChevronRight, Mail, Smartphone, Loader2 } from "lucide-react";
import { usePushSubscription } from "@/lib/usePushSubscription";

// Notification types that enqueue an email when the recipient is offline,
// and types that fire a Web Push to subscribed devices. Must stay in sync
// with the FALLBACK_ELIGIBLE constants in the sendNotificationEmails and
// sendPushNotifications edge functions plus the trigger whitelists in
// migrations 364 and 365.
const EMAIL_FALLBACK_ELIGIBLE = new Set(['note_mention', 'note_reply']);
const PUSH_ELIGIBLE = new Set(['note_mention', 'note_reply']);
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const NOTIFICATION_CATEGORIES = {
  scheduling: { label: "Scheduling", icon: "📅", color: "bg-blue-100 text-blue-700", description: "Shoot dates, calendar conflicts, photographer assignments" },
  project:    { label: "Projects",   icon: "📁", color: "bg-violet-100 text-violet-700", description: "Stage changes, assignments, deliveries, pricing updates" },
  task:       { label: "Tasks",      icon: "📋", color: "bg-cyan-100 text-cyan-700", description: "Task assignments, deadlines, completions, auto-generation" },
  revision:   { label: "Revisions",  icon: "🔄", color: "bg-amber-100 text-amber-700", description: "Revision requests, approvals, stale revision alerts" },
  notes:      { label: "Notes",      icon: "💬", color: "bg-pink-100 text-pink-700", description: "@mentions and replies on notes you're part of" },
  tonomo:     { label: "Tonomo",     icon: "⚡", color: "bg-emerald-100 text-emerald-700", description: "Booking arrivals, payments, mapping gaps, auto-approvals" },
  financial:  { label: "Financial",  icon: "💰", color: "bg-green-100 text-green-700", description: "Overdue invoices, payment receipts, first notices" },
  email:      { label: "Email",      icon: "📧", color: "bg-orange-100 text-orange-700", description: "Client emails, reply reminders, sync failures" },
  system:     { label: "System",     icon: "🔧", color: "bg-muted text-muted-foreground", description: "Stale projects, schema warnings, automation errors" },
};

const NOTIFICATION_TYPES_LIST = [
  // Scheduling
  { type: "shoot_moved_to_onsite",        category: "scheduling", label: "Shoot moved to Onsite" },
  { type: "shoot_overdue",                category: "scheduling", label: "Shoot date overdue" },
  { type: "reschedule_advanced_stage",    category: "scheduling", label: "Reschedule on advanced project" },
  { type: "shoot_date_changed",           category: "scheduling", label: "Shoot date changed" },
  { type: "calendar_event_conflict",      category: "scheduling", label: "Calendar event conflict" },
  { type: "photographer_assigned",        category: "scheduling", label: "Photographer assigned" },
  // Projects
  { type: "project_stage_changed",        category: "project",    label: "Project stage changed" },
  { type: "project_assigned_to_you",      category: "project",    label: "Project assigned to you" },
  { type: "project_owner_assigned",       category: "project",    label: "Project owner assigned" },
  { type: "project_delivered",            category: "project",    label: "Project delivered" },
  { type: "project_pricing_changed",      category: "project",    label: "Project pricing changed" },
  { type: "booking_approved",             category: "project",    label: "Booking approved" },
  { type: "stale_production",             category: "project",    label: "Stale production alert" },
  { type: "stale_submitted",              category: "project",    label: "Stale submitted alert" },
  // Tasks
  { type: "task_assigned",               category: "task",       label: "Task assigned to you" },
  { type: "task_overdue",                category: "task",       label: "Task overdue" },
  { type: "task_deadline_approaching",   category: "task",       label: "Task deadline approaching" },
  { type: "task_dependency_unblocked",   category: "task",       label: "Task unblocked" },
  { type: "task_completed",              category: "task",       label: "Task completed" },
  { type: "all_tasks_completed",         category: "task",       label: "All tasks completed" },
  { type: "tasks_auto_generated",        category: "task",       label: "Tasks auto-generated" },
  { type: "task_generation_failed",      category: "task",       label: "Task generation failed" },
  { type: "timer_running_warning",       category: "task",       label: "Timer still running" },
  // Revisions
  { type: "revision_created",            category: "revision",   label: "New revision request" },
  { type: "revision_urgent",             category: "revision",   label: "Urgent revision" },
  { type: "revision_approved",           category: "revision",   label: "Revision approved" },
  { type: "revision_cancelled",          category: "revision",   label: "Revision cancelled" },
  { type: "revision_stale_48h",          category: "revision",   label: "Revision open 48+ hours" },
  { type: "revision_all_resolved",       category: "revision",   label: "All revisions resolved" },
  { type: "change_request_created",      category: "revision",   label: "New change request" },
  // Notes
  { type: "note_mention",                category: "notes",      label: "@mentioned in a note or comment" },
  { type: "note_reply",                  category: "notes",      label: "Reply on your note" },
  // Tonomo / Bookings
  { type: "booking_arrived_pending_review", category: "tonomo",  label: "New booking pending review" },
  { type: "booking_cancellation",        category: "tonomo",     label: "Booking cancelled" },
  { type: "booking_urgent_review",       category: "tonomo",     label: "Urgent: shoot in 24h" },
  { type: "booking_payment_received",    category: "tonomo",     label: "Payment received" },
  { type: "booking_service_uncertainty", category: "tonomo",     label: "Service assignment uncertain" },
  { type: "booking_mapping_gaps",        category: "tonomo",     label: "Mapping gaps after approval" },
  { type: "booking_no_photographer",     category: "tonomo",     label: "No photographer assigned" },
  { type: "booking_auto_approved",       category: "tonomo",     label: "Booking auto-approved" },
  { type: "booking_services_changed",    category: "tonomo",     label: "Services changed" },
  { type: "booking_flow_unmapped",       category: "tonomo",     label: "Booking flow unmapped" },
  { type: "booking_type_unmapped",       category: "tonomo",     label: "Booking type unmapped" },
  { type: "booking_rescheduled",         category: "tonomo",     label: "Booking rescheduled" },
  // Financial
  { type: "invoice_overdue_7d",          category: "financial",  label: "Invoice overdue (7+ days)" },
  { type: "invoice_overdue_14d",         category: "financial",  label: "Invoice overdue (14+ days)" },
  { type: "payment_received",            category: "financial",  label: "Payment received" },
  { type: "payment_overdue_first",       category: "financial",  label: "Payment overdue (first notice)" },
  // Email
  { type: "email_received_from_client",  category: "email",      label: "Email from client" },
  { type: "email_requires_reply",        category: "email",      label: "Email requires reply" },
  { type: "email_sync_failed",           category: "email",      label: "Email sync failed" },
  // System
  { type: "stale_project",               category: "system",     label: "Project stale (7+ days)" },
  { type: "pending_review_stale",        category: "system",     label: "Booking pending review 48h+" },
  { type: "mapping_table_needs_update",  category: "system",     label: "Mapping table needs update" },
  { type: "schema_warning",              category: "system",     label: "Schema warning from Tonomo" },
  { type: "rule_engine_error",           category: "system",     label: "Automation rule error" },
  { type: "pricing_recalculated",        category: "system",     label: "Pricing recalculated" },
  { type: "engine_error",               category: "system",     label: "System engine error" },
];

function PushDeviceCard({ userId }) {
  const { supported, permission, subscribed, busy, error, subscribe, unsubscribe } = usePushSubscription(userId);

  // We hide the card entirely on browsers that can't do Web Push at all
  // (no SW or no PushManager). On iOS, this also covers regular Safari —
  // the card only renders inside the installed PWA where push works.
  if (!supported) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> Push Notifications</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This browser doesn't support push notifications. On iPhone, install FlexStudios to your home screen
            (Share → Add to Home Screen) and open it from there to enable push.
          </p>
        </CardContent>
      </Card>
    );
  }

  let statusText = '';
  let statusTone = 'text-muted-foreground';
  if (subscribed)              { statusText = 'Push notifications are enabled on this device.'; statusTone = 'text-green-700 dark:text-green-400'; }
  else if (permission === 'granted') statusText = 'Permission granted, but this device isn\'t subscribed yet.';
  else if (permission === 'denied')  { statusText = 'Notifications are blocked. To enable: open device Settings → FlexStudios → Notifications → Allow.'; statusTone = 'text-amber-700 dark:text-amber-400'; }
  else                              statusText = 'Get an alert on your phone\'s lock screen when you\'re @-mentioned.';

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Smartphone className="h-4 w-4" /> Push Notifications</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={`text-sm ${statusTone}`}>{statusText}</p>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex gap-2">
          {subscribed ? (
            <Button variant="outline" size="sm" onClick={unsubscribe} disabled={busy}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Disable on this device
            </Button>
          ) : (
            <Button size="sm" onClick={subscribe} disabled={busy || permission === 'denied'}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
              Enable push notifications
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          You'll see a system permission prompt the first time. iOS only allows it inside the installed PWA.
        </p>
      </CardContent>
    </Card>
  );
}

function MyPreferencesTab({ userId }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(new Set(["scheduling", "task"]));
  const [digestSettings, setDigestSettings] = useState({
    quiet_hours_enabled: false, quiet_hours_start: "22:00",
    quiet_hours_end: "08:00", sound_enabled: false, show_previews: true
  });

  const { data: prefs = [] } = useQuery({
    queryKey: ["notifPrefs", userId],
    queryFn: () => api.entities.NotificationPreference.list("-created_date", 200),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  const { data: digestData = [] } = useQuery({
    queryKey: ["notifDigest", userId],
    queryFn: () => api.entities.NotificationDigestSettings.list("-created_date", 10),
    enabled: !!userId,
    staleTime: 60 * 1000,
  });

  // Sync digest settings from server data on initial load only
  const digestInitialized = useRef(false);
  useEffect(() => {
    if (digestData.length > 0 && !digestInitialized.current) {
      const mine = digestData.find(d => d.user_id === userId);
      if (mine) {
        setDigestSettings(mine);
        digestInitialized.current = true;
      }
    }
  }, [digestData, userId]);

  const savePrefMutation = useMutation({
    mutationFn: async ({ type, category, enabled }) => {
      const existing = prefs.find(p => p.user_id === userId && p.notification_type === type);
      if (existing) {
        return api.entities.NotificationPreference.update(existing.id, { in_app_enabled: enabled });
      } else {
        return api.entities.NotificationPreference.create({
          user_id: userId, notification_type: type, category, in_app_enabled: enabled
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifPrefs", userId] }),
    onError: (err) => toast.error(err?.message || 'Failed to save notification preference'),
  });

  const saveEmailPrefMutation = useMutation({
    mutationFn: async ({ type, category, enabled }) => {
      const existing = prefs.find(p => p.user_id === userId && p.notification_type === type);
      if (existing) {
        return api.entities.NotificationPreference.update(existing.id, { email_enabled: enabled });
      } else {
        return api.entities.NotificationPreference.create({
          user_id: userId, notification_type: type, category, email_enabled: enabled
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifPrefs", userId] }),
    onError: (err) => toast.error(err?.message || 'Failed to save email preference'),
  });

  const savePushPrefMutation = useMutation({
    mutationFn: async ({ type, category, enabled }) => {
      const existing = prefs.find(p => p.user_id === userId && p.notification_type === type);
      if (existing) {
        return api.entities.NotificationPreference.update(existing.id, { push_enabled: enabled });
      } else {
        return api.entities.NotificationPreference.create({
          user_id: userId, notification_type: type, category, push_enabled: enabled
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifPrefs", userId] }),
    onError: (err) => toast.error(err?.message || 'Failed to save push preference'),
  });

  const saveCategoryMutation = useMutation({
    mutationFn: async ({ category, enabled }) => {
      const existing = prefs.find(
        p => p.user_id === userId && p.category === category && (!p.notification_type || p.notification_type === "*")
      );
      if (existing) {
        return api.entities.NotificationPreference.update(existing.id, { in_app_enabled: enabled });
      } else {
        return api.entities.NotificationPreference.create({
          user_id: userId, notification_type: "*", category, in_app_enabled: enabled
        });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifPrefs", userId] }),
    onError: (err) => toast.error(err?.message || 'Failed to save category preference'),
  });

  const saveDigestMutation = useMutation({
    mutationFn: async (settings) => {
      const existing = digestData.find(d => d.user_id === userId);
      if (existing) {
        return api.entities.NotificationDigestSettings.update(existing.id, settings);
      } else {
        return api.entities.NotificationDigestSettings.create({ user_id: userId, ...settings });
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifDigest", userId] }),
    onError: (err) => toast.error(err?.message || 'Failed to save digest settings'),
  });

  function getCategoryPref(category) {
    const p = prefs.find(
      x => x.user_id === userId && x.category === category && (!x.notification_type || x.notification_type === "*")
    );
    return p?.in_app_enabled !== false;
  }

  function getPref(type, category) {
    // If the parent category is disabled, individual type is effectively disabled
    if (!getCategoryPref(category)) return false;
    const p = prefs.find(x => x.user_id === userId && x.notification_type === type);
    return p?.in_app_enabled !== false;
  }

  function getEmailPref(type) {
    // Default ON for fallback-eligible types when no explicit preference exists
    // (matches the edge-function default in sendNotificationEmails).
    const p = prefs.find(x => x.user_id === userId && x.notification_type === type);
    if (p?.email_enabled === true) return true;
    if (p?.email_enabled === false) return false;
    return EMAIL_FALLBACK_ELIGIBLE.has(type);
  }

  function getPushPref(type) {
    // Default ON for push-eligible types when no explicit preference exists
    // (matches the edge-function default in sendPushNotifications).
    const p = prefs.find(x => x.user_id === userId && x.notification_type === type);
    if (p?.push_enabled === true) return true;
    if (p?.push_enabled === false) return false;
    return PUSH_ELIGIBLE.has(type);
  }

  const grouped = useMemo(() => {
    const g = {};
    for (const t of NOTIFICATION_TYPES_LIST) {
      if (!g[t.category]) g[t.category] = [];
      g[t.category].push(t);
    }
    return g;
  }, []);

  return (
    <div className="space-y-6">
      <PushDeviceCard userId={userId} />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Delivery Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Sound on notification</Label>
                <p className="text-xs text-muted-foreground">Play a sound when new notifications arrive</p>
              </div>
              <Switch
                checked={digestSettings.sound_enabled}
                onCheckedChange={v => {
                  const updated = { ...digestSettings, sound_enabled: v };
                  setDigestSettings(updated);
                  saveDigestMutation.mutate(updated);
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Show message previews</Label>
                <p className="text-xs text-muted-foreground">Show message content in the bell dropdown</p>
              </div>
              <Switch
                checked={digestSettings.show_previews}
                onCheckedChange={v => {
                  const updated = { ...digestSettings, show_previews: v };
                  setDigestSettings(updated);
                  saveDigestMutation.mutate(updated);
                }}
              />
            </div>
          </div>
          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <Label>Quiet hours</Label>
                <p className="text-xs text-muted-foreground">Suppress non-critical notifications during this window</p>
              </div>
              <Switch
                checked={digestSettings.quiet_hours_enabled}
                onCheckedChange={v => {
                  const updated = { ...digestSettings, quiet_hours_enabled: v };
                  setDigestSettings(updated);
                  saveDigestMutation.mutate(updated);
                }}
              />
            </div>
            {digestSettings.quiet_hours_enabled && (
              <div className="flex items-center gap-3 pl-1">
                <Label htmlFor="quiet-hours-start" className="text-xs">From</Label>
                <Input
                  id="quiet-hours-start"
                  type="time"
                  className="w-28 h-7 text-xs"
                  value={digestSettings.quiet_hours_start}
                  onChange={e => {
                    const updated = { ...digestSettings, quiet_hours_start: e.target.value };
                    setDigestSettings(updated);
                  }}
                  onBlur={e => {
                    saveDigestMutation.mutate({ ...digestSettings, quiet_hours_start: e.target.value });
                  }}
                />
                <Label htmlFor="quiet-hours-end" className="text-xs">to</Label>
                <Input
                  id="quiet-hours-end"
                  type="time"
                  className="w-28 h-7 text-xs"
                  value={digestSettings.quiet_hours_end}
                  onChange={e => {
                    const updated = { ...digestSettings, quiet_hours_end: e.target.value };
                    setDigestSettings(updated);
                  }}
                  onBlur={e => {
                    saveDigestMutation.mutate({ ...digestSettings, quiet_hours_end: e.target.value });
                  }}
                />
                <span className="text-xs text-muted-foreground">(Sydney time)</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Notification Types
        </h3>
        {Object.entries(grouped).map(([category, types]) => {
          const cfg = NOTIFICATION_CATEGORIES[category] || { label: category, icon: "🔔", color: "bg-muted text-muted-foreground" };
          const isExpanded = expanded.has(category);
          const catEnabled = getCategoryPref(category);

          return (
            <Card key={category}>
              <CardContent className="p-0">
                <div
                  className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30"
                  onClick={() => setExpanded(prev => {
                    const n = new Set(prev);
                    n.has(category) ? n.delete(category) : n.add(category);
                    return n;
                  })}
                >
                  <Switch
                    checked={catEnabled}
                    onCheckedChange={v => {
                      saveCategoryMutation.mutate({ category, enabled: v });
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                  <div className="flex flex-col min-w-0">
                    <Badge className={`text-xs ${cfg.color} w-fit`}>{cfg.icon} {cfg.label}</Badge>
                    {cfg.description && (
                      <span className="text-[11px] text-muted-foreground mt-0.5 truncate">{cfg.description}</span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {types.length} types
                  </span>
                  {isExpanded
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  }
                </div>

                {isExpanded && (
                  <div className="border-t divide-y">
                    {types.map(t => {
                      const emailEligible = EMAIL_FALLBACK_ELIGIBLE.has(t.type);
                      const pushEligible  = PUSH_ELIGIBLE.has(t.type);
                      return (
                        <div key={t.type} className={`flex items-center justify-between gap-3 px-4 py-2.5 pl-12 ${!catEnabled ? "opacity-50" : ""}`}>
                          <Label className="text-sm font-normal cursor-pointer flex-1 min-w-0">{t.label}</Label>
                          <div className="flex items-center gap-5 shrink-0">
                            {pushEligible ? (
                              <div className="flex items-center gap-1.5" title="Push notification on installed devices">
                                <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                                <Switch
                                  checked={getPushPref(t.type)}
                                  onCheckedChange={v => savePushPrefMutation.mutate({ type: t.type, category, enabled: v })}
                                  disabled={!catEnabled || !getPref(t.type, category)}
                                />
                              </div>
                            ) : (
                              <span className="w-[58px]" aria-hidden="true" />
                            )}
                            {emailEligible ? (
                              <div className="flex items-center gap-1.5" title="Email me when I'm offline">
                                <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                                <Switch
                                  checked={getEmailPref(t.type)}
                                  onCheckedChange={v => saveEmailPrefMutation.mutate({ type: t.type, category, enabled: v })}
                                  disabled={!catEnabled || !getPref(t.type, category)}
                                />
                              </div>
                            ) : (
                              <span className="w-[58px]" aria-hidden="true" />
                            )}
                            <div className="flex items-center gap-1.5" title="In-app notification">
                              <Bell className="h-3.5 w-3.5 text-muted-foreground" />
                              <Switch
                                checked={getPref(t.type, category)}
                                onCheckedChange={v => savePrefMutation.mutate({ type: t.type, category, enabled: v })}
                                disabled={!catEnabled}
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function NotificationLogTab() {
  const { data: notifs = [] } = useQuery({
    queryKey: ["allNotifications"],
    queryFn: () => api.entities.Notification.list("-created_date", 500),
    staleTime: 30 * 1000,
  });
  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list(),
    staleTime: 5 * 60 * 1000,
  });

  const [catFilter, setCatFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [readFilter, setReadFilter] = useState("all");
  const [search, setSearch] = useState("");

  const userMap = useMemo(() => {
    const m = {};
    users.forEach(u => { m[u.id] = u.full_name || u.email || u.id; });
    return m;
  }, [users]);

  const filtered = useMemo(() => {
    return notifs
      .filter(n => catFilter === "all" || n.category === catFilter)
      .filter(n => severityFilter === "all" || n.severity === severityFilter)
      .filter(n => readFilter === "all" || (readFilter === "unread" ? !n.is_read : n.is_read))
      .filter(n => {
        if (!search) return true;
        return ((n.title || '') + (n.message || '') + (n.project_name || '') + (n.type || '')).toLowerCase().includes(search.toLowerCase());
      });
  }, [notifs, catFilter, severityFilter, readFilter, search]);

  const stats = useMemo(() => ({
    total: notifs.length,
    unread: notifs.filter(n => !n.is_read).length,
    critical: notifs.filter(n => n.severity === "critical").length,
    today: notifs.filter(n => {
      const ts = n.created_date || "";
      const safe = (ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) ? ts : ts + "Z";
      const d = new Date(safe);
      return d.toDateString() === new Date().toDateString();
    }).length,
  }), [notifs]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total", value: stats.total, color: "text-foreground" },
          { label: "Unread", value: stats.unread, color: "text-blue-600" },
          { label: "Critical", value: stats.critical, color: "text-red-600" },
          { label: "Today", value: stats.today, color: "text-emerald-600" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3">
              <p className={`text-2xl font-bold tabular-nums ${s.color}`}>{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-40">
          <Input placeholder="Search..." className="h-8 pl-3 text-xs" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search notification settings" />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-36 h-8 text-xs"><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.entries(NOTIFICATION_CATEGORIES).map(([v, c]) => (
              <SelectItem key={v} value={v}>{c.icon} {c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={severityFilter} onValueChange={setSeverityFilter}>
          <SelectTrigger className="w-32 h-8 text-xs"><SelectValue placeholder="Severity" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Severities</SelectItem>
            <SelectItem value="critical">🔴 Critical</SelectItem>
            <SelectItem value="warning">🟡 Warning</SelectItem>
            <SelectItem value="info">🔵 Info</SelectItem>
          </SelectContent>
        </Select>
        <Select value={readFilter} onValueChange={setReadFilter}>
          <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="unread">Unread</SelectItem>
            <SelectItem value="read">Read</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        {filtered.slice(0, 200).map(n => (
          <div key={n.id} className={`flex items-start gap-3 p-3 rounded-lg border text-xs
            ${n.severity === "critical" ? "border-red-200 bg-red-50/30" :
              n.severity === "warning" ? "border-amber-200 bg-amber-50/20" : "border-border"}
            ${!n.is_read ? "bg-blue-50/20" : ""}
          `}>
            <Badge className={`text-[10px] shrink-0 ${
              n.severity === "critical" ? "bg-red-100 text-red-700" :
              n.severity === "warning" ? "bg-amber-100 text-amber-700" :
              "bg-blue-100 text-blue-700"
            }`}>{n.severity}</Badge>
            <div className="flex-1 min-w-0">
              <span className="font-semibold">{n.title}</span>
              {n.message && <span className="text-muted-foreground ml-1">— {n.message}</span>}
              <div className="flex gap-2 mt-0.5 text-muted-foreground">
                <span>→ {userMap[n.user_id] || n.user_id}</span>
                {n.project_name && <span>· {n.project_name}</span>}
                <span>· {n.type}</span>
                {n.is_read && <span>· ✓ read</span>}
              </div>
            </div>
            <span className="text-muted-foreground shrink-0">
              {(() => { const ts = n.created_date || ""; const safe = (ts.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(ts)) ? ts : ts + "Z"; return new Date(safe); })()
                .toLocaleString("en-AU", { day:"numeric", month:"short", hour:"2-digit", minute:"2-digit" })}
            </span>
          </div>
        ))}
        {filtered.length > 200 && (
          <p className="text-xs text-muted-foreground text-center py-2">
            Showing 200 of {filtered.length} entries. Use filters to narrow down.
          </p>
        )}
        {filtered.length === 0 && (
          <div className="text-center py-8 text-muted-foreground text-sm">No notifications match the current filters.</div>
        )}
      </div>
    </div>
  );
}

export default function SettingsNotifications() {
  const { data: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.role === "master_admin";

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Link to={createPageUrl("SettingsOrganisation")}>
          <Button variant="ghost" size="icon" aria-label="Back to settings"><ArrowLeft className="h-5 w-5" /></Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="h-7 w-7 text-primary" />
            Notification Settings
          </h1>
          <p className="text-muted-foreground mt-1">
            Control which notifications you receive and how they're delivered.
          </p>
        </div>
      </div>

      <Tabs defaultValue="preferences">
        <TabsList>
          <TabsTrigger value="preferences" className="gap-2">
            <Settings className="h-4 w-4" /> My Preferences
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="log" className="gap-2">
              <History className="h-4 w-4" /> Notification Log
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="preferences" className="mt-6">
          {currentUser?.id && <MyPreferencesTab userId={currentUser.id} />}
        </TabsContent>

        {isAdmin && (
          <TabsContent value="log" className="mt-6">
            <NotificationLogTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}