import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Tag, ChevronDown, Check, Minus, X, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

export default function LabelSelectorMultiSelect({ 
  emailAccountId, 
  selectedEmailIds = [],
  allEmailMessages = [],
  onLabelsChange,
  isAdmin = false
}) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#3b82f6");
  const [operationInProgress, setOperationInProgress] = useState(new Set());
  const queryClient = useQueryClient();
  const abortControllerRef = useRef(null);

  // Validate inputs
  if (!emailAccountId) {
    return null;
  }

  if (!Array.isArray(selectedEmailIds) || !Array.isArray(allEmailMessages)) {
    console.warn("LabelSelectorMultiSelect: Invalid props", { selectedEmailIds, allEmailMessages });
    return null;
  }

  // Fetch available labels with error handling
  const { data: labels = [], isLoading: labelsLoading, error: labelsError } = useQuery({
    queryKey: ["email-labels", emailAccountId],
    queryFn: async () => {
      try {
        const result = await base44.entities.EmailLabel.filter({ email_account_id: emailAccountId });
        return Array.isArray(result) ? result : [];
      } catch (err) {
        console.error("Failed to fetch labels:", err);
        throw err;
      }
    },
    enabled: !!emailAccountId,
    retry: 2,
    staleTime: 30000,
    gcTime: 60000
  });

  // Create label mutation with conflict detection
  const createLabelMutation = useMutation({
    mutationFn: async (data) => {
      // Validate label name
      if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
        throw new Error("Label name is required and must be a string");
      }

      if (data.name.length > 100) {
        throw new Error("Label name must be less than 100 characters");
      }

      // Check for duplicate
      const existing = labels.find(l => l.name.toLowerCase() === data.name.toLowerCase());
      if (existing) {
        throw new Error(`Label "${data.name}" already exists`);
      }

      // Validate color
      if (!/^#[0-9A-F]{6}$/i.test(data.color)) {
        throw new Error("Invalid color format");
      }

      return base44.entities.EmailLabel.create({
        email_account_id: emailAccountId,
        name: data.name.trim(),
        color: data.color
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-labels", emailAccountId] });
      setNewLabelName("");
      setNewLabelColor("#3b82f6");
      toast.success("Label created successfully");
    },
    onError: (error) => {
      const message = error?.message || "Failed to create label";
      toast.error(message);
      console.error("Label creation error:", error);
    }
  });

  // Get label state across selected emails
  const getLabelState = useCallback((labelName) => {
    if (!selectedEmailIds.length) return 'none';
    if (!Array.isArray(selectedEmailIds)) return 'none';

    const selectedMsgs = allEmailMessages.filter(m => 
      m && selectedEmailIds.includes(m.id)
    );
    
    if (!selectedMsgs.length) return 'none';

    const withLabel = selectedMsgs.filter(m => 
      Array.isArray(m.labels) && m.labels.includes(labelName)
    ).length;
    
    const total = selectedMsgs.length;

    if (withLabel === 0) return 'none';
    if (withLabel === total) return 'all';
    return 'some';
  }, [selectedEmailIds, allEmailMessages]);

  // Get all selected labels across selected emails
  const getSelectedLabels = useMemo(() => {
    if (!selectedEmailIds.length || !Array.isArray(selectedEmailIds)) return [];
    
    const selectedMsgs = allEmailMessages.filter(m => 
      m && selectedEmailIds.includes(m.id)
    );
    
    const allLabelsInSelection = new Set();
    
    selectedMsgs.forEach(msg => {
      if (Array.isArray(msg.labels)) {
        msg.labels.forEach(label => {
          if (typeof label === 'string' && label.length > 0) {
            allLabelsInSelection.add(label);
          }
        });
      }
    });
    
    return Array.from(allLabelsInSelection).sort();
  }, [selectedEmailIds, allEmailMessages]);

  // Filtered labels based on search
  const filteredLabels = useMemo(() => {
    if (!Array.isArray(labels)) return [];
    
    const query = (searchQuery || "").toLowerCase().trim();
    
    return labels
      .filter(l => l && l.name && l.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [labels, searchQuery]);

  // Handle clicking a label with debouncing
  const handleLabelToggle = useCallback((labelName) => {
    if (!labelName || typeof labelName !== 'string') {
      console.warn("Invalid label name:", labelName);
      return;
    }

    // Prevent duplicate operations
    if (operationInProgress.has(labelName)) {
      return;
    }

    const currentState = getLabelState(labelName);
    const action = currentState === 'all' ? 'remove' : 'add';

    setOperationInProgress(prev => new Set([...prev, labelName]));

    try {
      onLabelsChange({
        labelName,
        action,
        selectedEmailIds: Array.from(selectedEmailIds)
      });
    } finally {
      setTimeout(() => {
        setOperationInProgress(prev => {
          const next = new Set(prev);
          next.delete(labelName);
          return next;
        });
      }, 500);
    }
  }, [getLabelState, selectedEmailIds, onLabelsChange, operationInProgress]);

  const handleAddLabel = useCallback(() => {
    const trimmedName = (newLabelName || "").trim();

    if (!trimmedName) {
      toast.error("Label name is required");
      return;
    }

    if (trimmedName.length > 100) {
      toast.error("Label name must be less than 100 characters");
      return;
    }

    if (!/^[a-zA-Z0-9\s\-_]+$/.test(trimmedName)) {
      toast.error("Label name can only contain letters, numbers, spaces, hyphens, and underscores");
      return;
    }

    createLabelMutation.mutate({
      name: trimmedName,
      color: newLabelColor
    });
  }, [newLabelName, newLabelColor, createLabelMutation]);

  const handleKeyPress = useCallback((e) => {
    if (e.key === 'Enter' && !createLabelMutation.isPending) {
      e.preventDefault();
      handleAddLabel();
    }
  }, [handleAddLabel, createLabelMutation.isPending]);

  const renderCheckbox = useCallback((state) => {
    if (state === 'all') {
      return <Check className="h-4 w-4 text-primary font-bold" />;
    }
    if (state === 'some') {
      return <Minus className="h-4 w-4 text-muted-foreground" />;
    }
    return <div className="h-4 w-4 border border-input rounded" />;
  }, []);

  const displayedLabels = useMemo(() => {
    return getSelectedLabels
      .map(name => labels.find(l => l && l.name === name))
      .filter(Boolean)
      .slice(0, 2);
  }, [getSelectedLabels, labels]);

  const hasMoreLabels = getSelectedLabels.length > 2;

  // Show error state
  if (labelsError && !labelsLoading) {
    return (
      <Button variant="outline" size="sm" className="gap-2 h-8" disabled>
        <AlertCircle className="h-3 w-3 text-destructive" />
        Labels unavailable
      </Button>
    );
  }

  // Disable if no emails selected
  if (!selectedEmailIds.length) {
    return (
      <Button variant="outline" size="sm" className="gap-2 h-8" disabled>
        <Tag className="h-3 w-3" />
        Select emails
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="gap-2 h-8"
          disabled={selectedEmailIds.length === 0}
        >
          <Tag className="h-3 w-3" />
          {displayedLabels.length === 0 ? (
            <>Labels <ChevronDown className="h-3 w-3" /></>
          ) : displayedLabels.length === 1 ? (
            <>
              <Badge 
                style={{ backgroundColor: displayedLabels[0]?.color }}
                className="text-xs text-white h-5"
              >
                {displayedLabels[0]?.name}
              </Badge>
              {hasMoreLabels && <Badge className="bg-slate-600 text-white text-xs h-5">+{getSelectedLabels.length - 1}</Badge>}
              <ChevronDown className="h-3 w-3" />
            </>
          ) : displayedLabels.length === 2 ? (
            <>
              {displayedLabels.map(label => (
                <Badge 
                  key={label.id}
                  style={{ backgroundColor: label.color }}
                  className="text-xs text-white h-5"
                >
                  {label.name}
                </Badge>
              ))}
              {hasMoreLabels && <Badge className="bg-slate-600 text-white text-xs h-5">+{getSelectedLabels.length - 2}</Badge>}
              <ChevronDown className="h-3 w-3" />
            </>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        {/* Legend */}
        <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground space-y-1 border-b">
          <div className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-primary flex-shrink-0" />
            <span>Applied to all selected emails</span>
          </div>
          <div className="flex items-center gap-2">
            <Minus className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span>Applied to some selected emails</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 border border-input rounded flex-shrink-0" />
            <span>Not applied to any selected emails</span>
          </div>
        </div>

        {/* Search Input */}
        <div className="p-3 border-b">
          <Input
            placeholder="Search labels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 text-sm"
            autoFocus
            disabled={labelsLoading}
            maxLength={50}
          />
        </div>

        {/* Labels List */}
        <div className="max-h-72 overflow-y-auto">
          {labelsLoading ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              Loading labels...
            </div>
          ) : filteredLabels.length === 0 && !searchQuery ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No labels yet. Create one to get started.
            </div>
          ) : filteredLabels.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground text-center">
              No matching labels
            </div>
          ) : (
            filteredLabels.map((label) => {
              if (!label || !label.id) return null;
              
              const state = getLabelState(label.name);
              const isLoading = operationInProgress.has(label.name);
              
              return (
                <button
                  key={label.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isLoading) {
                      handleLabelToggle(label.name);
                    }
                  }}
                  disabled={isLoading}
                  className="w-full px-3 py-2.5 hover:bg-muted flex items-center gap-3 transition-colors border-b last:border-b-0 text-left disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                    {renderCheckbox(state)}
                  </div>
                  <Badge 
                    style={{ backgroundColor: label.color }}
                    className="text-xs text-white flex-shrink-0 font-medium"
                  >
                    {label.name}
                  </Badge>
                  {state === 'some' && selectedEmailIds.length > 0 && (
                    <span className="text-xs text-muted-foreground ml-auto">
                      {allEmailMessages.filter(m => 
                        m && selectedEmailIds.includes(m.id) && 
                        Array.isArray(m.labels) && m.labels.includes(label.name)
                      ).length}/{selectedEmailIds.length}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Add Label Section (Admin Only) */}
        {isAdmin && (
          <div className="p-3 border-t bg-muted/30 space-y-3">
            <div className="space-y-2">
              <Input
                placeholder="New label name"
                value={newLabelName}
                onChange={(e) => setNewLabelName(e.target.value.slice(0, 100))}
                onKeyPress={handleKeyPress}
                className="h-8 text-sm"
                disabled={createLabelMutation.isPending}
                maxLength={100}
              />
              <div className="flex gap-2 items-center">
                <input
                  type="color"
                  value={newLabelColor}
                  onChange={(e) => setNewLabelColor(e.target.value)}
                  className="h-8 w-12 rounded cursor-pointer"
                  title="Label color"
                  disabled={createLabelMutation.isPending}
                />
                <Button
                  size="sm"
                  onClick={handleAddLabel}
                  disabled={createLabelMutation.isPending || !newLabelName.trim()}
                  className="h-8 text-xs flex-1"
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {createLabelMutation.isPending ? "Adding..." : "Add"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}