import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { toast } from "sonner";

export default function SaveAsTemplateModal({ subject, body, onClose }) {
  const [name, setName] = useState("");
  const [isShared, setIsShared] = useState(false);
  const queryClient = useQueryClient();

  const saveMutation = useMutation({
    mutationFn: (data) => api.entities.EmailTemplate.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template saved");
      onClose();
    },
    onError: () => toast.error("Failed to save template"),
  });

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }
    if (!subject?.trim()) {
      toast.error("Subject line is required");
      return;
    }
    const strippedBody = (body || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!strippedBody) {
      toast.error("Template body cannot be empty");
      return;
    }

    saveMutation.mutate({
      name: name.trim(),
      subject: subject.trim(),
      body: body.trim(),
      is_shared: isShared,
      category: "custom",
    });
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <DialogTitle>Save as template</DialogTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Template name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Welcome Email"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Visibility</label>
            <Select value={isShared ? "shared" : "private"} onValueChange={(val) => setIsShared(val === "shared")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="shared">Shared</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-2 justify-end pt-4">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}