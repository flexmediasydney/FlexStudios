import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, ChevronDown, Tag } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export default function LabelSelector({ 
  emailAccountId, 
  selectedLabels = [], 
  onLabelsChange,
  isAdmin = false
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const queryClient = useQueryClient();

  // Fetch available labels with real-time polling
  const { data: labels = [] } = useQuery({
    queryKey: ["email-labels", emailAccountId],
    queryFn: () => base44.entities.EmailLabel.filter({ email_account_id: emailAccountId }),
    refetchInterval: 60_000
  });

  // Create label mutation
  const createLabelMutation = useMutation({
    mutationFn: (data) => base44.entities.EmailLabel.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      setNewLabelName("");
      setNewLabelColor("#3b82f6");
      toast.success("Label created");
    },
    onError: () => {
      toast.error("Failed to create label");
    }
  });

  const filteredLabels = labels.filter(l => 
    l.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleLabelToggle = (labelName) => {
    const newLabels = selectedLabels.includes(labelName)
      ? selectedLabels.filter(l => l !== labelName)
      : [...selectedLabels, labelName];
    onLabelsChange(newLabels);
  };

  const handleAddLabel = () => {
    if (!newLabelName.trim()) {
      toast.error("Label name is required");
      return;
    }
    createLabelMutation.mutate({
      email_account_id: emailAccountId,
      name: newLabelName.trim(),
      color: newLabelColor
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 h-8">
          <Tag className="h-3 w-3" />
          Labels
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        {/* Search Input */}
        <div className="p-3 border-b">
          <Input
            placeholder="Search labels"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 text-sm"
            autoFocus
          />
        </div>

        {/* Labels Scrollable Area */}
        <div className="max-h-72 overflow-y-auto">
          {filteredLabels.length === 0 && !searchQuery ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              No labels yet
            </div>
          ) : filteredLabels.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground text-center">
              No matching labels
            </div>
          ) : (
            filteredLabels.map(label => (
              <div
                key={label.id}
                onClick={() => handleLabelToggle(label.name)}
                className="px-3 py-2 hover:bg-muted cursor-pointer flex items-center gap-2 group transition-colors border-b last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={selectedLabels.includes(label.name)}
                  onChange={() => {}}
                  className="h-4 w-4 cursor-pointer"
                  onClick={(e) => e.stopPropagation()}
                />
                <Badge 
                  style={{ backgroundColor: label.color }}
                  className="text-xs text-white flex-shrink-0 font-medium"
                >
                  {label.name}
                </Badge>
                {selectedLabels.includes(label.name) && (
                  <span className="text-primary text-sm ml-auto flex-shrink-0 font-bold">✓</span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Add Label Section (Admin Only) */}
        {isAdmin && (
          <div className="p-3 border-t bg-muted/30 space-y-3">
            <div className="space-y-2">
              <Input
                placeholder="New label name"
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddLabel()}
                className="h-8 text-xs"
              />
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={newLabelColor}
                  onChange={(e) => setNewLabelColor(e.target.value)}
                  className="h-8 w-12 rounded cursor-pointer"
                  title="Label color"
                />
                <Button
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={createLabelMutation.isPending}
                  className="h-8 text-xs flex-1"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </Button>
              </div>
            </div>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}