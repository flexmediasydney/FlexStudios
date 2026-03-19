import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2, Edit2, ChevronDown, ChevronRight, Zap, CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PermissionGuard } from "@/components/auth/PermissionGuard";

const GROUPS = [
  { value: "scheduling", label: "Scheduling", color: "bg-blue-100 text-blue-700", icon: "📅" },
  { value: "production", label: "Production", color: "bg-violet-100 text-violet-700", icon: "🎬" },
  { value: "revision", label: "Revision", color: "bg-amber-100 text-amber-700", icon: "🔄" },
  { value: "tonomo", label: "Tonomo", color: "bg-emerald-100 text-emerald-700", icon: "⚡" },
  { value: "financial", label: "Financial", color: "bg-green-100 text-green-700", icon: "💰" },
  { value: "quality", label: "Quality", color: "bg-rose-100 text-rose-700", icon: "🔍" },
];

const TRIGGER_TYPES = [
  { value: "schedule_daily", label: "Daily Schedule" },
  { value: "project_stage_changed", label: "Stage Changed" },
  { value: "project_field_changed", label: "Field Changed" },
  { value: "tonomo_webhook_processed", label: "Tonomo Webhook" },
  { value: "revision_created", label: "Revision Created" },
  { value: "revision_closed", label: "Revision Closed" },
  { value: "always", label: "Always (Every Run)" },
];

const OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "is_set", label: "is set" },
  { value: "is_empty", label: "is empty" },
  { value: "contains", label: "contains" },
  { value: "in_list", label: "is one of" },
  { value: "not_in_list", label: "is not one of" },
  { value: "greater_than", label: ">" },
  { value: "less_than", label: "<" },
  { value: "stage_is_before", label: "stage is before" },
  { value: "stage_is_after", label: "stage is after" },
  { value: "date_is_today", label: "date is today" },
  { value: "date_is_past", label: "date is past" },
  { value: "date_within_hours", label: "date within N hours" },
  { value: "date_older_than_days", label: "last updated N+ days ago" },
];

const ACTION_TYPES = [
  { value: "set_stage", label: "Move to Stage" },
  { value: "set_field", label: "Set Field Value" },
  { value: "set_flag", label: "Set Flag" },
  { value: "notify_roles", label: "Send Notification" },
  { value: "add_activity_log", label: "Add Activity Log Entry" },
  { value: "noop", label: "No-op (Monitoring Only)" },
];

const STAGE_OPTIONS = [
  "pending_review", "to_be_scheduled", "scheduled", "onsite",
  "uploaded", "submitted", "in_progress", "ready_for_partial",
  "in_revision", "delivered"
];

const RESULT_COLORS = {
  executed: "bg-emerald-100 text-emerald-700",
  skipped_conditions: "bg-slate-100 text-slate-600",
  skipped_cooldown: "bg-blue-100 text-blue-700",
  skipped_overridden: "bg-orange-100 text-orange-700",
  skipped_dry_run: "bg-purple-100 text-purple-700",
  error: "bg-red-100 text-red-700",
};

function groupConfig(g) {
  return GROUPS.find(x => x.value === g) || { value: g, label: g, color: "bg-slate-100 text-slate-600", icon: "📋" };
}

function relTime(ts) {
  if (!ts) return "Never";
  const diff = Date.now() - new Date(ts + (ts.endsWith("Z") ? "" : "Z")).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 2) return "Just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const EMPTY_RULE = {
  name: "",
  description: "",
  rule_group: "quality",
  is_enabled: true,
  is_system: false,
  priority: 50,
  trigger_type: "schedule_daily",
  trigger_config: JSON.stringify({ time: "09:00" }),
  conditions_json: "[]",
  condition_logic: "AND",
  action_type: "add_activity_log",
  action_config: JSON.stringify({ message: "" }),
  cooldown_minutes: 60,
  dry_run_only: false,
  notes: ""
};

