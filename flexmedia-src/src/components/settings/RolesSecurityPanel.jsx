import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useAuth } from "@/lib/AuthContext";
import { canAccessRoute } from "@/components/lib/routeAccess";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Shield, AlertCircle, ArrowLeft, Search, Eye, X } from "lucide-react";
import { toast } from "sonner";
import PermissionMatrix from "@/components/settings/PermissionMatrix";
import EntityAccessMatrix from "@/components/settings/EntityAccessMatrix";

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLES = {
  master_admin: { label: "Owner", text: "text-red-700", bg: "bg-red-50", border: "border-red-200", fill: "#dc2626", ring: "ring-red-200" },
  admin: { label: "Administrator", text: "text-orange-700", bg: "bg-orange-50", border: "border-orange-200", fill: "#ea580c", ring: "ring-orange-200" },
  manager: { label: "Manager", text: "text-purple-700", bg: "bg-purple-50", border: "border-purple-200", fill: "#7c3aed", ring: "ring-purple-200" },
  employee: { label: "Staff", text: "text-blue-700", bg: "bg-blue-50", border: "border-blue-200", fill: "#2563eb", ring: "ring-blue-200" },
  contractor: { label: "Contractor", text: "text-gray-700", bg: "bg-gray-50", border: "border-gray-200", fill: "#6b7280", ring: "ring-gray-200" },
};

const PAGE_SECTIONS = [
  { label: "Workspace", pages: ["Dashboard","Calendar","Inbox","NotificationsPage","UserSettings"] },
  { label: "Projects", pages: ["Projects","ProjectDetails"] },
  { label: "Contacts & CRM", pages: ["ClientAgents","Organisations","Teams","People","PersonDetails","OrgDetails","TeamDetails","Prospecting","ProspectDetails","ClientMonitor"] },
  { label: "Social Media", pages: ["SocialMedia"] },
  { label: "Field Mode", pages: ["FieldMode"] },
  { label: "Analytics", pages: ["Reports"] },
  { label: "Products & Pricing", pages: ["Products","Packages","PriceMatrix","SettingsProductsPackages","SettingsPriceMatrix"] },
  { label: "Bookings", pages: ["TonomoIntegrationDashboard","TonomoPulse"] },
  { label: "Public & Gallery", pages: ["ClientGallery","MarketingWithFlex","SoldWithFlex","BountyBoard","InternalRoadmap","Favorites"] },
  { label: "Settings", pages: ["Settings","SettingsOrganisation","SettingsAutomationRules","SettingsRevisionTemplates","SettingsIntegrations","EmailSyncSettings","SettingsTonomoIntegration","SettingsTonomoMappings","SettingsNotifications","SettingsClients","SettingsProjectRulebook","SettingsTonomoWebhooks","SettingsAI","BusinessRequirementsDocument","HierarchyVisualization","SettingsTeamsUsers"] },
  { label: "Owner Only", pages: ["Users","NotificationsPulse","AdminTodoList","AIAuditLog"] },
];

const ALL_PAGES = PAGE_SECTIONS.flatMap(s => s.pages);

function prettify(name) {
  return name.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
}

function countAccess(role) {
  return ALL_PAGES.filter(p => canAccessRoute(p, role)).length;
}

// ─── Shared UI ───────────────────────────────────────────────────────────────

