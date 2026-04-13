import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  ChevronUp, ChevronDown, Building2, User,
  Mail, Phone, Calendar, MoreHorizontal, Pencil, Trash2,
  FolderOpen, MessageSquarePlus, ArrowUpDown, Clock,
  ExternalLink, AlertTriangle
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { TagList } from "@/components/clients/ContactTags";
import { toast } from "sonner";
import { formatDistanceToNow, differenceInDays } from "date-fns";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import { usePriceGate } from '@/components/auth/RoleGate';

// ─── Column definitions ───
const COLUMNS = [
  { id: "name",          label: "Name",          sortable: true,  minWidth: 220, defaultVisible: true },
  { id: "organization",  label: "Organisation",  sortable: true,  minWidth: 160, defaultVisible: true },
  { id: "email",         label: "Email",         sortable: true,  minWidth: 180, defaultVisible: true },
  { id: "phone",         label: "Phone",         sortable: false, minWidth: 130, defaultVisible: true },
  { id: "last_activity", label: "Last Activity", sortable: true,  minWidth: 120, defaultVisible: true },
  { id: "deal_value",    label: "Deal Value",    sortable: true,  minWidth: 110, defaultVisible: true },
  { id: "state",         label: "Status",        sortable: true,  minWidth: 110, defaultVisible: true },
  { id: "tags",          label: "Tags",          sortable: false, minWidth: 120, defaultVisible: false },
  { id: "team",          label: "Team",          sortable: true,  minWidth: 120, defaultVisible: false },
  { id: "title",         label: "Title",         sortable: true,  minWidth: 140, defaultVisible: false },
];

const STATE_STYLES = {
  Active:          { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200", dot: "bg-emerald-500" },
  Prospecting:     { bg: "bg-blue-50",    text: "text-blue-700",    border: "border-blue-200",    dot: "bg-blue-500" },
  Dormant:         { bg: "bg-gray-50",    text: "text-gray-500",    border: "border-gray-200",    dot: "bg-gray-400" },
  "Do Not Contact":{ bg: "bg-red-50",     text: "text-red-600",     border: "border-red-200",     dot: "bg-red-500" },
};

function fmtRevenue(val) {
  if (!val) return "\u2014";
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}k`;
  return `$${Math.round(val).toLocaleString()}`;
}

function lastActivityInfo(agent) {
  const lastContact = agent.last_contacted_at;
  if (!lastContact) return { label: "Never", days: Infinity, color: "text-muted-foreground" };
  const days = differenceInDays(new Date(), new Date(lastContact));
  let color = "text-emerald-600";
  if (days > 60) color = "text-red-600";
  else if (days > 30) color = "text-amber-600";
  else if (days > 14) color = "text-blue-600";
  const label = days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days}d ago`;
  return { label, days, color };
}

