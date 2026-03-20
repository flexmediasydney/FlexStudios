import { useState, useEffect, useCallback } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function EmailAccountSetup() {
  const [displayName, setDisplayName] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const queryClient = useQueryClient();

  const { data: teams = [] } = useQuery({
    queryKey: ["teams"],
    queryFn: () => base44.entities.InternalTeam.list()
  });

  const handleAuthMessage = useCallback((event) => {
    if (event.data?.type === 'gmail_auth_success') {
      toast.success(`Gmail account ${event.data.email} connected successfully`);
      setDisplayName("");
      setSelectedTeamId("");
      setIsConnecting(false);
      setPopupBlocked(false);
      // Refresh email accounts list without full page reload
      queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
    } else if (event.data?.type === 'gmail_auth_error') {
      toast.error(event.data.error || "Failed to connect Gmail account");
      setIsConnecting(false);
    }
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener('message', handleAuthMessage);
    return () => window.removeEventListener('message', handleAuthMessage);
  }, [handleAuthMessage]);

  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      setPopupBlocked(false);

      const result = await base44.functions.invoke('getGmailOAuthUrl', {
        displayName: displayName || null,
        teamId: selectedTeamId || null
      });

      if (result.data.error) {
        throw new Error(result.data.error);
      }

      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const popup = window.open(
        result.data.authUrl,
        'Gmail Authorization',
        `width=${width},height=${height},left=${left},top=${top}`
      );

      if (!popup || popup.closed) {
        setPopupBlocked(true);
        setIsConnecting(false);
        toast.error("Popup was blocked. Please allow popups for this site and try again.");
        return;
      }

      // Monitor popup close — if user closes it without completing auth, reset state
      const pollTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollTimer);
          // Give postMessage a moment to arrive before resetting
          setTimeout(() => {
            setIsConnecting((prev) => {
              if (prev) {
                // Still connecting means no success/error message arrived
                return false;
              }
              return prev;
            });
          }, 1000);
        }
      }, 500);
    } catch (error) {
      console.error('Connect error:', error);
      toast.error(error.message || "Failed to initiate Gmail connection");
      setIsConnecting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
              <Mail className="h-6 w-6 text-primary" />
            </div>
          </div>
          <CardTitle>Connect Gmail Account</CardTitle>
          <CardDescription>
            Connect your Gmail account via Google OAuth. Your emails will sync automatically.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {popupBlocked && (
            <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Popup blocked</p>
                <p className="text-xs mt-0.5">
                  Your browser blocked the authorization window. Please allow popups for this site in your browser settings and try again.
                </p>
              </div>
            </div>
          )}

          <div>
            <label className="text-sm font-medium">Display Name (Optional)</label>
            <Input
              placeholder="e.g., My Team Inbox"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div>
            <label className="text-sm font-medium">Team (Optional)</label>
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
              <SelectTrigger>
                <SelectValue placeholder="Personal inbox" />
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
              Assign to a team for shared access
            </p>
          </div>

          <Button
            onClick={handleConnect}
            disabled={isConnecting}
            className="w-full gap-2"
          >
            {isConnecting && <Loader2 className="h-4 w-4 animate-spin" />}
            <Mail className="h-4 w-4" />
            {isConnecting ? 'Opening Gmail Authorization...' : 'Connect Gmail Account'}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            You'll be redirected to Google to authorize your Gmail account
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
