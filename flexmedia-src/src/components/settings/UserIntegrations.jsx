import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Mail, Trash2, RotateCcw, Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function UserIntegrations({ user }) {
  const [showGmailDialog, setShowGmailDialog] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(null);
  const queryClient = useQueryClient();

  const { data: emailAccounts = [] } = useQuery({
    queryKey: ["my-email-accounts", user?.id],
    queryFn: () => user ? api.entities.EmailAccount.filter({ assigned_to_user_id: user.id }) : [],
    enabled: !!user
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["teams"],
    queryFn: () => api.entities.InternalTeam.list()
  });

  // Listen for OAuth postMessage from popup
  const handleAuthMessage = useCallback((event) => {
    if (event.data?.type === 'gmail_auth_success') {
      toast.success(`Gmail connected: ${event.data.email}`);
      setShowGmailDialog(false);
      setDisplayName("");
      setSelectedTeamId("");
      setIsConnecting(false);
      setIsReconnecting(null);
      queryClient.invalidateQueries({ queryKey: ["my-email-accounts", user?.id] });
    } else if (event.data?.type === 'gmail_auth_error') {
      toast.error(event.data.error || "Failed to connect Gmail");
      setIsConnecting(false);
      setIsReconnecting(null);
    }
  }, [queryClient, user?.id]);

  useEffect(() => {
    window.addEventListener('message', handleAuthMessage);
    return () => window.removeEventListener('message', handleAuthMessage);
  }, [handleAuthMessage]);

  const openOAuthPopup = async ({ displayName: dn, teamId: tid, reconnectAccountId } = {}) => {
    const result = await api.functions.invoke('getGmailOAuthUrl', {
      displayName: dn || null,
      teamId: tid || null,
      reconnectAccountId: reconnectAccountId || null
    });
    if (result.data?.error) throw new Error(result.data.error);

    const width = 600, height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(
      result.data.authUrl,
      'Gmail Authorization',
      `width=${width},height=${height},left=${left},top=${top}`
    );
    if (!popup || popup.closed) {
      throw new Error("Popup blocked. Please allow popups for this site.");
    }
  };

  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      await openOAuthPopup({
        displayName: displayName || user?.full_name,
        teamId: selectedTeamId
      });
    } catch (error) {
      toast.error(error.message || "Failed to connect Gmail");
      setIsConnecting(false);
    }
  };

  const handleReconnect = async (accountId) => {
    try {
      setIsReconnecting(accountId);
      const account = emailAccounts.find(a => a.id === accountId);
      await openOAuthPopup({
        displayName: account?.display_name,
        reconnectAccountId: accountId
      });
    } catch (error) {
      toast.error(error.message || "Failed to reconnect");
      setIsReconnecting(null);
    }
  };

  const removeAccountMutation = useMutation({
    mutationFn: (accountId) => api.entities.EmailAccount.update(accountId, { is_active: false }),
    onSuccess: () => {
      toast.success("Email account disconnected");
      queryClient.invalidateQueries({ queryKey: ["my-email-accounts", user?.id] });
    },
    onError: (err) => toast.error(err?.message || 'Failed to disconnect account'),
  });

  return (
    <div className="space-y-6">
      {/* Gmail Section */}
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Mail className="h-5 w-5" />
                Gmail Inbox
              </CardTitle>
              <CardDescription>
                Connect Gmail accounts to send and receive emails within Flex Studios.
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {emailAccounts.length === 0 ? (
            <div className="text-center py-6">
              <Mail className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
              <p className="text-muted-foreground mb-4">No Gmail accounts connected yet. Link your inbox to send and receive emails.</p>
              <Button
                onClick={() => setShowGmailDialog(true)}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                Connect Gmail
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {emailAccounts.map(account => (
                <div
                  key={account.id}
                  className="flex items-center justify-between p-4 border rounded-lg bg-muted/50"
                >
                  <div className="flex-1">
                    <p className="font-medium">{account.email_address}</p>
                    <p className="text-sm text-muted-foreground">{account.display_name}</p>
                    {account.last_sync && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Last synced: {new Date(account.last_sync).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <Badge variant={account.is_active ? "default" : "secondary"}>
                    {account.is_active ? "Connected" : "Disconnected"}
                  </Badge>
                  <div className="flex gap-2 ml-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReconnect(account.id)}
                      disabled={isReconnecting === account.id}
                      className="gap-2"
                    >
                      {isReconnecting === account.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" />
                      )}
                      Reconnect
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => removeAccountMutation.mutate(account.id)}
                      disabled={removeAccountMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                onClick={() => setShowGmailDialog(true)}
                variant="outline"
                className="w-full gap-2"
              >
                <Plus className="h-4 w-4" />
                Add Another Gmail Account
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gmail Connect Dialog */}
      {showGmailDialog && (
        <Dialog open onOpenChange={setShowGmailDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Connect Gmail Account</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">Display Name</label>
                <Input
                  placeholder="e.g., My Work Email"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div>
                <label className="text-sm font-medium">Assign to Team (Optional)</label>
                <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a team..." />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map(team => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  All members of this team will be able to access this inbox.
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowGmailDialog(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleConnect}
                  disabled={isConnecting || !displayName}
                  className="gap-2"
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    "Connect Gmail"
                  )}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
