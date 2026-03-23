import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Building, Users, User, Plus, Edit, Trash2, Search, History, AlertCircle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { format, isAfter, subDays } from "date-fns";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

const actionIcons = {
  create: Plus,
  update: Edit,
  delete: Trash2
};

const actionColors = {
  create: "bg-green-100 text-green-700 border-green-200",
  update: "bg-blue-100 text-blue-700 border-blue-200",
  delete: "bg-red-100 text-red-700 border-red-200"
};

const entityIcons = {
  agency: Building,
  team: Users,
  agent: User
};

export default function ActivityFeed() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [restoreItem, setRestoreItem] = useState(null);

  // Real-time subscription replaces polling + manual subscribe
  const { data: logs = [], loading: isLoading } = useEntityList("AuditLog", "-created_date", 500);

  const threeDaysAgo = subDays(new Date(), 3);
  
  const recentLogs = useMemo(() => 
    logs.filter(log => isAfter(new Date(log.created_date), threeDaysAgo)),
    [logs, threeDaysAgo]
  );

  const archivedLogs = useMemo(() => 
    logs.filter(log => !isAfter(new Date(log.created_date), threeDaysAgo)),
    [logs, threeDaysAgo]
  );

  const filterLogs = (logList) => {
    if (!searchQuery) return logList;
    const query = searchQuery.toLowerCase();
    return logList.filter(log => 
      log.entity_name?.toLowerCase().includes(query) ||
      log.user_name?.toLowerCase().includes(query) ||
      log.user_email?.toLowerCase().includes(query) ||
      log.action?.toLowerCase().includes(query)
    );
  };

  const handleRestore = async () => {
    if (!restoreItem) return;
    
    try {
      const { entity_type, entity_id, previous_state } = restoreItem;
      
      if (!previous_state) {
        toast.error("No previous state available for restore");
        return;
      }

      if (entity_type === "agency") {
        await api.entities.Agency.update(entity_id, previous_state);
      } else if (entity_type === "team") {
        await api.entities.Team.update(entity_id, previous_state);
      } else if (entity_type === "agent") {
        await api.entities.Agent.update(entity_id, previous_state);
      }

      // Create audit log for restore
      const user = await api.auth.me();
      await api.entities.AuditLog.create({
        entity_type,
        entity_id,
        entity_name: previous_state.name,
        action: "update",
        changed_fields: [{ field: "restored", old_value: "current", new_value: "previous" }],
        previous_state: restoreItem.new_state,
        new_state: previous_state,
        user_name: user.full_name,
        user_email: user.email
      });

      queryClient.invalidateQueries({ queryKey: ['agencies'] });
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['audit-logs'] });
      refetchEntityList("Agency");
      refetchEntityList("Team");
      refetchEntityList("Agent");
      refetchEntityList("AuditLog");
      toast.success("Successfully restored previous state");
      setRestoreItem(null);
    } catch (error) {
      toast.error("Failed to restore: " + (error.message || "Unknown error"));
    }
  };

  const LogEntry = ({ log }) => {
    const ActionIcon = actionIcons[log.action];
    const EntityIcon = entityIcons[log.entity_type];
    const canRestore = log.action === "update" && log.previous_state;

    return (
      <Card className="p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start gap-4">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${actionColors[log.action]}`}>
            <ActionIcon className="h-5 w-5" />
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2 flex-wrap">
                <EntityIcon className="h-4 w-4 text-muted-foreground" />
                <span className="font-semibold">{log.entity_name}</span>
                <Badge variant="outline" className="text-xs">
                  {log.entity_type}
                </Badge>
                <Badge variant="outline" className={`text-xs ${actionColors[log.action]}`}>
                  {log.action}
                </Badge>
              </div>
              {canRestore && (
                <Button 
                  size="sm" 
                  variant="ghost"
                  onClick={() => setRestoreItem(log)}
                  className="gap-1"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </Button>
              )}
            </div>

            {log.changed_fields && log.changed_fields.length > 0 && (
              <div className="space-y-1 mb-3">
                {log.changed_fields.map((change, idx) => (
                  <div key={idx} className="text-sm bg-muted/50 rounded p-2">
                    <span className="font-medium text-muted-foreground">{change.field}:</span>
                    {change.old_value && (
                      <span className="text-red-600 line-through ml-2">{change.old_value}</span>
                    )}
                    {change.new_value && (
                      <span className="text-green-600 ml-2">→ {change.new_value}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{log.user_name}</span>
              <span>•</span>
              <span>{log.user_email}</span>
              <span>•</span>
              <span>{format(new Date(log.created_date), "PPp")}</span>
            </div>
          </div>
        </div>
      </Card>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading activity...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search activity..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      <Tabs defaultValue="recent">
        <TabsList>
          <TabsTrigger value="recent" className="gap-2">
            <History className="h-4 w-4" />
            Recent (Last 3 Days)
            <Badge variant="secondary" className="ml-1">{recentLogs.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="archived" className="gap-2">
            <AlertCircle className="h-4 w-4" />
            Archives
            <Badge variant="secondary" className="ml-1">{archivedLogs.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="recent" className="mt-6">
          {filterLogs(recentLogs).length === 0 ? (
            <Card className="p-12 text-center">
              <History className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No recent activity</h3>
              <p className="text-muted-foreground">
                {searchQuery ? "No activity matches your search" : "Activity from the last 3 days will appear here"}
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {filterLogs(recentLogs).map(log => (
                <LogEntry key={log.id} log={log} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="archived" className="mt-6">
          {filterLogs(archivedLogs).length === 0 ? (
            <Card className="p-12 text-center">
              <AlertCircle className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No archived activity</h3>
              <p className="text-muted-foreground">
                {searchQuery ? "No archived activity matches your search" : "Activity older than 3 days will appear here"}
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {filterLogs(archivedLogs).map(log => (
                <LogEntry key={log.id} log={log} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={!!restoreItem} onOpenChange={() => setRestoreItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore Previous State?</AlertDialogTitle>
            <AlertDialogDescription>
              This will restore {restoreItem?.entity_name} to its previous state. This action will be logged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore}>
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}