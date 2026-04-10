/**
 * SettingsAI.jsx — AI assistant configuration page.
 *
 * Sections:
 *   1. Admin Controls (master_admin only) — master switch, daily limit, etc.
 *   2. Per-User Overrides (master_admin only) — table of user-level limits.
 *   3. My Preferences (all users) — voice input, TTS, auto-execute toggle.
 */

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, Save, Shield, Users, UserCog, Loader2 } from "lucide-react";
import { toast } from "sonner";

// ── Helpers ─────────────────────────────────────────────────────────────────

const CONFIRMATION_LEVELS = [
  { value: "all", label: "Confirm all actions" },
  { value: "destructive", label: "Confirm destructive only" },
  { value: "none", label: "No confirmation required" },
];

// ── Component ───────────────────────────────────────────────────────────────

export default function SettingsAI() {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const isMasterAdmin = user?.role === "master_admin";

  // ── Load global AI settings ─────────────────────────────────────────────

  const { data: aiSettings = [], isLoading: settingsLoading } = useQuery({
    queryKey: ["aiSettings"],
    queryFn: () => api.entities.AiSetting.list(),
  });

  // Derive current global config (first row, or defaults)
  const globalConfig = useMemo(() => {
    const s = aiSettings[0] || {};
    return {
      id: s.id || null,
      ai_enabled: s.ai_enabled ?? true,
      default_daily_limit: s.default_daily_limit ?? 50,
      confirmation_level: s.confirmation_level ?? "destructive",
      voice_enabled: s.voice_enabled ?? true,
      cost_budget_daily: s.cost_budget_daily ?? 5.0,
    };
  }, [aiSettings]);

  // Local editable state for global config
  const [globalForm, setGlobalForm] = useState(null);
  const activeGlobal = globalForm ?? globalConfig;

  // Reset form when loaded data changes
  const updateGlobalField = (field, value) => {
    setGlobalForm((prev) => ({ ...(prev ?? globalConfig), [field]: value }));
  };

  // ── Load users for per-user overrides ───────────────────────────────────

  const { data: users = [] } = useQuery({
    queryKey: ["users-ai-settings"],
    queryFn: () => api.entities.User.list("full_name"),
    enabled: isMasterAdmin,
  });

  const { data: userOverrides = [], isLoading: overridesLoading } = useQuery({
    queryKey: ["aiUserOverrides"],
    queryFn: () => api.entities.AiUserOverride.list().catch(() => []),
    enabled: isMasterAdmin,
  });

  // Map overrides by user_id for quick lookup
  const overrideMap = useMemo(() => {
    const map = {};
    for (const o of userOverrides) {
      map[o.user_id] = o;
    }
    return map;
  }, [userOverrides]);

  // ── Load personal preferences ───────────────────────────────────────────

  const { data: myPrefs = [], isLoading: prefsLoading } = useQuery({
    queryKey: ["aiMyPrefs", user?.id],
    queryFn: () => api.entities.AiUserPreference.filter({ user_id: user.id }).catch(() => []),
    enabled: !!user?.id,
  });

  const myPref = useMemo(() => {
    const p = myPrefs[0] || {};
    return {
      id: p.id || null,
      voice_input: p.voice_input ?? true,
      tts_enabled: p.tts_enabled ?? false,
      auto_execute_safe: p.auto_execute_safe ?? false,
    };
  }, [myPrefs]);

  const [prefForm, setPrefForm] = useState(null);
  const activePref = prefForm ?? myPref;

  const updatePrefField = (field, value) => {
    setPrefForm((prev) => ({ ...(prev ?? myPref), [field]: value }));
  };

  // ── Mutations ───────────────────────────────────────────────────────────

  const saveGlobalMutation = useMutation({
    mutationFn: async (data) => {
      const { id, ...rest } = data;
      if (id) {
        return api.entities.AiSetting.update(id, rest);
      }
      return api.entities.AiSetting.create(rest);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["aiSettings"] });
      setGlobalForm(null);
      toast.success("AI settings saved.");
    },
    onError: (err) => toast.error(`Failed to save: ${err.message}`),
  });

  const savePrefMutation = useMutation({
    mutationFn: async (data) => {
      const { id, ...rest } = data;
      rest.user_id = user.id;
      if (id) {
        return api.entities.AiUserPreference.update(id, rest);
      }
      return api.entities.AiUserPreference.create(rest);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["aiMyPrefs", user?.id] });
      setPrefForm(null);
      toast.success("Preferences saved.");
    },
    onError: (err) => toast.error(`Failed to save: ${err.message}`),
  });

  const saveOverrideMutation = useMutation({
    mutationFn: async ({ userId, data }) => {
      const existing = overrideMap[userId];
      if (existing) {
        return api.entities.AiUserOverride.update(existing.id, data);
      }
      return api.entities.AiUserOverride.create({ user_id: userId, ...data });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["aiUserOverrides"] });
      toast.success("User override saved.");
    },
    onError: (err) => toast.error(`Failed to save override: ${err.message}`),
  });

  // ── Loading state ───────────────────────────────────────────────────────

  if (settingsLoading || prefsLoading) {
    return (
      <div className="p-6 lg:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-8">
      {/* Page header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <Sparkles className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold tracking-tight">AI Settings</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Configure the AI assistant for your organisation.
        </p>
      </div>

      {/* ── Section 1: Admin Controls ────────────────────────────────────── */}
      {isMasterAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-lg">Admin Controls</CardTitle>
                <CardDescription>Global AI assistant configuration</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Master Switch */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">AI Assistant Enabled</Label>
                <p className="text-xs text-muted-foreground">Master switch for the entire organisation</p>
              </div>
              <Switch
                checked={activeGlobal.ai_enabled}
                onCheckedChange={(v) => updateGlobalField("ai_enabled", v)}
              />
            </div>

            {/* Default Daily Limit */}
            <div className="space-y-2">
              <Label htmlFor="daily-limit" className="text-sm font-medium">Default Daily Limit</Label>
              <p className="text-xs text-muted-foreground">Maximum AI requests per user per day</p>
              <Input
                id="daily-limit"
                type="number"
                min={1}
                max={500}
                value={activeGlobal.default_daily_limit}
                onChange={(e) => updateGlobalField("default_daily_limit", parseInt(e.target.value, 10) || 50)}
                className="w-32"
              />
            </div>

            {/* Confirmation Level */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Confirmation Level</Label>
              <p className="text-xs text-muted-foreground">When to require user confirmation before executing</p>
              <Select
                value={activeGlobal.confirmation_level}
                onValueChange={(v) => updateGlobalField("confirmation_level", v)}
              >
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONFIRMATION_LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Voice Enabled */}
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-sm font-medium">Voice Input Enabled</Label>
                <p className="text-xs text-muted-foreground">Allow voice input across the organisation</p>
              </div>
              <Switch
                checked={activeGlobal.voice_enabled}
                onCheckedChange={(v) => updateGlobalField("voice_enabled", v)}
              />
            </div>

            {/* Cost Budget */}
            <div className="space-y-2">
              <Label htmlFor="cost-budget" className="text-sm font-medium">Daily Cost Budget</Label>
              <p className="text-xs text-muted-foreground">Maximum AI spend per day (AUD)</p>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  id="cost-budget"
                  type="number"
                  min={0}
                  step={0.5}
                  value={activeGlobal.cost_budget_daily}
                  onChange={(e) => updateGlobalField("cost_budget_daily", parseFloat(e.target.value) || 5.0)}
                  className="w-32"
                />
                <span className="text-xs text-muted-foreground">/day</span>
              </div>
            </div>

            {/* Save */}
            <Button
              onClick={() => saveGlobalMutation.mutate(activeGlobal)}
              disabled={saveGlobalMutation.isPending}
            >
              {saveGlobalMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Admin Settings
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Section 2: Per-User Overrides ────────────────────────────────── */}
      {isMasterAdmin && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <CardTitle className="text-lg">Per-User Overrides</CardTitle>
                <CardDescription>Set custom AI limits for individual users</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {overridesLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No users found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-2 pr-4 font-medium text-muted-foreground">User</th>
                      <th className="py-2 pr-4 font-medium text-muted-foreground">Limit</th>
                      <th className="py-2 pr-4 font-medium text-muted-foreground">Actions</th>
                      <th className="py-2 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.filter(u => u.is_active !== false).map((u) => {
                      const override = overrideMap[u.id] || {};
                      return (
                        <UserOverrideRow
                          key={u.id}
                          userRecord={u}
                          override={override}
                          defaultLimit={activeGlobal.default_daily_limit}
                          onSave={(data) => saveOverrideMutation.mutate({ userId: u.id, data })}
                          isSaving={saveOverrideMutation.isPending}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Section 3: My Preferences ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            <div>
              <CardTitle className="text-lg">My Preferences</CardTitle>
              <CardDescription>Personal AI assistant settings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Voice Input */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Voice Input</Label>
              <p className="text-xs text-muted-foreground">Enable microphone for voice commands</p>
            </div>
            <Switch
              checked={activePref.voice_input}
              onCheckedChange={(v) => updatePrefField("voice_input", v)}
            />
          </div>

          {/* Read Responses Aloud */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Read Responses Aloud</Label>
              <p className="text-xs text-muted-foreground">Text-to-speech for AI responses</p>
            </div>
            <Switch
              checked={activePref.tts_enabled}
              onCheckedChange={(v) => updatePrefField("tts_enabled", v)}
            />
          </div>

          {/* Auto-execute safe actions */}
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Auto-Execute Safe Actions</Label>
              <p className="text-xs text-muted-foreground">Skip confirmation for low-risk actions (e.g. adding notes)</p>
            </div>
            <Switch
              checked={activePref.auto_execute_safe}
              onCheckedChange={(v) => updatePrefField("auto_execute_safe", v)}
            />
          </div>

          {/* Save */}
          <Button
            onClick={() => savePrefMutation.mutate(activePref)}
            disabled={savePrefMutation.isPending}
          >
            {savePrefMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Preferences
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Per-User Override Row ────────────────────────────────────────────────────

function UserOverrideRow({ userRecord, override, defaultLimit, onSave, isSaving }) {
  const [limit, setLimit] = useState(override.daily_limit ?? defaultLimit);
  const [actions, setActions] = useState(override.allowed_actions ?? "all");
  const isActive = override.is_active !== false;
  const hasOverride = !!override.id;

  return (
    <tr className="border-b last:border-0">
      <td className="py-2.5 pr-4">
        <div className="flex items-center gap-2">
          <span className="font-medium">{userRecord.full_name}</span>
          {hasOverride && (
            <Badge variant="secondary" className="text-[10px]">Custom</Badge>
          )}
        </div>
      </td>
      <td className="py-2.5 pr-4">
        <Input
          type="number"
          min={0}
          max={500}
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10) || defaultLimit)}
          className="w-20 h-8 text-sm"
        />
      </td>
      <td className="py-2.5 pr-4">
        <Select value={actions} onValueChange={setActions}>
          <SelectTrigger className="w-28 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="read_only">Read Only</SelectItem>
            <SelectItem value="none">None</SelectItem>
          </SelectContent>
        </Select>
      </td>
      <td className="py-2.5">
        <div className="flex items-center gap-2">
          <Badge variant={isActive ? "default" : "secondary"} className="text-[10px]">
            {isActive ? "Active" : "Disabled"}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onSave({ daily_limit: limit, allowed_actions: actions, is_active: true })}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          </Button>
        </div>
      </td>
    </tr>
  );
}