// ─── Inline editable cell ───
function InlineEditCell({ value, onSave, type = "text", className = "" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Sync draft when value changes externally (e.g. after save + refetch)
  useEffect(() => {
    if (!editing) {
      setDraft(value || "");
    }
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== (value || "").trim()) {
      onSave(trimmed);
    }
  };

  if (editing) {
    return (
      <Input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") { setDraft(value || ""); setEditing(false); }
        }}
        className={cn("h-7 text-xs px-1.5 -my-0.5 w-full", className)}
        onClick={e => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={cn(
        "cursor-text rounded px-1 -mx-1 py-0.5 hover:bg-muted/60 transition-colors inline-block max-w-full truncate",
        className
      )}
      onClick={e => { e.stopPropagation(); setDraft(value || ""); setEditing(true); }}
      title="Click to edit"
    >
      {value || <span className="text-muted-foreground">\u2014</span>}
    </span>
  );
}

// ─── Sort header ───
function SortableHeader({ column, sortKey, sortDir, onSort }) {
  const isActive = sortKey === column.id;
  return (
    <button
      className={cn(
        "flex items-center gap-1 text-left font-medium text-xs transition-colors whitespace-nowrap select-none",
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() => onSort(column.id)}
    >
      {column.label}
      {column.sortable && (
        isActive ? (
          sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )
      )}
    </button>
  );
}

// ─── Main component ───
export default function HierarchyTableView({
  agencies, teams, agents, onEdit, onDelete, onAddTeam, onAddAgent,
  onOpenActivityPanel, selectedAgentIds, toggleSelectAgent, toggleSelectAll,
  agentProjectCounts, agentRevenue
}) {
  const { canEdit, canView } = useEntityAccess('agencies');
  const { visible: showPricing } = usePriceGate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [visibleCols, setVisibleCols] = useState(() =>
    COLUMNS.filter(c => c.defaultVisible).map(c => c.id)
  );

  const { data: projects = [] } = useEntityList("Project", null, 5000);

  // Build lookup maps
  const agencyMap = useMemo(() => {
    const m = {};
    agencies.forEach(a => { m[a.id] = a; });
    return m;
  }, [agencies]);

  const teamMap = useMemo(() => {
    const m = {};
    teams.forEach(t => { m[t.id] = t; });
    return m;
  }, [teams]);

  // Compute per-agent stats
  const agentStats = useMemo(() => {
    const map = {};
    for (const a of agents) {
      const ps = projects.filter(p => p.agent_id === a.id);
      map[a.id] = {
        projects: ps.length,
        revenue: ps.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0),
      };
    }
    return map;
  }, [agents, projects]);

  // Sort agents
  const sortedAgents = useMemo(() => {
    const arr = [...agents];
    const dir = sortDir === "asc" ? 1 : -1;

    arr.sort((a, b) => {
      let av, bv;
      switch (sortKey) {
        case "name":
          av = (a.name || "").toLowerCase();
          bv = (b.name || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        case "organization":
          av = (a.current_agency_name || "").toLowerCase();
          bv = (b.current_agency_name || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        case "email":
          av = (a.email || "").toLowerCase();
          bv = (b.email || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        case "last_activity": {
          const da = lastActivityInfo(a).days;
          const db = lastActivityInfo(b).days;
          return (da - db) * dir;
        }
        case "deal_value": {
          const ra = agentStats[a.id]?.revenue || 0;
          const rb = agentStats[b.id]?.revenue || 0;
          return (ra - rb) * dir;
        }
        case "state":
          av = (a.relationship_state || "").toLowerCase();
          bv = (b.relationship_state || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        case "team":
          av = (a.current_team_name || "").toLowerCase();
          bv = (b.current_team_name || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        case "title":
          av = (a.title || "").toLowerCase();
          bv = (b.title || "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        default:
          return 0;
      }
    });
    return arr;
  }, [agents, sortKey, sortDir, agentStats]);

  const handleSort = useCallback((key) => {
    if (sortKey === key) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }, [sortKey]);

  const handleInlineSave = useCallback(async (agentId, field, value) => {
    try {
      await api.entities.Agent.update(agentId, { [field]: value });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      refetchEntityList("Agent");
      toast.success("Updated");
    } catch {
      toast.error("Failed to save");
    }
  }, [queryClient]);

  const activeCols = COLUMNS.filter(c => visibleCols.includes(c.id));
  const allSelected = selectedAgentIds && selectedAgentIds.size === agents.length && agents.length > 0;
  const someSelected = selectedAgentIds && selectedAgentIds.size > 0;

  return (
    <div className="space-y-0">
      {/* Results count */}
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {agents.length} contact{agents.length !== 1 ? "s" : ""}
          {canView && !canEdit && <span className="ml-2 text-muted-foreground font-normal border rounded px-1.5 py-0.5 text-[10px]">View only</span>}
          {someSelected && (
            <span className="ml-2 text-primary font-medium">
              ({selectedAgentIds.size} selected)
            </span>
          )}
        </span>
      </div>

      {/* Table */}
      <div className="border rounded-xl overflow-hidden bg-card shadow-sm">
        <div className="overflow-x-auto max-h-[calc(100vh-280px)] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b bg-muted/30 bg-card">
                {/* Checkbox column */}
                {toggleSelectAgent && (
                  <th className="w-10 px-3 py-2.5" scope="col">
                    <Checkbox
                      checked={allSelected ? true : someSelected ? "indeterminate" : false}
                      onCheckedChange={() => toggleSelectAll && toggleSelectAll()}
                      aria-label="Select all"
                    />
                  </th>
                )}
                {activeCols.map(col => (
                  <th
                    key={col.id}
                    className="px-3 py-2.5 text-left"
                    style={{ minWidth: col.minWidth }}
                    scope="col"
                  >
                    {col.sortable ? (
                      <SortableHeader
                        column={col}
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                    ) : (
                      <span className="text-xs font-medium text-muted-foreground">{col.label}</span>
                    )}
                  </th>
                ))}
                {/* Actions column */}
                <th className="w-12 px-2 py-2.5" scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {sortedAgents.length === 0 ? (
                <tr>
                  <td colSpan={activeCols.length + 2} className="text-center py-16 text-muted-foreground">
                    <User className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    <p className="text-sm font-medium">No contacts match your filters</p>
                    <p className="text-xs mt-1">Try adjusting the filters or search criteria above.</p>
                  </td>
                </tr>
              ) : (
                sortedAgents.map(agent => (
                  <ContactRow
                    key={agent.id}
                    agent={agent}
                    activeCols={activeCols}
                    agencyMap={agencyMap}
                    teamMap={teamMap}
                    stats={agentStats[agent.id]}
                    isSelected={selectedAgentIds?.has(agent.id)}
                    toggleSelect={toggleSelectAgent}
                    showCheckbox={!!toggleSelectAgent}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onOpenActivityPanel={onOpenActivityPanel}
                    onInlineSave={handleInlineSave}
                    navigate={navigate}
                    showPricing={showPricing}
                    canEdit={canEdit}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Individual row (memoized) ───
const ContactRow = React.memo(function ContactRow({
  agent, activeCols, agencyMap, teamMap, stats,
  isSelected, toggleSelect, showCheckbox,
  onEdit, onDelete, onOpenActivityPanel, onInlineSave, navigate,
  showPricing, canEdit
}) {
  const [hovered, setHovered] = useState(false);
  const activityInfo = lastActivityInfo(agent);
  const stateStyle = STATE_STYLES[agent.relationship_state] || {};
  const initials = (agent.name || "?").split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const isIdle = activityInfo.days > 30 && activityInfo.days !== Infinity;

  const renderCell = (colId) => {
    switch (colId) {
      case "name":
        return (
          <div className="flex items-center gap-2.5">
            {/* Avatar */}
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 transition-shadow",
              isIdle
                ? "bg-amber-100 text-amber-700 ring-2 ring-amber-200"
                : "bg-primary/10 text-primary"
            )}>
              {initials}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1">
                <button
                  className="text-sm font-medium text-foreground hover:text-primary hover:underline truncate block text-left"
                  onClick={(e) => { e.stopPropagation(); navigate(createPageUrl("PersonDetails") + "?id=" + agent.id); }}
                >
                  {agent.name}
                </button>
                {agent.needs_review && (
                  <span title="Needs review — data integrity issues" className="shrink-0">
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                  </span>
                )}
              </div>
              {agent.title && (
                <span className="text-[11px] text-muted-foreground truncate block">{agent.title}</span>
              )}
            </div>
          </div>
        );

      case "organization": {
        const org = agencyMap[agent.current_agency_id];
        return org ? (
          <button
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors group/org"
            onClick={(e) => { e.stopPropagation(); navigate(createPageUrl("OrgDetails") + "?id=" + org.id); }}
          >
            <Building2 className="h-3 w-3 text-blue-500 shrink-0" />
            <span className="truncate group-hover/org:underline">{org.name}</span>
          </button>
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Missing org</span>
        );
      }

      case "email":
        return agent.email ? (
          <InlineEditCell
            value={agent.email}
            onSave={val => onInlineSave(agent.id, "email", val)}
            type="email"
            className="text-xs"
          />
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Missing email</span>
        );

      case "phone":
        return agent.phone ? (
          <InlineEditCell
            value={agent.phone}
            onSave={val => onInlineSave(agent.id, "phone", val)}
            type="tel"
            className="text-xs tabular-nums"
          />
        ) : (
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Missing phone</span>
        );

      case "last_activity":
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={cn("inline-flex items-center gap-1 text-xs", activityInfo.color)}>
                  <Clock className="h-3 w-3" />
                  {activityInfo.label}
                  {isIdle && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {agent.last_contacted_at
                  ? `Last contacted ${formatDistanceToNow(new Date(agent.last_contacted_at), { addSuffix: true })}`
                  : "No contact recorded"}
                {isIdle && <p className="text-amber-600 font-medium mt-0.5">Idle contact - follow up needed</p>}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );

      case "deal_value":
        return (
          <span className="text-xs tabular-nums font-medium">
            {showPricing ? fmtRevenue(stats?.revenue) : <span className="text-muted-foreground">&mdash;</span>}
            {stats?.projects > 0 && (
              <span className="text-muted-foreground font-normal ml-1">
                ({stats.projects})
              </span>
            )}
          </span>
        );

      case "state": {
        const s = agent.relationship_state;
        if (!s) return <span className="text-muted-foreground">\u2014</span>;
        return (
          <span className={cn(
            "inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border",
            stateStyle.bg, stateStyle.text, stateStyle.border
          )}>
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", stateStyle.dot)} />
            {s}
          </span>
        );
      }

      case "tags":
        return Array.isArray(agent.tags) && agent.tags.length > 0
          ? <TagList tags={agent.tags} max={2} size="xs" />
          : <span className="text-muted-foreground">\u2014</span>;

      case "team":
        return agent.current_team_name
          ? <span className="text-xs text-muted-foreground">{agent.current_team_name}</span>
          : <span className="text-muted-foreground">\u2014</span>;

      case "title":
        return (
          <InlineEditCell
            value={agent.title}
            onSave={val => onInlineSave(agent.id, "title", val)}
            className="text-xs"
          />
        );

      default:
        return null;
    }
  };

  return (
    <tr
      className={cn(
        "border-b transition-colors group",
        isSelected ? "bg-primary/5" : "hover:bg-muted/30",
        isIdle && !isSelected && "bg-amber-50/20"
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Checkbox */}
      {showCheckbox && (
        <td className="px-3 py-2">
          <Checkbox
            checked={isSelected || false}
            onCheckedChange={() => toggleSelect(agent.id)}
            onClick={e => e.stopPropagation()}
            aria-label={`Select ${agent.name}`}
          />
        </td>
      )}

      {/* Data cells */}
      {activeCols.map(col => (
        <td key={col.id} className="px-3 py-2">
          {renderCell(col.id)}
        </td>
      ))}

      {/* Hover action icons */}
      <td className="px-2 py-2">
        <div className={cn(
          "flex items-center gap-0.5 transition-opacity",
          hovered ? "opacity-100" : "opacity-0"
        )}>
          {agent.email && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <a href={`mailto:${agent.email}`} onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <Mail className="h-3.5 w-3.5 text-blue-600" />
                    </Button>
                  </a>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Email</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {agent.phone && (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <a href={`tel:${agent.phone}`} onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-7 w-7">
                      <Phone className="h-3.5 w-3.5 text-emerald-600" />
                    </Button>
                  </a>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">Call</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => e.stopPropagation()} aria-label="More actions" title="More actions">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={() => navigate(createPageUrl("PersonDetails") + "?id=" + agent.id)}>
                <ExternalLink className="h-3.5 w-3.5 mr-2" />View Profile
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit("agent", agent)} disabled={!canEdit}>
                <Pencil className="h-3.5 w-3.5 mr-2" />Edit
              </DropdownMenuItem>
              {onOpenActivityPanel && (
                <DropdownMenuItem onClick={() => onOpenActivityPanel(agent)}>
                  <MessageSquarePlus className="h-3.5 w-3.5 mr-2" />Activity
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => navigate(createPageUrl("Projects") + `?agent=${agent.id}`)}>
                <FolderOpen className="h-3.5 w-3.5 mr-2" />Projects
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onDelete("agent", agent)} className="text-destructive focus:text-destructive focus:bg-red-50 dark:focus:bg-red-950/20" disabled={!canEdit}>
                <Trash2 className="h-3.5 w-3.5 mr-2" />Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </td>
    </tr>
  );
});
