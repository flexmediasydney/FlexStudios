import React, { useState, useMemo, useEffect, useRef } from "react";
import { api, supabase } from "@/api/supabaseClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { retryWithBackoff, isTransientError } from "@/lib/networkResilience";
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
  FileText,
  Image as ImageIcon,
  FileArchive,
  File as FileGenericIcon,
  Upload,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import FieldInsertMenu from "./FieldInsertMenu";
import TemplateSelector from "./TemplateSelector";
import SaveAsTemplateModal from "./SaveAsTemplateModal";
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

// ─── Attachment helpers ─────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024;   // 10 MB per file
const MAX_TOTAL_SIZE = 25 * 1024 * 1024;  // 25 MB total

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0) + " " + sizes[i];
}

function getFileIcon(filename, mimeType) {
  const ext = filename?.split(".").pop()?.toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("pdf") || ext === "pdf") return { Icon: FileText, color: "text-red-500" };
  if (mime.includes("image") || ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext))
    return { Icon: ImageIcon, color: "text-blue-500" };
  if (mime.includes("zip") || mime.includes("compressed") || ["zip", "rar", "7z", "tar", "gz"].includes(ext))
    return { Icon: FileArchive, color: "text-amber-500" };
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return { Icon: FileText, color: "text-blue-600" };
  if (["xls", "xlsx", "csv"].includes(ext)) return { Icon: FileText, color: "text-green-600" };
  if (["ppt", "pptx"].includes(ext)) return { Icon: FileText, color: "text-orange-500" };
  return { Icon: FileGenericIcon, color: "text-gray-500" };
}

/**
 * Build the quoted-text HTML block used when replying.
 */
/**
 * Escape HTML special characters to prevent XSS in quoted text metadata.
 * The body is rendered through ReactQuill which handles its own sanitization,
 * but sender names, subjects, and other metadata must be escaped.
 */
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Strip dangerous tags/attributes from email body before embedding in quoted reply.
 * Prevents script injection via the compose editor.
 */
function sanitizeBodyForQuote(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"');
}

function buildQuotedReplyHtml(msg) {
  if (!msg) return "";
  const sender = escapeHtml(msg.from_name || msg.from || "unknown");
  const date = msg.received_at
    ? new Date(msg.received_at).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
    : "";
  const safeBody = sanitizeBodyForQuote(msg.body || "");
  return `<br/><br/><div style="border-left: 2px solid #ccc; padding-left: 12px; margin-left: 4px; color: #666;"><p>On ${escapeHtml(date)}, ${sender} wrote:</p>${safeBody}</div>`;
}

