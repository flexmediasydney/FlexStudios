/**
 * SettingsEmailSyncHealth
 *
 * Admin-only page that surfaces per-account Gmail sync health so broken syncs
 * can't stay invisible. Reads from `email_accounts` fields:
 *   sync_health, sync_error_count, last_sync_error, last_sync, last_full_sync_at,
 *   total_synced_count, sync_start_date, is_active, refresh_token,
 *   last_sync_mode, last_sync_message_count, sync_status
 *
 * Also pulls a per-account 24h ingestion count from `email_messages.created_at`
 * as an additional health signal (since no dedicated sync log table exists).
 *
 * Inline actions per account:
 *   - Sync Now        → syncGmailMessagesForAccount { accountId, userId }
 *   - Backfill Links  → backfillEmailLinks { emailAccountId }
 *   - Extend History  → extendEmailHistory { emailAccountId, days: 30 }
 *   - Disconnect      → EmailAccount.update(id, { is_active: false })
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { formatDistanceToNow, format } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { toast } from "sonner";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Mail, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Clock,
  History, Link2, PlugZap, Inbox, Loader2, Database, Activity, ShieldAlert,
} from "lucide-react";

// ── helpers ──────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return null;
  try {
    return formatDistanceToNow(new Date(fixTimestamp(ts)), { addSuffix: true });
  } catch {
    return null;
  }
}

function absTime(ts) {
  if (!ts) return null;
  try {
    return format(new Date(fixTimestamp(ts)), "PPpp");
  } catch {
    return null;
  }
}

function fmtNum(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

function fmtDate(ts) {
  if (!ts) return "—";
  try {
    return format(new Date(fixTimestamp(ts)), "MMM d, yyyy");
  } catch {
    return "—";
  }
}

/**
 * Compute health bucket for an account.
 * Returns { level: 'healthy' | 'warning' | 'error' | 'inactive', reason }
 */
function computeHealth(account) {
  if (!account.is_active) {
    return { level: "inactive", reason: "Account disconnected" };
  }
  if (!account.refresh_token) {
    return { level: "error", reason: "OAuth token missing — reconnect required" };
  }
  const errCount = Number(account.sync_error_count || 0);
  const health = String(account.sync_health || "").toLowerCase();

  if (health === "error" || errCount >= 3) {
    return { level: "error", reason: account.last_sync_error || `${errCount} sync errors` };
  }
  if (health === "warning" || errCount > 0) {
    return { level: "warning", reason: account.last_sync_error || `${errCount} recent error${errCount !== 1 ? "s" : ""}` };
  }

  // Staleness check — no sync in >2h is suspicious for an active account
  if (account.last_sync) {
    try {
      const ageMs = Date.now() - new Date(fixTimestamp(account.last_sync)).getTime();
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const ONE_DAY = 24 * 60 * 60 * 1000;
      if (ageMs > ONE_DAY) {
        return { level: "error", reason: `No sync in ${Math.floor(ageMs / ONE_DAY)}d — scheduler may be stuck` };
      }
      if (ageMs > TWO_HOURS) {
        return { level: "warning", reason: `Last sync ${Math.floor(ageMs / (60 * 60 * 1000))}h ago — expected every ~15 min` };
      }
    } catch { /* no-op */ }
  } else {
    return { level: "warning", reason: "Never synced" };
  }

  return { level: "healthy", reason: "Syncing normally" };
}

const HEALTH_STYLES = {
  healthy:  { badgeCls: "bg-green-100 text-green-700 border-green-200",   icon: CheckCircle2,  iconCls: "text-green-600"  },
  warning:  { badgeCls: "bg-amber-100 text-amber-800 border-amber-200",   icon: AlertTriangle, iconCls: "text-amber-600"  },
  error:    { badgeCls: "bg-red-100 text-red-700 border-red-200",         icon: XCircle,       iconCls: "text-red-600"    },
  inactive: { badgeCls: "bg-gray-100 text-gray-600 border-gray-200",      icon: Inbox,         iconCls: "text-gray-500"   },
};

