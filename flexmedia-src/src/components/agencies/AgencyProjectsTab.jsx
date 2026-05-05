import React, { useState, useMemo, useCallback } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { usePermissions, useCurrentUser } from "@/components/auth/PermissionGuard";
import { useCardFields } from "@/components/projects/useCardFields";
import { Search, LayoutGrid, List } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ProjectCard from "@/components/dashboard/ProjectCard";
import ProjectStatusBadge from "@/components/dashboard/ProjectStatusBadge";
import ProjectStatusTimer from "@/components/projects/ProjectStatusTimer";
import CardFieldsCustomizer, { CardFieldsCustomizerButton } from "@/components/projects/CardFieldsCustomizer";
import ProjectFiltersSort from "@/components/projects/ProjectFiltersSort";
import { ProjectFieldValue } from "@/components/projects/ProjectCardFields";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function AgencyProjectsTab({ projects = [], agencyId }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState("grid");
  const [showFieldCustomizer, setShowFieldCustomizer] = useState(false);
  const [filters, setFilters] = useState({});
  const [sortBy, setSortBy] = useState("last_status_change");

  const { canSeePricing, canAccessProject } = usePermissions();
  const { enabledFields } = useCardFields();
  const { data: currentUser } = useCurrentUser();

  // Load supporting data for filters and card display
  const { data: allTasks = [] } = useEntityList("ProjectTask", "-due_date", 500);
  const { data: allTimeLogs = [] } = useEntityList("TaskTimeLog", null, 100);
  const { data: products = [] } = useEntityList("Product", "-created_date", 200);
  const { data: packages = [] } = useEntityList("Package", "-created_date", 200);
  const { data: agents = [] } = useEntityList("Agent", null, 100);
  const { data: allUsers = [] } = useEntityList("User", null, 50);
  const { data: internalTeams = [] } = useEntityList("InternalTeam", null, 50);
  const { data: allEmployeeRoles = [] } = useEntityList("EmployeeRole", null, 200);

  const myTeamIds = useMemo(() => {
    if (!currentUser) return [];
    return allEmployeeRoles
      .filter(er => er.user_id === currentUser.id && er.team_id)
      .map(er => er.team_id);
  }, [currentUser?.id, allEmployeeRoles]);

  const myTeamMemberUserIds = useMemo(() => {
    if (!myTeamIds.length) return new Set();
    const ids = new Set();
    allEmployeeRoles.forEach(er => {
      if (er.team_id && myTeamIds.includes(er.team_id) && er.user_id) ids.add(er.user_id);
    });
    return ids;
  }, [myTeamIds, allEmployeeRoles]);

  // Agency-agents only for the agent filter (scoped to this agency)
  const agencyAgents = useMemo(() => agents.filter(a => a.current_agency_id === agencyId), [agents, agencyId]);

  const filteredProjects = useMemo(() => {
    return projects
      .filter(project => {
        const matchesSearch =
          project.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          project.property_address?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          project.client_name?.toLowerCase().includes(searchQuery.toLowerCase());
        if (!matchesSearch) return false;

        const projectAssignedUserIds = new Set([
          project.project_owner_id,
          project.onsite_staff_1_id,
          project.onsite_staff_2_id,
          project.image_editor_id,
          project.video_editor_id,
        ].filter(Boolean));

        const projectAssignedTeamIds = new Set([
          project.project_owner_type === "team" ? project.project_owner_id : null,
          project.onsite_staff_1_type === "team" ? project.onsite_staff_1_id : null,
          project.onsite_staff_2_type === "team" ? project.onsite_staff_2_id : null,
          project.image_editor_type === "team" ? project.image_editor_id : null,
          project.video_editor_type === "team" ? project.video_editor_id : null,
        ].filter(Boolean));

        const projectTasks = allTasks.filter(t => t.project_id === project.id);

        if (filters.assigned_to_me && currentUser) {
          const assignedViaRole = projectAssignedUserIds.has(currentUser.id);
          const assignedViaTask = projectTasks.some(
            t => t.assigned_to === currentUser.id || t.assigned_to === currentUser.email || t.assigned_to_name === currentUser.full_name
          );
          if (!assignedViaRole && !assignedViaTask) return false;
        }

        if (filters.assigned_to_my_team) {
          if (myTeamMemberUserIds.size === 0) return false;
          const teamMemberEmails = new Set(
            allEmployeeRoles.filter(er => er.team_id && myTeamIds.includes(er.team_id)).map(er => er.user_email).filter(Boolean)
          );
          const teamAssignedViaRole = [...projectAssignedUserIds].some(uid => myTeamMemberUserIds.has(uid));
          const teamAssignedViaTask = projectTasks.some(t => myTeamMemberUserIds.has(t.assigned_to) || teamMemberEmails.has(t.assigned_to));
          const teamAssignedViaTeamRole = [...projectAssignedTeamIds].some(tid => myTeamIds.includes(tid));
          if (!teamAssignedViaRole && !teamAssignedViaTask && !teamAssignedViaTeamRole) return false;
        }

        if (filters.products?.length > 0) {
          if (!project.products?.some(p => filters.products.includes(p.product_id))) return false;
        }
        if (filters.packages?.length > 0) {
          if (!project.packages?.some(p => filters.packages.includes(p.package_id))) return false;
        }
        if (filters.agents?.length > 0 && !filters.agents.includes(project.agent_id)) return false;

        if (filters.internal_users?.length > 0) {
          const matchesRole = filters.internal_users.some(uid => projectAssignedUserIds.has(uid));
          const matchesTask = projectTasks.some(t => filters.internal_users.includes(t.assigned_to));
          if (!matchesRole && !matchesTask) return false;
        }

        if (filters.internal_teams?.length > 0) {
          if (![...projectAssignedTeamIds].some(tid => filters.internal_teams.includes(tid))) return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (sortBy === "task_deadline") {
          const aTask = allTasks.filter(t => t.project_id === a.id).sort((x, y) => new Date(x.due_date) - new Date(y.due_date))[0];
          const bTask = allTasks.filter(t => t.project_id === b.id).sort((x, y) => new Date(x.due_date) - new Date(y.due_date))[0];
          if (!aTask && !bTask) return 0;
          if (!aTask) return 1;
          if (!bTask) return -1;
          return new Date(aTask.due_date) - new Date(bTask.due_date);
        } else if (sortBy === "created_date") {
          return new Date(b.created_date) - new Date(a.created_date);
        }
        return new Date(b.last_status_change || 0) - new Date(a.last_status_change || 0);
      });
  }, [projects, searchQuery, filters, sortBy, allTasks, currentUser, myTeamIds, myTeamMemberUserIds, allEmployeeRoles]);

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search projects, addresses, clients..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Filters & Sort — agency filter hidden since we're already scoped */}
      <ProjectFiltersSort
        products={products}
        packages={packages}
        agents={agencyAgents}
        agencies={[]}
        teams={[]}
        internalUsers={allUsers}
        internalTeams={internalTeams}
        activeFilters={filters}
        activeSort={sortBy}
        onFiltersChange={setFilters}
        onSortChange={setSortBy}
      />

      {/* View Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CardFieldsCustomizerButton onClick={() => setShowFieldCustomizer(true)} />
          <span className="text-sm text-muted-foreground">{filteredProjects.length} project{filteredProjects.length !== 1 ? "s" : ""}</span>
        </div>
        <Tabs value={viewMode} onValueChange={setViewMode}>
          <TabsList>
            <TabsTrigger value="grid"><LayoutGrid className="h-4 w-4" /></TabsTrigger>
            <TabsTrigger value="list"><List className="h-4 w-4" /></TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      {filteredProjects.length === 0 ? (
        <Card className="p-10 text-center bg-muted/30 border-dashed">
          <p className="text-muted-foreground">
            {searchQuery || Object.values(filters).some(v => v?.length > 0)
              ? "No projects match your filters"
              : "No projects for this agency yet"}
          </p>
        </Card>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredProjects.map(project => {
            const projectTasks = allTasks.filter(t => t.project_id === project.id && !t.parent_task_id);
            const projectTimeLogs = allTimeLogs.filter(l => l.project_id === project.id);
            return (
              <ProjectCard
                key={project.id}
                project={project}
                products={products}
                packages={packages}
                tasks={projectTasks}
                timeLogs={projectTimeLogs}
              />
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-4 font-medium text-sm">Project</th>
                  <th className="text-left p-4 font-medium text-sm">Status</th>
                  {enabledFields.map(fieldId => {
                    if (fieldId === "status_timer" || fieldId === "tasks") return null;
                    if (fieldId === "price" && !canSeePricing) return null;
                    const labels = { agency_agent: "Person and Organisation", shoot: "Shoot", price: "Price", priority: "Priority", property_type: "Type", products_packages: "Products & Packages", payment_status: "Payment", effort: "Effort" };
                    if (!labels[fieldId]) return null;
                    return <th key={fieldId} className="text-left p-4 font-medium text-sm">{labels[fieldId]}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredProjects.map(project => {
                  const projectTasks = allTasks.filter(t => t.project_id === project.id && !t.parent_task_id);
                  const projectTimeLogs = allTimeLogs.filter(l => l.project_id === project.id);
                  return (
                    <tr key={project.id} className="border-t hover:bg-muted/30 transition-colors">
                      <td className="p-4">
                        <Link
                          to={createPageUrl("ProjectDetails") + `?id=${project.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {project.title}
                        </Link>
                        <p className="text-sm text-muted-foreground truncate max-w-xs">{project.property_address}</p>
                      </td>
                      <td className="p-4">
                        <div>
                          <ProjectStatusBadge status={project.status} lastStatusChange={project.last_status_change} />
                          {enabledFields.includes("status_timer") && project.last_status_change && (
                            <ProjectStatusTimer lastStatusChange={project.last_status_change} />
                          )}
                        </div>
                      </td>
                      {enabledFields.map(fieldId => {
                        if (fieldId === "status_timer") return null;
                        if (fieldId === "price" && !canSeePricing) return null;
                        const validFields = { agency_agent: true, shoot: true, price: true, priority: true, property_type: true, products_packages: true, payment_status: true, effort: true };
                        if (!validFields[fieldId]) return null;
                        return (
                          <td key={fieldId} className="p-4">
                            <ProjectFieldValue
                              fieldId={fieldId}
                              project={project}
                              products={products}
                              packages={packages}
                              tasks={projectTasks}
                              timeLogs={projectTimeLogs}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <CardFieldsCustomizer open={showFieldCustomizer} onClose={() => setShowFieldCustomizer(false)} />
    </div>
  );
}