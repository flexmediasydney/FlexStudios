import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, Plus, Settings, FileText, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import EditTemplateModal from "./EditTemplateModal";

export default function TemplateSelector({ onSelectTemplate, onSaveAsTemplate }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [showManage, setShowManage] = useState(false);

  const { data: templates = [] } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => api.entities.EmailTemplate.list("-created_date", 100)
  });

  const filteredTemplates = templates.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    t.subject?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="text-xs gap-2">
            <FileText className="h-3 w-3" />
            Choose template
            <ChevronDown className="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="start" className="w-80 p-0">
          <div className="p-3 space-y-3">
            <Input
              placeholder="Search templates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-sm"
            />

            {filteredTemplates.length > 0 ? (
              <div className="max-h-64 overflow-y-auto space-y-1">
                {filteredTemplates.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => {
                      onSelectTemplate(template);
                      setOpen(false);
                      setSearch("");
                    }}
                    className="w-full flex items-center justify-between p-2 rounded hover:bg-muted text-left group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{template.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {template.subject}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                      {!template.is_shared && (
                        <Lock className="h-3 w-3 text-muted-foreground" />
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingTemplate(template);
                          setShowManage(true);
                          setOpen(false);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-accent rounded"
                      >
                        <Settings className="h-3 w-3" />
                      </button>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 text-sm text-muted-foreground">
                {search ? "No templates found" : "No templates yet"}
              </div>
            )}
          </div>

          <DropdownMenuSeparator />

          <div className="p-2 space-y-1">
            <button
              onClick={() => {
                onSaveAsTemplate();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-muted text-left"
            >
              <Plus className="h-3 w-3" />
              Save draft as template
            </button>
            <button
              onClick={() => {
                setShowManage(true);
                setEditingTemplate(null);
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm hover:bg-muted text-left"
            >
              <Settings className="h-3 w-3" />
              Manage templates
            </button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {showManage && (
        <EditTemplateModal
          template={editingTemplate}
          onClose={() => {
            setShowManage(false);
            setEditingTemplate(null);
          }}
        />
      )}
    </>
  );
}