function RolePill({ role, selected, onClick, className = "" }) {
  const r = ROLES[role];
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-bold rounded-full border transition-all ${
        selected ? `${r.bg} ${r.text} ${r.border}` : "bg-muted text-muted-foreground border-transparent hover:border-border"
      } ${className}`}
    >
      {r.label}
    </button>
  );
}

function UserAvatar({ name, role, size = "md" }) {
  const r = ROLES[role] || ROLES.employee;
  const initials = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2);
  const px = size === "lg" ? "w-10 h-10 text-sm" : size === "sm" ? "w-7 h-7 text-[10px]" : "w-8 h-8 text-xs";
  return (
    <div className={`${px} rounded-full ${r.bg} ${r.border} border-2 flex items-center justify-center font-bold ${r.text} flex-shrink-0`}>
      {initials}
    </div>
  );
}

// ─── People Mode ─────────────────────────────────────────────────────────────

function PeopleMode({ onViewAs, onSimulateUser }) {
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [roleChangePreview, setRoleChangePreview] = useState(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list(),
    staleTime: 60_000,
  });

  const { data: userPermissions = [] } = useQuery({
    queryKey: ["userPermissions"],
    queryFn: () => api.entities.UserPermission.list(),
    staleTime: 60_000,
  });

  const { data: projects = [] } = useQuery({
    queryKey: ["projects-for-security"],
    queryFn: () => api.entities.Project.list("-created_date", 500),
    staleTime: 5 * 60_000,
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }) => api.entities.User.update(userId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      refetchEntityList("User");
      toast.success("Role updated");
      setRoleChangePreview(null);
    },
    onError: (err) => toast.error(err?.message || "Failed to update role"),
  });

  const filtered = users.filter(u =>
    !search || u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase()) ||
    u.role?.includes(search.toLowerCase())
  );

  const selected = users.find(u => u.id === selectedId);

  const getUserOverrides = (email) =>
    userPermissions.filter(up => up.user_email === email && up.is_active &&
      (!up.expires_at || new Date(up.expires_at) > new Date()));

  const getUserProjectCount = (userId) =>
    projects.filter(p => [p.project_owner_id, p.photographer_id, p.videographer_id, p.image_editor_id, p.video_editor_id, p.onsite_staff_1_id, p.onsite_staff_2_id].includes(userId)).length;

  const { data: accessRequests = [] } = useQuery({
    queryKey: ["access-requests"],
    queryFn: async () => {
      try {
        const notifs = await api.entities.Notification.filter({ type: "access_request", is_dismissed: false }, "-created_date", 20);
        return notifs || [];
      } catch { return []; }
    },
    staleTime: 30_000,
  });

  return (
    <div className={`grid gap-4 ${selected ? "grid-cols-1 lg:grid-cols-[1fr_360px]" : "grid-cols-1"} items-start`}>
      <div className="space-y-3">
        {/* Access requests */}
        {accessRequests.length > 0 && (
          <div className="rounded-lg border-l-4 border-l-amber-500 border border-amber-200 bg-amber-50 p-4">
            <div className="text-xs font-bold text-amber-900 mb-2 flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-amber-200 flex items-center justify-center text-[10px] font-extrabold text-amber-800">
                {accessRequests.length}
              </span>
              Pending access requests
            </div>
            {accessRequests.map(req => (
              <div key={req.id} className="flex items-center gap-3 py-2 border-t border-amber-200 first:border-0">
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-foreground">{req.title}</div>
                  <div className="text-[10px] text-amber-700 mt-0.5">{req.message}</div>
                </div>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={async () => {
                  try {
                    await api.entities.Notification.update(req.id, { is_dismissed: true });
                    queryClient.invalidateQueries({ queryKey: ["access-requests"] });
                    toast.success("Access request dismissed");
                  } catch { toast.error("Failed to dismiss request. Please try again."); }
                }}>
                  Dismiss
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Search + role filter */}
        <div className="flex gap-2 items-center flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search users..."
              className="pl-9 h-9 text-sm"
            />
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setSearch("")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-full border transition-all ${
                !search ? "bg-foreground text-background border-foreground" : "bg-muted text-muted-foreground border-transparent"
              }`}
            >
              All ({users.length})
            </button>
            {Object.keys(ROLES).map(r => (
              <RolePill key={r} role={r} selected={search === r} onClick={() => setSearch(search === r ? "" : r)} />
            ))}
          </div>
        </div>

        {/* User cards */}
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading users...</div>
        ) : (
          <div className="space-y-1.5">
            {filtered.map(user => {
              const isSel = selectedId === user.id;
              const role = ROLES[user.role] || ROLES.employee;
              const overrides = getUserOverrides(user.email);
              return (
                <div
                  key={user.id}
                  onClick={() => setSelectedId(isSel ? null : user.id)}
                  className={`rounded-lg border p-3 cursor-pointer transition-all ${
                    isSel ? `${role.border} ${role.ring} ring-2` : "hover:border-border hover:shadow-sm"
                  } ${!user.is_active ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-3">
                    <UserAvatar name={user.full_name} role={user.role} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate">{user.full_name || user.email}</span>
                        {!user.is_active && <Badge variant="destructive" className="text-[9px] px-1.5 py-0">INACTIVE</Badge>}
                        {overrides.length > 0 && (
                          <Badge className="text-[9px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200">
                            {overrides.length} override{overrides.length > 1 ? "s" : ""}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        {user.title || user.email}{user.internal_team_name ? ` · ${user.internal_team_name}` : ""}
                      </div>
                    </div>
                    <RolePill role={user.role || "employee"} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected user detail panel */}
      {selected && (
        <div className="sticky top-4 rounded-lg border overflow-hidden bg-card">
          {/* Header */}
          <div className={`p-4 border-b ${ROLES[selected.role]?.bg || "bg-muted"}`}>
            <div className="flex items-start gap-3">
              <UserAvatar name={selected.full_name} role={selected.role} size="lg" />
              <div className="flex-1 min-w-0">
                <div className="text-base font-bold truncate">{selected.full_name}</div>
                <div className="text-xs text-muted-foreground">{selected.email}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {selected.title}{selected.internal_team_name ? ` · ${selected.internal_team_name}` : ""}
                </div>
              </div>
              <button onClick={() => setSelectedId(null)} className="text-muted-foreground hover:text-foreground p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex gap-6 mt-3">
              {[
                { v: countAccess(selected.role), l: "pages" },
                { v: getUserProjectCount(selected.id), l: "projects" },
                { v: getUserOverrides(selected.email).length, l: "overrides" },
              ].map((s, i) => (
                <div key={i} className="text-center">
                  <div className="text-lg font-extrabold">{s.v}</div>
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider">{s.l}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="p-4 space-y-4 max-h-[500px] overflow-y-auto">
            {/* Role changer with diff preview */}
            <div>
              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Role</div>
              <div className="flex gap-1.5">
                {Object.entries(ROLES).map(([role, style]) => (
                  <button
                    key={role}
                    onClick={() => {
                      if (role !== selected.role) setRoleChangePreview({ from: selected.role, to: role });
                      else setRoleChangePreview(null);
                    }}
                    className={`flex-1 py-1.5 text-xs font-bold rounded-md border transition-all ${
                      selected.role === role
                        ? `${style.bg} ${style.text} ${style.border}`
                        : roleChangePreview?.to === role
                        ? `bg-background ${style.text} ring-2 ${style.ring} ${style.border}`
                        : "bg-muted text-muted-foreground border-transparent"
                    }`}
                  >
                    {style.label}
                  </button>
                ))}
              </div>

              {roleChangePreview && (() => {
                const gained = ALL_PAGES.filter(p => canAccessRoute(p, roleChangePreview.to) && !canAccessRoute(p, roleChangePreview.from));
                const lost = ALL_PAGES.filter(p => !canAccessRoute(p, roleChangePreview.to) && canAccessRoute(p, roleChangePreview.from));
                return (
                  <div className="mt-2 p-3 rounded-md bg-muted/50 border text-xs space-y-2">
                    <div className="font-bold">
                      {ROLES[roleChangePreview.from].label} → {ROLES[roleChangePreview.to].label}
                    </div>
                    {gained.length > 0 && (
                      <div>
                        <span className="font-bold text-green-700">+ Gains {gained.length} pages:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {gained.map(p => <span key={p} className="px-1.5 py-0.5 rounded bg-green-100 text-green-800 text-[9px] font-medium">{prettify(p)}</span>)}
                        </div>
                      </div>
                    )}
                    {lost.length > 0 && (
                      <div>
                        <span className="font-bold text-red-700">− Loses {lost.length} pages:</span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {lost.map(p => <span key={p} className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[9px] font-medium">{prettify(p)}</span>)}
                        </div>
                      </div>
                    )}
                    {gained.length === 0 && lost.length === 0 && <div className="text-muted-foreground">No access changes</div>}
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" className="h-7 text-xs flex-1" onClick={() => updateRoleMutation.mutate({ userId: selected.id, role: roleChangePreview.to })}>
                        Apply
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setRoleChangePreview(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Active overrides */}
            {getUserOverrides(selected.email).length > 0 && (
              <div>
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Active overrides</div>
                {getUserOverrides(selected.email).map(o => (
                  <div key={o.id} className="p-2.5 rounded-md bg-amber-50 border border-amber-200 mb-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold font-mono text-amber-800">{o.permission_name}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-5 px-2 text-[9px] text-red-600 hover:text-red-700 hover:bg-red-50"
                        onClick={() => {
                          api.entities.UserPermission.update(o.id, { is_active: false })
                            .then(() => { queryClient.invalidateQueries({ queryKey: ["userPermissions"] }); toast.success("Permission revoked"); })
                            .catch(() => toast.error("Failed to revoke permission. Please try again."));
                        }}
                      >
                        Revoke
                      </Button>
                    </div>
                    {o.reason && <div className="text-[10px] text-amber-700 mt-1">"{o.reason}"</div>}
                    <div className="text-[9px] text-muted-foreground mt-1">
                      By {o.granted_by}{o.expires_at ? ` · Expires ${new Date(o.expires_at).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Page access breakdown */}
            <div>
              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                Page access ({countAccess(selected.role)}/{ALL_PAGES.length})
              </div>
              {PAGE_SECTIONS.map(section => {
                const accessible = section.pages.filter(p => canAccessRoute(p, selected.role));
                const blocked = section.pages.filter(p => !canAccessRoute(p, selected.role));
                return (
                  <div key={section.label} className="mb-2">
                    <div className="text-[9px] font-bold text-muted-foreground uppercase tracking-wider mb-0.5">{section.label}</div>
                    {accessible.map(p => (
                      <div key={p} className="flex items-center gap-2 py-0.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                        <span className="text-[11px] flex-1">{prettify(p)}</span>
                      </div>
                    ))}
                    {blocked.map(p => (
                      <div key={p} className="flex items-center gap-2 py-0.5 opacity-25">
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 flex-shrink-0" />
                        <span className="text-[11px] line-through">{prettify(p)}</span>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2 border-t">
              <Button
                size="sm"
                className="flex-1 h-8 text-xs text-white"
                style={{ backgroundColor: ROLES[selected.role]?.fill }}
                onClick={() => {
                  onSimulateUser(selected.id);
                  toast.success(`Now viewing as ${selected.full_name || selected.email}`, {
                    description: `Role: ${ROLES[selected.role]?.label || selected.role}. Use the banner at the top to end the simulation.`,
                  });
                }}
              >
                <Eye className="h-3 w-3 mr-1.5" />
                Impersonate {(selected.full_name || "").split(" ")[0]}
              </Button>
              {selected.is_active ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => {
                    api.entities.User.update(selected.id, { is_active: false })
                      .then(() => { queryClient.invalidateQueries({ queryKey: ["users"] }); toast.success(`${selected.full_name || "User"} deactivated`); })
                      .catch(() => toast.error("Failed to deactivate user. Please try again."));
                  }}
                >
                  Deactivate
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs text-green-600 border-green-200 hover:bg-green-50"
                  onClick={() => {
                    api.entities.User.update(selected.id, { is_active: true })
                      .then(() => { queryClient.invalidateQueries({ queryKey: ["users"] }); toast.success(`${selected.full_name || "User"} reactivated`); })
                      .catch(() => toast.error("Failed to reactivate user. Please try again."));
                  }}
                >
                  Reactivate
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Simulator Mode ──────────────────────────────────────────────────────────

function SimulatorMode() {
  const [simRole, setSimRole] = useState("employee");
  const [compareRole, setCompareRole] = useState(null);

  const renderNav = (role) => {
    const style = ROLES[role];
    return (
      <div className="bg-slate-900 rounded-lg p-3 text-white min-h-[350px]">
        <div className={`text-xs font-bold px-2 py-1 rounded mb-3 inline-block ${style.bg} ${style.text}`}>
          {style.label}
        </div>
        {PAGE_SECTIONS.map(section => {
          const visible = section.pages.filter(p => canAccessRoute(p, role));
          if (visible.length === 0) return null;
          return (
            <div key={section.label} className="mb-2">
              <div className="text-[9px] uppercase tracking-widest text-muted-foreground px-2 pt-2 pb-1">{section.label}</div>
              {visible.map(page => (
                <div key={page} className="text-xs text-muted-foreground/50 px-2 py-1 flex items-center gap-2">
                  <span className="w-1 h-1 rounded-full bg-slate-600 flex-shrink-0" />
                  <span className="flex-1">{prettify(page)}</span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="border-t border-slate-800 mt-3 pt-2 px-2 text-[10px] text-muted-foreground">
          {countAccess(role)} pages accessible
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-muted-foreground">View as:</span>
        {Object.keys(ROLES).map(r => (
          <RolePill key={r} role={r} selected={simRole === r} onClick={() => { setSimRole(r); if (r === compareRole) setCompareRole(null); }} />
        ))}
        <span className="w-px h-5 bg-border mx-1" />
        <span className="text-sm font-semibold text-muted-foreground">Compare:</span>
        {Object.keys(ROLES).filter(r => r !== simRole).map(r => (
          <RolePill key={r} role={r} selected={compareRole === r} onClick={() => setCompareRole(compareRole === r ? null : r)} />
        ))}
        {compareRole && <button onClick={() => setCompareRole(null)} className="text-xs text-muted-foreground underline">Clear</button>}
      </div>

      <div className={`grid gap-4 ${compareRole ? "grid-cols-2" : "grid-cols-[220px_1fr]"}`}>
        {renderNav(simRole)}
        {compareRole ? renderNav(compareRole) : (
          <div className="space-y-3">
            {PAGE_SECTIONS.map(section => {
              const accessible = section.pages.filter(p => canAccessRoute(p, simRole));
              const blocked = section.pages.filter(p => !canAccessRoute(p, simRole));
              return (
                <div key={section.label} className="bg-card border rounded-lg p-3">
                  <div className="text-xs font-bold mb-2">{section.label}</div>
                  {accessible.map(p => (
                    <div key={p} className="flex items-center gap-2 py-0.5">
                      <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                      <span className="text-xs flex-1">{prettify(p)}</span>
                    </div>
                  ))}
                  {blocked.map(p => (
                    <div key={p} className="flex items-center gap-2 py-0.5 opacity-30">
                      <span className="w-2 h-2 rounded-full bg-slate-300 flex-shrink-0" />
                      <span className="text-xs line-through">{prettify(p)}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {compareRole && (() => {
        const onlyLeft = ALL_PAGES.filter(p => canAccessRoute(p, simRole) && !canAccessRoute(p, compareRole));
        const onlyRight = ALL_PAGES.filter(p => !canAccessRoute(p, simRole) && canAccessRoute(p, compareRole));
        const both = ALL_PAGES.filter(p => canAccessRoute(p, simRole) && canAccessRoute(p, compareRole));
        return (
          <div className="bg-card border rounded-lg p-4">
            <div className="text-sm font-bold mb-3">Difference: {ROLES[simRole].label} vs {ROLES[compareRole].label}</div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <div className="text-xs font-bold text-green-700 mb-2">Only {ROLES[simRole].label} ({onlyLeft.length})</div>
                {onlyLeft.length > 0 ? onlyLeft.map(p => <div key={p} className="text-xs py-0.5">{prettify(p)}</div>) : <div className="text-xs text-muted-foreground italic">None</div>}
              </div>
              <div>
                <div className="text-xs font-bold text-muted-foreground mb-2">Both ({both.length})</div>
                <div className="text-xs text-muted-foreground">{both.length} shared pages</div>
              </div>
              <div>
                <div className={`text-xs font-bold mb-2 ${ROLES[compareRole].text}`}>Only {ROLES[compareRole].label} ({onlyRight.length})</div>
                {onlyRight.length > 0 ? onlyRight.map(p => <div key={p} className="text-xs py-0.5">{prettify(p)}</div>) : <div className="text-xs text-muted-foreground italic">None</div>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Blocked UX Preview ──────────────────────────────────────────────────────

function BlockedUXMode() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground leading-relaxed">
        When a user navigates to a page their role can't access, they see this screen.
        The <strong>"Request access"</strong> button creates a notification that appears in the
        <strong> Pending access requests</strong> queue on the People tab above.
      </p>
      <div className="bg-muted/30 rounded-xl border border-dashed p-12 flex items-center justify-center">
        <div className="bg-card rounded-xl border p-10 max-w-sm text-center shadow-lg">
          <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center mx-auto mb-5">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <h2 className="text-lg font-bold mb-2">Access restricted</h2>
          <p className="text-sm text-muted-foreground mb-6">
            This page requires a different permission level. If you need access, ask the account owner.
          </p>
          <div className="flex gap-3 justify-center">
            <Button size="sm" className="gap-2">
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Button>
            <Button size="sm" variant="outline">
              Request access
            </Button>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-card border rounded-lg p-4">
          <div className="text-xs font-bold mb-2">Request flow</div>
          {["User hits blocked page", "Clicks 'Request access'", "Notification created for Owner/Admin", "Owner sees it in People tab", "Owner grants override or changes role", "Override auto-expires after set days"].map((step, i) => (
            <div key={i} className="flex items-start gap-2 py-1">
              <span className="w-4 h-4 rounded-full bg-muted flex items-center justify-center text-[9px] font-bold text-muted-foreground flex-shrink-0 mt-0.5">{i + 1}</span>
              <span className="text-xs text-muted-foreground">{step}</span>
            </div>
          ))}
        </div>
        <div className="bg-card border rounded-lg p-4">
          <div className="text-xs font-bold mb-2">Design decisions</div>
          {[
            "Says 'restricted' not 'denied' — non-alarming",
            "'Request access' closes the feedback loop",
            "No page content hint — prevents info leakage",
            "Dashboard link as safe harbour",
            "All requests logged in audit trail",
          ].map((point, i) => (
            <div key={i} className="text-xs text-muted-foreground py-1 leading-relaxed">• {point}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export default function RolesSecurityPanel() {
  const [mode, setMode] = useState("people");
  const { startSimulation } = useAuth();

  const modes = [
    { key: "people", label: "People" },
    { key: "simulate", label: "Simulate" },
    { key: "security-matrix", label: "Security Matrix" },
    { key: "overrides", label: "Overrides" },
    { key: "blocked", label: "Blocked UX" },
  ];

  return (
    <div className="space-y-4">
      {/* Role summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Object.entries(ROLES).map(([role, style]) => {
          const count = countAccess(role);
          const pct = Math.round((count / ALL_PAGES.length) * 100);
          return (
            <div key={role} className={`rounded-lg border p-4 ${style.border} ${style.bg}`}>
              <div className={`text-sm font-bold ${style.text}`}>{style.label}</div>
              <div className="flex items-end gap-2 mt-1">
                <span className="text-2xl font-extrabold text-foreground">{count}</span>
                <span className="text-xs text-muted-foreground mb-1">of {ALL_PAGES.length} pages ({pct}%)</span>
              </div>
              <div className="mt-2 h-1.5 bg-background rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: style.fill }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 border-b">
        {modes.map(m => (
          <button
            key={m.key}
            onClick={() => setMode(m.key)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-colors ${
              mode === m.key ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Mode content */}
      {mode === "people" && <PeopleMode onViewAs={(role) => setMode("simulate")} onSimulateUser={(userId) => startSimulation(userId)} />}
      {mode === "simulate" && <SimulatorMode />}
      {mode === "security-matrix" && <EntityAccessMatrix />}
      {mode === "overrides" && <PermissionMatrix />}
      {mode === "blocked" && <BlockedUXMode />}

      {/* Platform note */}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex gap-3">
        <Shield className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div>
          <div className="text-xs font-bold text-amber-900">Security note</div>
          <div className="text-xs text-amber-700 mt-1 leading-relaxed">
            Row-level security (RLS) policies in Supabase enforce data access at the database level.
            Route guards and nav filtering provide the UI layer. Both work together to protect sensitive data.
          </div>
        </div>
      </div>
    </div>
  );
}