function RuleBuilderModal({ open, onClose, initialRule, onSave }) {
  const [form, setForm] = useState(initialRule || EMPTY_RULE);
  const [conditions, setConditions] = useState(() => {
    try { return JSON.parse(initialRule?.conditions_json || "[]"); } catch { return []; }
  });
  const [triggerCfg, setTriggerCfg] = useState(() => {
    try { return JSON.parse(initialRule?.trigger_config || "{}"); } catch { return {}; }
  });
  const [actionCfg, setActionCfg] = useState(() => {
    try { return JSON.parse(initialRule?.action_config || "{}"); } catch { return {}; }
  });

  function updateForm(k, v) { setForm(prev => ({ ...prev, [k]: v })); }

  function addCondition() {
    setConditions(prev => [...prev, { field: "status", operator: "equals", value: "" }]);
  }

  function updateCondition(i, k, v) {
    setConditions(prev => prev.map((c, idx) => idx === i ? { ...c, [k]: v } : c));
  }

  function removeCondition(i) {
    setConditions(prev => prev.filter((_, idx) => idx !== i));
  }

  function handleSave() {
    onSave({
      ...form,
      conditions_json: JSON.stringify(conditions),
      trigger_config: JSON.stringify(triggerCfg),
      action_config: JSON.stringify(actionCfg)
    });
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initialRule?.id ? "Edit Rule" : "New Automation Rule"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2">
          <div className="space-y-3">
            <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">1 — Identity</h3>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Rule Name *</Label>
                <Input value={form.name} onChange={e => updateForm("name", e.target.value)} placeholder="e.g. Move to Onsite on Shoot Day" />
              </div>
              <div>
                <Label>Group</Label>
                <Select value={form.rule_group} onValueChange={v => updateForm("rule_group", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GROUPS.map(g => <SelectItem key={g.value} value={g.value}>{g.icon} {g.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority (1=highest)</Label>
                <Input type="number" min={1} max={100} value={form.priority} onChange={e => updateForm("priority", parseInt(e.target.value) || 50)} />
              </div>
              <div className="col-span-2">
                <Label>Description</Label>
                <Textarea value={form.description} onChange={e => updateForm("description", e.target.value)} rows={2} placeholder="What does this rule do?" />
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">2 — Trigger</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Trigger Type</Label>
                <Select value={form.trigger_type} onValueChange={v => { updateForm("trigger_type", v); setTriggerCfg({}); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRIGGER_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {form.trigger_type === "schedule_daily" && (
                <div>
                  <Label>Time (Sydney, 24h HH:MM)</Label>
                  <Input value={triggerCfg.time || ""} onChange={e => setTriggerCfg(p => ({ ...p, time: e.target.value }))} placeholder="09:00" />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">3 — Conditions</h3>
              <div className="flex items-center gap-2">
                <Select value={form.condition_logic} onValueChange={v => updateForm("condition_logic", v)}>
                  <SelectTrigger className="w-20 h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AND">ALL (AND)</SelectItem>
                    <SelectItem value="OR">ANY (OR)</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" onClick={addCondition}><Plus className="h-3 w-3 mr-1" />Add</Button>
              </div>
            </div>
            {conditions.length === 0 && (
              <p className="text-sm text-muted-foreground italic">No conditions — rule fires for ALL projects.</p>
            )}
            {conditions.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input className="flex-1 text-xs h-8" value={c.field} onChange={e => updateCondition(i, "field", e.target.value)} placeholder="field" />
                <Select value={c.operator} onValueChange={v => updateCondition(i, "operator", v)}>
                  <SelectTrigger className="w-40 h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {OPERATORS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                {!["is_set", "is_empty", "date_is_today", "date_is_past"].includes(c.operator) && (
                  <Input className="flex-1 text-xs h-8" value={c.value || ""} onChange={e => updateCondition(i, "value", e.target.value)} placeholder="value" />
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeCondition(i)} aria-label="Remove condition">
                  <XCircle className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">4 — Action</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Action Type</Label>
                <Select value={form.action_type} onValueChange={v => { updateForm("action_type", v); setActionCfg({}); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACTION_TYPES.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {form.action_type === "set_stage" && (
                <div>
                  <Label>Target Stage</Label>
                  <Select value={actionCfg.stage || ""} onValueChange={v => setActionCfg({ stage: v })}>
                    <SelectTrigger><SelectValue placeholder="Select stage" /></SelectTrigger>
                    <SelectContent>
                      {STAGE_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {form.action_type === "set_field" && (
                <>
                  <div>
                    <Label>Field Name</Label>
                    <Input value={actionCfg.field || ""} onChange={e => setActionCfg(p => ({ ...p, field: e.target.value }))} placeholder="e.g. urgent_review" />
                  </div>
                  <div className="col-span-2">
                    <Label>Value</Label>
                    <Input value={actionCfg.value !== undefined ? String(actionCfg.value) : ""} onChange={e => setActionCfg(p => ({ ...p, value: e.target.value }))} placeholder="e.g. true or some_text" />
                  </div>
                </>
              )}

              {form.action_type === "set_flag" && (
                <>
                  <div>
                    <Label>Flag Name</Label>
                    <Input value={actionCfg.flag || ""} onChange={e => setActionCfg(p => ({ ...p, flag: e.target.value }))} placeholder="e.g. urgent_review" />
                  </div>
                  <div>
                    <Label>Value</Label>
                    <Select value={String(actionCfg.value ?? "true")} onValueChange={v => setActionCfg(p => ({ ...p, value: v === "true" }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="true">true</SelectItem>
                        <SelectItem value="false">false</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              {(form.action_type === "add_activity_log" || form.action_type === "notify_roles") && (
                <div className="col-span-2">
                  <Label>Message</Label>
                  <Textarea value={actionCfg.message || ""} onChange={e => setActionCfg(p => ({ ...p, message: e.target.value }))} rows={2} placeholder="Message to log or send" />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3 border-t pt-4">
            <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wide">5 — Settings</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Cooldown (minutes)</Label>
                <Input type="number" min={0} value={form.cooldown_minutes} onChange={e => updateForm("cooldown_minutes", parseInt(e.target.value) || 60)} />
                <p className="text-xs text-muted-foreground mt-1">Prevents re-firing for same project within this window</p>
              </div>
              <div className="flex flex-col gap-3 pt-1">
                <div className="flex items-center gap-2">
                  <Switch checked={form.is_enabled} onCheckedChange={v => updateForm("is_enabled", v)} />
                  <Label>Enabled</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.dry_run_only} onCheckedChange={v => updateForm("dry_run_only", v)} />
                  <Label>Dry Run Only (logs but no changes)</Label>
                </div>
              </div>
              <div className="col-span-2">
                <Label>Admin Notes</Label>
                <Textarea value={form.notes || ""} onChange={e => updateForm("notes", e.target.value)} rows={1} placeholder="Internal notes about this rule" />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={!form.name.trim()}>
            {initialRule?.id ? "Save Changes" : "Create Rule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RuleCard({ rule, onToggle, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const gc = groupConfig(rule.rule_group);
  const triggerCfg = (() => { try { return JSON.parse(rule.trigger_config || "{}"); } catch { return {}; } })();
  const conditions = (() => { try { return JSON.parse(rule.conditions_json || "[]"); } catch { return []; } })();
  const actionCfg = (() => { try { return JSON.parse(rule.action_config || "{}"); } catch { return {}; } })();

  return (
    <Card className={`transition-all ${rule.is_enabled ? "" : "opacity-60"} ${rule.dry_run_only ? "border-purple-200" : ""}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <Switch checked={rule.is_enabled} onCheckedChange={v => onToggle(rule.id, v)} className="mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{rule.name}</span>
              <Badge className={`text-xs ${gc.color}`}>{gc.icon} {gc.label}</Badge>
              {rule.dry_run_only && <Badge className="text-xs bg-purple-100 text-purple-700">Dry Run</Badge>}
              {rule.is_system && <Badge className="text-xs bg-slate-100 text-slate-600">System</Badge>}
              <Badge className="text-xs bg-slate-100 text-slate-600">P{rule.priority}</Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{rule.description}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Zap className="h-3 w-3" />
                {TRIGGER_TYPES.find(t => t.value === rule.trigger_type)?.label || rule.trigger_type}
                {rule.trigger_type === "schedule_daily" && triggerCfg.time && ` @ ${triggerCfg.time}`}
              </span>
              <span className="flex items-center gap-1">
                <CheckCircle className="h-3 w-3 text-emerald-500" />
                {rule.fire_count || 0} fired
              </span>
              {rule.last_fired_at && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Last: {relTime(rule.last_fired_at)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(rule)} aria-label="Edit rule">
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
            {!rule.is_system && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDelete(rule)} aria-label="Delete rule">
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setExpanded(v => !v)} aria-label={expanded ? "Collapse rule details" : "Expand rule details"}>
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t space-y-3 text-xs">
            {conditions.length > 0 && (
              <div>
                <p className="font-semibold mb-1 text-muted-foreground">CONDITIONS ({rule.condition_logic})</p>
                {conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-1 text-xs mb-0.5">
                    <code className="bg-muted px-1 rounded">{c.field}</code>
                    <span className="text-muted-foreground">{OPERATORS.find(o => o.value === c.operator)?.label || c.operator}</span>
                    {c.value !== null && c.value !== undefined && c.value !== "" && (
                      <code className="bg-muted px-1 rounded">{String(c.value)}</code>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div>
              <p className="font-semibold mb-1 text-muted-foreground">ACTION</p>
              <p>{ACTION_TYPES.find(a => a.value === rule.action_type)?.label || rule.action_type}: {JSON.stringify(actionCfg)}</p>
            </div>
            {rule.notes && (
              <div>
                <p className="font-semibold mb-1 text-muted-foreground">NOTES</p>
                <p className="text-muted-foreground">{rule.notes}</p>
              </div>
            )}
            <div className="flex items-center gap-3 text-muted-foreground">
              <span>Cooldown: {rule.cooldown_minutes}min</span>
              <span>Skipped: {rule.skip_count || 0}</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsAutomationRules() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("rules");
  const [filterGroup, setFilterGroup] = useState("all");
  const [filterEnabled, setFilterEnabled] = useState("all");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [logFilter, setLogFilter] = useState("all");
  const [seedingRules, setSeedingRules] = useState(false);
  const [seedMessage, setSeedMessage] = useState(null);

  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ["automationRules"],
    queryFn: () => base44.entities.ProjectAutomationRule.list("-priority", 200),
    staleTime: 60 * 1000,
    onError: () => toast.error('Failed to load automation rules'),
  });

  const { data: logs = [], isLoading: logsLoading } = useQuery({
    queryKey: ["automationRuleLogs"],
    queryFn: () => base44.entities.AutomationRuleLog.list("-fired_at", 200),
    enabled: activeTab === "log",
    staleTime: 30 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: async (rule) => {
      if (rule.id) {
        return base44.entities.ProjectAutomationRule.update(rule.id, rule);
      } else {
        return base44.entities.ProjectAutomationRule.create({ ...rule, fire_count: 0, skip_count: 0 });
      }
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["automationRules"] }); setBuilderOpen(false); setEditingRule(null); },
    onError: (err) => toast.error(err?.message || 'Failed to save automation rule'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }) => base44.entities.ProjectAutomationRule.update(id, { is_enabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["automationRules"] }),
    onError: (err) => toast.error(err?.message || 'Failed to toggle rule'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.ProjectAutomationRule.delete(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["automationRules"] }); setDeleteTarget(null); },
    onError: (err) => toast.error(err?.message || 'Failed to delete rule'),
  });

  const filteredRules = useMemo(() => {
    return rules.filter(r => {
      if (filterGroup !== "all" && r.rule_group !== filterGroup) return false;
      if (filterEnabled === "enabled" && !r.is_enabled) return false;
      if (filterEnabled === "disabled" && r.is_enabled) return false;
      return true;
    });
  }, [rules, filterGroup, filterEnabled]);

  const groupedRules = useMemo(() => {
    const groups = {};
    for (const r of filteredRules) {
      const g = r.rule_group || "other";
      if (!groups[g]) groups[g] = [];
      groups[g].push(r);
    }
    return groups;
  }, [filteredRules]);

  const stats = useMemo(() => ({
    total: rules.length,
    enabled: rules.filter(r => r.is_enabled).length,
    total_fired: rules.reduce((s, r) => s + (r.fire_count || 0), 0),
    dry_run: rules.filter(r => r.dry_run_only).length
  }), [rules]);

  function handleEdit(rule) { setEditingRule(rule); setBuilderOpen(true); }
  function handleNew() { setEditingRule(null); setBuilderOpen(true); }

  async function handleSeedRules() {
    setSeedingRules(true);
    setSeedMessage(null);
    try {
      const res = await base44.functions.invoke('seedAutomationRules', {});
      if (res.data.error) {
        setSeedMessage({ type: 'error', text: res.data.error });
      } else {
        setSeedMessage({ type: 'success', text: `✅ ${res.data.message || 'Rules seeded successfully'}` });
        queryClient.invalidateQueries({ queryKey: ["automationRules"] });
      }
    } catch (err) {
      setSeedMessage({ type: 'error', text: `Failed to seed rules: ${err.message}` });
    } finally {
      setSeedingRules(false);
    }
  }

  const filteredLogs = useMemo(() => {
    if (logFilter === "all") return logs;
    return logs.filter(l => l.result === logFilter);
  }, [logs, logFilter]);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8 space-y-6 max-w-5xl">
        <div className="flex items-center gap-3">
          <Link to={createPageUrl("SettingsOrganisation")}>
            <Button variant="ghost" size="icon" aria-label="Back to settings"><ArrowLeft className="h-5 w-5" /></Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-3xl font-bold tracking-tight">Automation Rules</h1>
            <p className="text-muted-foreground mt-1">Configure automated actions that run against projects on a schedule or on change.</p>
          </div>
          <Button onClick={handleNew}><Plus className="h-4 w-4 mr-2" />New Rule</Button>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Card><CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold">{stats.total}</p>
            <p className="text-xs text-muted-foreground">Total Rules</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold text-emerald-600">{stats.enabled}</p>
            <p className="text-xs text-muted-foreground">Active</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold text-blue-600">{stats.total_fired}</p>
            <p className="text-xs text-muted-foreground">Total Actions Taken</p>
          </CardContent></Card>
          <Card><CardContent className="pt-4 pb-3">
            <p className="text-2xl font-bold text-purple-600">{stats.dry_run}</p>
            <p className="text-xs text-muted-foreground">Dry Run Mode</p>
          </CardContent></Card>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="rules">Rules</TabsTrigger>
            <TabsTrigger value="log">Execution Log</TabsTrigger>
          </TabsList>

          <TabsContent value="rules" className="mt-4 space-y-4">
            <div className="flex gap-2 flex-wrap">
              <Select value={filterGroup} onValueChange={setFilterGroup}>
                <SelectTrigger className="w-40"><SelectValue placeholder="All Groups" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Groups</SelectItem>
                  {GROUPS.map(g => <SelectItem key={g.value} value={g.value}>{g.icon} {g.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filterEnabled} onValueChange={setFilterEnabled}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Rules</SelectItem>
                  <SelectItem value="enabled">Enabled Only</SelectItem>
                  <SelectItem value="disabled">Disabled Only</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {rulesLoading ? (
              <p className="text-muted-foreground text-sm">Loading rules...</p>
            ) : Object.keys(groupedRules).length === 0 ? (
              <Card><CardContent className="py-12 text-center">
                <Zap className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                <p className="font-semibold">No rules found</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {rules.length === 0 ? "Seed the default automation rules or create your first custom rule." : "Create your first rule or adjust the filters above."}
                </p>
                {seedMessage && (
                  <p className={`text-sm mt-3 ${seedMessage.type === 'error' ? 'text-red-600' : 'text-green-600'}`}>
                    {seedMessage.text}
                  </p>
                )}
                <div className="flex gap-2 justify-center mt-4">
                  {rules.length === 0 && (
                    <Button onClick={handleSeedRules} disabled={seedingRules} variant="default">
                      {seedingRules ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
                      {seedingRules ? "Seeding..." : "Seed Default Rules"}
                    </Button>
                  )}
                  <Button variant="outline" onClick={handleNew}><Plus className="h-4 w-4 mr-2" />New Rule</Button>
                </div>
              </CardContent></Card>
            ) : (
              Object.entries(groupedRules).sort(([a], [b]) => a.localeCompare(b)).map(([group, groupRules]) => {
                const gc = groupConfig(group);
                return (
                  <div key={group}>
                    <div className="flex items-center gap-2 mb-2">
                      <Badge className={`${gc.color}`}>{gc.icon} {gc.label}</Badge>
                      <span className="text-xs text-muted-foreground">{groupRules.length} rule{groupRules.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div className="space-y-2">
                      {groupRules.sort((a, b) => (a.priority || 50) - (b.priority || 50)).map(rule => (
                        <RuleCard
                          key={rule.id}
                          rule={rule}
                          onToggle={(id, enabled) => toggleMutation.mutate({ id, enabled })}
                          onEdit={handleEdit}
                          onDelete={setDeleteTarget}
                        />
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </TabsContent>

          <TabsContent value="log" className="mt-4 space-y-3">
            <div className="flex gap-2">
              <Select value={logFilter} onValueChange={setLogFilter}>
                <SelectTrigger className="w-48"><SelectValue placeholder="All Results" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Results</SelectItem>
                  <SelectItem value="executed">Executed</SelectItem>
                  <SelectItem value="skipped_conditions">Skipped (Conditions)</SelectItem>
                  <SelectItem value="skipped_cooldown">Skipped (Cooldown)</SelectItem>
                  <SelectItem value="skipped_dry_run">Dry Run</SelectItem>
                  <SelectItem value="error">Errors</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {logsLoading ? (
              <p className="text-sm text-muted-foreground">Loading logs...</p>
            ) : filteredLogs.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No log entries yet.</CardContent></Card>
            ) : (
              <div className="space-y-2">
                {filteredLogs.map(log => (
                  <Card key={log.id} className="p-0">
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge className={`text-xs ${RESULT_COLORS[log.result] || "bg-slate-100 text-slate-600"}`}>
                              {log.result}
                            </Badge>
                            <span className="text-sm font-medium truncate">{log.rule_name}</span>
                            {log.dry_run && <Badge className="text-xs bg-purple-100 text-purple-700">dry run</Badge>}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Project: <span className="font-medium">{log.project_name || log.project_id}</span>
                          </p>
                          {log.action_taken && (
                            <p className="text-xs mt-0.5 text-slate-700">{log.action_taken}</p>
                          )}
                          {log.result_detail && (
                            <p className="text-xs mt-0.5 text-red-600">{log.result_detail}</p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">{relTime(log.fired_at)}</span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        {builderOpen && (
          <RuleBuilderModal
            open={builderOpen}
            onClose={() => { setBuilderOpen(false); setEditingRule(null); }}
            initialRule={editingRule}
            onSave={rule => saveMutation.mutate(rule)}
          />
        )}

        <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Rule?</AlertDialogTitle>
              <AlertDialogDescription>
                "{deleteTarget?.name}" will be permanently deleted. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive" onClick={() => deleteMutation.mutate(deleteTarget.id)}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </PermissionGuard>
  );
}