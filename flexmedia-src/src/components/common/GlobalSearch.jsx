import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { useEntityList } from "@/components/hooks/useEntityData";
import { stageConfig, stageLabel } from "@/components/projects/projectStatuses";
import { fmtDate } from "@/components/utils/dateUtils";
import {
  Command, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Camera, Users, Building2, MapPin, Mail, Search } from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────
function highlight(text = "", query = "") {
  if (!query || !text) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-100 text-yellow-900 rounded-sm px-0.5 not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}



export default function GlobalSearch({ open, onClose }) {
  const navigate  = useNavigate();
  const [query, setQuery] = useState("");

  // ── Data (all from shared cache — zero extra API calls) ─────────────────
  const { data: allProjects = [] } = useEntityList("Project");
  const { data: allAgents = [] }   = useEntityList("Agent");
  const { data: allAgencies = [] } = useEntityList("Agency");

  // Reset query when closed
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  // ── Search results ───────────────────────────────────────────────────────
  const q = query.trim().toLowerCase();

  const projectResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allProjects.filter(p =>
      p.title?.toLowerCase().includes(q) ||
      p.property_address?.toLowerCase().includes(q) ||
      p.client_name?.toLowerCase().includes(q) ||
      p.agent_name?.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [allProjects, q]);

  const agentResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allAgents.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.email?.toLowerCase().includes(q) ||
      a.phone?.toLowerCase().includes(q)
    ).slice(0, 5);
  }, [allAgents, q]);

  const agencyResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allAgencies.filter(a =>
      a.name?.toLowerCase().includes(q) ||
      a.suburb?.toLowerCase().includes(q)
    ).slice(0, 4);
  }, [allAgencies, q]);

  const totalResults = projectResults.length + agentResults.length + agencyResults.length;

  // ── Navigation ───────────────────────────────────────────────────────────
  const goTo = useCallback((path) => {
    onClose();
    navigate(path);
  }, [navigate, onClose]);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="p-0 gap-0 shadow-xl max-w-xl overflow-hidden">
        <Command shouldFilter={false} className="rounded-lg">
          <div className="flex items-center border-b px-3 gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <CommandInput
              placeholder="Search projects, people, agencies…"
              value={query}
              onValueChange={setQuery}
              className="border-0 focus:ring-0 h-12 text-sm"
            />
            <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
              ESC
            </kbd>
          </div>

          <CommandList className="max-h-[420px]">
            {q.length < 2 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search
              </div>
            ) : totalResults === 0 ? (
              <CommandEmpty>No results for "{query}"</CommandEmpty>
            ) : (
              <>
                {/* Projects */}
                {projectResults.length > 0 && (
                  <CommandGroup heading={`Projects (${projectResults.length})`}>
                    {projectResults.map(p => (
                      <CommandItem
                       key={p.id}
                       value={p.id}
                       onSelect={() => goTo(createPageUrl("ProjectDetails") + `?id=${p.id}`)}
                       className="flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150"
                       aria-label={`Go to project ${p.title}`}
                      >
                        <Camera className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm truncate">
                              {highlight(p.title || p.property_address, query)}
                            </span>
                            {p.status && (() => {
                              const cfg = stageConfig(p.status);
                              return (
                                <Badge className={`text-[10px] h-4 shrink-0 ${cfg.color} ${cfg.textColor}`}>
                                  {stageLabel(p.status)}
                                </Badge>
                              );
                            })()}
                            {p.shoot_date && (
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                📅 {fmtDate(p.shoot_date, 'd MMM')}
                              </span>
                            )}
                            {p.calculated_price && (
                              <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                                ${Math.round(p.calculated_price).toLocaleString()}
                              </span>
                            )}
                          </div>
                          {p.title && p.property_address && (
                            <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                              <MapPin className="h-3 w-3 shrink-0" />
                              {highlight(p.property_address, query)}
                            </p>
                          )}
                          {p.client_name && (
                            <p className="text-xs text-muted-foreground truncate">
                              {highlight(p.client_name, query)}
                            </p>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {/* Agents */}
                {agentResults.length > 0 && (
                  <CommandGroup heading={`People (${agentResults.length})`}>
                    {agentResults.map(a => (
                      <CommandItem
                       key={a.id}
                       value={`agent-${a.id}`}
                       onSelect={() => goTo(createPageUrl("PersonDetails") + `?id=${a.id}`)}
                       className="flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150"
                       aria-label={`Go to person ${a.name}`}
                      >
                        <Users className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{highlight(a.name, query)}</p>
                          {a.email && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1">
                              <Mail className="h-3 w-3 shrink-0" />
                              {highlight(a.email, query)}
                            </p>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}

                {/* Agencies */}
                {agencyResults.length > 0 && (
                  <CommandGroup heading={`Agencies (${agencyResults.length})`}>
                    {agencyResults.map(a => (
                      <CommandItem
                       key={a.id}
                       value={`agency-${a.id}`}
                       onSelect={() => goTo(createPageUrl("ClientAgents") + `?agency=${a.id}`)}
                       className="flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150"
                       aria-label={`Go to agency ${a.name}`}
                      >
                        <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{highlight(a.name, query)}</p>
                          {a.suburb && (
                            <p className="text-xs text-muted-foreground">{highlight(a.suburb, query)}</p>
                          )}
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}