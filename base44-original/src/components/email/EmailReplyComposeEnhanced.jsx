import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Send, X, Plus } from "lucide-react";
import { toast } from "sonner";

export default function EmailReplyComposeEnhanced({ thread, account, onClose }) {
  const [body, setBody] = useState("");
  const [to, setTo] = useState([thread.messages[0].from]);
  const [cc, setCc] = useState([]);
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");

  const msg = thread.messages[0];

  const addToRecipient = () => {
    if (toInput && !to.includes(toInput)) {
      setTo([...to, toInput]);
      setToInput("");
    }
  };

  const addCcRecipient = () => {
    if (ccInput && !cc.includes(ccInput)) {
      setCc([...cc, ccInput]);
      setCcInput("");
    }
  };

  const sendMutation = useMutation({
    mutationFn: () =>
      base44.functions.invoke("sendGmailMessage", {
        emailAccountId: account.id,
        to: to.join(","),
        cc: cc.length > 0 ? cc.join(",") : undefined,
        subject: `Re: ${thread.subject}`,
        body,
        threadId: thread.threadId,
      }),
    onSuccess: () => {
      toast.success("Reply sent successfully");
      onClose();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send reply");
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Reply</CardTitle>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* To Field */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground">To</label>
          <div className="flex gap-2 flex-wrap p-2 bg-muted/30 rounded-md min-h-10">
            {to.map((email) => (
              <Badge key={email} variant="secondary" className="gap-1">
                {email}
                <button
                  onClick={() => setTo(to.filter((e) => e !== email))}
                  className="ml-1 hover:text-destructive"
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
              onKeyPress={(e) => e.key === "Enter" && addToRecipient()}
              className="flex-1 border-0 bg-transparent p-0 h-auto min-w-48 focus-visible:ring-0"
            />
          </div>
        </div>

        {/* CC Field */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-muted-foreground">CC</label>
          <div className="flex gap-2 flex-wrap p-2 bg-muted/30 rounded-md min-h-10">
            {cc.map((email) => (
              <Badge key={email} variant="outline" className="gap-1">
                {email}
                <button
                  onClick={() => setCc(cc.filter((e) => e !== email))}
                  className="ml-1 hover:text-destructive"
                >
                  ✕
                </button>
              </Badge>
            ))}
            <Input
              type="email"
              placeholder="Add CC recipient"
              value={ccInput}
              onChange={(e) => setCcInput(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && addCcRecipient()}
              className="flex-1 border-0 bg-transparent p-0 h-auto min-w-48 focus-visible:ring-0"
            />
          </div>
        </div>

        {/* Body */}
        <div className="space-y-2">
          <Textarea
            placeholder="Type your reply..."
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
          />
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => sendMutation.mutate()}
            disabled={sendMutation.isPending || !body.trim() || to.length === 0}
            className="gap-2"
          >
            <Send className="h-4 w-4" />
            {sendMutation.isPending ? "Sending..." : "Send Reply"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}