export default function EmailComposeDialog({
  // Primary props
  email: emailProp,
  originalMessage,
  type: typeProp,
  mode: modeProp,
  onClose,
  onSent,
  projectId,
  defaultTo = "",
  defaultProjectId,
  defaultProjectTitle,
  // Backward-compat: simple compose passes account object directly
  account: accountProp,
  defaultBodyPrefix = '',
}) {
  // Normalise aliases so callers can use either name
  const email = emailProp || originalMessage || null;
  const rawType = modeProp || typeProp || "compose";
  const type = rawType === "reply-all" ? "replyAll" : rawType;

  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const [selectedAccount, setSelectedAccount] = useState(accountProp?.id || "");
  const [recipients, setRecipients] = useState(defaultTo || "");

  const initialSubject = type === "forward"
    ? `Fwd: ${email?.subject || ""}`
    : (type === "reply" || type === "replyAll")
    ? (email?.subject?.startsWith("Re:") ? email.subject : `Re: ${email?.subject || ""}`)
    : "";
  const [subject, setSubject] = useState(initialSubject);

  const [cc, setCc] = useState(() => {
    if (type !== "replyAll") return "";
    const ccList = Array.isArray(email?.cc) ? email.cc : (email?.cc ? email.cc.split(",").map(s => s.trim()) : []);
    // Dedup CC — final sender-email exclusion happens in getRecipientsFromEmail
    // but we also remove duplicates here
    const seen = new Set();
    return ccList.filter(addr => {
      const normalized = addr.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    }).join(", ");
  });
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(type === "replyAll");
  const [showBcc, setShowBcc] = useState(false);

  // For reply / replyAll, insert quoted original message
  const initialBody = (type === "reply" || type === "replyAll") ? buildQuotedReplyHtml(email) : "";
  const [body, setBody] = useState(initialBody);

  // Handle quick reply template injection
  const prevPrefixRef = useRef(defaultBodyPrefix);
  useEffect(() => {
    if (defaultBodyPrefix && defaultBodyPrefix !== prevPrefixRef.current) {
      // Prepend template body before the quoted reply
      const quotedStart = body.indexOf('<div class="gmail_quote">') || body.indexOf('<blockquote');
      if (quotedStart > 0) {
        setBody(`<p>${defaultBodyPrefix}</p><br/>` + body.slice(quotedStart));
      } else {
        setBody(`<p>${defaultBodyPrefix}</p><br/>` + body);
      }
      prevPrefixRef.current = defaultBodyPrefix;
    }
  }, [defaultBodyPrefix]);
  const [linkedProject, setLinkedProject] = useState(defaultProjectId || projectId || "");
  const [linkedProjectTitle, setLinkedProjectTitle] = useState(defaultProjectTitle || "");
  const [isPrivate, setIsPrivate] = useState(true);
  const [selectedSignatureId, setSelectedSignatureId] = useState(null);

  // Fetch user signatures for selector
  const { data: userSignatures = [] } = useQuery({
    queryKey: ["user-signatures-compose", user?.id],
    queryFn: () => api.entities.UserSignature.filter({ user_id: user?.id }),
    enabled: !!user?.id,
  });
  const [projectSearch, setProjectSearch] = useState("");
  const [attachments, setAttachments] = useState(() => {
    // Forward: carry over original email's attachments so they're included
    if (type === "forward" && Array.isArray(email?.attachments) && email.attachments.length > 0) {
      return email.attachments.map(att => ({
        filename: att.filename || att.name || 'attachment',
        mime_type: att.mime_type || att.mimeType || 'application/octet-stream',
        size: att.size || 0,
        file_url: att.file_url || att.url || '',
      })).filter(att => att.file_url);
    }
    return [];
  });
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const [uploadProgress, setUploadProgress] = useState(null); // null | 'uploading'
  const [uploadingFiles, setUploadingFiles] = useState([]); // [{name, status: 'uploading'|'done'|'error'}]
  const fileInputRef = React.useRef(null);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");

  // Draft autosave — persists to sessionStorage so it survives accidental closes
  // Use a stable instance ID for new composes to avoid collisions between multiple open dialogs
  const [instanceId] = useState(() => email?.id || email?.gmail_message_id || email?.subject || `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const DRAFT_KEY = `compose-draft-${type}-${instanceId}`;
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
    queryFn: () => api.entities.EmailAccount.filter({
      assigned_to_user_id: user?.id,
      is_active: true
    }),
    enabled: !!user?.id,
  });

  // Fetch templates
  const { data: templates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => api.entities.EmailTemplate.filter({}),
  });

  // Fetch projects for linking
  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.entities.Project.list(),
  });

  // Load agent + agency for the linked project to enable template substitution
  const linkedProjectData = projects.find(p => p.id === linkedProject);

  const { data: linkedAgent } = useQuery({
    queryKey: ['agent-for-template', linkedProjectData?.agent_id],
    queryFn: () => api.entities.Agent.filter({ id: linkedProjectData.agent_id }, null, 1).then(r => r[0]),
    enabled: !!linkedProjectData?.agent_id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: linkedAgency } = useQuery({
    queryKey: ['agency-for-template', linkedProjectData?.agency_id],
    queryFn: () => api.entities.Agency.filter({ id: linkedProjectData.agency_id }, null, 1).then(r => r[0]),
    enabled: !!linkedProjectData?.agency_id,
    staleTime: 5 * 60 * 1000,
  });

  // Set first account as default
  React.useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(emailAccounts[0].id);
    }
  }, [emailAccounts, selectedAccount]);

  // Auto-fill recipient from linked project's agent email when composing from project context
  React.useEffect(() => {
    if (linkedAgent?.email && !recipients && !defaultTo) {
      setRecipients(linkedAgent.email);
    }
  }, [linkedAgent?.email]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prepopulate body for forward type
  React.useEffect(() => {
    if (type === "forward" && email && !body) {
      const fwdBody = `
<br/><br/>
<div style="border-left:2px solid #ccc; padding-left:12px; color:#666; font-size:13px;">
  <p><strong>---------- Forwarded message ----------</strong></p>
  <p><strong>From:</strong> ${escapeHtml(email.from || '')}</p>
  <p><strong>Date:</strong> ${escapeHtml(email.received_at ? new Date(email.received_at).toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }) : '')}</p>
  <p><strong>Subject:</strong> ${escapeHtml(email.subject || '')}</p>
  <p><strong>To:</strong> ${escapeHtml(Array.isArray(email.to) ? email.to.join(', ') : (email.to || ''))}</p>
  <br/>
  ${sanitizeBodyForQuote(email.body || '')}
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
      // Validate email format for all recipient fields
      const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const validateEmails = (field, label) => {
        if (!field.trim()) return;
        const addrs = field.split(",").map(s => s.trim()).filter(Boolean);
        for (const addr of addrs) {
          if (!EMAIL_RE.test(addr)) {
            throw new Error(`Invalid ${label} email address: "${addr}"`);
          }
        }
      };
      validateEmails(recipients, "recipient");
      if (cc.trim()) validateEmails(cc, "CC");
      if (bcc.trim()) validateEmails(bcc, "BCC");
      if (!subject.trim()) {
        throw new Error("Subject required");
      }

      const idemKey = buildIdempotencyKey(recipients, subject, body);
      const response = await retryWithBackoff(() => api.functions.invoke("sendGmailMessage", {
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
        signatureId: selectedSignatureId || undefined,
        idempotency_key: idemKey,
      }), { maxRetries: 2, onRetry: (err, attempt) => console.warn(`Email send retry ${attempt}:`, err.message) });

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
      // Log as ProjectActivity so it appears on the project timeline
      if (linkedProject) {
        api.entities.ProjectActivity.create({
          project_id: linkedProject,
          action: type === "forward" ? 'email_forwarded' : 'email_sent',
          description: `Email ${type === "forward" ? "forwarded" : "sent"}: "${subject}" to ${recipients}`,
          user_name: user?.full_name,
          user_email: user?.email,
        }).catch(() => {});
      }
      setRecipients("");
      setSubject("");
      setBody("");
      setCc("");
      setBcc("");
      setAttachments([]);
      setLinkedProject("");
      // Call onSent if provided (handles close for reply/forward), else fall back to onClose.
      // Avoids double-fire when callers pass onClose as onSent (e.g., EmailComposeReply).
      if (onSent) {
        onSent();
      } else {
        onClose();
      }
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send email");
    },
  });

  // ── Attachment upload logic ──────────────────────────────────────────────
  // NOTE: The Supabase Storage bucket "email-attachments" must exist.
  //       Create it via the Supabase dashboard or SQL:
  //         INSERT INTO storage.buckets (id, name, public)
  //         VALUES ('email-attachments', 'email-attachments', true);

  const currentTotalSize = useMemo(
    () => attachments.reduce((sum, a) => sum + (a.size || 0), 0),
    [attachments]
  );

  const addFiles = async (files) => {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);

    // Validate per-file size
    for (const file of fileList) {
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`"${file.name}" exceeds the 10 MB per-file limit (${formatFileSize(file.size)})`);
        return;
      }
    }

    // Validate total size
    const newTotal = currentTotalSize + fileList.reduce((s, f) => s + f.size, 0);
    if (newTotal > MAX_TOTAL_SIZE) {
      toast.error(`Total attachments would exceed the 25 MB limit (${formatFileSize(newTotal)})`);
      return;
    }

    setUploadProgress('uploading');
    // Show per-file upload status
    const fileStatuses = fileList.map(f => ({ name: f.name, status: 'uploading' }));
    setUploadingFiles(fileStatuses);

    const userId = user?.id || 'anonymous';
    const ts = Date.now();
    let successCount = 0;

    // Upload each file independently — don't lose successful ones if a later file fails
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      try {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = `${userId}/${ts}_${safeName}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('email-attachments')
          .upload(filePath, file);

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('email-attachments')
          .getPublicUrl(uploadData.path);

        // Add this file immediately to attachments (don't wait for batch)
        const uploaded = {
          filename: file.name,
          mime_type: file.type,
          size: file.size,
          file_url: urlData.publicUrl,
        };
        setAttachments((prev) => [...prev, uploaded]);
        successCount++;

        // Update per-file status to done
        setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'done' } : f));
      } catch (error) {
        console.error(`Attachment upload error for "${file.name}":`, error);
        toast.error(`Failed to upload "${file.name}": ${error?.message || 'Unknown error'}`);
        // Mark this file as failed but continue with remaining files
        setUploadingFiles(prev => prev.map((f, idx) => idx === i ? { ...f, status: 'error' } : f));
      }
    }

    if (successCount > 0 && successCount === fileList.length) {
      toast.success(
        successCount === 1
          ? `${fileList[0].name} attached`
          : `${successCount} files attached`
      );
    } else if (successCount > 0) {
      toast.warning(`${successCount} of ${fileList.length} files attached`);
    }

    setUploadProgress(null);
    // Clear per-file statuses after a brief delay so user sees final state
    setTimeout(() => setUploadingFiles([]), 1500);
  };

  const handleAttachFile = (e) => {
    addFiles(e.target.files);
    // Reset input so the same file can be re-selected
    if (e.target) e.target.value = '';
  };

  const removeAttachment = (idx) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Drag & drop handlers (full-dialog drop zone) ─────────────────────────
  const handleDragEnter = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer?.types?.includes('Files')) {
      setIsDragOver(true);
    }
  };
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (e.dataTransfer?.files?.length) {
      addFiles(e.dataTransfer.files);
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
    if (type === "reply") return email?.from || "";
    if (type === "forward") return ""; // forward: user picks a new recipient
    if (type === "replyAll") {
      // Collect all original To recipients + the sender (From)
      const toList = Array.isArray(email?.to) ? email.to : (email?.to ? [email.to] : []);
      const allTo = [email?.from, ...toList].filter(Boolean);

      // CC stays in the CC field (handled separately in useState init)
      // Deduplicate and exclude sender's own email address
      const currentAccountEmail = emailAccounts.find(a => a.id === selectedAccount)?.email_address?.toLowerCase();
      const seen = new Set();
      const deduped = allTo.filter(addr => {
        const normalized = addr.trim().toLowerCase();
        if (seen.has(normalized)) return false;
        if (currentAccountEmail && normalized === currentAccountEmail) return false;
        seen.add(normalized);
        return true;
      });
      return deduped.join(", ");
    }
    return "";
  };

  React.useEffect(() => {
    if (type !== "compose" && !recipients && email) {
      setRecipients(getRecipientsFromEmail());
    }
  }, [type, email, recipients]);

  // Once email accounts load, strip the sender's own email from To/CC (reply-all)
  // and remove CC addresses that duplicate To addresses
  React.useEffect(() => {
    if (type !== "replyAll" || !selectedAccount) return;
    const ownEmail = emailAccounts.find(a => a.id === selectedAccount)?.email_address?.toLowerCase();
    if (!ownEmail) return;

    // Refresh To to exclude self
    if (email) {
      const newTo = getRecipientsFromEmail();
      if (newTo !== recipients) setRecipients(newTo);

      // Clean CC: remove self + any addresses already in To
      if (cc) {
        const toAddrs = new Set(newTo.split(",").map(s => s.trim().toLowerCase()));
        const cleaned = cc.split(",").map(s => s.trim()).filter(addr => {
          const lower = addr.toLowerCase();
          return lower !== ownEmail && !toAddrs.has(lower) && lower.length > 0;
        }).join(", ");
        if (cleaned !== cc) setCc(cleaned);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccount, emailAccounts.length]);

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
        <DialogContent
          className="max-w-5xl w-[95vw] h-[88vh] flex flex-col p-0 bg-card !fixed"
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Full-dialog drag & drop overlay (Gmail-style) */}
          {isDragOver && (
            <div className="absolute inset-0 bg-blue-50/70 backdrop-blur-[2px] border-[3px] border-dashed border-blue-400 rounded-lg flex items-center justify-center z-50 pointer-events-none transition-all duration-150">
              <div className="flex flex-col items-center gap-3 bg-card/80 px-10 py-8 rounded-2xl shadow-lg border border-blue-200">
                <div className="h-14 w-14 rounded-full bg-blue-100 flex items-center justify-center">
                  <Upload className="h-7 w-7 text-blue-600" />
                </div>
                <span className="text-lg font-semibold text-blue-700">Drop files here</span>
                <span className="text-sm text-blue-500">Max 10 MB per file &middot; 25 MB total</span>
              </div>
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between border-b bg-gradient-to-r from-slate-50 to-white px-6 py-5 shadow-sm">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-9 w-9 hover:bg-muted"
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
          <div className="flex flex-1 overflow-hidden bg-card">
            {/* Left Content */}
            <div className="flex-1 overflow-y-auto flex flex-col bg-card">
              <div className="p-6 space-y-5 flex-1">
                {/* From */}
                <div className="space-y-2">
                  <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                    From
                  </label>
                  <Select value={selectedAccount} onValueChange={setSelectedAccount}>
                    <SelectTrigger className="w-full bg-card border-2 hover:border-blue-300">
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
                    className="text-sm bg-card border-2 hover:border-blue-300"
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
                      className="text-sm bg-card border-2 hover:border-blue-300"
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
                      className="text-sm bg-card border-2 hover:border-blue-300"
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
                    className="text-sm bg-card border-2 hover:border-blue-300 font-medium"
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
                    className="bg-card rounded border-2 border-slate-200 flex-1 [&>.ql-container]:h-full [&>.ql-toolbar]:border-b-2 [&>.ql-toolbar]:border-slate-200"
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

                {/* Per-file upload progress indicator */}
                {uploadingFiles.length > 0 && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-1.5 animate-in fade-in duration-200">
                    <p className="text-xs font-semibold text-blue-700">
                      {uploadProgress === 'uploading' ? 'Uploading...' : 'Upload complete'}
                    </p>
                    {uploadingFiles.map((f, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        {f.status === 'uploading' && <Loader2 className="h-3 w-3 animate-spin text-blue-600 flex-shrink-0" />}
                        {f.status === 'done' && <Check className="h-3 w-3 text-green-600 flex-shrink-0" />}
                        {f.status === 'error' && <AlertTriangle className="h-3 w-3 text-red-500 flex-shrink-0" />}
                        <span className={f.status === 'error' ? 'text-red-600 line-through' : 'text-blue-700'}>{f.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Attachments List — enhanced with type icons, sizes, and remove */}
                {attachments.length > 0 && (
                  <div className="space-y-3 p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-bold text-muted-foreground uppercase tracking-wider block">
                        Attachments ({attachments.length})
                      </label>
                      <span className="text-xs text-muted-foreground">
                        {formatFileSize(currentTotalSize)} / 25 MB
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((att, idx) => {
                        const { Icon, color } = getFileIcon(att.filename, att.mime_type);
                        return (
                          <div
                            key={idx}
                            className="flex items-center gap-2 bg-card px-3 py-2 rounded-lg border border-slate-200 text-xs font-medium hover:border-blue-300 transition-colors group"
                          >
                            <Icon className={`h-4 w-4 flex-shrink-0 ${color}`} />
                            <span className="truncate max-w-[160px]" title={att.filename}>
                              {att.filename}
                            </span>
                            <span className="text-muted-foreground/60 flex-shrink-0">
                              {formatFileSize(att.size)}
                            </span>
                            <button
                              onClick={() => removeAttachment(idx)}
                              className="text-muted-foreground hover:text-red-600 transition-colors opacity-60 group-hover:opacity-100"
                              title="Remove attachment"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Bottom Action Bar */}
              <div className="border-t bg-gradient-to-r from-white to-slate-50 px-6 py-4 flex items-center justify-between shadow-sm">
                <div className="flex items-center gap-2">
                  <label htmlFor="attach-file" title="Attach files (max 10 MB each, 25 MB total)">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 hover:bg-muted rounded-full transition-all active:scale-95"
                      asChild
                      disabled={uploadProgress === 'uploading'}
                    >
                      <span>
                        {uploadProgress === 'uploading' ? (
                          <Loader2 className="h-4.5 w-4.5 text-blue-600 animate-spin" />
                        ) : (
                          <Paperclip className="h-4.5 w-4.5 text-blue-600" />
                        )}
                      </span>
                    </Button>
                  </label>
                  <input
                    id="attach-file"
                    ref={fileInputRef}
                    type="file"
                    multiple
                    onChange={handleAttachFile}
                    className="hidden"
                    aria-label="Attach files"
                  />
                  {userSignatures.length > 1 && (
                    <Select value={selectedSignatureId || "default"} onValueChange={(v) => setSelectedSignatureId(v === "default" ? null : v)}>
                      <SelectTrigger className="h-8 w-40 text-xs">
                        <SelectValue placeholder="Signature" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default signature</SelectItem>
                        {userSignatures.map(sig => (
                          <SelectItem key={sig.id} value={sig.id}>
                            {sig.name || `Signature ${userSignatures.indexOf(sig) + 1}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {attachments.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {attachments.length} file{attachments.length !== 1 ? 's' : ''} ({formatFileSize(currentTotalSize)})
                    </span>
                  )}
                </div>

                <div className="flex items-center">
                  <Button
                    onClick={() => {
                      if (sendMutation.isPending || uploadProgress === 'uploading') return;
                      sendMutation.mutate();
                    }}
                    disabled={sendMutation.isPending || uploadProgress === 'uploading' || !recipients.trim() || !subject.trim()}
                    className="bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-md hover:shadow-lg active:scale-95 transition-all rounded-r-none"
                    size="lg"
                  >
                    {(sendMutation.isPending) && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    {sendMutation.isPending ? "Sending…" : (type === "forward" ? "Forward" : "Send")}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="default"
                        size="lg"
                        className="bg-blue-600 hover:bg-blue-700 text-white rounded-l-none border-l border-blue-500 px-2"
                        disabled={sendMutation.isPending || !recipients.trim() || !subject.trim()}
                      >
                        <Clock className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <div className="px-3 py-1.5">
                        <p className="text-xs font-semibold text-muted-foreground">Schedule Send</p>
                      </div>
                      <DropdownMenuSeparator />
                      {[
                        { label: 'In 1 hour', hours: 1 },
                        { label: 'In 2 hours', hours: 2 },
                        { label: 'Tomorrow morning (9 AM)', hours: null, preset: 'tomorrow_morning' },
                        { label: 'Tomorrow afternoon (2 PM)', hours: null, preset: 'tomorrow_afternoon' },
                        { label: 'Next Monday (9 AM)', hours: null, preset: 'next_monday' },
                      ].map(opt => (
                        <DropdownMenuItem key={opt.label} onClick={async () => {
                          let sendAt;
                          const now = new Date();
                          if (opt.hours) {
                            sendAt = new Date(now.getTime() + opt.hours * 60 * 60 * 1000);
                          } else if (opt.preset === 'tomorrow_morning') {
                            sendAt = new Date(now); sendAt.setDate(sendAt.getDate() + 1);
                            sendAt.setHours(9, 0, 0, 0);
                          } else if (opt.preset === 'tomorrow_afternoon') {
                            sendAt = new Date(now); sendAt.setDate(sendAt.getDate() + 1);
                            sendAt.setHours(14, 0, 0, 0);
                          } else if (opt.preset === 'next_monday') {
                            sendAt = new Date(now);
                            const daysUntilMonday = (8 - sendAt.getDay()) % 7 || 7;
                            sendAt.setDate(sendAt.getDate() + daysUntilMonday);
                            sendAt.setHours(9, 0, 0, 0);
                          }
                          try {
                            await api.entities.ScheduledEmail.create({
                              email_account_id: selectedAccount,
                              to: recipients,
                              cc: cc?.trim() || null,
                              bcc: bcc?.trim() || null,
                              subject,
                              body,
                              attachments: attachments.length > 0 ? attachments : null,
                              send_at: sendAt.toISOString(),
                              status: 'pending',
                              in_reply_to: (type === "reply" || type === "replyAll") ? email?.gmail_message_id : null,
                              thread_id: (type === "reply" || type === "replyAll") ? email?.gmail_thread_id : null,
                              created_by: user?.id,
                            });
                            toast.success(`Scheduled for ${sendAt.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`);
                            clearDraft();
                            onClose?.();
                          } catch (err) {
                            toast.error('Failed to schedule: ' + (err?.message || 'Unknown error'));
                          }
                        }}>
                          <Clock className="h-4 w-4 mr-2" />
                          {opt.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
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
                    placeholder={linkedProject ? "Unlink current project to search..." : "Search projects..."}
                    value={linkedProject ? "" : projectSearch}
                    onChange={(e) => {
                      if (!linkedProject) setProjectSearch(e.target.value);
                    }}
                    disabled={!!linkedProject}
                    className="text-sm bg-card border-2 hover:border-blue-300 disabled:opacity-50"
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
                  <div className="border-2 border-slate-200 rounded-lg bg-card flex-1 overflow-y-auto shadow-sm">
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