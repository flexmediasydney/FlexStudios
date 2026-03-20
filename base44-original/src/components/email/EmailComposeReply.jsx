import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

const replyQuillModules = {
  toolbar: [
    ["bold", "italic", "underline"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link"],
    ["clean"],
  ],
};
import { Badge } from "@/components/ui/badge";
import { Send, X, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function EmailComposeReply({ thread, account, onClose, onReplyMode, emailAccounts = [] }) {
   // Always reply to the most recent message in the thread, not the first
   const latestMsg = thread.messages[thread.messages.length - 1];

   const [body, setBody] = useState("");
   const [to, setTo] = useState([latestMsg.from]);
   const [cc, setCc] = useState([]);
   const [toInput, setToInput] = useState("");
   const [ccInput, setCcInput] = useState("");
   const [fromEmail, setFromEmail] = useState(account?.email_address);
   const [replyMode, setReplyMode] = useState('reply');

  const msg = latestMsg;

  const addRecipient = (email, type) => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;

    if (type === "to") {
      if (!to.includes(trimmedEmail)) {
        setTo([...to, trimmedEmail]);
      }
      setToInput("");
    } else if (type === "cc") {
      if (!cc.includes(trimmedEmail)) {
        setCc([...cc, trimmedEmail]);
      }
      setCcInput("");
    }
  };

  const removeRecipient = (email, type) => {
    if (type === "to") {
      setTo(to.filter((e) => e !== email));
    } else if (type === "cc") {
      setCc(cc.filter((e) => e !== email));
    }
  };

  const sendMutation = useMutation({
    mutationFn: () => {
      const selectedAccount = emailAccounts.find(a => a.email_address === fromEmail) || account;
      return base44.functions.invoke("sendGmailMessage", {
        emailAccountId: selectedAccount.id,
        to: to.join(","),
        cc: cc.length > 0 ? cc.join(",") : undefined,
        subject: thread.subject?.startsWith('Re:') ? thread.subject : `Re: ${thread.subject}`,
        body,
        threadId: thread.threadId,
        inReplyTo: latestMsg.gmail_message_id, // Required for Gmail to thread the reply correctly
      });
    },
    onSuccess: () => {
      toast.success("Reply sent");
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send reply");
    },
  });

  return (
    <Card className="border-0 rounded-lg">
      <CardContent className="p-0">
        {/* Reply Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 rounded-t-lg">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Reply to: {msg.from_name || msg.from}</span>
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1 text-xs">
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-32">
                <DropdownMenuItem onClick={() => { setReplyMode('reply'); onReplyMode?.("reply"); }}>
                  Reply
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setReplyMode('reply_all'); if (latestMsg.cc?.length > 0) { setCc(latestMsg.cc); } }}>
                  Reply All
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setReplyMode('forward'); setToInput(''); setTo([]); }}>
                  Forward
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Recipients Section */}
         <div className="px-4 py-3 space-y-2 border-b">
           {/* From */}
           <div className="flex items-center gap-2">
             <span className="font-semibold text-xs text-muted-foreground">From:</span>
             {emailAccounts.length > 1 ? (
               <DropdownMenu>
                 <DropdownMenuTrigger asChild>
                   <Button variant="outline" size="sm" className="gap-2 h-7 text-xs">
                     {fromEmail}
                     <ChevronDown className="h-3 w-3" />
                   </Button>
                 </DropdownMenuTrigger>
                 <DropdownMenuContent align="start">
                   {emailAccounts.map(acc => (
                     <DropdownMenuItem
                       key={acc.id}
                       onClick={() => setFromEmail(acc.email_address)}
                       className={fromEmail === acc.email_address ? 'bg-muted' : ''}
                     >
                       {acc.email_address}
                     </DropdownMenuItem>
                   ))}
                 </DropdownMenuContent>
               </DropdownMenu>
             ) : (
               <span className="text-sm">{fromEmail || "Select account"}</span>
             )}
           </div>

          {/* To */}
          <div className="text-xs">
            <span className="font-semibold text-muted-foreground mr-2">To:</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {to.map((email) => (
                <Badge key={email} variant="secondary" className="gap-1">
                  {email}
                  <button
                    onClick={() => removeRecipient(email, "to")}
                    className="ml-1 hover:opacity-70"
                  >
                    ✕
                  </button>
                </Badge>
              ))}
              <Input
                type="email"
                placeholder="Add recipient"
                value={toInput}
                onChange={(e) => setToInput(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRecipient(toInput, "to");
                  }
                }}
                className="border-0 bg-transparent p-0 h-auto text-xs min-w-40 focus-visible:ring-0"
              />
            </div>
          </div>

          {/* CC */}
          <div className="text-xs">
            <span className="font-semibold text-muted-foreground mr-2">CC:</span>
            <div className="flex flex-wrap gap-2 mt-1">
              {cc.map((email) => (
                <Badge key={email} variant="outline" className="gap-1">
                  {email}
                  <button
                    onClick={() => removeRecipient(email, "cc")}
                    className="ml-1 hover:opacity-70"
                  >
                    ✕
                  </button>
                </Badge>
              ))}
              <Input
                type="email"
                placeholder="Add CC"
                value={ccInput}
                onChange={(e) => setCcInput(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRecipient(ccInput, "cc");
                  }
                }}
                className="border-0 bg-transparent p-0 h-auto text-xs min-w-40 focus-visible:ring-0"
              />
            </div>
          </div>
        </div>

        {/* Compose Body */}
        <div className="p-4 space-y-3">
          <ReactQuill
            theme="snow"
            value={body}
            onChange={setBody}
            modules={replyQuillModules}
            placeholder="Compose your reply..."
            style={{ minHeight: "160px" }}
          />

          {/* Action Buttons */}
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-2">
              {/* Quick actions could go here */}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} size="sm">
                Discard
              </Button>
              <Button
                onClick={() => sendMutation.mutate()}
                disabled={sendMutation.isPending || !body.replace(/<[^>]*>/g, '').trim() || to.length === 0}
                className="gap-2"
                size="sm"
              >
                <Send className="h-4 w-4" />
                {sendMutation.isPending ? "Sending..." : "Send"}
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}