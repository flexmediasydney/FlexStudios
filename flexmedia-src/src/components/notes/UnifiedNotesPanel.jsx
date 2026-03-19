import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { useCurrentUser, usePermissions } from '@/components/auth/PermissionGuard';
import { useDebounce } from '@/components/hooks/useDebounce';
import { Input } from '@/components/ui/input';
import { Search, Pin, Lightbulb, ChevronDown, ChevronRight } from 'lucide-react';
import { decorateEntity } from '@/components/utils/entityTransformer';
import { fixTimestamp } from '@/components/utils/dateUtils';
import UnifiedNoteComposer from './UnifiedNoteComposer';
import UnifiedNoteCard from './UnifiedNoteCard';

const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: 'agency', label: 'Org' },
  { key: 'project', label: 'Projects' },
  { key: 'agent', label: 'People' },
  { key: 'team', label: 'Teams' },
];

function SkeletonNote() {
  return (
    <div className="bg-white border border-border/60 rounded-xl shadow-sm mx-3 my-2.5 p-4 animate-pulse">
      <div className="flex gap-2.5 mb-3">
        <div className="w-8 h-8 rounded-full bg-muted shrink-0" />
        <div className="flex-1 space-y-1.5 pt-0.5">
          <div className="h-3 w-28 bg-muted rounded" />
          <div className="h-2.5 w-20 bg-muted/70 rounded" />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-3 bg-muted rounded w-3/4" />
        <div className="h-3 bg-muted rounded w-1/2" />
      </div>
    </div>
  );
}

