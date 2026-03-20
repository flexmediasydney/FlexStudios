import React, { useState } from "react";
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
import { MessageSquare, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function QuickReplyTemplates({ onTemplateSelect, compact = false }) {
  const [templates, setTemplates] = useState([
    { id: 1, name: "Acknowledged", text: "Thank you for reaching out. I've received your message and will get back to you shortly." },
    { id: 2, name: "Will follow up", text: "Thanks for your email. I'm looking into this and will have an update for you within 24 hours." },
    { id: 3, name: "Out of office", text: "I'm currently out of the office and will return on [DATE]. I'll respond to your email then." },
  ]);

  const [showNewTemplate, setShowNewTemplate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");

  const saveTemplate = () => {
    if (!newName.trim() || !newText.trim()) {
      toast.error("Please fill in both name and text");
      return;
    }
    const updated = [...templates, { id: Date.now(), name: newName, text: newText }];
    setTemplates(updated);
    setNewName("");
    setNewText("");
    setShowNewTemplate(false);
    toast.success("Template saved");
  };

  const deleteTemplate = (id) => {
    const updated = templates.filter((t) => t.id !== id);
    setTemplates(updated);
    toast.success("Template deleted");
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
          {templates.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onClick={() => onTemplateSelect(t.text)}
              className="flex-col items-start py-2"
            >
              <p className="font-medium text-sm">{t.name}</p>
              <p className="text-xs text-muted-foreground truncate">{t.text}</p>
            </DropdownMenuItem>
          ))}
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
              <Button size="sm" onClick={saveTemplate}>
                Save
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
          {templates.map((t) => (
            <div
              key={t.id}
              className="p-2 rounded-lg border hover:bg-muted/50 transition-colors group cursor-pointer"
              onClick={() => onTemplateSelect(t.text)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="text-sm font-medium">{t.name}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {t.text}
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
          ))}
        </div>
      </CardContent>
    </Card>
  );
}