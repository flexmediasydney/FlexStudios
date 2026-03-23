import React, { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import FieldInsertMenu from "./FieldInsertMenu";

const modules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline"],
    ["blockquote", "code-block"],
    [{ list: "ordered" }, { list: "bullet" }],
    ["link"],
  ],
};

export default function EditTemplateModal({ template, onClose }) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isShared, setIsShared] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (template) {
      setName(template.name || "");
      setSubject(template.subject || "");
      setBody(template.body || "");
      setIsShared(!!template.is_shared);
    }
  }, [template]);

  const createMutation = useMutation({
    mutationFn: (data) => api.entities.EmailTemplate.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template created");
      onClose();
    },
    onError: () => toast.error("Failed to create template"),
  });

  const updateMutation = useMutation({
    mutationFn: (data) => api.entities.EmailTemplate.update(template.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template updated");
      onClose();
    },
    onError: () => toast.error("Failed to update template"),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.entities.EmailTemplate.delete(template.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
      toast.success("Template deleted");
      onClose();
    },
    onError: () => toast.error("Failed to delete template"),
  });

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }
    if (!subject.trim()) {
      toast.error("Subject is required");
      return;
    }

    const payload = {
      name: name.trim(),
      subject: subject.trim(),
      body,
      is_shared: isShared,
    };

    if (template) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate({ ...payload, category: "custom" });
    }
  };

  const handleInsertField = (field) => {
    const newBody = body + " " + field;
    setBody(newBody);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex flex-row items-center justify-between pb-4 border-b">
          <DialogTitle>
            {template ? "Edit email template" : "Create email template"}
          </DialogTitle>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </DialogHeader>

        <div className="space-y-4">
          {/* Template Name and Visibility */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Template name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Welcome to FlexStudios"
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
          </div>

          {/* Subject */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Subject</label>
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Email subject"
            />
          </div>

          {/* Body with Rich Text Editor */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Body</label>
              <FieldInsertMenu onInsert={handleInsertField} />
            </div>
            <ReactQuill
              value={body}
              onChange={setBody}
              modules={modules}
              theme="snow"
              className="bg-white"
            />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4 border-t">
            {template && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    className="gap-2"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogTitle>Delete "{template.name}"?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This template will be permanently removed and cannot be recovered.
                  </AlertDialogDescription>
                  <div className="flex justify-end gap-3 mt-4">
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={() => deleteMutation.mutate()}
                    >
                      Delete
                    </AlertDialogAction>
                  </div>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createMutation.isPending || updateMutation.isPending}
              >
                {(createMutation.isPending || updateMutation.isPending) ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}