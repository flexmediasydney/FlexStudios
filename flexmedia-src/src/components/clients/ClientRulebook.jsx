import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, Users, Building, Network, AlertCircle, CheckCircle } from "lucide-react";

export default function ClientRulebook() {
  const rules = [
    {
      category: "Hierarchy Structure",
      icon: Network,
      color: "text-blue-600",
      bgColor: "bg-blue-100",
      items: [
        {
          title: "Three-Tier System",
          description: "Client structure follows Agency → Team (optional) → Agent hierarchy",
          type: "structure"
        },
        {
          title: "Required Relationships",
          description: "Agents must belong to an Agency. Team membership is optional",
          type: "requirement"
        },
        {
          title: "Cascading Data",
          description: "Agency name and Team name are cached on Agent records for faster queries",
          type: "structure"
        }
      ]
    },
    {
      category: "Deletion Rules",
      icon: AlertCircle,
      color: "text-red-600",
      bgColor: "bg-red-100",
      items: [
        {
          title: "Agency Protection",
          description: "Cannot delete an Agency if it has any Teams or Agents associated with it",
          type: "constraint"
        },
        {
          title: "Team Protection",
          description: "Cannot delete a Team if it has any Agents associated with it",
          type: "constraint"
        },
        {
          title: "Agent Deletion",
          description: "Agents can be deleted freely without dependency checks",
          type: "allowed"
        },
        {
          title: "Audit Logging",
          description: "All deletions are logged in AuditLog with previous state, user details, and timestamp",
          type: "requirement"
        }
      ]
    },
    {
      category: "Project Association",
      icon: FileText,
      color: "text-purple-600",
      bgColor: "bg-purple-100",
      items: [
        {
          title: "Client ID Reference",
          description: "Projects store client_id referencing the individual Agent, not Agency or Team",
          type: "structure"
        },
        {
          title: "Display Name Caching",
          description: "Projects cache client_name (agent name) for display without additional lookups",
          type: "structure"
        },
        {
          title: "Project Counter",
          description: "Client entity tracks total_projects count for reporting and analytics",
          type: "feature"
        }
      ]
    },
    {
      category: "Data Integrity",
      icon: CheckCircle,
      color: "text-green-600",
      bgColor: "bg-green-100",
      items: [
        {
          title: "Required Fields",
          description: "Agency and Agent must have 'name' field. Agent must have 'agency_name' reference",
          type: "requirement"
        },
        {
          title: "Optional Fields",
          description: "Address, phone, email, and notes are optional across all hierarchy levels",
          type: "structure"
        },
        {
          title: "Audit Trail",
          description: "All create, update, delete operations logged with field-level change tracking",
          type: "feature"
        },
        {
          title: "User Context",
          description: "All audit logs capture user_name and user_email of the person making changes",
          type: "requirement"
        }
      ]
    },
    {
      category: "Search & Filtering",
      icon: Users,
      color: "text-amber-600",
      bgColor: "bg-amber-100",
      items: [
        {
          title: "Cross-Entity Search",
          description: "Search works across Agency name, Team name, Agent name, and email fields",
          type: "feature"
        },
        {
          title: "Filtered Views",
          description: "Each tab (Agencies, Teams, Agents) supports independent filtering and search",
          type: "feature"
        },
        {
          title: "Multiple View Modes",
          description: "Hierarchy data viewable in Tree, Org Chart, List, Grid, and Table formats",
          type: "feature"
        }
      ]
    }
  ];

  const ruleTypeStyles = {
    structure: { badge: "Structure", variant: "outline", className: "border-blue-200 text-blue-700" },
    requirement: { badge: "Required", variant: "default", className: "bg-red-100 text-red-700 border-red-200" },
    constraint: { badge: "Constraint", variant: "destructive", className: "bg-red-500 text-white" },
    allowed: { badge: "Allowed", variant: "secondary", className: "bg-green-100 text-green-700 border-green-200" },
    feature: { badge: "Feature", variant: "secondary", className: "bg-purple-100 text-purple-700 border-purple-200" }
  };

  return (
    <div className="space-y-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold mb-2">Client Rulebook</h2>
        <p className="text-muted-foreground">
          Comprehensive documentation of client hierarchy logic, constraints, and business rules
        </p>
      </div>

      {rules.map((section) => {
        const Icon = section.icon;
        return (
          <Card key={section.category}>
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-lg ${section.bgColor} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${section.color}`} />
                </div>
                {section.category}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {section.items.map((rule, idx) => {
                  const typeStyle = ruleTypeStyles[rule.type];
                  return (
                    <div key={idx} className="flex items-start gap-3 p-4 bg-muted/30 rounded-lg">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold">{rule.title}</h4>
                          <Badge variant={typeStyle.variant} className={typeStyle.className}>
                            {typeStyle.badge}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{rule.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div>
              <h4 className="font-medium mb-1">Implementation Notes</h4>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li>• All entities use Base44's built-in fields: id, created_date, updated_date, created_by</li>
                <li>• Hierarchical relationships maintained via agency_id and team_id foreign keys</li>
                <li>• Name caching improves query performance by avoiding joins on list views</li>
                <li>• Audit logs enable complete history playback and rollback capabilities</li>
                <li>• Search queries are case-insensitive and perform substring matching</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}