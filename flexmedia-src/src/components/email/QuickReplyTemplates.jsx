import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { MessageSquare, Plus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";

const QUICK_REPLY_CATEGORY = "quick_reply";
const QUERY_KEY = ["email-templates", QUICK_REPLY_CATEGORY];

const DEFAULT_TEMPLATES = [
  { name: "Acknowledged", body: "Thank you for reaching out. I've received your message and will get back to you shortly." },
  { name: "Will follow up", body: "Thanks for your email. I'm looking into this and will have an update for you within 24 hours." },
  { name: "Out of office", body: "I'm currently out of the office and will return on [DATE]. I'll respond to your email then." },
];

async function fetchQuickReplyTemplates() {
  const templates = await base44.entities.EmailTemplate.filter(
    { category: QUICK_REPLY_CATEGORY },
    "-created_date",
    100
  );
  return templates;
}

async function seedDefaultTemplates() {
  const created = [];
  for (const t of DEFAULT_TEMPLATES) {
    const record = await base44.entities.EmailTemplate.create({
      name: t.name,
      subject: "",
      body: t.body,
      category: QUICK_REPLY_CATEGORY,
      is_shared: true,
    });
    created.push(record);
  }
  return created;
}

export default function QuickReplyTemplates({ onTemplateSelect, compact = false }) {
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const existing = await fetchQuickReplyTemplates();
      if (existing.length === 0) {
        // First load with empty DB — seed defaults
        const seeded = await seedDefaultTemplates();
        return seeded;
      }
      return existing;
    },
  });

  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.EmailTemplate.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      // Also invalidate the main templates list so TemplateSelector stays in sync
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      setNewName("");
      setNewText("");
      setShowNewTemplate(false);
      toast.success("Template saved");
    },
    onError: () => toast.error("Failed to save template"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.EmailTemplate.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template deleted");
    },
    onError: () => toast.error("Failed to delete template"),
  });

  const saveTemplate = () => {
    if (!newName.trim() || !newText.trim()) {
      toast.error("Please fill in both name and text");
      return;
    }
    createMutation.mutate({
      name: newName.trim(),
      subject: "",
      body: newText.trim(),
      category: QUICK_REPLY_CATEGORY,
      is_shared: true,
    });
  };

  const deleteTemplate = (id) => {
    deleteMutation.mutate(id);
  };

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1">
            <MessageSquare className="h-4 w-4" />
            Templates
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {isLoading ? (
            <div className="flex items-center justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            templates.map((t) => (
              <DropdownMenuItem
                key={t.id}
                onClick={() => onTemplateSelect(t.body)}
                className="flex-col items-start py-2"
              >
                <p className="font-medium text-sm">{t.name}</p>
                <p className="text-xs text-muted-foreground truncate">{t.body}</p>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setShowNewTemplate(!showNewTemplate)}>
            <Plus className="h-4 w-4 mr-2" />
            New Template
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Reply Templates</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowNewTemplate(!showNewTemplate)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showNewTemplate && (
          <div className="space-y-2 p-3 bg-muted rounded-lg">
            <Input
              placeholder="Template name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <Textarea
              placeholder="Template text"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              className="text-xs"
              rows={3}
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveTemplate} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowNewTemplate(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : templates.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No quick reply templates yet
            </p>
          ) : (
            templates.map((t) => (
              <div
                key={t.id}
                className="p-2 rounded-lg border hover:bg-muted/50 transition-colors group cursor-pointer"
                onClick={() => onTemplateSelect(t.body)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {t.body}
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteTemplate(t.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="h-3 w-3 text-destructive" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
