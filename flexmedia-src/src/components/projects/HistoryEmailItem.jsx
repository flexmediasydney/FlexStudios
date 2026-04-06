import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, ChevronDown, ChevronUp, Lock, Users, Reply, Share2, MoreVertical, ArrowRight, Trash2, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import EmailComposeDialog from "@/components/email/EmailComposeDialog";

// Use centralized sanitizer — covers script, style, iframe, object, embed, on* handlers,
// javascript:/data:/vbscript: URIs, base, form, meta, HTML comments, and head blocks.
import { sanitizeEmailHtml } from '@/utils/sanitizeHtml';

export default function HistoryEmailItem({ email, projectId, isOwner = false }) {
  const [expanded, setExpanded] = useState(false);
  const [replyType, setReplyType] = useState(null);
  const queryClient = useQueryClient();

  // Pipedrive model: only the owner can update visibility, reply, or delete.
  // Non-owners see the email body read-only with no action controls.

  const updateEmailMutation = useMutation({
    mutationFn: (data) => api.entities.EmailMessage.update(email.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-emails"] });
      toast.success("Updated");
    },
    onError: (err) => toast.error(err?.message || "Failed to update email"),
  });

  // Soft-delete only (moves to deleted folder, preserves data).
  // Hard delete via EmailMessage.delete is intentionally removed —
  // deleting from project view should not permanently destroy the email.
  const deleteEmailMutation = useMutation({
    mutationFn: () => api.entities.EmailMessage.update(email.id, {
      is_deleted: true,
      project_id: null,
      project_title: null
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["project-emails"] });
      toast.success("Email removed from project and moved to deleted folder");
    },
    onError: (err) => toast.error(err?.message || "Failed to delete email"),
  });

  const toggleVisibility = () => {
    if (!isOwner) return;
    const next = email.visibility === 'shared' ? 'private' : 'shared';
    updateEmailMutation.mutate({ visibility: next });
  };

  const getVisibilityIcon = (visibility) =>
    visibility === 'shared'
      ? <Users className="h-3.5 w-3.5 text-blue-600" />
      : <Lock className="h-3.5 w-3.5 text-muted-foreground" />;

  const getVisibilityLabel = (visibility) =>
    visibility === 'shared' ? 'Shared' : 'Private';

  const isPrivateAndOwner = isOwner && email.visibility !== 'shared';

  // Build the account object enough for EmailComposeDialog (needs email_address)
  // We pass it through so compose can pre-fill the From field correctly.
  // The account object only needs id and email_address — fetch lazily via email fields.
  const accountForCompose = {
    id: email.email_account_id,
    email_address: email.from  // from field contains the account's address for outgoing
  };

  return (
    <div className="pb-6 relative">
      <div className="flex gap-4">
        <div className="flex flex-col items-center">
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${isOwner ? 'bg-purple-100' : 'bg-gray-100'}`}>
            <Mail className={`h-4 w-4 ${isOwner ? 'text-purple-600' : 'text-muted-foreground/70'}`} />
          </div>
          <div className="w-0.5 h-12 bg-gray-200 mt-2" />
        </div>

        <div className="pt-1 flex-1">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">
                {fmtTimestampCustom(email.received_at, { dateStyle: 'medium', timeStyle: 'short' })} • {email.from_name || email.from}
              </p>
              <p className="text-sm font-medium text-foreground/80 mt-1">{email.subject}</p>
            </div>

            <div className="flex items-center gap-1">
              {/* Visibility toggle — owner only */}
              {isOwner ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={toggleVisibility}
                  title={`Visibility: ${getVisibilityLabel(email.visibility)} — click to toggle`}
                >
                  {getVisibilityIcon(email.visibility)}
                </Button>
              ) : (
                <span
                  className="h-7 w-7 flex items-center justify-center"
                  title="Shared with project team"
                >
                  {getVisibilityIcon(email.visibility)}
                </span>
              )}

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>

              {/* Actions menu — owner only */}
              {isOwner && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem onClick={() => setReplyType("reply")}>
                      <Reply className="h-3.5 w-3.5 mr-2" />
                      Reply
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReplyType("replyAll")}>
                      <Share2 className="h-3.5 w-3.5 mr-2" />
                      Reply All
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReplyType("forward")}>
                      <ArrowRight className="h-3.5 w-3.5 mr-2" />
                      Forward
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => deleteEmailMutation.mutate()}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />
                      Remove from project
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>

          {/* Metadata badges */}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {/* Private-and-owner badge — only you see this */}
            {isPrivateAndOwner && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 border-amber-300 text-amber-700 bg-amber-50 gap-1">
                <EyeOff className="h-2.5 w-2.5" />
                Only visible to you
              </Badge>
            )}

            {/* Shared badge for non-owners viewing it */}
            {!isOwner && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 border-blue-200 text-blue-700 bg-blue-50 gap-1">
                <Users className="h-2.5 w-2.5" />
                Shared by {email.from_name || email.from}
              </Badge>
            )}

            {email.labels?.length > 0 && (
              <div className="flex gap-1">
                {email.labels.slice(0, 2).map((label, i) => (
                  <Badge key={i} variant="secondary" className="text-xs px-1.5 py-0">
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Non-owner read-only notice */}
          {!isOwner && (
            <p className="text-[11px] text-muted-foreground mt-1 italic">
              View only — reply from your own inbox if you are part of this thread
            </p>
          )}

          {/* Preview (collapsed) */}
          {!expanded && email.body && (
            <p className="text-sm text-muted-foreground mt-2 line-clamp-2">
              {email.body.replace(/<[^>]*>/g, '')}
            </p>
          )}

          {/* Expanded email body */}
          {expanded && (
            <div className="mt-3 space-y-3 bg-muted/50 rounded-lg p-3 border">
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-muted-foreground">From:</p>
                  <p className="text-sm text-foreground/80">{email.from}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">To:</p>
                  <p className="text-sm text-foreground/80">{email.to?.join(", ")}</p>
                </div>
              </div>

              <div className="border-t pt-3">
                <div
                  className="text-sm text-foreground/80 prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(email.body) }}
                />
              </div>

              {email.attachments?.length > 0 && (
                <div className="border-t pt-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Attachments ({email.attachments.length})
                  </p>
                  <div className="space-y-1">
                    {email.attachments.map((att, i) => (
                      <a
                        key={i}
                        href={att.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
                      >
                        📎 {att.filename}
                        {att.size && <span className="text-muted-foreground/70">({(att.size / 1024).toFixed(1)} KB)</span>}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Reply/Forward compose — owner only, only if account is resolvable */}
      {replyType && isOwner && (
        <EmailComposeDialog
          email={email}
          account={accountForCompose}
          type={replyType}
          onClose={() => setReplyType(null)}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ["project-emails"] });
          }}
          projectId={projectId}
        />
      )}
    </div>
  );
}