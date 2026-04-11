import { useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { usePriceGate } from "@/components/auth/RoleGate";

export default function ProjectLinkDialogForInbox({
  thread,
  open,
  onOpenChange,
  account,
  onLinked,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const queryClient = useQueryClient();
  const { showPricing } = usePriceGate();

  // Fetch recent projects once, filter client-side (avoids re-fetching on every keystroke)
  const { data: allProjects = [], isLoading } = useQuery({
    queryKey: ["projects-for-linking"],
    queryFn: () => api.entities.Project.filter({}, "-updated_date", 200),
    staleTime: 2 * 60 * 1000,
  });
  const projects = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    return allProjects.filter(p =>
      p.title?.toLowerCase().includes(query) ||
      p.property_address?.toLowerCase().includes(query) ||
      p.client_name?.toLowerCase().includes(query)
    );
  }, [allProjects, searchQuery]);

  const linkProjectMutation = useMutation({
    mutationFn: async (projectId) => {
      const project = projects.find(p => p.id === projectId);
      const messageIds = thread.messages.map(msg => msg.id);
      // Update ALL messages in the thread, not just the first one
      // Do NOT change visibility on link — owner controls that separately.
      // Pipedrive model: linked + private = only owner sees it in project timeline.
      // Linked + shared = all project members see it.
      await Promise.all(
        messageIds.map(msgId =>
          api.entities.EmailMessage.update(msgId, {
            project_id: projectId,
            project_title: project.title
            // visibility intentionally not set here
          })
        )
      );
      return { messageIds, projectId, projectTitle: project.title };
    },
    onSuccess: (data) => {
      // Add to undo stack for undo/redo support
      const undoStack = JSON.parse(sessionStorage.getItem('emailUndoStack') || '[]');
      undoStack.push({
        type: 'linkProject',
        data: {
          messageIds: data.messageIds,
          projectId: data.projectId,
          projectTitle: data.projectTitle
        }
      });
      sessionStorage.setItem('emailUndoStack', JSON.stringify(undoStack));

      toast.success("Email linked to project", {
        description: "Set visibility to Shared in your inbox if you want team members to see it.",
        duration: 5000
      });
      // Invalidate all email-related queries to force refresh
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["projects-search"] });
      onLinked?.();
      onOpenChange(false);
      setSearchQuery("");
    },
    onError: () => {
      toast.error("Failed to link project");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Link to Project</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search for deal, lead or project"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              autoFocus
            />
          </div>

          {/* Results */}
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {isLoading ? (
              <p className="text-sm text-muted-foreground text-center py-4">Loading projects...</p>
            ) : projects.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                {searchQuery ? "No projects found" : "Start typing to search"}
              </p>
            ) : (
              projects.map(project => (
                <div
                  key={project.id}
                  className="p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm">{project.title}</h4>
                      {project.property_address && (
                        <p className="text-xs text-muted-foreground truncate mt-1">
                          {project.property_address}
                        </p>
                      )}
                      {project.client_name && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {project.client_name}
                        </p>
                      )}
                      <div className="flex gap-2 mt-2">
                        {project.status && (
                          <Badge variant="outline" className="text-xs">
                            {project.status}
                          </Badge>
                        )}
                        {showPricing && project.price && (
                          <Badge variant="secondary" className="text-xs">
                            A${project.price}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => linkProjectMutation.mutate(project.id)}
                      disabled={linkProjectMutation.isPending}
                      className="gap-2 flex-shrink-0"
                    >
                      <Link2 className="h-4 w-4" />
                      Link
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}