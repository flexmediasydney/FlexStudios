import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, Signature, Save, Plus, X } from "lucide-react";
import { toast } from "sonner";

function sanitizeSignatureHtml(html) {
  if (!html) return '';
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  clean = clean.replace(/(href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"');
  clean = clean.replace(/(href|src|action)\s*=\s*(?:"data:[^"]*"|'data:[^']*')/gi, 'href="#"');
  clean = clean.replace(/<base\b[^>]*>/gi, '');
  clean = clean.replace(/<\/?form\b[^>]*>/gi, '');
  return clean;
}

export default function EmailSettings({ onClose }) {
  const queryClient = useQueryClient();

  const { data: user } = useQuery({
    queryKey: ["current-user"],
    queryFn: () => api.auth.me()
  });

  const { data: signature } = useQuery({
    queryKey: ["user-signature", user?.id],
    queryFn: () => user ? api.entities.UserSignature.filter({ user_id: user.id }).then(res => res[0]) : null,
    enabled: !!user
  });

  const { data: templates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => api.entities.EmailTemplate.list("-created_date", 50)
  });

  const [signatureHtml, setSignatureHtml] = useState("");
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);

  // Sync signature state once the query resolves
  useEffect(() => {
    if (signature?.signature_html && !signatureHtml) {
      setSignatureHtml(signature.signature_html);
    }
  }, [signature?.signature_html]);
  const [templateName, setTemplateName] = useState("");
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");

  const updateSignatureMutation = useMutation({
    mutationFn: async () => {
      const cleanHtml = signatureHtml?.trim();
      if (!cleanHtml || cleanHtml === '<p><br></p>' || cleanHtml === '<p></p>') {
        throw new Error("Signature cannot be empty");
      }
      if (signature?.id) {
        await api.entities.UserSignature.update(signature.id, { signature_html: cleanHtml });
      } else {
        await api.entities.UserSignature.create({
          user_id: user.id,
          user_name: user.full_name,
          user_email: user.email,
          signature_html: cleanHtml,
          is_default: true
        });
      }
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to save signature");
    },
    onSuccess: () => {
      toast.success("Signature updated");
      queryClient.invalidateQueries({ queryKey: ["user-signature"] });
    }
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id) => api.entities.EmailTemplate.delete(id),
    onSuccess: () => {
      toast.success("Template deleted");
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: () => toast.error("Failed to delete template"),
  });

  const createTemplateMutation = useMutation({
    mutationFn: () => api.entities.EmailTemplate.create({
      name: templateName,
      subject: templateSubject,
      body: templateBody,
      category: "custom",
      is_shared: true
    }),
    onSuccess: () => {
      toast.success("Template created");
      setTemplateName("");
      setTemplateSubject("");
      setTemplateBody("");
      setShowTemplateDialog(false);
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    }
  });

  return (
    <>
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Email Settings</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="signature" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signature" className="gap-2">
              <Signature className="h-4 w-4" />
              Signature
            </TabsTrigger>
            <TabsTrigger value="templates" className="gap-2">
              <FileText className="h-4 w-4" />
              Templates
            </TabsTrigger>
          </TabsList>

          <TabsContent value="signature" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Email Signature</CardTitle>
                <p className="text-sm text-muted-foreground">Added to all outgoing emails</p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Signature HTML</label>
                  <Textarea
                    placeholder="<p>Best regards,<br/>Your Name</p>"
                    value={signatureHtml}
                    onChange={(e) => setSignatureHtml(e.target.value)}
                    rows={6}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Use HTML for formatting. Images should be hosted externally.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-medium">Preview</label>
                  <Card className="p-4 bg-muted/50">
                    <div dangerouslySetInnerHTML={{ __html: sanitizeSignatureHtml(signatureHtml) || "(empty)" }} />
                  </Card>
                </div>

                <Button
                  onClick={() => updateSignatureMutation.mutate()}
                  disabled={updateSignatureMutation.isPending}
                  className="gap-2"
                >
                  <Save className="h-4 w-4" />
                  {updateSignatureMutation.isPending ? 'Saving...' : 'Save Signature'}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="templates" className="space-y-4">
            <Button
              onClick={() => setShowTemplateDialog(true)}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              New Template
            </Button>

            <div className="space-y-2">
              {templates.map(template => (
                <Card key={template.id} className="p-4">
                  <div className="flex justify-between items-start gap-2">
                    <div className="flex-1">
                      <h4 className="font-medium">{template.name}</h4>
                      <p className="text-sm text-muted-foreground truncate">{template.subject}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-destructive hover:text-destructive"
                      onClick={() => deleteTemplateMutation.mutate(template.id)}
                      disabled={deleteTemplateMutation.isPending}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>

    {showTemplateDialog && (
      <Dialog open onOpenChange={setShowTemplateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Email Template</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Template Name</label>
              <Input
                placeholder="e.g., Follow-up Email"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium">Subject</label>
              <Input
                placeholder="Email subject"
                value={templateSubject}
                onChange={(e) => setTemplateSubject(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium">Body</label>
              <Textarea
                placeholder="Email body..."
                value={templateBody}
                onChange={(e) => setTemplateBody(e.target.value)}
                rows={8}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowTemplateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => createTemplateMutation.mutate()}
                disabled={createTemplateMutation.isPending || !templateName || !templateSubject}
                className="gap-2"
              >
                <Plus className="h-4 w-4" />
                {createTemplateMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}