export default function UnifiedNotesPanel({
  agencyId,
  projectId,
  agentId,
  teamId,
  contextLabel,
  contextType,
  relatedProjectIds,
  relatedAgentIds,
  showContextOnNotes = false,
}) {
  const { data: currentUser } = useCurrentUser();
  const { isMasterAdmin } = usePermissions();
  const queryClient = useQueryClient();
  const [filterType, setFilterType] = useState('all');
  const [searchRaw, setSearchRaw] = useState('');
  const searchQuery = useDebounce(searchRaw, 300);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);

  // Most specific context wins
  const contextKey = teamId || agentId || projectId || agencyId;
  const contextField = teamId ? 'team_id' : agentId ? 'agent_id' : projectId ? 'project_id' : 'agency_id';

  const { data: rawNotes = [], isLoading: loading } = useQuery({
    queryKey: ['org-notes', contextField, contextKey],
    queryFn: () => base44.entities.OrgNote.filter(
      { [contextField]: contextKey },
      '-created_date',
      agencyId && !projectId && !agentId && !teamId ? 500 : 200
    ),
    enabled: !!contextKey,
    staleTime: 30 * 1000,
  });

  const { data: legacyNotes = [] } = useQuery({
    queryKey: ['project-notes', projectId],
    queryFn: () => base44.entities.ProjectNote.filter({ project_id: projectId }, '-created_date', 100),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const handleSaved = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['org-notes', contextField, contextKey] });
  }, [queryClient, contextField, contextKey]);

  // Merge OrgNotes + legacy ProjectNotes, sorted newest first
  // Apply decorator to OrgNotes to add shadow fields
  const allNotes = useMemo(() => {
    const decorated = rawNotes.map(n => decorateEntity('OrgNote', n));
    return [
      ...decorated,
      ...legacyNotes.map(n => ({ ...n, _isLegacy: true })),
    ].sort((a, b) => new Date(fixTimestamp(b.created_date)) - new Date(fixTimestamp(a.created_date)));
  }, [rawNotes, legacyNotes]);

  // Build thread map: root notes + replyMap
  const { rootNotes, replyMap } = useMemo(() => {
    const roots = [];
    const replies = {};
    for (const note of allNotes) {
      if (note.parent_note_id) {
        if (!replies[note.parent_note_id]) replies[note.parent_note_id] = [];
        replies[note.parent_note_id].push(note);
      } else {
        roots.push(note);
      }
    }
    return { rootNotes: roots, replyMap: replies };
  }, [allNotes]);

  const pinnedNotes = useMemo(() => rootNotes.filter(n => n.is_pinned), [rootNotes]);

  // Compute per-tab counts for badges
  const tabCounts = useMemo(() => {
    if (!showContextOnNotes) return {};
    const unpinned = rootNotes.filter(n => !n.is_pinned);
    return {
      all: unpinned.length,
      agency: unpinned.filter(n => !n.context_type || n.context_type === 'agency').length,
      project: unpinned.filter(n => n.context_type === 'project').length,
      agent: unpinned.filter(n => n.context_type === 'agent').length,
      team: unpinned.filter(n => n.context_type === 'team').length,
    };
  }, [rootNotes, showContextOnNotes]);

  const visibleNotes = useMemo(() => {
    let notes = rootNotes.filter(n => !n.is_pinned);
    // Context type filter (org level only)
    if (showContextOnNotes && filterType !== 'all') {
      notes = notes.filter(n => {
        if (filterType === 'agency') return !n.context_type || n.context_type === 'agency';
        return n.context_type === filterType;
      });
    }
    // Search — always available
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      notes = notes.filter(n =>
        (n.content || '').toLowerCase().includes(q) ||
        (n.content_html || '').replace(/<[^>]*>/g, '').toLowerCase().includes(q) ||
        (n.author_name || '').toLowerCase().includes(q) ||
        (n.context_label || '').toLowerCase().includes(q)
      );
    }
    return notes;
  }, [rootNotes, filterType, searchQuery, showContextOnNotes]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Composer */}
      <div className="shrink-0 px-4 py-4 border-b bg-background">
        <div className="shadow-sm rounded-lg">
          <UnifiedNoteComposer
            agencyId={agencyId}
            projectId={projectId}
            agentId={agentId}
            teamId={teamId}
            contextType={contextType}
            contextLabel={contextLabel}
            currentUser={currentUser}
            onSave={handleSaved}
            onCancel={() => {}}
          />
        </div>
      </div>

      {/* Filter + Search bar — filter tabs only at org level, search always */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b bg-background flex-wrap">
        {showContextOnNotes && (
          <div className="flex gap-1 flex-wrap">
            {FILTER_TABS.map(tab => {
              const count = tabCounts[tab.key];
              return (
                <button
                  key={tab.key}
                  onClick={() => setFilterType(tab.key)}
                  className={`flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors ${
                    filterType === tab.key
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {tab.label}
                  {count > 0 && (
                    <span className={`text-[9px] px-1 py-0.5 rounded-full leading-none ${
                      filterType === tab.key ? 'bg-white/25 text-white' : 'bg-muted-foreground/15 text-muted-foreground'
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <div className={`relative ${showContextOnNotes ? 'flex-1 min-w-[140px]' : 'w-full'}`}>
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchRaw}
            onChange={e => setSearchRaw(e.target.value)}
            placeholder="Search notes…"
            className="pl-8 h-7 text-xs"
          />
        </div>
      </div>

      {/* Notes feed */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <>
            <SkeletonNote />
            <SkeletonNote />
            <SkeletonNote />
          </>
        ) : (
          <>
            {/* Pinned strip */}
            {pinnedNotes.length > 0 && (
              <div className="mb-1">
                <button
                  onClick={() => setPinnedExpanded(e => !e)}
                  className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50/50 transition-colors sticky top-0 bg-background/95 backdrop-blur-sm z-10 border-b border-amber-100/60"
                >
                  <span className="flex items-center gap-1.5">
                    <Pin className="h-3 w-3 fill-amber-400 text-amber-500" />
                    Pinned ({pinnedNotes.length})
                  </span>
                  {pinnedExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </button>
                {pinnedExpanded && pinnedNotes.map(note => (
                  <UnifiedNoteCard
                    key={note.id}
                    note={note}
                    replies={replyMap[note.id] || []}
                    showContext={showContextOnNotes}
                    onRefresh={handleSaved}
                    currentUser={currentUser}
                    isMasterAdmin={isMasterAdmin}
                  />
                ))}
                {pinnedExpanded && pinnedNotes.length > 0 && (
                  <div className="mx-3 border-t border-border/40 mt-1 mb-3" />
                )}
              </div>
            )}

            {/* Main feed */}
            {visibleNotes.length === 0 && !loading ? (
              <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                <Lightbulb className="h-10 w-10 text-yellow-300 mb-3" />
                <p className="text-sm font-medium text-foreground/60">
                  {searchQuery.trim() ? 'No notes match your search' : 'No notes yet'}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {searchQuery.trim() ? 'Try a different search term' : 'Start the conversation above'}
                </p>
              </div>
            ) : (
              <>
                {visibleNotes.map(note => (
                  <UnifiedNoteCard
                    key={note.id}
                    note={note}
                    replies={replyMap[note.id] || []}
                    showContext={showContextOnNotes}
                    onRefresh={handleSaved}
                    currentUser={currentUser}
                    isMasterAdmin={isMasterAdmin}
                  />
                ))}
                <div className="h-4" />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}