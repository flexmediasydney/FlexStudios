import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { stageConfig, stageLabel } from "@/components/projects/projectStatuses";
import { fmtDate } from "@/components/utils/dateUtils";
import {
  Search, X, Camera, Users, Building2, MapPin, Clock,
  Plus, ChevronRight, Grid2X2
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePrefetchProjectDetails } from "@/components/lib/prefetchRoutes";
import { usePriceGate } from '@/components/auth/RoleGate';

const CATEGORIES = [
  { id: 'all', label: 'All categories', icon: Grid2X2 },
  { id: 'projects', label: 'Projects', icon: Camera },
  { id: 'people', label: 'People', icon: Users },
  { id: 'organizations', label: 'Organizations', icon: Building2 },
];

function highlight(text = "", query = "") {
  if (!query || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-yellow-900 font-medium not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function TopSearchBar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState('all');
  const [recentSearches, setRecentSearches] = useState([]);
  const [recentlyViewed, setRecentlyViewed] = useState([]);
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  const { prefetch: prefetchProject } = usePrefetchProjectDetails();
  const { visible: showPricing } = usePriceGate();

  // Prefetch project data when hovering over a search result
  const handleResultHover = useCallback((type, id) => {
    if (type === 'project') prefetchProject(id);
  }, [prefetchProject]);

  // Lazy-load: only fetch when the search bar is open.
  // This prevents 3 DB queries on every page load across the entire app.
  const { data: allProjects = [], isFetching: projectsFetching } = useQuery({
    queryKey: ["search-projects"],
    queryFn: () => api.entities.Project.list("-created_date", 500),
    enabled: isOpen,
    staleTime: 2 * 60 * 1000,
  });
  const { data: allAgents = [], isFetching: agentsFetching } = useQuery({
    queryKey: ["search-agents"],
    queryFn: () => api.entities.Agent.list("name", 1000),
    enabled: isOpen,
    staleTime: 2 * 60 * 1000,
  });
  const { data: allAgencies = [], isFetching: agenciesFetching } = useQuery({
    queryKey: ["search-agencies"],
    queryFn: () => api.entities.Agency.list("name", 500),
    enabled: isOpen,
    staleTime: 2 * 60 * 1000,
  });

  const isSearching = projectsFetching || agentsFetching || agenciesFetching;

  // Recent searches and viewed items are in-memory only (no localStorage in Base44).
  // They persist for the session but reset on page reload — this is intentional.

  // Save search to in-memory recents
  const saveSearch = (searchQuery) => {
    if (!searchQuery.trim()) return;
    setRecentSearches(prev =>
      [searchQuery, ...prev.filter(s => s !== searchQuery)].slice(0, 5)
    );
  };

  // Save viewed item to in-memory recents
  const saveViewedItem = (type, id, label) => {
    const item = { type, id, label, timestamp: Date.now() };
    setRecentlyViewed(prev =>
      [item, ...prev.filter(v => !(v.type === type && v.id === id))].slice(0, 5)
    );
  };

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape key closes the dropdown. Ctrl+K is handled by Layout.jsx — do not duplicate here.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const q = query.trim().toLowerCase();

  // Search results
  const projectResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allProjects.filter(p =>
      p.title?.toLowerCase().includes(q) ||
      p.property_address?.toLowerCase().includes(q) ||
      p.client_name?.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [allProjects, q]);

  const agentResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allAgents.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.email?.toLowerCase().includes(q) ||
      a.phone?.toLowerCase().includes(q)
    ).slice(0, 6);
  }, [allAgents, q]);

  const agencyResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allAgencies.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.address?.toLowerCase().includes(q)
    ).slice(0, 5);
  }, [allAgencies, q]);

  const filteredResults = useMemo(() => {
    if (activeCategory === 'all') {
      return {
        projects: projectResults,
        agents: agentResults,
        agencies: agencyResults
      };
    }
    if (activeCategory === 'projects') return { projects: projectResults, agents: [], agencies: [] };
    if (activeCategory === 'people') return { projects: [], agents: agentResults, agencies: [] };
    if (activeCategory === 'organizations') return { projects: [], agents: [], agencies: agencyResults };
    return { projects: [], agents: [], agencies: [] };
  }, [activeCategory, projectResults, agentResults, agencyResults]);

  const totalResults = filteredResults.projects.length + filteredResults.agents.length + filteredResults.agencies.length;

  const handleSelect = (type, id, label) => {
    saveSearch(query);
    saveViewedItem(type, id, label);
    setIsOpen(false);
    setQuery("");
    
    if (type === 'goal') navigate(createPageUrl('GoalDetails') + `?id=${id}`);
    if (type === 'project') navigate(createPageUrl('ProjectDetails') + `?id=${id}`);
    if (type === 'person') navigate(createPageUrl('PersonDetails') + `?id=${id}`);
    if (type === 'organization') navigate(createPageUrl('ClientAgents') + `?agency=${id}`);
  };

  const showDropdown = isOpen && (q.length >= 2 || (!q && (recentSearches.length > 0 || recentlyViewed.length > 0)));

  return (
    <div ref={dropdownRef} className="relative w-full max-w-2xl">
      {/* Search Input */}
      <div className={cn(
        "relative flex items-center bg-background border rounded-lg transition-all",
        isOpen ? "ring-2 ring-primary border-primary shadow-lg" : "border-input hover:border-primary/50"
      )}>
        {isSearching ? (
          <div className="absolute left-3 h-4 w-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        ) : (
          <Search className="absolute left-3 h-4 w-4 text-muted-foreground pointer-events-none" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setIsOpen(true)}
          placeholder="Search projects, people, organizations..."
          className="w-full pl-10 pr-20 py-2.5 text-sm bg-transparent focus:outline-none"
          aria-label="Global search"
        />
        <div className="absolute right-2 flex items-center gap-1.5">
          {query && (
            <>
              <span className="text-[10px] text-muted-foreground/60 font-medium tabular-nums">{query.length}</span>
              <button
                onClick={() => setQuery("")}
                className="p-1 hover:bg-muted rounded transition-colors duration-150"
                title="Clear search (Esc)"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </>
          )}
          <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-0.5 rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </div>
      </div>

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full mt-2 w-full bg-background border rounded-lg shadow-2xl z-50 max-h-[600px] overflow-hidden flex">
          {/* Categories Sidebar */}
          <div className="w-48 border-r bg-muted/30 p-2 flex-shrink-0">
            {CATEGORIES.map(cat => {
              const Icon = cat.icon;
              const count = cat.id === 'all' ? totalResults :
                           cat.id === 'projects' ? projectResults.length :
                           cat.id === 'people' ? agentResults.length :
                           cat.id === 'organizations' ? agencyResults.length : 0;
              
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  aria-label={cat.label}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md transition-colors duration-150 text-left",
                    activeCategory === cat.id 
                      ? "bg-primary/10 text-primary font-medium" 
                      : "hover:bg-muted text-muted-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="flex-1">{cat.label}</span>
                  {q.length >= 2 && count > 0 && (
                    <span className="text-xs bg-muted px-1.5 rounded">{count}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {q.length < 2 ? (
              <div className="p-4">
                {/* Recent Searches */}
                {recentSearches.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 px-2">
                      Recent searches
                    </h3>
                    {recentSearches.map((search, idx) => (
                      <button
                        key={idx}
                        onClick={() => setQuery(search)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted rounded-md transition-colors duration-150 text-left"
                        aria-label={`Recent search: ${search}`}
                      >
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {search}
                      </button>
                    ))}
                  </div>
                )}

                {/* Recently Viewed */}
                {recentlyViewed.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-2 px-2">
                      Recently viewed
                    </h3>
                    {recentlyViewed.map((item, idx) => {
                      const Icon = item.type === 'project' ? Camera : item.type === 'person' ? Users : Building2;
                      return (
                        <button
                          key={idx}
                          onClick={() => handleSelect(item.type, item.id, item.label)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted rounded-md transition-colors duration-150 text-left"
                          aria-label={`Go to ${item.type}: ${item.label}`}
                        >
                          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{item.label}</span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {recentSearches.length === 0 && recentlyViewed.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Start typing to search...
                  </p>
                )}
              </div>
            ) : totalResults === 0 ? (
              <div className="p-8 text-center">
                <div className="relative inline-block mb-4">
                  <Search className="h-10 w-10 mx-auto text-muted-foreground/30" />
                  <div className="absolute inset-0 blur-xl bg-muted/20 rounded-full" />
                </div>
                <p className="text-sm text-muted-foreground mb-4">
                  No results for <strong className="text-foreground">"{query}"</strong>
                </p>
                {isSearching && <p className="text-xs text-muted-foreground/60 mb-3 animate-pulse">Still searching...</p>}
              </div>
            ) : (
              <div className="p-2">
                {/* Projects */}
                {filteredResults.projects.length > 0 && (
                  <div className="mb-3">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5 px-2">
                      Projects ({filteredResults.projects.length})
                    </h3>
                    {filteredResults.projects.map(p => (
                      <button
                        key={p.id}
                        onClick={() => handleSelect(p.source === 'goal' ? 'goal' : 'project', p.id, p.title || p.property_address)}
                        onMouseEnter={() => handleResultHover('project', p.id)}
                        className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-muted rounded-md transition-colors duration-150 text-left group"
                        aria-label={`Go to ${p.source === 'goal' ? 'goal' : 'project'} ${p.title || p.property_address}`}
                      >
                        <Camera className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <span className="font-medium text-sm">
                              {highlight(p.title || p.property_address, query)}
                            </span>
                            {p.source === 'goal' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                                Goal
                              </span>
                            )}
                            {p.source !== 'goal' && p.status && (() => {
                              const cfg = stageConfig(p.status);
                              return (
                                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", cfg.color, cfg.textColor)}>
                                  {stageLabel(p.status)}
                                </span>
                              );
                            })()}
                          </div>
                          {p.property_address && p.title !== p.property_address && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                              <MapPin className="h-3 w-3 flex-shrink-0" />
                              {highlight(p.property_address, query)}
                            </p>
                          )}
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            {p.shoot_date && <span>📅 {fmtDate(p.shoot_date, 'd MMM yyyy')}</span>}
                            {showPricing && p.calculated_price && <span className="font-mono">${Math.round(p.calculated_price).toLocaleString()}</span>}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
                      </button>
                    ))}
                  </div>
                )}

                {/* People */}
                {filteredResults.agents.length > 0 && (
                  <div className="mb-3">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5 px-2">
                      People ({filteredResults.agents.length})
                    </h3>
                    {filteredResults.agents.map(a => (
                      <button
                        key={a.id}
                        onClick={() => handleSelect('person', a.id, a.name)}
                        className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-muted rounded-md transition-colors duration-150 text-left group"
                        aria-label={`Go to person ${a.name}`}
                      >
                        <Users className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{highlight(a.name, query)}</p>
                          {a.email && (
                            <p className="text-xs text-muted-foreground truncate">{highlight(a.email, query)}</p>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
                      </button>
                    ))}
                  </div>
                )}

                {/* Organizations */}
                {filteredResults.agencies.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase mb-1.5 px-2">
                      Organizations ({filteredResults.agencies.length})
                    </h3>
                    {filteredResults.agencies.map(a => (
                      <button
                        key={a.id}
                        onClick={() => handleSelect('organization', a.id, a.name)}
                        className="w-full flex items-start gap-3 px-3 py-2.5 hover:bg-muted rounded-md transition-colors duration-150 text-left group"
                        aria-label={`Go to organization ${a.name}`}
                      >
                        <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{highlight(a.name, query)}</p>
                          {a.address && (
                            <p className="text-xs text-muted-foreground truncate">{highlight(a.address, query)}</p>
                          )}
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 mt-0.5" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}