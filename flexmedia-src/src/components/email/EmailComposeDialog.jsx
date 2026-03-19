import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Paperclip,
  Loader2,
  ArrowLeft,
  Lock,
  LockOpen,
  X,
  Check,
  AlertTriangle,
  Clock,
  Search,
} from "lucide-react";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import FieldInsertMenu from "./FieldInsertMenu";
import TemplateSelector from "./TemplateSelector";
import SaveAsTemplateModal from "./SaveAsTemplateModal";
import FieldPlaceholder from "./FieldPlaceholder";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import { toast } from "sonner";
import { writeFeedEvent } from "@/components/notifications/createNotification";

/**
 * Replace all {{token}} placeholders in a string using a flat context map.
 * Unresolved tokens are left as-is so the user can spot them.
 */
function substituteTemplateVars(text, context = {}) {
  if (!text) return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const val = context[key.trim()];
    return val !== undefined && val !== null && val !== '' ? String(val) : match;
  });
}

/**
 * Build a flat substitution context from available compose-time data.
 */
function buildTemplateContext({ project, agent, agency, currentUser }) {
  const ctx = {};

  if (agent) {
    const nameParts = (agent.name || '').split(' ');
    ctx['agent_first_name'] = nameParts[0] || '';
    ctx['agent_last_name'] = nameParts.slice(1).join(' ') || '';
    ctx['agent_email'] = agent.email || '';
    ctx['agent_phone'] = agent.phone || '';
    ctx['agent_company'] = agent.current_agency_name || agency?.name || '';
  }

  if (agency) {
    ctx['agency_name'] = agency.name || '';
    ctx['agency_email'] = agency.email || '';
    ctx['agency_phone'] = agency.phone || '';
  }

  if (project) {
    ctx['project_title'] = project.title || project.property_address || '';
    ctx['project_address'] = project.property_address || '';
    ctx['project_shoot_date'] = project.shoot_date
      ? new Date(project.shoot_date).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    ctx['project_delivery_date'] = project.delivery_date
      ? new Date(project.delivery_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
      : '';
    ctx['project_price'] = project.calculated_price || project.price
      ? `$${(project.calculated_price || project.price).toLocaleString()}`
      : '';
  }

  if (currentUser) {
    ctx['user_name'] = currentUser.full_name || '';
    ctx['user_email'] = currentUser.email || '';
  }

  ctx['current_date'] = new Date().toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  return ctx;
}

/**
 * Generate an idempotency key before sending
 */
function buildIdempotencyKey(to, subject, body) {
  const raw = `${to}|${subject}|${(body || '').slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return `send_${Math.abs(hash)}_${Math.floor(Date.now() / 60000)}`;
}

const modules = {
  toolbar: [
    [{ font: [] }],
    ["bold", "italic", "underline"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link", "image"],
    [{ align: [] }],
    ["code-block"],
    ["clean"],
  ],
};

const formats = [
  "font",
  "bold",
  "italic",
  "underline",
  "list",
  "bullet",
  "link",
  "image",
  "align",
  "code-block",
];

export default function EmailComposeDialog({
  email,
  type = "compose",
  onClose,
  onSent,
  projectId,
  defaultTo = "",
  defaultProjectId,
  defaultProjectTitle,
}) {
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [selectedAccount, setSelectedAccount] = useState("");
  const [recipients, setRecipients] = useState(defaultTo || "");
  const [subject, setSubject] = useState(
    type === "forward"
      ? `Fwd: ${email?.subject || ""}`
      : (type === "reply" || type === "replyAll")
      ? `Re: ${email?.subject || ""}`
      : ""
  );
  const [cc, setCc] = useState(type === "replyAll" ? (email?.cc?.join(", ") || "") : "");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(type === "replyAll");
  const [showBcc, setShowBcc] = useState(false);
  const [body, setBody] = useState("");
  const [linkedProject, setLinkedProject] = useState(defaultProjectId || projectId || "");
  const [linkedProjectTitle, setLinkedProjectTitle] = useState(defaultProjectTitle || "");
  const [isPrivate, setIsPrivate] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");

  // Draft autosave — persists to sessionStorage so it survives accidental closes
  const DRAFT_KEY = `compose-draft-${type}-${email?.id || 'new'}`;
  React.useEffect(() => {
    const saved = sessionStorage.getItem(DRAFT_KEY);
    if (saved) {
      try {
        const { savedBody, savedSubject, savedRecipients, savedCc } = JSON.parse(saved);
        if (savedBody && !body) setBody(savedBody);
        if (savedSubject && !subject) setSubject(savedSubject);
        if (savedRecipients && !recipients) setRecipients(savedRecipients);
        if (savedCc && !cc) setCc(savedCc);
      } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // only on mount

  React.useEffect(() => {
    if (!body && !subject && !recipients) return; // don't save empty drafts
    const timer = setTimeout(() => {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ savedBody: body, savedSubject: subject, savedRecipients: recipients, savedCc: cc }));
    }, 800);
    return () => clearTimeout(timer);
  }, [body, subject, recipients, cc, DRAFT_KEY]);

  // Clear draft on successful send (called in onSuccess below)
  const clearDraft = () => sessionStorage.removeItem(DRAFT_KEY);

  // Fetch only email accounts belonging to the current user
  const { data: emailAccounts = [] } = useQuery({
    queryKey: ["email-accounts", user?.id],
    queryFn: () => base44.entities.EmailAccount.filter({
      assigned_to_user_id: user?.id,
      is_active: true
    }),
    enabled: !!user?.id,
  });

  // Fetch templates
  const { data: templates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => base44.entities.EmailTemplate.filter({}),
  });

  // Fetch projects for linking
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => base44.entities.Project.list(),
  });

  // Load agent + agency for the linked project to enable template substitution
  const linkedProjectData = projects.find(p => p.id === linkedProject);

  const { data: linkedAgent } = useQuery({
    queryKey: ['agent-for-template', linkedProjectData?.agent_id],
    queryFn: () => base44.entities.Agent.filter({ id: linkedProjectData.agent_id }, null, 1).then(r => r[0]),
    enabled: !!linkedProjectData?.agent_id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: linkedAgency } = useQuery({
    queryKey: ['agency-for-template', linkedProjectData?.agency_id],
    queryFn: () => base44.entities.Agency.filter({ id: linkedProjectData.agency_id }, null, 1).then(r => r[0]),
    enabled: !!linkedProjectData?.agency_id,
    staleTime: 5 * 60 * 1000,
  });

  // Set first account as default
  React.useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(emailAccounts[0].id);
    }
  }, [emailAccounts, selectedAccount]);

  // Prepopulate body for forward type
  React.useEffect(() => {
    if (type === "forward" && email && !body) {
      const fwdBody = `
<br/><br/>
<div style="border-left:2px solid #ccc; padding-left:12px; color:#666; font-size:13px;">
  <p><strong>---------- Forwarded message ----------</strong></p>
  <p><strong>From:</strong> ${email.from || ''}</p>
  <p><strong>Date:</strong> ${email.received_at ? new Date(email.received_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : ''}</p>
  <p><strong>Subject:</strong> ${email.subject || ''}</p>
  <p><strong>To:</strong> ${email.to || ''}</p>
  <br/>
  ${email.body || ''}
</div>`;
      setBody(fwdBody);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, email?.id]);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAccount) {
        throw new Error("No email account selected");
      }
      if (!recipients.trim()) {
        throw new Error("Recipients required");
      }
      if (!subject.trim()) {
        throw new Error("Subject required");
      }

      setIsLoading(true);

      const idemKey = buildIdempotencyKey(recipients, subject, body);
      const response = await base44.functions.invoke("sendGmailMessage", {
        emailAccountId: selectedAccount,
        to: recipients,
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject,
        body,
        inReplyTo: (type === "reply" || type === "replyAll") ? email?.gmail_message_id : undefined,
        threadId: (type === "reply" || type === "replyAll") ? email?.gmail_thread_id : undefined,
        projectId: linkedProject || undefined,
        isPrivate,
        attachments: attachments.length > 0 ? attachments : undefined,
        idempotency_key: idemKey,
      });

      setIsLoading(false);
      return response;
    },
    onSuccess: () => {
      toast.success(type === "forward" ? "Email forwarded" : "Email sent");
      clearDraft();
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      queryClient.invalidateQueries({ queryKey: ["project-emails"] });
      // Feed event for email sent
      writeFeedEvent({
        eventType: type === "forward" ? 'email_forwarded' : 'email_sent',
        category: 'email', severity: 'info',
        actorId: user?.id, actorName: user?.full_name,
        title: type === "forward" ? `Email forwarded: ${subject}` : `Email sent: ${subject}`,
        description: `To: ${recipients}`,
        projectId: linkedProject || null,
        entityType: 'email',
      }).catch(() => {});
      setRecipients("");
      setSubject("");
      setBody("");
      setCc("");
      setBcc("");
      setAttachments([]);
      setLinkedProject("");
      onSent?.();
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send email");
      setIsLoading(false);
    },
  });

  const handleAttachFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Upload to Supabase Storage (email-attachments bucket)
      const supabase = base44._supabase;
      const filePath = `${selectedAccount}/${Date.now()}-${file.name}`;
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('email-attachments')
        .upload(filePath, file);
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from('email-attachments')
        .getPublicUrl(uploadData.path);

      setAttachments([
        ...attachments,
        {
          filename: file.name,
          mime_type: file.type,
          size: file.size,
          file_url: urlData.publicUrl,
        },
      ]);
      toast.success(`${file.name} attached`);
    } catch (error) {
      console.error('Attachment upload error:', error);
      toast.error(error?.message || "Failed to attach file");
    }
  };

  const handleApplyTemplate = (template) => {
    const ctx = buildTemplateContext({
      project: linkedProjectData || null,
      agent: linkedAgent || null,
      agency: linkedAgency || null,
      currentUser: user,
    });

    const resolvedSubject = substituteTemplateVars(template.subject, ctx);
    const resolvedBody = substituteTemplateVars(template.body, ctx);

    setSubject(resolvedSubject);
    setBody(resolvedBody);

    const remainingTokens = [
      ...(resolvedSubject.match(/\{\{[^}]+\}\}/g) || []),
      ...(resolvedBody.match(/\{\{[^}]+\}\}/g) || []),
    ];
    if (remainingTokens.length > 0) {
      const unique = [...new Set(remainingTokens)];
      toast.warning(
        `${unique.length} field${unique.length > 1 ? 's' : ''} couldn't be filled: ${unique.join(', ')}. Link a project to resolve them.`,
        { duration: 5000 }
      );
    } else {
      toast.success(`Template "${template.name}" applied`);
    }
  };

  const getTitle = () => {
    if (type === "forward") return "Forward Email";
    if (type === "replyAll") return "Reply All";
    if (type === "reply") return "Reply to Email";
    return "New Email";
  };

  const getRecipientsFromEmail = () => {
    if (type === "reply" || type === "forward") return email?.from || "";
    if (type === "replyAll") {
      const all = [email?.from, ...email?.cc || []].filter(Boolean).join(", ");
      return all;
    }
    return "";
  };

  React.useEffect(() => {
    if (type !== "compose" && !recipients && email) {
      setRecipients(getRecipientsFromEmail());
    }
  }, [type, email, recipients]);

  const selectedProjectData = projects.find((p) => p.id === linkedProject);
  const filteredProjects = projects.filter((p) =>
    projectSearch
      ? p.title.toLowerCase().includes(projectSearch.toLowerCase()) ||
        p.property_address?.toLowerCase().includes(projectSearch.toLowerCase())
      : false
  );

  return (
    <>
      <Dialog open onOpenChange={onClose}>
        <DialogContent className="max-w-6xl h-[92vh] flex flex-col p-0 bg-white">
          {/* Header */}
          <div className="flex items-center justify-between border-b bg-gradient-to-r from-slate-50 to-white px-6 py-5 shadow-sm">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-9 w-9 hover:bg-slate-100"
                title="Close (Esc)"
              >
                <ArrowLeft className="h-5 w-5 text-slate-600" />
              </Button>
              <div>
                <h2 className="font-bold text-base text-foreground">{getTitle()}</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Draft autosaved</p>
              </div>
            </div>
            <Button
              onClick={() => setIsPrivate(!isPrivate)}
              variant={isPrivate ? "outline" : "secondary"}
              size="sm"
              title={isPrivate ? "Private to you — click to share" : "Shared with team — click to make private"}
              className="gap-2 font-medium"
            >
              {isPrivate ? (
                <>
                  <Lock className="h-4 w-4" />
                  Private
                </>
              ) : (
                <>
                  <LockOpen className="h-4 w-4" />
                  Shared
                </>
              )}
            </Button>
          </div>

          {/* Main Content */}
          <div className="flex flex-1 overflow-hidden bg-white">
            {/* Left Content */}
            <div className="flex-1 overflow-y-auto flex flex-col bg-white">
              <div className="p-6 space-y-5 flex-1">
                {/* From */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    From
                  </label>
                  <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                    <SelectTrigger className="w-full bg-white border-2 hover:border-blue-300">
                      <SelectValue placeholder="Select email account" />
                    </SelectTrigger>
                    <SelectContent>
                      {emailAccounts.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          <span className="font-medium">{account.email_address}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Recipients */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">To</label>
                    <div className="flex gap-3">
                      {!showCc && (
                        <button
                          type="button"
                          onClick={() => setShowCc(true)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-700 transition-colors"
                        >
                          + Cc
                        </button>
                      )}
                      {!showBcc && (
                        <button
                          type="button"
                          onClick={() => setShowBcc(true)}
                          className="text-xs font-bold text-blue-600 hover:text-blue-700 transition-colors"
                        >
                          + Bcc
                        </button>
                      )}
                    </div>
                  </div>
                  <Input
                    placeholder="recipient@example.com"
                    value={recipients}
                    onChange={(e) => setRecipients(e.target.value)}
                    className="text-sm bg-white border-2 hover:border-blue-300"
                    required
                  />
                </div>

                {/* CC — shown on demand or when replyAll */}
                {showCc && (
                  <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Cc</label>
                    <Input
                      placeholder="cc@example.com"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      className="text-sm bg-white border-2 hover:border-blue-300"
                    />
                  </div>
                )}

                {/* BCC — shown on demand */}
                {showBcc && (
                  <div className="space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Bcc</label>
                    <Input
                      placeholder="bcc@example.com"
                      value={bcc}
                      onChange={(e) => setBcc(e.target.value)}
                      className="text-sm bg-white border-2 hover:border-blue-300"
                    />
                  </div>
                )}

                {/* Subject */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    Subject
                  </label>
                  <Input
                    placeholder="Enter email subject..."
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="text-sm bg-white border-2 hover:border-blue-300 font-medium"
                    required
                  />
                </div>

                {/* Templates and Insert Fields Toolbar */}
                <div className="border-t border-b bg-slate-50 px-4 py-3 flex items-center gap-3 flex-wrap">
                  <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Tools:</p>
                  <TemplateSelector
                    onSelectTemplate={(template) => handleApplyTemplate(template)}
                    onSaveAsTemplate={() => setShowSaveTemplate(true)}
                  />
                  <div className="h-5 border-r border-slate-300" />
                  <FieldInsertMenu onInsert={(field) => {
                    const placeholder = `<span class="ql-placeholder">${field}</span>`;
                    setBody(body + placeholder);
                  }} />
                </div>

                {/* Rich Text Editor */}
                <div className="space-y-2 flex-1 flex flex-col">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    Message
                  </label>
                  <ReactQuill
                    value={body}
                    onChange={setBody}
                    modules={modules}
                    formats={formats}
                    placeholder="Write your message..."
                    className="bg-white rounded border-2 border-slate-200 flex-1 [&>.ql-container]:h-full [&>.ql-toolbar]:border-b-2 [&>.ql-toolbar]:border-slate-200"
                  />
                  {body && /\{\{[^}]+\}\}/.test(body) && (
                    <div className="bg-amber-50 border border-amber-200 rounded p-3 flex gap-2 text-xs text-amber-800">
                      <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-medium">Unresolved fields</p>
                        <p className="mt-1">Link a project or edit manually before sending: {[...new Set(body.match(/\{\{[^}]+\}\}/g) || [])].join(', ')}</p>
                      </div>
                    </div>
                  )}
                </div>

                 {/* Attachments List */}
                {attachments.length > 0 && (
                  <div className="space-y-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block">
                      Attachments ({attachments.length})
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((att, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 bg-white px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium hover:border-blue-300 transition-colors"
                        >
                          <Paperclip className="h-3.5 w-3.5 text-blue-600" />
                          <span className="truncate max-w-xs">{att.filename}</span>
                          <button
                            onClick={() =>
                              setAttachments(attachments.filter((_, i) => i !== idx))
                            }
                            className="text-muted-foreground hover:text-red-600 transition-colors"
                            title="Remove attachment"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Bottom Action Bar */}
              <div className="border-t bg-gradient-to-r from-white to-slate-50 px-6 py-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2">
                  <label htmlFor="attach-file" title="Attach file">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 hover:bg-slate-100 rounded-full transition-all active:scale-95"
                      asChild
                    >
                      <span>
                        <Paperclip className="h-4.5 w-4.5 text-blue-600" />
                      </span>
                    </Button>
                  </label>
                  <input
                    id="attach-file"
                    type="file"
                    onChange={handleAttachFile}
                    className="hidden"
                    aria-label="Attach file"
                  />
                </div>

                <Button
                  onClick={() => {
                    if (sendMutation.isPending || isLoading) return;
                    sendMutation.mutate();
                  }}
                  disabled={isLoading || sendMutation.isPending || !recipients.trim() || !subject.trim()}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-md hover:shadow-lg active:scale-95 transition-all"
                  size="lg"
                >
                  {(sendMutation.isPending || isLoading) && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {sendMutation.isPending ? "Sending…" : (type === "forward" ? "Forward" : "Send")}
                </Button>
              </div>
            </div>

            {/* Right Sidebar */}
            <div className="w-80 border-l bg-gradient-to-b from-slate-50 to-white p-6 flex flex-col shadow-inner">
              <div className="mb-5">
                <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-1">
                  Link To Project
                </h3>
                <p className="text-xs text-muted-foreground/60">Auto-populate fields with project data</p>
              </div>

              <div className="space-y-4 flex-1 flex flex-col">
                <div className="relative">
                  <Input
                    placeholder="Search projects..."
                    value={linkedProject ? "" : projectSearch}
                    onChange={(e) => {
                      setProjectSearch(e.target.value);
                    }}
                    className="text-sm bg-white border-2 hover:border-blue-300"
                    aria-label="Search projects"
                  />
                  {projectSearch && (
                    <button
                      onClick={() => setProjectSearch("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>

                {linkedProject && selectedProjectData && (
                  <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-4 flex justify-between items-start">
                    <div className="flex-1">
                      <p className="text-sm font-bold text-emerald-900">
                        {selectedProjectData.title}
                      </p>
                      <p className="text-xs text-emerald-800/70 mt-1.5">
                        {selectedProjectData.property_address}
                      </p>
                      <p className="text-xs text-emerald-700 mt-2 font-semibold">✓ Linked</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 -mr-1 -mt-1 hover:bg-red-100 text-red-600"
                      onClick={() => {
                        setLinkedProject("");
                        setLinkedProjectTitle("");
                        setProjectSearch("");
                      }}
                      title="Unlink project"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}

                {projectSearch && filteredProjects.length > 0 && (
                  <div className="border-2 border-slate-200 rounded-lg bg-white flex-1 overflow-y-auto shadow-sm">
                    {filteredProjects.map((project) => (
                      <button
                        key={project.id}
                        onClick={() => {
                          setLinkedProject(project.id);
                          setLinkedProjectTitle(project.title);
                          setProjectSearch("");
                        }}
                        className="w-full text-left p-3 border-b last:border-b-0 hover:bg-blue-50 transition-all active:bg-blue-100/40"
                      >
                        <p className="text-xs font-bold text-foreground">
                          {project.title}
                        </p>
                        <p className="text-xs text-muted-foreground/70 mt-1">
                          {project.property_address}
                        </p>
                      </button>
                    ))}
                  </div>
                )}

                {projectSearch && filteredProjects.length === 0 && (
                  <div className="text-center py-12 px-3">
                    <Search className="h-8 w-8 text-muted-foreground/20 mx-auto mb-2" />
                    <p className="text-xs text-muted-foreground font-medium">
                      No projects found
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Save as Template Modal */}
      {showSaveTemplate && (
        <SaveAsTemplateModal
          subject={subject}
          body={body}
          onClose={() => setShowSaveTemplate(false)}
        />
      )}
    </>
  );
}