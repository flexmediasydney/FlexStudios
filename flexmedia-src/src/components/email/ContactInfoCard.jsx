import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, Copy, Phone, MapPin, Globe } from "lucide-react";
import { toast } from "sonner";

export default function ContactInfoCard({ sender, senderName, allMessages = [] }) {
  const [copied, setCopied] = useState(false);

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(sender);
      setCopied(true);
      toast.success("Email copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy email");
    }
  };

  // Count messages from this sender
  const messageCount = allMessages.filter((m) => m.from === sender).length;
  const firstMessage = allMessages.find((m) => m.from === sender);
  const lastMessage = [...allMessages]
    .reverse()
    .find((m) => m.from === sender);

  const formatDate = (dateStr) => {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return "Unknown";
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Contact Info</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Sender Avatar & Name */}
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-lg font-bold text-primary">
            {(senderName || sender).charAt(0).toUpperCase()}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm">{senderName || sender}</p>
            <p className="text-xs text-muted-foreground truncate">{sender}</p>
          </div>
        </div>

        {/* Email Actions */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={copyEmail}
          >
            <Copy className="h-3 w-3 mr-1" />
            {copied ? "Copied" : "Copy Email"}
          </Button>
        </div>

        {/* Communication Stats */}
        <div className="space-y-2 pt-2 border-t">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Messages from sender</span>
            <Badge variant="secondary">{messageCount}</Badge>
          </div>
          {firstMessage && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">First contact</span>
              <span className="font-medium">
                {formatDate(firstMessage.received_at)}
              </span>
            </div>
          )}
          {lastMessage && messageCount > 1 && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Last contact</span>
              <span className="font-medium">
                {formatDate(lastMessage.received_at)}
              </span>
            </div>
          )}
        </div>

        {/* Quick Tags removed — emails use labels, not tags */}
      </CardContent>
    </Card>
  );
}