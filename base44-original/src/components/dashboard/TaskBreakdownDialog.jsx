import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CheckSquare, Clock, User, Calendar, ExternalLink } from "lucide-react";
import { fmtDate } from "@/components/utils/dateUtils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

const criticalityColors = {
  grey: 'bg-slate-100 text-slate-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  orange: 'bg-orange-100 text-orange-700',
  red: 'bg-red-100 text-red-700',
  late: 'bg-red-600 text-white'
};

export default function TaskBreakdownDialog({ open, onClose, title, tasks, type }) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-[60vh] pr-4">
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No tasks found
            </p>
          ) : (
            <div className="space-y-3">
              {tasks.map((task) => (
                <Link
                  key={task.id}
                  to={createPageUrl(`ProjectDetails?id=${task.project_id}`)}
                  className="block p-4 rounded-lg border hover:bg-muted/50 hover:shadow-md transition-all group"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium mb-1 flex items-center gap-2">
                        {task.is_completed && (
                          <CheckSquare className="h-4 w-4 text-green-600 flex-shrink-0" />
                        )}
                        <span className={task.is_completed ? "line-through text-muted-foreground" : ""}>
                          {task.title}
                        </span>
                        <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                      </h4>
                      {task.description && (
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {task.description}
                        </p>
                      )}
                    </div>
                    {task.criticality && (
                      <Badge className={criticalityColors[task.criticality.level]}>
                        {task.criticality.label}
                      </Badge>
                    )}
                  </div>
                  
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-2">
                    {task.assigned_to_name && (
                      <div className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {task.assigned_to_name}
                      </div>
                    )}
                    {task.due_date && (
                       <div className="flex items-center gap-1">
                         <Calendar className="h-3 w-3" />
                         {fmtDate(task.due_date, 'MMM d, yyyy')}
                       </div>
                     )}
                    {task.project_title && (
                      <div className="flex items-center gap-1">
                        <span className="font-medium">Project:</span>
                        {task.project_title}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}