// ── stat card ────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, tone = "default", sublabel }) {
  const toneCls = {
    default: "bg-card border-border",
    green:   "bg-green-50 border-green-200 text-green-900",
    amber:   "bg-amber-50 border-amber-200 text-amber-900",
    red:     "bg-red-50 border-red-200 text-red-900",
    blue:    "bg-blue-50 border-blue-200 text-blue-900",
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${toneCls}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium opacity-70 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
          {sublabel && <p className="text-[11px] opacity-70 mt-0.5">{sublabel}</p>}
        </div>
        {Icon && <Icon className="h-5 w-5 opacity-60 flex-shrink-0" />}
      </div>
    </div>
  );
}

// ── account card ─────────────────────────────────────────────────

function AccountCard({ account, ingested24h, onAction, pendingAction }) {
  const health = computeHealth(account);
  const HStyle = HEALTH_STYLES[health.level];
  const HIcon = HStyle.icon;

  const lastSyncRel = relTime(account.last_sync);
  const lastFullRel = relTime(account.last_full_sync_at);

  const isBusy = pendingAction?.accountId === account.id;
  const busyAction = isBusy ? pendingAction.action : null;

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <CardTitle className="text-base font-semibold truncate" title={account.email_address}>
                {account.email_address}
              </CardTitle>
            </div>
            {account.display_name && account.display_name !== account.email_address && (
              <CardDescription className="text-xs mt-1 ml-6 truncate">
                {account.display_name}
              </CardDescription>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <Badge
              variant="outline"
              className={`gap-1 ${HStyle.badgeCls}`}
              title={health.reason}
            >
              <HIcon className={`h-3 w-3 ${HStyle.iconCls}`} />
              {health.level.toUpperCase()}
            </Badge>
            <Badge
              variant="outline"
              className={
                account.is_active
                  ? "text-[10px] border-green-200 bg-green-50 text-green-700"
                  : "text-[10px] border-gray-200 bg-gray-50 text-gray-600"
              }
            >
              {account.is_active ? "connected" : "disconnected"}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3 pb-4">
        {/* Metrics grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Last sync</p>
            <p className="font-medium" title={absTime(account.last_sync) || ""}>
              {lastSyncRel || <span className="text-muted-foreground">never</span>}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Last full sync</p>
            <p className="font-medium" title={absTime(account.last_full_sync_at) || ""}>
              {lastFullRel || <span className="text-muted-foreground">never</span>}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Total synced</p>
            <p className="font-medium tabular-nums">{fmtNum(account.total_synced_count)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Synced (24h)</p>
            <p className="font-medium tabular-nums">
              {fmtNum(ingested24h)}
              {account.last_sync_message_count != null && (
                <span className="text-xs text-muted-foreground ml-1.5">
                  · last batch: {fmtNum(account.last_sync_message_count)}
                </span>
              )}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Sync since</p>
            <p className="font-medium">{fmtDate(account.sync_start_date)}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase text-muted-foreground font-medium tracking-wide">Errors</p>
            <p className={`font-medium tabular-nums ${Number(account.sync_error_count) > 0 ? "text-red-600" : ""}`}>
              {fmtNum(account.sync_error_count || 0)}
              {account.last_sync_mode && (
                <span className="text-xs text-muted-foreground ml-1.5 font-normal">· {account.last_sync_mode}</span>
              )}
            </p>
          </div>
        </div>

        {/* Error block */}
        {account.last_sync_error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2.5">
            <div className="flex items-start gap-2">
              <ShieldAlert className="h-3.5 w-3.5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-red-800 uppercase tracking-wide">Last sync error</p>
                <p className="text-xs text-red-700 mt-0.5 break-words line-clamp-3 font-mono">
                  {account.last_sync_error}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Healthy-but-idle or warning context line */}
        {!account.last_sync_error && health.level !== "healthy" && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            {health.reason}
          </div>
        )}

        <Separator />

        {/* Actions row */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="default"
            className="gap-1.5 h-8 text-xs"
            onClick={() => onAction("sync", account)}
            disabled={!account.is_active || isBusy}
          >
            {busyAction === "sync"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <RefreshCw className="h-3.5 w-3.5" />}
            Sync Now
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8 text-xs"
            onClick={() => onAction("backfill", account)}
            disabled={!account.is_active || isBusy}
            title="Re-resolve agent/agency/project links for all messages on this account"
          >
            {busyAction === "backfill"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Link2 className="h-3.5 w-3.5" />}
            Backfill Links
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8 text-xs"
            onClick={() => onAction("extend", account)}
            disabled={!account.is_active || isBusy}
            title="Pull 30 days of older emails than what's currently stored"
          >
            {busyAction === "extend"
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <History className="h-3.5 w-3.5" />}
            Extend History
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                disabled={!account.is_active || isBusy}
              >
                <PlugZap className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Disconnect {account.email_address}?</AlertDialogTitle>
              <AlertDialogDescription>
                Syncing will stop for this account. Previously synced emails stay in your inbox.
                You can reconnect from the Email Sync settings at any time.
              </AlertDialogDescription>
              <div className="flex justify-end gap-2 mt-4">
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive hover:bg-destructive/90"
                  onClick={() => onAction("disconnect", account)}
                >
                  Disconnect
                </AlertDialogAction>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>
    </Card>
  );
}

// ── recent activity panel ────────────────────────────────────────

function RecentActivityPanel({ accounts }) {
  // Pull the 20 most recently ingested email_messages as a proxy for "sync log"
  // Joined in-memory with accounts to show sender + which account.
  const { data: recentMessages = [], isLoading } = useQuery({
    queryKey: ["sync-health-recent-messages"],
    queryFn: async () => {
      return await api.entities.EmailMessage.list("-created_at", 20);
    },
    staleTime: 30_000,
  });

  const accountById = useMemo(() => {
    const m = new Map();
    for (const a of accounts) m.set(a.id, a);
    return m;
  }, [accounts]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Recent sync activity
        </CardTitle>
        <CardDescription>
          Last 20 messages ingested across all accounts (proxy for per-batch sync log)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : recentMessages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">No messages ingested yet.</p>
        ) : (
          <div className="divide-y">
            {recentMessages.map((m) => {
              const acct = accountById.get(m.email_account_id);
              return (
                <div key={m.id} className="py-2 flex items-start gap-3 text-xs">
                  <div className="w-36 flex-shrink-0">
                    <p className="font-mono text-[10px] text-muted-foreground" title={absTime(m.created_at) || ""}>
                      {relTime(m.created_at) || "—"}
                    </p>
                  </div>
                  <div className="w-40 flex-shrink-0">
                    <p className="font-medium truncate" title={acct?.email_address || m.email_account_id}>
                      {acct?.email_address || <span className="text-muted-foreground">(unknown account)</span>}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate">
                      <span className="text-muted-foreground">from </span>
                      <span className="font-medium">{m.from_name || m.from || "unknown"}</span>
                    </p>
                    <p className="truncate text-muted-foreground">{m.subject || "(no subject)"}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── page ──────────────────────────────────────────────────────────

export default function SettingsEmailSyncHealth() {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [pendingAction, setPendingAction] = useState(null); // { accountId, action }

  // All accounts — admins see everything
  const {
    data: accounts = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["email-accounts-sync-health"],
    queryFn: () => api.entities.EmailAccount.list("email_address", 200),
    staleTime: 15_000,
  });

  // 24h ingestion rate per account via a scoped list of recent messages
  // (we intentionally keep this cheap — 500 rows is plenty to compute per-account counts for 5-10 accts)
  const { data: recentMessages = [] } = useQuery({
    queryKey: ["email-messages-24h-counts"],
    queryFn: async () => {
      // Filter by created_at > now - 24h isn't trivial via entity client; instead
      // pull the last 500 messages sorted desc and cutoff client-side.
      return await api.entities.EmailMessage.list("-created_at", 500);
    },
    staleTime: 30_000,
  });

  const ingest24hByAccount = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const map = new Map();
    for (const m of recentMessages) {
      const ts = m.created_at ? new Date(fixTimestamp(m.created_at)).getTime() : 0;
      if (!ts || ts < cutoff) continue;
      map.set(m.email_account_id, (map.get(m.email_account_id) || 0) + 1);
    }
    return map;
  }, [recentMessages]);

  // Aggregate stats for top strip
  const stats = useMemo(() => {
    const s = { total: 0, healthy: 0, warning: 0, error: 0, inactive: 0, totalSynced: 0, ingested24h: 0 };
    for (const a of accounts) {
      s.total += 1;
      s.totalSynced += Number(a.total_synced_count || 0);
      const h = computeHealth(a);
      s[h.level] += 1;
    }
    for (const v of ingest24hByAccount.values()) s.ingested24h += v;
    return s;
  }, [accounts, ingest24hByAccount]);

  // ── Mutations ──
  const syncMutation = useMutation({
    mutationFn: async (account) => {
      setPendingAction({ accountId: account.id, action: "sync" });
      // Sync Health page is an admin tool — must pass the ACCOUNT's assigned user,
      // not the current admin's user id. The edge function does
      //   .filter({ id: accountId, assigned_to_user_id: userId, is_active: true })
      // so passing the admin's id on an account they don't own returns empty,
      // which is why the button was returning "Account not found or inactive".
      const res = await api.functions.invoke("syncGmailMessagesForAccount", {
        accountId: account.id,
        userId: account.assigned_to_user_id,
      });
      if (res?.data?.error) throw new Error(res.data.error);
      return res?.data;
    },
    onSuccess: (data, account) => {
      const n = data?.synced ?? 0;
      toast.success(
        n > 0
          ? `Synced ${n} new email${n !== 1 ? "s" : ""} for ${account.email_address}`
          : `${account.email_address} already up to date`
      );
      queryClient.invalidateQueries({ queryKey: ["email-accounts-sync-health"] });
      queryClient.invalidateQueries({ queryKey: ["email-messages-24h-counts"] });
      queryClient.invalidateQueries({ queryKey: ["sync-health-recent-messages"] });
    },
    onError: (err, account) => {
      console.error("[SyncHealth] sync error", err);
      toast.error(`Sync failed for ${account.email_address}: ${err.message || "unknown error"}`);
    },
    onSettled: () => setPendingAction(null),
  });

  const backfillMutation = useMutation({
    mutationFn: async (account) => {
      setPendingAction({ accountId: account.id, action: "backfill" });
      const res = await api.functions.invoke("backfillEmailLinks", {
        emailAccountId: account.id,
      });
      if (res?.data?.error) throw new Error(res.data.error);
      return res?.data;
    },
    onSuccess: (data, account) => {
      const scanned = data?.scanned ?? 0;
      const changed = (data?.linkedFresh ?? 0) + (data?.linkChanged ?? 0);
      toast.success(`Backfill done for ${account.email_address}: scanned ${scanned}, updated ${changed}`);
      queryClient.invalidateQueries({ queryKey: ["email-accounts-sync-health"] });
    },
    onError: (err, account) => {
      console.error("[SyncHealth] backfill error", err);
      toast.error(`Backfill failed for ${account.email_address}: ${err.message || "unknown error"}`);
    },
    onSettled: () => setPendingAction(null),
  });

  const extendMutation = useMutation({
    mutationFn: async (account) => {
      setPendingAction({ accountId: account.id, action: "extend" });
      const res = await api.functions.invoke("extendEmailHistory", {
        emailAccountId: account.id,
        days: 30,
      });
      if (res?.data?.error) throw new Error(res.data.error);
      return res?.data;
    },
    onSuccess: (data, account) => {
      const n = data?.inserted ?? data?.synced ?? 0;
      toast.success(
        n > 0
          ? `Pulled ${n} older email${n !== 1 ? "s" : ""} for ${account.email_address}`
          : `No older emails found for ${account.email_address} in the 30-day window`
      );
      queryClient.invalidateQueries({ queryKey: ["email-accounts-sync-health"] });
    },
    onError: (err, account) => {
      console.error("[SyncHealth] extend error", err);
      toast.error(`Extend history failed for ${account.email_address}: ${err.message || "unknown error"}`);
    },
    onSettled: () => setPendingAction(null),
  });

  const disconnectMutation = useMutation({
    mutationFn: (account) =>
      api.entities.EmailAccount.update(account.id, { is_active: false }),
    onSuccess: (_, account) => {
      toast.success(`${account.email_address} disconnected`);
      queryClient.invalidateQueries({ queryKey: ["email-accounts-sync-health"] });
    },
    onError: (err, account) => {
      console.error("[SyncHealth] disconnect error", err);
      toast.error(`Failed to disconnect ${account.email_address}`);
    },
  });

  const handleAction = (action, account) => {
    if (action === "sync")       syncMutation.mutate(account);
    else if (action === "backfill")   backfillMutation.mutate(account);
    else if (action === "extend")     extendMutation.mutate(account);
    else if (action === "disconnect") disconnectMutation.mutate(account);
  };

  // ── render ──
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading accounts…
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <Activity className="h-6 w-6" />
              Email Sync Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Per-account Gmail sync status. Catches broken OAuth, stuck schedulers, and silent failures
              before they turn into weeks of missing emails.
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => {
                  refetch();
                  queryClient.invalidateQueries({ queryKey: ["email-messages-24h-counts"] });
                  queryClient.invalidateQueries({ queryKey: ["sync-health-recent-messages"] });
                  toast.success("Refreshed");
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </Button>
            </TooltipTrigger>
            <TooltipContent>Reloads metrics from the database</TooltipContent>
          </Tooltip>
        </div>

        {/* Top stat strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Connected accounts"
            value={stats.total}
            icon={Mail}
            sublabel={`${stats.total - stats.inactive} active · ${stats.inactive} disconnected`}
          />
          <StatCard
            label="Healthy"
            value={stats.healthy}
            icon={CheckCircle2}
            tone={stats.healthy === (stats.total - stats.inactive) && stats.total > 0 ? "green" : "default"}
          />
          <StatCard
            label="Warning / error"
            value={stats.warning + stats.error}
            icon={AlertTriangle}
            tone={stats.warning + stats.error > 0 ? (stats.error > 0 ? "red" : "amber") : "default"}
            sublabel={stats.error > 0 ? `${stats.error} in error state` : undefined}
          />
          <StatCard
            label="Total emails synced"
            value={fmtNum(stats.totalSynced)}
            icon={Database}
            tone="blue"
            sublabel={`${fmtNum(stats.ingested24h)} in last 24h`}
          />
        </div>

        {/* Accounts grid */}
        {accounts.length === 0 ? (
          <Card>
            <CardContent className="py-16 flex flex-col items-center gap-3 text-muted-foreground">
              <Mail className="h-10 w-10" />
              <p className="text-sm">No Gmail accounts connected yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {accounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                ingested24h={ingest24hByAccount.get(a.id) || 0}
                onAction={handleAction}
                pendingAction={pendingAction}
              />
            ))}
          </div>
        )}

        {/* Recent activity diagnostic */}
        <RecentActivityPanel accounts={accounts} />

        <div className="text-[11px] text-muted-foreground text-center pt-2 flex items-center justify-center gap-1.5">
          <Clock className="h-3 w-3" />
          Gmail scheduler runs every ~15 minutes. Health = healthy when last_sync is under 2h old and
          sync_error_count is 0.
        </div>
      </div>
    </TooltipProvider>
  );
}
