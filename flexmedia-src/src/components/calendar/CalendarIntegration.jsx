import { useState, useEffect, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, RefreshCw, Loader2, CalendarDays, CheckCircle, AlertCircle, Clock } from "lucide-react";
import { toast } from "sonner";

// Auto-sync interval — 5 minutes (fast enough for RSVP and reschedule pickup)
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;

export default function CalendarIntegration({ selectedUserEmail, onConnectionsChange, compact = false }) {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null); // { created, updated, accounts, errors }
  const [isConnecting, setIsConnecting] = useState(false);
  const autoSyncRef = useRef(null);
  const { data: currentUser } = useCurrentUser();
  const [deleteConfirm, setDeleteConfirm] = useState(null); // { id, email, eventCount }
  const [deletingEvents, setDeletingEvents] = useState(false);

  const { data: connections = [], isLoading } = useQuery({
    queryKey: ["calendar-connections", selectedUserEmail],
    queryFn: () => selectedUserEmail
      ? api.entities.CalendarConnection.filter({ created_by: selectedUserEmail })
      : api.entities.CalendarConnection.list(),
    staleTime: 60_000,
  });

  const isAdmin = currentUser?.role === 'master_admin' || currentUser?.role === 'admin';
  const connectionLimit = isAdmin ? 5 : 2;
  // When viewing another user's connections (admin panel), use their email's connections
  const myConnections = selectedUserEmail
    ? connections  // already filtered to that user
    : connections.filter(c => c.created_by === currentUser?.email);
  const atLimit = myConnections.length >= connectionLimit;

  useEffect(() => {
    if (onConnectionsChange) onConnectionsChange(connections);
  }, [connections]);

  // Gap fix: Only auto-sync if tab is active + retry failed syncs
  const [syncAttempts, setSyncAttempts] = useState(0);
  const MAX_RETRY_ATTEMPTS = 3;
  
  useEffect(() => {
    const enabledConnections = connections.filter(c => c.is_enabled);
    if (enabledConnections.length === 0) return;

    let cancelled = false;

    const runAutoSync = async () => {
      if (cancelled || document.hidden) return; // Gap fix: Don't sync if tab inactive
      const stillEnabled = connections.filter(c => c.is_enabled);
      if (stillEnabled.length === 0) return;
      try {
        await api.asServiceRole.functions.invoke('syncGoogleCalendar', {
          targetUserEmail: selectedUserEmail || null,
          syncAll: !selectedUserEmail,
          incremental: true,
        });
        if (!cancelled) {
          setSyncAttempts(0);
          queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
          queryClient.invalidateQueries({ queryKey: ["calendar-connections", selectedUserEmail] });
        }
      } catch (e) {
        // Gap fix: Retry up to 3 times on sync error
        setSyncAttempts(prev => {
          const next = prev + 1;
          if (next >= MAX_RETRY_ATTEMPTS) {
            console.warn('Calendar sync failed after retries:', e?.message);
          }
          return next;
        });
      }
    };

    // Gap fix: Listen for visibility changes
    const handleVisibilityChange = () => {
      if (!document.hidden) runAutoSync();
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const intervalId = setInterval(runAutoSync, AUTO_SYNC_INTERVAL_MS);
    autoSyncRef.current = intervalId;

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      autoSyncRef.current = null;
    };
  }, [connections, selectedUserEmail]);

  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data.type === 'calendar_auth_success') {
        toast.success(`Google Calendar connected: ${event.data.email}`);
        setIsConnecting(false);
        queryClient.invalidateQueries({ queryKey: ["calendar-connections"] });
        // Immediately sync the newly connected calendar
        setTimeout(() => handleSync(), 1000);
      } else if (event.data.type === 'calendar_auth_error') {
        toast.error(event.data.error || "Failed to connect Google Calendar");
        setIsConnecting(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [queryClient]);

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }) =>
      api.entities.CalendarConnection.update(id, { is_enabled: enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["calendar-connections"] }),
    onError: (err) => toast.error(err?.message || 'Failed to toggle calendar connection'),
  });

  const deleteMutation = useMutation({
    mutationFn: async ({ id, cleanupEvents }) => {
      if (cleanupEvents) {
        // Soft-orphan: null out calendar_account on events from this connection
        // so they stop appearing without being hard-deleted (preserves Tonomo events)
        const accountEmail = deleteConfirm?.email;
        if (accountEmail) {
          try {
            setDeletingEvents(true);
            const eventsToOrphan = await api.entities.CalendarEvent.filter({
              calendar_account: accountEmail,
              event_source: 'google', // only orphan google-source events, never tonomo
            }, null, 2000);
            const batchSize = 10;
            for (let i = 0; i < eventsToOrphan.length; i += batchSize) {
              const batch = eventsToOrphan.slice(i, i + batchSize);
              await Promise.all(batch.map(ev =>
                api.entities.CalendarEvent.update(ev.id, {
                  calendar_account: null,
                  is_enabled: false,
                  is_done: true,
                }).catch(() => {})
              ));
            }
          } finally {
            setDeletingEvents(false);
          }
        }
      }
      return api.entities.CalendarConnection.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-connections"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-events-team"] });
      setDeleteConfirm(null);
      toast.success("Calendar disconnected and events cleaned up");
    },
    onError: (err) => {
      toast.error(err.message || "Failed to disconnect calendar");
      setDeleteConfirm(null);
    }
  });

  const handleConnect = async () => {
    // Client-side guard (server enforces too)
    if (atLimit) {
      toast.error(`Connection limit reached. ${isAdmin ? 'Admins' : 'Users'} can connect up to ${connectionLimit} calendars.`);
      return;
    }
    try {
      setIsConnecting(true);
      const result = await api.functions.invoke('getGoogleCalendarOAuthUrl', {});
      if (result.data.error) throw new Error(result.data.error);
      const width = 600, height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      window.open(result.data.authUrl, 'Google Calendar Authorization', `width=${width},height=${height},left=${left},top=${top}`);
    } catch (error) {
      toast.error(error.message || "Failed to initiate Google Calendar connection");
      setIsConnecting(false);
    }
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.asServiceRole.functions.invoke('syncGoogleCalendar', {
        targetUserEmail: selectedUserEmail || null,
        syncAll: !selectedUserEmail, // sync all team if no specific user targeted
      });

      if (result.data?.error) throw new Error(result.data.error);

      const { created = 0, updated = 0, linked = 0, accounts = [] } = result.data || {};
      const skipped = accounts.filter(a => a.status === 'skipped' || a.status === 'error').length;
      setSyncResult({ created, updated, linked, skipped, accounts, errors: result.data?.errors });

      if (created + updated === 0) {
        toast.success("Calendar up to date — no changes");
      } else {
        toast.success(`Synced: ${created} new, ${updated} updated`);
      }

      queryClient.invalidateQueries({ queryKey: ["calendar-events"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-connections", selectedUserEmail] });
    } catch (error) {
      toast.error(error.message || "Sync failed");
      setSyncResult({ error: error.message });
    } finally {
      setSyncing(false);
    }
  };

  const enabledCount = connections.filter(c => c.is_enabled).length;

  if (compact) {
    // Minimal version for embedding in the calendar header
    return (
      <div className="flex items-center gap-2">
        {connections.map(c => (
          <Badge key={c.id} variant={c.account_email === 'info@flexmedia.sydney' ? 'default' : 'outline'} className={`text-xs gap-1 ${c.account_email === 'info@flexmedia.sydney' ? 'bg-blue-600 text-white' : ''}`}>
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: c.account_email === 'info@flexmedia.sydney' ? '#fff' : (c.color || '#3b82f6') }} />
            {c.account_email === 'info@flexmedia.sydney' ? 'Tonomo Master' : c.account_email}
            {c.last_synced && (
              <span className={c.account_email === 'info@flexmedia.sydney' ? 'text-white/70' : 'text-muted-foreground'}>
                · {formatLastSync(c.last_synced)}
              </span>
            )}
          </Badge>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={syncing || enabledCount === 0}
          className="h-7 text-xs"
        >
          {syncing
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <RefreshCw className="h-3 w-3" />
          }
          {syncing ? 'Syncing...' : 'Sync'}
        </Button>
        {!atLimit && (
          <Button size="sm" variant="outline" onClick={handleConnect} disabled={isConnecting} className="h-7 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            Connect Google Calendar
          </Button>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <CalendarDays className="h-5 w-5" />
            Calendar Connections
            {selectedUserEmail && (
              <Badge variant="outline" className="text-xs font-normal">{selectedUserEmail}</Badge>
            )}
          </CardTitle>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleSync}
              disabled={syncing || enabledCount === 0}
            >
              {syncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              {syncing ? 'Syncing...' : 'Sync Now'}
            </Button>
            <Button size="sm" onClick={handleConnect} disabled={isConnecting || atLimit} title={atLimit ? `Limit of ${connectionLimit} calendars reached` : undefined}>
              {isConnecting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
              Connect Calendar
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : connections.length === 0 ? (
          <div className="text-center py-6">
            <CalendarDays className="h-10 w-10 mx-auto mb-2 text-muted-foreground opacity-40" />
            <p className="text-muted-foreground text-sm">No calendar connections yet</p>
            <Button size="sm" className="mt-3" onClick={handleConnect}>
              <Plus className="h-4 w-4 mr-2" />
              Connect Google Calendar
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map(connection => {
              // Detect Tonomo master calendar (the business calendar linked to Tonomo scheduling)
              const isMasterCalendar = connection.account_email === 'info@flexmedia.sydney';
              return (
              <div key={connection.id} className={`flex items-center justify-between p-3 border rounded-lg ${isMasterCalendar ? 'border-blue-300 bg-blue-50/30' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: connection.color || '#3b82f6' }} />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-sm">{connection.account_name || connection.account_email}</p>
                      {isMasterCalendar && (
                        <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-blue-600 hover:bg-blue-600">
                          Tonomo Master
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{connection.account_email}</p>
                    {isMasterCalendar && (
                      <p className="text-[10px] text-blue-600/70">Business calendar — syncs Tonomo bookings to FlexStudios</p>
                    )}
                    {connection.created_by && connection.created_by !== selectedUserEmail && !isMasterCalendar && (
                      <p className="text-xs text-muted-foreground italic">Owner: {connection.created_by}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {connection.last_synced ? (
                      <Badge variant="secondary" className="text-xs gap-1">
                        <CheckCircle className="h-2.5 w-2.5 text-green-600" />
                        {formatLastSync(connection.last_synced)}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs text-muted-foreground">
                        Never synced
                      </Badge>
                    )}
                    {connection.last_sync_count > 0 && (
                      <span className="text-xs text-muted-foreground pl-1">
                        {connection.last_sync_count} events in range
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Gap fix: Show selected visibility policy on event blocks */}
                  <select
                    value={connection.visibility_policy || 'show_all'}
                    onChange={async (e) => {
                      await api.entities.CalendarConnection.update(connection.id, {
                        visibility_policy: e.target.value
                      });
                      queryClient.invalidateQueries({ queryKey: ['calendar-connections'] });
                      toast.success(`Visibility set to ${e.target.value}`);
                    }}
                    className="text-xs border rounded px-1.5 py-1 bg-background"
                    title="Show as busy only: hides event titles for privacy. Skip private: excludes marked-private events."
                  >
                    <option value="show_all">All events visible</option>
                    <option value="show_busy_only">Show as busy only (privacy)</option>
                    <option value="skip_private">Skip private events</option>
                  </select>
                  <Switch
                    checked={connection.is_enabled}
                    onCheckedChange={(checked) => toggleMutation.mutate({ id: connection.id, enabled: checked })}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={async () => {
                      // Count synced events for this connection to warn the user
                      let eventCount = 0;
                      try {
                        const evs = await api.entities.CalendarEvent.filter({
                          calendar_account: connection.account_email,
                          event_source: 'google',
                        }, null, 1);
                        eventCount = evs.length; // approximation — just checking if any exist
                      } catch {}
                      setDeleteConfirm({
                        id: connection.id,
                        email: connection.account_email,
                        name: connection.account_name || connection.account_email,
                        eventCount,
                      });
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
              );
            })}
          </div>
        )}

        {/* Sync result summary */}
        {syncResult && !syncResult.error && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
              <span className="text-sm font-medium">
                {syncResult.created + syncResult.updated === 0
                  ? 'Calendar up to date — no new changes'
                  : `${syncResult.created} new · ${syncResult.updated} updated`}
              </span>
              {syncResult.linked > 0 && (
                <span className="text-xs text-blue-600 font-medium">· {syncResult.linked} linked to projects</span>
              )}
            </div>

            {syncResult.accounts?.map((acc, i) => {
              const hasError = acc.errors?.length > 0;
              const isTokenMissing = acc.skip_reason === 'no_refresh_token';
              const isTokenFailed = acc.skip_reason === 'token_refresh_failed';
              const isSkipped = acc.status === 'skipped' || acc.status === 'error';

              return (
                <div
                  key={i}
                  className={`pl-6 py-1.5 rounded text-xs border ${
                    isSkipped
                      ? 'bg-amber-50 border-amber-200 text-amber-800'
                      : hasError
                      ? 'bg-red-50 border-red-200 text-red-700'
                      : 'text-muted-foreground border-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium">{acc.account_name || acc.account}</span>

                    {!isSkipped && !hasError && (
                      <span className="text-green-700">
                        ✓ {acc.created} new · {acc.updated} updated
                        {acc.linked > 0 && ` · ${acc.linked} linked`}
                      </span>
                    )}

                    {isTokenMissing && (
                      <div className="flex items-center gap-2">
                        <span className="text-amber-700">⚠ No auth token — calendar not connected</span>
                        <button
                          onClick={handleConnect}
                          className="underline text-amber-800 font-semibold hover:no-underline"
                        >
                          Reconnect →
                        </button>
                      </div>
                    )}

                    {isTokenFailed && (
                      <div className="flex items-center gap-2">
                        <span className="text-red-700">✕ Token refresh failed</span>
                        <button
                          onClick={handleConnect}
                          className="underline text-red-800 font-semibold hover:no-underline"
                        >
                          Reconnect →
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Show actual error messages, not just count */}
                  {hasError && !isTokenMissing && !isTokenFailed && acc.errors?.slice(0, 3).map((err, ei) => (
                    <p key={ei} className="mt-0.5 text-red-600">✕ {err}</p>
                  ))}
                  {acc.errors?.length > 3 && (
                    <p className="text-red-500">+{acc.errors.length - 3} more errors</p>
                  )}
                </div>
              );
            })}

            {syncResult.skipped > 0 && (
              <p className="text-xs text-amber-600 pl-6">
                {syncResult.skipped} account{syncResult.skipped > 1 ? 's' : ''} skipped — reconnect to fix
              </p>
            )}
          </div>
        )}

        {syncResult?.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-700">Sync failed</p>
              <p className="text-xs text-red-600 mt-0.5">{syncResult.error}</p>
              <p className="text-xs text-red-500 mt-1">Check that your Google OAuth credentials are configured correctly in Settings.</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-1 text-xs text-muted-foreground space-y-1">
          <Clock className="h-3 w-3" />
          <div>
            Auto-syncs every 5 minutes (pauses when tab inactive) · 90 days back, 12 months forward
          </div>
        </div>

        {/* Connection limit indicator */}
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
          <span>{myConnections.length} / {connectionLimit} calendars connected</span>
          {atLimit && (
            <span className="text-amber-600 font-medium">Limit reached</span>
          )}
        </div>

        {/* Delete confirmation dialog */}
        {deleteConfirm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-background rounded-xl border shadow-xl max-w-sm w-full p-5 space-y-4">
              <div>
                <h3 className="font-semibold text-base">Disconnect calendar?</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  <span className="font-medium text-foreground">{deleteConfirm.name}</span> will be disconnected.
                  Auto-sync will stop for this account.
                </p>
              </div>
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 space-y-1">
                <p className="font-medium">⚠ What happens to synced events?</p>
                <p>Events synced from this calendar will be removed from your FlexStudios calendar view.</p>
                <p>Tonomo booking events linked to projects are never affected.</p>
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="px-3 py-1.5 rounded-lg border text-sm hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => deleteMutation.mutate({ id: deleteConfirm.id, cleanupEvents: true })}
                  disabled={deleteMutation.isLoading || deletingEvents}
                  className="px-3 py-1.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 transition-colors disabled:opacity-50"
                >
                  {deletingEvents ? "Cleaning up events…" : deleteMutation.isLoading ? "Disconnecting…" : "Disconnect"}
                </button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatLastSync(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString.endsWith('Z') ? isoString : isoString + 'Z');
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return d.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' });
}