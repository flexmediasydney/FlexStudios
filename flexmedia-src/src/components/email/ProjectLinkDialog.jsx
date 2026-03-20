import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Search } from "lucide-react";

export default function ProjectLinkDialog({ thread, onClose }) {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => base44.entities.Project.list("-created_date", 100)
  });

  const linkMutation = useMutation({
    mutationFn: async (projectId) => {
      const project = projects.find(p => p.id === projectId);
      
      // Update email with project link and change visibility to team
      await base44.entities.EmailMessage.update(thread.messages[0].id, {
        project_id: projectId,
        project_title: project?.title,
        visibility: "team"
      });
      
      // Create activity log entry
      await base44.entities.ProjectActivity.create({
        project_id: projectId,
        project_title: project?.title,
        action: "email_linked",
        description: `Email linked: "${thread.subject}" from ${thread.from}`,
        user_name: "System"
      });
    },
    onSuccess: () => {
      onClose();
    }
  });

  const filteredProjects = projects.filter(p =>
    (p.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (p.property_address || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link to Project</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          <div className="max-h-[300px] overflow-y-auto space-y-2">
            {isLoading ? (
              <p className="text-center text-muted-foreground py-4">Loading projects...</p>
            ) : filteredProjects.length === 0 ? (
              <p className="text-center text-muted-foreground py-4">No projects found</p>
            ) : (
              filteredProjects.map(project => (
                <Card
                  key={project.id}
                  className="p-3 cursor-pointer hover:bg-muted transition-colors"
                  onClick={() => linkMutation.mutate(project.id)}
                >
                  <p className="font-medium text-sm">{project.title}</p>
                  <p className="text-xs text-muted-foreground">{project.property_address}</p>
                </Card>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}