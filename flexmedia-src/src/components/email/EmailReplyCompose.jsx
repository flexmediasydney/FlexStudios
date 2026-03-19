import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, X } from "lucide-react";
import { toast } from "sonner";

export default function EmailReplyCompose({ thread, account, onClose }) {
  const [body, setBody] = useState("");

  const sendMutation = useMutation({
    mutationFn: () => base44.functions.invoke('sendGmailMessage', {
      emailAccountId: account.id,
      to: thread.messages[0].from,
      subject: `Re: ${thread.subject}`,
      body,
      threadId: thread.threadId
    }),
    onSuccess: () => {
      toast.success("Reply sent successfully");
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send reply");
    }
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Reply</CardTitle>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          placeholder="Type your reply..."
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !body}
            className="gap-2"
          >
            <Send className="h-4 w-4" />
            {sendMutation.isPending ? 'Sending...' : 'Send Reply'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}