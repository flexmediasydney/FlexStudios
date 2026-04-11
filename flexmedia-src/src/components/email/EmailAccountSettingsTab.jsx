import { useState, useEffect, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Mail, RefreshCw, Plus, X, CheckCircle2, AlertTriangle, Loader2, Star,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogClose,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

import { sanitizeDisplayHtml as sanitizeSignatureHtml } from '@/utils/sanitizeHtml';

const QUILL_MODULES = {
  toolbar: [
    [{ font: [] }, { size: [] }],
    ["bold", "italic", "underline"],
    [{ color: [] }],
    ["link", "image"],
    ["clean"],
  ],
};

const stripHtml = (html) => {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export default function EmailAccountSettingsTab() {
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();

  // FIX 1: scoped to current user
  const { data: emailAccounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["email-accounts", user?.id],
    queryFn: () =>
      api.entities.EmailAccount.filter({
        is_active: true,
        assigned_to_user_id: user?.id,
      }),
    enabled: !!user?.id,
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["internal-teams"],
    queryFn: () => api.entities.InternalTeam.list(),
  });

  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const selectedAccount = emailAccounts.find((a) => a.id === selectedAccountId);

  // FIX 2: local draft for blur-save fields
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  useEffect(() => {
    if (selectedAccount) setDisplayNameDraft(selectedAccount.display_name || "");
  }, [selectedAccount?.id]);

  useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccountId)
      setSelectedAccountId(emailAccounts[0].id);
  }, [emailAccounts, selectedAccountId]);

  const { data: signatures = [] } = useQuery({
    queryKey: ["user-signatures", selectedAccount?.assigned_to_user_id],
    queryFn: () =>
      api.entities.UserSignature.filter({
        user_id: selectedAccount.assigned_to_user_id,
      }),
    enabled: !!selectedAccount,
  });

  const { data: blockedAddresses = [] } = useQuery({
    queryKey: ["email-blocked-addresses", selectedAccount?.id],
    queryFn: () =>
      api.entities.EmailBlockedAddress.filter({
        email_account_id: selectedAccount.id,
      }),
    enabled: !!selectedAccount,
  });

  const updateAccountMutation = useMutation({
    mutationFn: (data) => api.entities.EmailAccount.update(selectedAccountId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] });
      toast.success("Saved.");
    },
    onError: (err) => { console.error("Account update error:", err); toast.error("Failed to save account settings. Please try again."); },
  });

  const handleFieldSave = (field, value) => updateAccountMutation.mutate({ [field]: value });

  // FIX 3: correct function + correct params { accountId, userId }
  const syncMutation = useMutation({
    mutationFn: () =>
      api.functions.invoke("syncGmailMessagesForAccount", {
        accountId: selectedAccount.id,
        userId: user.id,
      }),
    onSuccess: (res) => {
      const n = res?.data?.synced ?? 0;
      queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] });
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      queryClient.invalidateQueries({ queryKey: ["email-conversations"] });
      toast.success(n > 0 ? `Synced ${n} new email${n !== 1 ? "s" : ""}.` : "Already up to date.");
    },
    onError: (err) => { console.error("Email sync error:", err); toast.error("Email sync failed. Please check your connection and try again."); },
  });

  // FIX 9: reconnect flow — sends reconnectAccountId in state
  const [isReconnecting, setIsReconnecting] = useState(false);
  const handleReconnect = async () => {
    try {
      setIsReconnecting(true);
      const result = await api.functions.invoke("getGmailOAuthUrl", {
        displayName: selectedAccount.display_name,
        teamId: selectedAccount.team_id || null,
        reconnectAccountId: selectedAccount.id,
      });
      if (result.data?.error) throw new Error(result.data.error);
      const w = 600, h = 700;
      window.open(
        result.data.authUrl,
        "Gmail Reconnect",
        `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`
      );
    } catch (err) {
      console.error("Reconnect error:", err);
      toast.error("Could not start reconnect. Please try again.");
      setIsReconnecting(false);
    }
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === "gmail_auth_success") {
        setIsReconnecting(false);
        queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] });
        toast.success("Gmail reconnected successfully.");
      } else if (e.data?.type === "gmail_auth_error") {
        setIsReconnecting(false);
        toast.error(e.data.error || "Reconnect failed.");
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [queryClient, user?.id]);

  const createSignatureMutation = useMutation({
    mutationFn: (data) => api.entities.UserSignature.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-signatures"] });
      queryClient.invalidateQueries({ queryKey: ["user-signatures-compose"] });
      toast.success("Signature saved.");
    },
    onError: () => toast.error("Failed to save signature."),
  });

  const updateSignatureMutation = useMutation({
    mutationFn: ({ id, html }) =>
      api.entities.UserSignature.update(id, { signature_html: html }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-signatures"] });
      queryClient.invalidateQueries({ queryKey: ["user-signatures-compose"] });
      toast.success("Signature updated.");
    },
    onError: () => toast.error("Failed to update signature."),
  });

  // FIX 8: set default signature
  const setDefaultSignatureMutation = useMutation({
    mutationFn: async (sigId) => {
      // Clear all defaults first, then set new one
      await Promise.all(
        signatures.map((s) =>
          api.entities.UserSignature.update(s.id, { is_default: s.id === sigId })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-signatures"] });
      queryClient.invalidateQueries({ queryKey: ["user-signatures-compose"] });
      toast.success("Default signature updated.");
    },
  });

  const deleteSignatureMutation = useMutation({
    mutationFn: (id) => api.entities.UserSignature.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-signatures"] });
      queryClient.invalidateQueries({ queryKey: ["user-signatures-compose"] });
      toast.success("Signature deleted.");
    },
  });

  const createBlockedAddressMutation = useMutation({
    mutationFn: (data) => api.entities.EmailBlockedAddress.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-blocked-addresses"] });
      toast.success("Address blocked.");
    },
    onError: () => toast.error("Failed to block address."),
  });

  const deleteBlockedAddressMutation = useMutation({
    mutationFn: (id) => api.entities.EmailBlockedAddress.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-blocked-addresses"] });
      toast.success("Address unblocked.");
    },
  });

  const deleteAccountMutation = useMutation({
    mutationFn: (id) => api.entities.EmailAccount.update(id, { is_active: false }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] });
      setSelectedAccountId(null);
      toast.success("Account disconnected.");
    },
    onError: (err) => { console.error("Disconnect error:", err); toast.error("Failed to disconnect account. Please try again."); },
  });

  if (accountsLoading) {
    return (
      <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading accounts...
      </div>
    );
  }

  const hasToken = !!selectedAccount?.refresh_token;

  return (
    <div className="w-full">
      <div className="grid grid-cols-3 gap-6">

        {/* Sidebar */}
        <div className="col-span-1">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Connected Accounts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {emailAccounts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">No accounts connected.</p>
              ) : (
                emailAccounts.map((account) => {
                  const isActive = selectedAccountId === account.id;
                  const lastSync = account.last_sync
                    ? formatDistanceToNow(new Date(fixTimestamp(account.last_sync)), { addSuffix: true })
                    : null;
                  const tokenOk = !!account.refresh_token;
                  return (
                    <button
                      key={account.id}
                      onClick={() => setSelectedAccountId(account.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-md transition-colors ${
                        isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {tokenOk
                          ? <CheckCircle2 className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? "text-primary-foreground/80" : "text-green-500"}`} />
                          : <AlertTriangle className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? "text-yellow-200" : "text-yellow-500"}`} />
                        }
                        <span className="text-xs font-medium truncate">{account.email_address}</span>
                      </div>
                      {account.display_name && account.display_name !== account.email_address && (
                        <p className={`text-[10px] mt-0.5 pl-5 truncate ${isActive ? "text-primary-foreground/60" : "text-muted-foreground"}`}>
                          {account.display_name}
                        </p>
                      )}
                      {lastSync && (
                        <p className={`text-[10px] pl-5 ${isActive ? "text-primary-foreground/50" : "text-muted-foreground/70"}`}>
                          Synced {lastSync}
                        </p>
                      )}
                    </button>
                  );
                })
              )}

              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" className="w-full mt-2 gap-2 h-8 text-xs">
                    <Plus className="h-3.5 w-3.5" /> Add Gmail Account
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>Connect Gmail Account</DialogTitle></DialogHeader>
                  <AddGmailAccountForm
                    onSuccess={() => queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] })}
                  />
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        </div>

        {/* Main panel */}
        <div className="col-span-2 space-y-4">
          {!selectedAccount ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                <Mail className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Select an account or connect a new one.</p>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button className="gap-2"><Plus className="h-4 w-4" /> Connect Gmail</Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader><DialogTitle>Connect Gmail Account</DialogTitle></DialogHeader>
                    <AddGmailAccountForm
                      onSuccess={() => queryClient.invalidateQueries({ queryKey: ["email-accounts", user?.id] })}
                    />
                  </DialogContent>
                </Dialog>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Account Details — FIX 10: no duplicate X button here */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Account Details</CardTitle>
                  <CardDescription>{selectedAccount.email_address}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="displayName">Display Name</Label>
                      {/* FIX 2: save on blur */}
                      <Input
                        id="displayName"
                        value={displayNameDraft}
                        onChange={(e) => setDisplayNameDraft(e.target.value)}
                        onBlur={() => {
                          if (displayNameDraft !== selectedAccount.display_name)
                            handleFieldSave("display_name", displayNameDraft);
                        }}
                        placeholder="e.g. Support Team"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">Saves when you click away</p>
                    </div>
                    <div>
                      <Label>Email Address</Label>
                      <Input value={selectedAccount.email_address} readOnly className="bg-muted" />
                    </div>
                  </div>

                  {user?.role === "master_admin" && (
                    <div>
                      <Label>Assign to Team</Label>
                      {/* FIX 11: use "" not null */}
                      <Select
                        value={selectedAccount.team_id || "__none__"}
                        onValueChange={(val) => {
                          const teamId = val === "__none__" ? null : val;
                          const team = teams.find((t) => t.id === teamId);
                          updateAccountMutation.mutate({
                            team_id: teamId,
                            team_name: team?.name || "",
                          });
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="No team (personal)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No team (personal)</SelectItem>
                          {teams.map((t) => (
                            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* FIX 9: Connection status + reconnect */}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div className="flex items-center gap-2">
                      {hasToken
                        ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                        : <AlertTriangle className="h-4 w-4 text-yellow-500" />}
                      <div>
                        <p className="text-sm font-medium">
                          {hasToken ? "OAuth connection active" : "Token missing — reconnect required"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {hasToken ? "Emails will sync automatically" : "Click Reconnect to restore access"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-2 text-xs"
                      onClick={handleReconnect}
                      disabled={isReconnecting}
                    >
                      {isReconnecting
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <RefreshCw className="h-3.5 w-3.5" />}
                      {isReconnecting ? "Reconnecting..." : "Reconnect Gmail"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Sync */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Email Sync</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label htmlFor="syncStartDate">Sync emails from date</Label>
                    <Input
                      id="syncStartDate"
                      type="date"
                      value={
                        selectedAccount.sync_start_date
                          ? new Date(fixTimestamp(selectedAccount.sync_start_date))
                              .toISOString()
                              .split("T")[0]
                          : ""
                      }
                      onChange={(e) => handleFieldSave("sync_start_date", e.target.value)}
                    />
                    {selectedAccount.last_sync && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Last synced{" "}
                        {formatDistanceToNow(new Date(fixTimestamp(selectedAccount.last_sync)), {
                          addSuffix: true,
                        })}
                      </p>
                    )}
                  </div>
                  {/* FIX 3: correct function + correct params */}
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => syncMutation.mutate()}
                    disabled={syncMutation.isPending}
                    title="Pull new emails from Gmail into the CRM inbox"
                  >
                    <RefreshCw className={`h-4 w-4 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                    {syncMutation.isPending ? "Syncing..." : "Sync Now"}
                  </Button>
                  <p className="text-[10px] text-muted-foreground mt-1.5">Fetches the latest emails from your connected Gmail account.</p>
                </CardContent>
              </Card>

              {/* Signatures — FIX 5, 6, 7, 8 */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Email Signatures</CardTitle>
                      <CardDescription>Appended automatically when sending emails.</CardDescription>
                    </div>
                    <SignatureDialog
                      onSave={(html) =>
                        createSignatureMutation.mutate({
                          user_id: selectedAccount.assigned_to_user_id,
                          user_name: selectedAccount.display_name,
                          user_email: selectedAccount.email_address,
                          signature_html: html,
                          is_default: signatures.length === 0,
                        })
                      }
                      isSaving={createSignatureMutation.isPending}
                    />
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {signatures.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No signatures yet.</p>
                  ) : (
                    signatures.map((sig) => (
                      <div key={sig.id} className="border rounded-lg overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b">
                          {sig.is_default && (
                            <Badge variant="secondary" className="text-[10px] h-4 gap-1">
                              <Star className="h-2.5 w-2.5 fill-current" /> Default
                            </Badge>
                          )}
                          {/* FIX 5: plain-text preview, no broken HTML slice */}
                          <p className="text-xs text-muted-foreground truncate flex-1">
                            {stripHtml(sig.signature_html).slice(0, 80) || "(empty)"}
                          </p>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {!sig.is_default && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs gap-1 px-2"
                                onClick={() => setDefaultSignatureMutation.mutate(sig.id)}
                                disabled={setDefaultSignatureMutation.isPending}
                              >
                                <Star className="h-3 w-3" /> Set default
                              </Button>
                            )}
                            {/* FIX 7: edit button that actually works */}
                            <SignatureDialog
                              existingHtml={sig.signature_html}
                              onSave={(html) => updateSignatureMutation.mutate({ id: sig.id, html })}
                              isSaving={updateSignatureMutation.isPending}
                              isEdit
                            />
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive">
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogTitle>Delete signature?</AlertDialogTitle>
                                <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                                <div className="flex justify-end gap-2 mt-4">
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    className="bg-destructive hover:bg-destructive/90"
                                    onClick={() => deleteSignatureMutation.mutate(sig.id)}
                                  >Delete</AlertDialogAction>
                                </div>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </div>
                        {/* Safe rendered preview */}
                        <div
                          className="px-3 py-2 text-sm max-h-20 overflow-hidden pointer-events-none"
                          dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtml(sig.signature_html) }}
                        />
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              {/* Tracking */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Tracking & Behaviour</CardTitle>
                </CardHeader>
                <CardContent className="divide-y">
                  {[
                    { id: "track_opens", label: "Track email opens", desc: "Know when recipients open your emails" },
                    { id: "track_clicks", label: "Track link clicks", desc: "Know when recipients click links" },
                    { id: "auto_link_to_projects", label: "Auto-link to projects", desc: "Automatically associate emails with relevant projects" },
                  ].map(({ id, label, desc }) => (
                    <div key={id} className="flex items-center justify-between py-3">
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                      <Switch
                        checked={!!selectedAccount[id]}
                        onCheckedChange={(v) => handleFieldSave(id, v)}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Visibility — FIX 4: use 'private'/'shared' */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Default Email Visibility</CardTitle>
                  <CardDescription>Controls who sees synced emails by default.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {[
                    { value: "private", label: "Private", desc: "Only visible to you" },
                    { value: "shared", label: "Shared with team", desc: "Visible to team members in linked projects" },
                  ].map(({ value, label, desc }) => (
                    <label
                      key={value}
                      className={`flex items-center gap-3 p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedAccount.default_visibility === value
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`visibility-${selectedAccount.id}`}
                        checked={selectedAccount.default_visibility === value}
                        onChange={() => handleFieldSave("default_visibility", value)}
                        className="accent-primary"
                      />
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground">{desc}</p>
                      </div>
                    </label>
                  ))}

                  {/* Backfill button — apply default visibility to all existing emails */}
                  {selectedAccount.default_visibility === 'shared' && (
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-xs text-blue-800 font-medium mb-2">
                        Apply to existing emails?
                      </p>
                      <p className="text-xs text-blue-600 mb-3">
                        This will update all historical emails for this account to "shared" visibility so your team can see them in linked projects.
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-blue-300 text-blue-700 hover:bg-blue-100"
                        onClick={async () => {
                          const confirmed = confirm(
                            `This will change ALL existing emails for ${selectedAccount.email_address} to "shared" visibility. This cannot be undone.\n\nContinue?`
                          );
                          if (!confirmed) return;
                          try {
                            toast.loading('Updating existing emails...', { id: 'backfill-visibility' });
                            const emails = await api.entities.EmailMessage.filter({
                              email_account_id: selectedAccount.id,
                              visibility: 'private'
                            });
                            if (emails.length === 0) {
                              toast.success('All emails are already shared', { id: 'backfill-visibility' });
                              return;
                            }
                            // Batch update in chunks of 50
                            const chunkSize = 50;
                            let updated = 0;
                            for (let i = 0; i < emails.length; i += chunkSize) {
                              const chunk = emails.slice(i, i + chunkSize);
                              await Promise.all(
                                chunk.map(e => api.entities.EmailMessage.update(e.id, { visibility: 'shared' }))
                              );
                              updated += chunk.length;
                              toast.loading(`Updated ${updated} of ${emails.length} emails...`, { id: 'backfill-visibility' });
                            }
                            toast.success(`${emails.length} emails updated to shared visibility`, { id: 'backfill-visibility' });
                          } catch (err) {
                            console.error('Backfill visibility error:', err);
                            toast.error('Failed to update email visibility. Please try again.', { id: 'backfill-visibility' });
                          }
                        }}
                      >
                        Apply to all existing emails
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Blocked Addresses */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">Blocked Addresses</CardTitle>
                      <CardDescription>Emails from these addresses won't be synced.</CardDescription>
                    </div>
                    <BlockedAddressDialog
                      onAdd={(address) => {
                        const normalized = address.toLowerCase().trim();
                        if (blockedAddresses.some(b => b.email_address === normalized)) {
                          toast.error("This address is already blocked.");
                          return;
                        }
                        createBlockedAddressMutation.mutate({
                          email_account_id: selectedAccount.id,
                          email_address: normalized,
                        });
                      }}
                      isAdding={createBlockedAddressMutation.isPending}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  {blockedAddresses.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No blocked addresses.</p>
                  ) : (
                    <div className="space-y-2">
                      {blockedAddresses.map((b) => (
                        <div key={b.id} className="flex items-center justify-between px-3 py-2 border rounded-md">
                          <span className="text-sm font-mono">{b.email_address}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => deleteBlockedAddressMutation.mutate(b.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Danger zone — FIX 10: only one remove button, here */}
              <Card className="border-destructive/40">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm text-destructive">Danger Zone</CardTitle>
                </CardHeader>
                <CardContent>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive" className="w-full">
                        Disconnect {selectedAccount.email_address}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Email syncing will stop for <strong>{selectedAccount.email_address}</strong>.
                        Previously synced emails remain in your inbox. You can reconnect at any time.
                      </AlertDialogDescription>
                      <div className="flex justify-end gap-3 mt-4">
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive hover:bg-destructive/90"
                          onClick={() => deleteAccountMutation.mutate(selectedAccount.id)}
                        >
                          Disconnect Account
                        </AlertDialogAction>
                      </div>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────

function SignatureDialog({ onSave, isSaving, existingHtml = "", isEdit = false }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState(existingHtml);

  useEffect(() => { if (open) setHtml(existingHtml); }, [open]);

  const handleSave = () => {
    const plainText = html.replace(/<[^>]+>/g, "").trim();
    if (!plainText) { toast.error("Signature cannot be empty"); return; }
    onSave(html);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit
          ? <Button variant="ghost" size="sm" className="h-7 text-xs px-2">Edit</Button>
          : <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs"><Plus className="h-3.5 w-3.5" /> Add Signature</Button>
        }
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Signature" : "New Signature"}</DialogTitle>
        </DialogHeader>
        {/* FIX 6: ReactQuill rich editor */}
        <div className="min-h-[180px]">
          <ReactQuill
            theme="snow"
            value={html}
            onChange={setHtml}
            modules={QUILL_MODULES}
            placeholder="Write your signature here..."
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving ? "Saving..." : "Save Signature"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BlockedAddressDialog({ onAdd, isAdding }) {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const valid = address.includes("@") && address.includes(".");

  const handleAdd = () => {
    if (!valid) { toast.error("Enter a valid email address"); return; }
    onAdd(address);
    setAddress("");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs">
          <Plus className="h-3.5 w-3.5" /> Block Address
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Block Email Address</DialogTitle></DialogHeader>
        <Input
          type="email"
          placeholder="noreply@example.com"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleAdd} disabled={isAdding || !valid}>
            {isAdding ? "Blocking..." : "Block Address"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddGmailAccountForm({ onSuccess }) {
  const [displayName, setDisplayName] = useState("");
  const [teamId, setTeamId] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  const { data: teams = [] } = useQuery({
    queryKey: ["internal-teams"],
    queryFn: () => api.entities.InternalTeam.list(),
  });

  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === "gmail_auth_success") {
        toast.success(`${e.data.email} connected.`);
        setIsConnecting(false);
        onSuccess?.();
      } else if (e.data?.type === "gmail_auth_error") {
        toast.error(e.data.error || "Connection failed.");
        setIsConnecting(false);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const handleConnect = async () => {
    try {
      setIsConnecting(true);
      const result = await api.functions.invoke("getGmailOAuthUrl", {
        displayName: displayName || null,
        teamId: teamId || null,
      });
      if (result.data?.error) throw new Error(result.data.error);
      const w = 600, h = 700;
      window.open(
        result.data.authUrl,
        "Gmail Auth",
        `width=${w},height=${h},left=${window.screenX + (window.outerWidth - w) / 2},top=${window.screenY + (window.outerHeight - h) / 2}`
      );
    } catch (err) {
      console.error("Gmail connection error:", err);
      toast.error("Failed to start Gmail connection. Please try again.");
      setIsConnecting(false);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      <div>
        <Label htmlFor="addDisplayName">Display Name (optional)</Label>
        <Input
          id="addDisplayName"
          placeholder="e.g. Support Team"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div>
        <Label htmlFor="addTeam">Assign to Team (optional)</Label>
        <Select value={teamId} onValueChange={setTeamId}>
          <SelectTrigger id="addTeam">
            <SelectValue placeholder="Personal inbox" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Personal (no team)</SelectItem>
            {teams.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button onClick={handleConnect} disabled={isConnecting} className="gap-2">
          {isConnecting && <Loader2 className="h-4 w-4 animate-spin" />}
          <Mail className="h-4 w-4" />
          {isConnecting ? "Opening Google..." : "Connect Gmail"}
        </Button>
      </DialogFooter>
      <p className="text-xs text-center text-muted-foreground">
        A Google sign-in popup will open. Keep this tab open.
      </p>
    </div>
  );
}