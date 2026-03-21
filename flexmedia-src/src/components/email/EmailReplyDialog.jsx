import { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function EmailReplyDialog({ email, account, type = "reply", onClose, onSent }) {
  const [body, setBody] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const sendMutation = useMutation({
    mutationFn: async () => {
      setIsLoading(true);
      const response = await api.functions.invoke('sendGmailMessage', {
        to: type === "reply" ? email.from : (type === "replyAll" ? [email.from, ...email.cc].join(", ") : email.from),
        subject: `Re: ${email.subject}`,
        body,
        inReplyTo: email.gmail_message_id,
        threadId: email.gmail_thread_id
      });
      setIsLoading(false);
      return response;
    },
    onSuccess: () => {
      toast.success("Email sent");
      setBody("");
      onSent?.();
      onClose();
    },
    onError: (error) => {
      toast.error("Failed to send email");
      setIsLoading(false);
    }
  });

  const getTitle = () => {
    if (type === "forward") return "Forward Email";
    if (type === "replyAll") return "Reply All";
    return "Reply to Email";
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="bg-gray-50 p-3 rounded border border-gray-200">
            <p className="text-xs font-medium text-gray-600">To:</p>
            <p className="text-sm text-gray-900 mt-1">
              {type === "replyAll" ? [email.from, ...email.cc].join(", ") : email.from}
            </p>
            <p className="text-xs font-medium text-gray-600 mt-2">Subject:</p>
            <p className="text-sm text-gray-900">Re: {email.subject}</p>
          </div>

          <div>
            <Textarea
              placeholder="Write your reply..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[200px]"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => sendMutation.mutate()}
              disabled={isLoading || !body.trim()}
            >
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Send
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}