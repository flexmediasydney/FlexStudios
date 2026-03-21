import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, FileText, Users, Calendar, Mail, UserPlus, Send, Zap } from "lucide-react";

export default function QuickActionsPanel({ urgentCount, onNewProject, onNewContact, onComposeEmail, onViewCalendar, onViewInbox, onViewReports }) {
  const actions = [
    {
      icon: Plus,
      label: "New Project",
      description: "Create project",
      onClick: onNewProject,
      variant: "default"
    },
    {
      icon: UserPlus,
      label: "New Contact",
      description: "Add a person",
      onClick: onNewContact,
      variant: "outline"
    },
    {
      icon: Send,
      label: "Compose Email",
      description: "Draft and send",
      onClick: onComposeEmail,
      variant: "outline"
    },
    {
      icon: Calendar,
      label: "Today's Schedule",
      description: "View calendar",
      onClick: onViewCalendar,
      variant: "outline"
    },
    {
      icon: Mail,
      label: "Inbox",
      description: "Check emails",
      onClick: onViewInbox,
      variant: "outline",
      badge: urgentCount > 0 ? urgentCount : null
    },
    {
      icon: FileText,
      label: "Reports",
      description: "View analytics",
      onClick: onViewReports,
      variant: "outline"
    }
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Zap className="h-4 w-4 text-yellow-500" />
          Quick Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {actions.map((action, idx) => {
          const Icon = action.icon;
          return (
            <Button
              key={idx}
              variant={action.variant}
              className="w-full justify-start h-auto py-3 relative"
              onClick={action.onClick}
            >
              <div className="flex items-center gap-3 w-full">
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                  action.variant === 'default' ? 'bg-primary-foreground/20' : 'bg-muted'
                }`}>
                  <Icon className="h-5 w-5" />
                </div>
                <div className="text-left flex-1">
                  <p className="font-semibold text-sm">{action.label}</p>
                  <p className={`text-xs ${action.variant === 'default' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {action.description}
                  </p>
                </div>
                {action.badge && (
                  <Badge variant="destructive" className="text-xs">
                    {action.badge}
                  </Badge>
                )}
              </div>
            </Button>
          );
        })}
      </CardContent>
    </Card>
  );
}
