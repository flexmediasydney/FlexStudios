import React, { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, ChevronDown, RotateCcw, User, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const FilterGroup = ({ title, items, selectedIds, onToggle, icon: Icon }) => {
  const [search, setSearch] = useState("");
  
  const filtered = useMemo(() => 
    items.filter(item => item.name.toLowerCase().includes(search.toLowerCase())),
    [items, search]
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
        <h4 className="font-medium text-sm">{title}</h4>
        {selectedIds.length > 0 && (
          <Badge variant="secondary" className="ml-auto text-xs">
            {selectedIds.length}
          </Badge>
        )}
      </div>
      
      <Input
        placeholder={`Search ${title.toLowerCase()}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-8 text-sm"
      />
      
      <ScrollArea className="h-auto max-h-48">
        <div className="space-y-2 pr-4">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No results</p>
          ) : (
            filtered.map(item => (
              <label
                key={item.id}
                className={cn(
                  "flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors",
                  selectedIds.includes(item.id)
                    ? "bg-primary/10"
                    : "hover:bg-muted/50"
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => onToggle(item.id)}
                  className="rounded w-4 h-4"
                />
                <span className="text-sm flex-1 truncate">{item.name}</span>
              </label>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default function ProjectFiltersSort({ 
  products = [],
  packages = [],
  agents = [],
  agencies = [],
  teams = [],
  internalUsers = [],
  internalTeams = [],
  onFiltersChange,
  onSortChange,
  activeFilters = {},
  activeSort = "last_status_change"
}) {
  const [openFilter, setOpenFilter] = useState(null);

  const handleFilterChange = (filterType, value) => {
    const newFilters = { ...activeFilters };
    if (!newFilters[filterType]) newFilters[filterType] = [];
    if (newFilters[filterType].includes(value)) {
      newFilters[filterType] = newFilters[filterType].filter(v => v !== value);
    } else {
      newFilters[filterType].push(value);
    }
    if (newFilters[filterType].length === 0) delete newFilters[filterType];
    onFiltersChange(newFilters);
  };

  // Toggle a boolean-style filter (assigned_to_me, assigned_to_my_team)
  const handleToggleFilter = (filterType) => {
    const newFilters = { ...activeFilters };
    if (newFilters[filterType]) {
      delete newFilters[filterType];
    } else {
      newFilters[filterType] = true;
    }
    onFiltersChange(newFilters);
  };

  const clearFilter = (filterType, value) => {
    const newFilters = { ...activeFilters };
    if (value === undefined) {
      delete newFilters[filterType];
    } else if (newFilters[filterType]) {
      newFilters[filterType] = newFilters[filterType].filter(v => v !== value);
      if (newFilters[filterType].length === 0) delete newFilters[filterType];
    }
    onFiltersChange(newFilters);
  };

  // Count active filters (arrays + booleans)
  const activeFilterCount = Object.values(activeFilters).reduce(
    (sum, val) => sum + (Array.isArray(val) ? val.length : (val ? 1 : 0)),
    0
  );

  const sortOptions = [
    { value: "last_status_change", label: "Last Updated" },
    { value: "task_deadline", label: "Task Deadline" },
    { value: "next_activity", label: "Next Activity" },
    { value: "created_date", label: "Date Created" },
    { value: "shoot_date_asc", label: "Shoot date (soonest first)" },
    { value: "shoot_date_desc", label: "Shoot date (latest first)" }
  ];

  // Multi-select filter groups (existing)
  const filterGroups = [
    { type: "products", title: "Products", items: products },
    { type: "packages", title: "Packages", items: packages },
    { type: "agents", title: "Agents", items: agents },
    { type: "agencies", title: "Agencies", items: agencies },
    { type: "teams", title: "Client Teams", items: teams },
    // Internal users filter (by user id)
    { type: "internal_users", title: "Staff", items: internalUsers.map(u => ({ id: u.id, name: u.full_name || u.email })) },
    // Internal teams filter
    { type: "internal_teams", title: "Internal Teams", items: internalTeams.map(t => ({ id: t.id, name: t.name })) },
  ].filter(g => g.items.length > 0);

  // All items for chip label lookup
  const allItems = [
    ...products, ...packages, ...agents, ...agencies, ...teams,
    ...internalUsers.map(u => ({ id: u.id, name: u.full_name || u.email })),
    ...internalTeams.map(t => ({ id: t.id, name: t.name })),
  ];

  return (
    <div className="space-y-4">
      {/* Controls Bar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Sort */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Sort by:</span>
          <Select value={activeSort} onValueChange={onSortChange}>
            <SelectTrigger className="w-44 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1" />

        {/* Quick toggle: My Projects / My Team */}
        <Button
          variant={activeFilters.assigned_to_me ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => handleToggleFilter("assigned_to_me")}
        >
          <User className="h-3.5 w-3.5" />
          My Projects
        </Button>
        <Button
          variant={activeFilters.assigned_to_my_team ? "default" : "outline"}
          size="sm"
          className="gap-2"
          onClick={() => handleToggleFilter("assigned_to_my_team")}
        >
          <Users className="h-3.5 w-3.5" />
          My Team
        </Button>

        {/* Multi-select filter buttons */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {filterGroups.map(group => (
            <Popover key={group.type} open={openFilter === group.type} onOpenChange={(open) => setOpenFilter(open ? group.type : null)}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "gap-2",
                    (activeFilters[group.type]?.length || 0) > 0 && "bg-primary/5 border-primary/30"
                  )}
                >
                  {group.title}
                  {(activeFilters[group.type]?.length || 0) > 0 && (
                    <Badge variant="secondary" className="ml-1 text-xs">
                      {activeFilters[group.type].length}
                    </Badge>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-4" align="start">
                <FilterGroup
                  title={group.title}
                  items={group.items}
                  selectedIds={activeFilters[group.type] || []}
                  onToggle={(id) => handleFilterChange(group.type, id)}
                />
              </PopoverContent>
            </Popover>
          ))}
        </div>

        {/* Reset Button */}
        {activeFilterCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onFiltersChange({})}
            className="gap-1.5"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        )}
      </div>

      {/* Active Filters Chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-xs text-muted-foreground font-medium">Active:</span>
          {activeFilters.assigned_to_me && (
            <Badge variant="secondary" className="gap-1.5 px-2.5 py-1">
              <User className="h-3 w-3" />
              <span className="text-xs">My Projects</span>
              <button onClick={() => clearFilter("assigned_to_me")} className="hover:opacity-70">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {activeFilters.assigned_to_my_team && (
            <Badge variant="secondary" className="gap-1.5 px-2.5 py-1">
              <Users className="h-3 w-3" />
              <span className="text-xs">My Team</span>
              <button onClick={() => clearFilter("assigned_to_my_team")} className="hover:opacity-70">
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
          {Object.entries(activeFilters).map(([type, values]) =>
            Array.isArray(values) && values.map(value => {
              const item = allItems.find(i => i.id === value);
              return (
                <Badge
                  key={`${type}-${value}`}
                  variant="secondary"
                  className="gap-1.5 px-2.5 py-1"
                >
                  <span className="text-xs">{item?.name || value}</span>
                  <button
                    onClick={() => clearFilter(type, value)}
                    className="hover:opacity-70 transition-opacity"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}