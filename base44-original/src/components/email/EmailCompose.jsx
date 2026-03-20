import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, X, FileText } from "lucide-react";
import { toast } from "sonner";

export default function EmailCompose({ account, onClose, onSent }) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [emailError, setEmailError] = useState("");

  const { data: templates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => base44.entities.EmailTemplate.filter({ is_shared: true })
  });

  const validateEmail = (email) => {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
  };

  const validateEmails = () => {
    const toEmails = to.split(',').map(e => e.trim()).filter(Boolean);
    const ccEmails = cc ? cc.split(',').map(e => e.trim()).filter(Boolean) : [];
    
    for (const email of [...toEmails, ...ccEmails]) {
      if (!validateEmail(email)) {
        setEmailError(`Invalid email address: ${email}`);
        return false;
      }
    }
    
    if (toEmails.length === 0) {
      setEmailError("At least one recipient is required");
      return false;
    }
    
    setEmailError("");
    return true;
  };

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!validateEmails()) {
        throw new Error(emailError || "Invalid email format");
      }
      
      const response = await base44.functions.invoke('sendGmailMessage', {
        emailAccountId: account.id,
        to,
        cc: cc || undefined,
        subject,
        body
      });
      
      if (response.data?.error) {
        throw new Error(response.data.error);
      }
      
      return response;
    },
    onSuccess: () => {
      toast.success("Email sent successfully");
      onSent();
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send email");
    }
  });

  const handleTemplateSelect = (templateId) => {
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setSubject(template.subject);
      setBody(template.body);
      setSelectedTemplate(templateId);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && to && subject) { e.preventDefault(); sendMutation.mutate(); }
      }}>
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">From</label>
            <Card className="p-3 bg-muted">
              {account.email_address}
            </Card>
          </div>

          <div>
            <label className="text-sm font-medium">To *</label>
            <Input
              placeholder="recipient@example.com"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setEmailError("");
              }}
              type="email"
              required
              autoFocus
            />
            {emailError && <p className="text-xs text-destructive mt-1">{emailError}</p>}
          </div>

          <div>
            <label className="text-sm font-medium">CC</label>
            <Input
              placeholder="cc@example.com (optional)"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              type="email"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Subject *</label>
            <Input
              placeholder="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              required
            />
          </div>

          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-medium">Message</label>
              {templates.length > 0 && (
                <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                  <SelectTrigger className="w-40 h-8">
                    <FileText className="h-3 w-3 mr-2" />
                    <SelectValue placeholder="Use template..." />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map(t => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <Textarea
              placeholder="Type your message..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
            />
            <p className="text-xs text-muted-foreground text-right mt-1">{body.length} characters</p>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (validateEmails()) {
                  sendMutation.mutate();
                }
              }}
              disabled={sendMutation.isPending || !to.trim() || !subject.trim()}
              className="gap-2"
              title="Ctrl+Enter to send"
            >
              <Send className="h-4 w-4" />
              {sendMutation.isPending ? 'Sending...' : 'Send Email'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}