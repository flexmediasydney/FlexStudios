import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import {
  Camera, Users, Building2, MapPin, Mail, Search,
  Clock, ArrowRight, X
} from "lucide-react";

// ── localStorage helpers ──────────────────────────────────────────────────────
const RECENT_SEARCHES_KEY = "flex-global-search-recent";
const MAX_RECENT = 8;

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(term) {
  if (!term || !term.trim()) return;
  const trimmed = term.trim();
  const prev = loadRecentSearches();
  const next = [trimmed, ...prev.filter(s => s !== trimmed)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch { /* quota exceeded — ignore */ }
  return next;
}

function clearRecentSearches() {
  try { localStorage.removeItem(RECENT_SEARCHES_KEY); } catch {}
}

// ── Highlight helper ──────────────────────────────────────────────────────────
function highlight(text = "", query = "") {
  if (!query || !text) return text;
  // Escape regex special chars so user input like "C++" or "(test)" doesn't break
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(regex);
  if (parts.length === 1) return text; // no match
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-100 text-yellow-900 dark:bg-yellow-800/40 dark:text-yellow-200 rounded-sm px-0.5 not-italic">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

// ── Strip HTML for email body preview ─────────────────────────────────────────
function stripHtml(html = "") {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function GlobalSearch({ open, onClose }) {
  const navigate  = useNavigate();
  const [query, setQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef(null);
  const selectedItemRef = useRef(null);

  // ── Data (all from shared cache — zero extra API calls) ─────────────────
  // Only load entities when dialog is open to avoid triggering subscriptions/cache for EmailMessage
  const { data: allProjects = [] } = useEntityList(open ? "Project" : null);
  const { data: allAgents = [] }   = useEntityList(open ? "Agent" : null);
  const { data: allAgencies = [] } = useEntityList(open ? "Agency" : null);
  const { data: allEmails = [] }   = useEntityList(open ? "EmailMessage" : null, "-received_at", 500);

  // Load recent searches when dialog opens
  useEffect(() => {
    if (open) {
      setRecentSearches(loadRecentSearches());
      setSelectedIndex(0);
    } else {
      setQuery("");
    }
  }, [open]);

  // Reset selected index when query changes
  useEffect(() => { setSelectedIndex(0); }, [query]);

  // Scroll selected item into view for keyboard navigation
  useEffect(() => {
    if (selectedItemRef.current) {
      selectedItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

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

  const emailResults = useMemo(() => {
    if (!q || q.length < 2) return [];
    return allEmails.filter(e =>
      e.subject?.toLowerCase().includes(q) ||
      e.from?.toLowerCase().includes(q) ||
      e.from_name?.toLowerCase().includes(q) ||
      e.to?.toLowerCase().includes(q) ||
      stripHtml(e.body).toLowerCase().includes(q)
    ).slice(0, 6);
  }, [allEmails, q]);

  const totalResults = projectResults.length + agentResults.length + agencyResults.length + emailResults.length;

  // Build a flat list of all results for keyboard navigation
  const flatResults = useMemo(() => {
    const items = [];
    projectResults.forEach(p => items.push({ type: 'project', data: p }));
    agentResults.forEach(a => items.push({ type: 'agent', data: a }));
    agencyResults.forEach(a => items.push({ type: 'agency', data: a }));
    emailResults.forEach(e => items.push({ type: 'email', data: e }));
    return items;
  }, [projectResults, agentResults, agencyResults, emailResults]);

  // ── Navigation ───────────────────────────────────────────────────────────
  const goTo = useCallback((path) => {
    if (q.length >= 2) {
      setRecentSearches(saveRecentSearch(query.trim()));
    }
    onClose();
    navigate(path);
  }, [navigate, onClose, q, query]);

  const navigateToResult = useCallback((item) => {
    if (!item) return;
    const { type, data } = item;
    switch (type) {
      case 'project':
        goTo(createPageUrl("ProjectDetails") + `?id=${data.id}`);
        break;
      case 'agent':
        goTo(createPageUrl("PersonDetails") + `?id=${data.id}`);
        break;
      case 'agency':
        goTo(createPageUrl("ClientAgents") + `?agency=${data.id}`);
        break;
      case 'email':
        goTo(createPageUrl("Inbox") + `?thread=${data.gmail_thread_id || data.id}`);
        break;
    }
  }, [goTo]);

  // Keyboard navigation: arrow keys + Enter to select from flat result list
  // (must be declared after flatResults and navigateToResult)
  useEffect(() => {
    if (!open || flatResults.length === 0) return;
    const handler = (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, flatResults.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && flatResults[selectedIndex]) {
        e.preventDefault();
        navigateToResult(flatResults[selectedIndex]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, flatResults, selectedIndex, navigateToResult]);

  // Handle recent search click
  const handleRecentClick = useCallback((term) => {
    setQuery(term);
  }, []);

  const handleClearRecent = useCallback(() => {
    clearRecentSearches();
    setRecentSearches([]);
  }, []);

  const removeRecentSearch = useCallback((term, e) => {
    e.stopPropagation();
    const prev = loadRecentSearches();
    const next = prev.filter(s => s !== term);
    try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch {}
    setRecentSearches(next);
  }, []);

  // Show recent searches when query is empty
  const showRecents = !q && recentSearches.length > 0;

  // Track a running flat index counter for rendering
  let flatIndexCounter = 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="p-0 gap-0 shadow-xl max-w-xl overflow-hidden" aria-label="Global search">
        <Command shouldFilter={false} className="rounded-lg" aria-label="Search results">
          <div className="flex items-center border-b px-3 gap-2">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <CommandInput
              placeholder="Search projects, contacts, emails..."
              value={query}
              onValueChange={setQuery}
              className="border-0 focus:ring-0 h-12 text-sm"
              aria-label="Search projects, contacts, and emails"
            />
            <div className="flex items-center gap-1.5 shrink-0">
              {q.length >= 2 && totalResults > 0 && (
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full font-medium tabular-nums">
                  {totalResults}
                </span>
              )}
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="p-1 hover:bg-muted rounded transition-colors"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              )}
              <kbd className="hidden sm:inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                ESC
              </kbd>
            </div>
          </div>

          <CommandList className="max-h-[480px]" ref={listRef}>
            {/* Screen reader announcement for result count */}
            {q.length >= 2 && (
              <div aria-live="polite" aria-atomic="true" className="sr-only">
                {totalResults === 0
                  ? `No results found for ${query}`
                  : `${totalResults} result${totalResults !== 1 ? 's' : ''} found`}
              </div>
            )}
            {/* Recent Searches (when query is empty) */}
            {showRecents && (
              <CommandGroup heading={
                <div className="flex items-center justify-between">
                  <span>Recent Searches</span>
                  <button
                    onClick={handleClearRecent}
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors font-normal normal-case tracking-normal"
                  >
                    Clear all
                  </button>
                </div>
              }>
                {recentSearches.map((term, idx) => (
                  <CommandItem
                    key={`recent-${idx}`}
                    value={`recent-${term}`}
                    onSelect={() => handleRecentClick(term)}
                    className="group flex items-center gap-3 py-2.5 cursor-pointer hover:bg-accent transition-colors duration-150"
                  >
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="flex-1 text-sm">{term}</span>
                    <button
                      onClick={(e) => removeRecentSearch(term, e)}
                      className="p-0.5 hover:bg-muted rounded opacity-0 group-hover:opacity-100 transition-opacity"
                      aria-label={`Remove "${term}" from recent searches`}
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Empty state: no query, no recents */}
            {!q && !showRecents && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                <Search className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
                <p>Search across projects, contacts, and emails</p>
                <p className="text-xs mt-1 text-muted-foreground/60">
                  Type at least 2 characters to search
                </p>
                <div className="flex items-center justify-center gap-4 mt-4 text-[10px] text-muted-foreground/40">
                  <span className="flex items-center gap-1">
                    <kbd className="bg-muted/60 px-1.5 py-0.5 rounded border border-border/30">&uarr;&darr;</kbd>
                    navigate
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="bg-muted/60 px-1.5 py-0.5 rounded border border-border/30">&crarr;</kbd>
                    open
                  </span>
                  <span className="flex items-center gap-1">
                    <kbd className="bg-muted/60 px-1.5 py-0.5 rounded border border-border/30">esc</kbd>
                    close
                  </span>
                </div>
              </div>
            )}

            {/* Query too short */}
            {q && q.length < 2 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search
              </div>
            )}

            {/* No results */}
            {q.length >= 2 && totalResults === 0 && (
              <CommandEmpty>
                <div className="py-8 text-center">
                  <Search className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">
                    No results for <strong className="text-foreground">"{query}"</strong>
                  </p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    Try different keywords or check spelling
                  </p>
                </div>
              </CommandEmpty>
            )}

            {/* Results */}
            {q.length >= 2 && totalResults > 0 && (
              <>
                {/* ── Projects ──────────────────────────────────────────── */}
                {projectResults.length > 0 && (
                  <CommandGroup heading={
                    <span className="flex items-center gap-1.5">
                      <Camera className="h-3.5 w-3.5" />
                      Projects
                      <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{projectResults.length}</Badge>
                    </span>
                  }>
                    {projectResults.map(p => {
                      const myIdx = flatResults.findIndex(r => r.type === 'project' && r.data.id === p.id);
                      const isSelected = myIdx === selectedIndex;
                      return (
                      <CommandItem
                        key={p.id}
                        value={`project-${p.id}`}
                        ref={isSelected ? selectedItemRef : undefined}
                        onSelect={() => {
                          setRecentSearches(saveRecentSearch(query.trim()));
                          onClose();
                          navigate(createPageUrl("ProjectDetails") + `?id=${p.id}`);
                        }}
                        className={`flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150 ${isSelected ? 'bg-accent ring-2 ring-primary/30' : ''}`}
                        aria-label={`Go to project ${p.title}`}
                        aria-selected={isSelected}
                      >
                        <div className="mt-0.5 shrink-0 w-7 h-7 rounded-md bg-blue-50 flex items-center justify-center">
                          <Camera className="h-3.5 w-3.5 text-blue-600" />
                        </div>
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
                          </div>
                          {/* Preview: address */}
                          {p.property_address && (
                            <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-0.5">
                              <MapPin className="h-3 w-3 shrink-0" />
                              {highlight(p.property_address, query)}
                            </p>
                          )}
                          {/* Preview: client + date */}
                          <div className="flex items-center gap-3 mt-0.5">
                            {p.client_name && (
                              <span className="text-[11px] text-muted-foreground/70 truncate">
                                {highlight(p.client_name, query)}
                              </span>
                            )}
                            {p.shoot_date && (
                              <span className="text-[11px] text-muted-foreground/60 shrink-0">
                                {fmtDate(p.shoot_date, 'd MMM')}
                              </span>
                            )}
                          </div>
                        </div>
                      </CommandItem>
                    );
                    })}
                  </CommandGroup>
                )}

                {/* ── Contacts (Agents/People) ──────────────────────────── */}
                {agentResults.length > 0 && (
                  <CommandGroup heading={
                    <span className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5" />
                      Contacts
                      <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{agentResults.length}</Badge>
                    </span>
                  }>
                    {agentResults.map(a => {
                      const myIdx = flatResults.findIndex(r => r.type === 'agent' && r.data.id === a.id);
                      const isSelected = myIdx === selectedIndex;
                      return (
                      <CommandItem
                        key={a.id}
                        value={`agent-${a.id}`}
                        ref={isSelected ? selectedItemRef : undefined}
                        onSelect={() => {
                          setRecentSearches(saveRecentSearch(query.trim()));
                          onClose();
                          navigate(createPageUrl("PersonDetails") + `?id=${a.id}`);
                        }}
                        className={`flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150 ${isSelected ? 'bg-accent ring-2 ring-primary/30' : ''}`}
                        aria-label={`Go to contact ${a.name}`}
                        aria-selected={isSelected}
                      >
                        <div className="mt-0.5 shrink-0 w-7 h-7 rounded-md bg-emerald-50 flex items-center justify-center">
                          <Users className="h-3.5 w-3.5 text-emerald-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-medium text-sm truncate">{highlight(a.name, query)}</p>
                            {a.role && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium shrink-0 capitalize">
                                {a.role.replace(/_/g, ' ')}
                              </span>
                            )}
                          </div>
                          {/* Preview: email */}
                          {a.email && (
                            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Mail className="h-3 w-3 shrink-0" />
                              {highlight(a.email, query)}
                            </p>
                          )}
                          {/* Preview: phone */}
                          {a.phone && !a.email && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {highlight(a.phone, query)}
                            </p>
                          )}
                        </div>
                      </CommandItem>
                    );
                    })}
                  </CommandGroup>
                )}

                {/* ── Emails ────────────────────────────────────────────── */}
                {emailResults.length > 0 && (
                  <CommandGroup heading={
                    <span className="flex items-center gap-1.5">
                      <Mail className="h-3.5 w-3.5" />
                      Emails
                      <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{emailResults.length}</Badge>
                    </span>
                  }>
                    {emailResults.map(e => {
                      const snippet = stripHtml(e.body).substring(0, 100);
                      const myIdx = flatResults.findIndex(r => r.type === 'email' && r.data.id === e.id);
                      const isSelected = myIdx === selectedIndex;
                      return (
                        <CommandItem
                          key={e.id}
                          value={`email-${e.id}`}
                          ref={isSelected ? selectedItemRef : undefined}
                          onSelect={() => {
                            setRecentSearches(saveRecentSearch(query.trim()));
                            onClose();
                            navigate(createPageUrl("Inbox") + `?thread=${e.gmail_thread_id || e.id}`);
                          }}
                          className={`flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150 ${isSelected ? 'bg-accent ring-2 ring-primary/30' : ''}`}
                          aria-label={`Go to email: ${e.subject}`}
                          aria-selected={isSelected}
                        >
                          <div className="mt-0.5 shrink-0 w-7 h-7 rounded-md bg-violet-50 flex items-center justify-center">
                            <Mail className="h-3.5 w-3.5 text-violet-600" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">
                                {highlight(e.subject || "(no subject)", query)}
                              </span>
                              {e.is_unread && (
                                <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                              )}
                            </div>
                            {/* Preview: from + snippet */}
                            <p className="text-xs text-muted-foreground truncate mt-0.5">
                              {highlight(e.from_name || e.from || "", query)}
                              {e.received_at && (
                                <span className="text-muted-foreground/50 ml-2">
                                  {fmtDate(e.received_at, 'd MMM')}
                                </span>
                              )}
                            </p>
                            {snippet && (
                              <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5 italic">
                                {snippet}
                              </p>
                            )}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                )}

                {/* ── Agencies ──────────────────────────────────────────── */}
                {agencyResults.length > 0 && (
                  <CommandGroup heading={
                    <span className="flex items-center gap-1.5">
                      <Building2 className="h-3.5 w-3.5" />
                      Agencies
                      <Badge variant="secondary" className="ml-1 text-[10px] h-4 px-1.5">{agencyResults.length}</Badge>
                    </span>
                  }>
                    {agencyResults.map(a => {
                      const myIdx = flatResults.findIndex(r => r.type === 'agency' && r.data.id === a.id);
                      const isSelected = myIdx === selectedIndex;
                      return (
                      <CommandItem
                        key={a.id}
                        value={`agency-${a.id}`}
                        ref={isSelected ? selectedItemRef : undefined}
                        onSelect={() => {
                          setRecentSearches(saveRecentSearch(query.trim()));
                          onClose();
                          navigate(createPageUrl("ClientAgents") + `?agency=${a.id}`);
                        }}
                        className={`flex items-start gap-3 py-3 cursor-pointer hover:bg-accent transition-colors duration-150 ${isSelected ? 'bg-accent ring-2 ring-primary/30' : ''}`}
                        aria-label={`Go to agency ${a.name}`}
                        aria-selected={isSelected}
                      >
                        <div className="mt-0.5 shrink-0 w-7 h-7 rounded-md bg-amber-50 flex items-center justify-center">
                          <Building2 className="h-3.5 w-3.5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{highlight(a.name, query)}</p>
                          {a.suburb && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {highlight(a.suburb, query)}
                            </p>
                          )}
                        </div>
                      </CommandItem>
                    );
                    })}
                  </CommandGroup>
                )}

                {/* Result count footer */}
                <div className="px-3 py-2 border-t bg-muted/30 flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">
                    {totalResults} result{totalResults !== 1 ? 's' : ''}
                  </span>
                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                    <span className="flex items-center gap-1">
                      <kbd className="bg-muted px-1 py-0.5 rounded border border-border/40 text-[9px]">&uarr;&darr;</kbd>
                      navigate
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="bg-muted px-1 py-0.5 rounded border border-border/40 text-[9px]">&crarr;</kbd>
                      open
                    </span>
                    <span className="flex items-center gap-1">
                      <kbd className="bg-muted px-1 py-0.5 rounded border border-border/40 text-[9px]">esc</kbd>
                      close
                    </span>
                  </div>
                </div>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
