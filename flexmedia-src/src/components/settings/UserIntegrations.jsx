import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Mail, Trash2, RotateCcw, Plus } from "lucide-react";
import { toast } from "sonner";

export default function UserIntegrations({ user }) {
  const [showGmailDialog, setShowGmailDialog] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const queryClient = useQueryClient();

  const { data: emailAccounts = [] } = useQuery({
    queryKey: ["my-email-accounts", user?.id],
    queryFn: () => user ? base44.entities.EmailAccount.filter({ assigned_to_user_id: user.id }) : [],
    enabled: !!user
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["teams"],
    queryFn: () => base44.entities.InternalTeam.list()
  });

  const initializeGmailMutation = useMutation({
    mutationFn: () => base44.functions.invoke('initializeGmail', {
      displayName: displayName || user?.full_name,
      teamId: selectedTeamId || null
    }),
    onSuccess: (response) => {
      toast.success(`Gmail connected: ${response.data.email}`);
      setShowGmailDialog(false);
      setDisplayName("");
      setSelectedTeamId("");
      queryClient.invalidateQueries({ queryKey: ["my-email-accounts"] });
    },
    onError: (error) => {
      toast.error(error.message || "Failed to connect Gmail");
    }
  });

  const removeAccountMutation = useMutation({
    mutationFn: (accountId) => base44.entities.EmailAccount.delete(accountId),
    onSuccess: () => {
      toast.success("Email account removed");
      queryClient.invalidateQueries({ queryKey: ["my-email-accounts"] });
    },
    onError: (err) => toast.error(err?.message || 'Failed to remove account'),
  });

  const reconnectAccountMutation = useMutation({
    mutationFn: (accountId) => base44.functions.invoke('initializeGmail', {
      displayName: emailAccounts.find(a => a.id === accountId)?.display_name
    }),
    onSuccess: () => {
      toast.success("Email account reconnected");
      queryClient.invalidateQueries({ queryKey: ["my-email-accounts"] });
    },
    onError: (error) => {
      toast.error(error.message || "Failed to reconnect");
    }
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
                Connect your Gmail account to manage emails in Flex Studios
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {emailAccounts.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-muted-foreground mb-4">No Gmail accounts connected</p>
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
                      onClick={() => reconnectAccountMutation.mutate(account.id)}
                      disabled={reconnectAccountMutation.isPending}
                      className="gap-2"
                    >
                      <RotateCcw className="h-4 w-4" />
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
                  Team members can access the inbox together
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setShowGmailDialog(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => initializeGmailMutation.mutate()}
                  disabled={initializeGmailMutation.isPending || !displayName}
                  className="gap-2"
                >
                  {initializeGmailMutation.isPending ? "Connecting..." : "Connect Gmail"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}