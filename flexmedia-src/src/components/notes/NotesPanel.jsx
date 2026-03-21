import React, { useState, useMemo, useEffect } from 'react';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Filter, Lightbulb, MessageCircle, Pin, RefreshCw, X, CornerDownLeft } from 'lucide-react';
import NoteComposer from './NoteComposer';
import NoteCard from './NoteCard';
import { useQuery } from '@tanstack/react-query';

export default function NotesPanel({ agencyId, notes = [] }) {
  const { data: noteTags = [] } = useQuery({
    queryKey: ['note-tags'],
    queryFn: () => api.entities.NoteTag.list('order', 100),
    staleTime: 5 * 60 * 1000,
  });
  const [filterType, setFilterType] = useState('all');
  const [selectedFocusTag, setSelectedFocusTag] = useState(null);
  const [replyingToId, setReplyingToId] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [localNotes, setLocalNotes] = useState([]);
  const [threadedReplies, setThreadedReplies] = useState({});

  // Split all notes (roots + replies) into two structures.
  // `notes` from OrgDetails already contains ALL OrgNotes for this agency,
  // including replies (which have parent_note_id set). No N+1 queries needed.
  const processNotes = (allNotes) => {
    const roots = allNotes.filter(n => !n.parent_note_id);
    const replyMap = {};
    allNotes.filter(n => n.parent_note_id).forEach(reply => {
      if (!replyMap[reply.parent_note_id]) replyMap[reply.parent_note_id] = [];
      replyMap[reply.parent_note_id].push(reply);
    });
    setLocalNotes(roots);
    setThreadedReplies(replyMap);
  };

  useEffect(() => {
    processNotes(notes);
  }, [notes]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      const updated = await api.entities.OrgNote.filter({ agency_id: agencyId });
      processNotes(updated);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleNoteCreated = () => {
    handleRefresh();
    setReplyingToId(null);
  };

  const handleReplyToggle = (noteId) => {
    setReplyingToId(prev => (prev === noteId ? null : noteId));
  };

  const pinnedNotes = useMemo(() => localNotes.filter(n => n.is_pinned), [localNotes]);

  const mainNotes = useMemo(() => {
    let items;
    if (filterType === 'pinned') {
      items = pinnedNotes;
    } else {
      items = localNotes.filter(n => !n.is_pinned);
      if (filterType === 'threaded') {
        items = items.filter(n => (threadedReplies[n.id]?.length || 0) > 0);
      } else if (selectedFocusTag) {
        items = items.filter(n => n.focus_tags?.includes(selectedFocusTag));
      }
    }
    return [...items].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
  }, [localNotes, filterType, selectedFocusTag, threadedReplies, pinnedNotes]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Pinned notes strip (hide when filtering by pinned to avoid duplication) */}
      {pinnedNotes.length > 0 && filterType !== 'pinned' && (
        <div className="px-4 pt-3 pb-3 border-b bg-orange-50/60">
          <div className="flex items-center gap-1.5 mb-2">
            <Pin className="h-3.5 w-3.5 text-orange-600" />
            <span className="text-xs font-semibold text-orange-800">Pinned ({pinnedNotes.length})</span>
          </div>
          <div className="space-y-2">
            {pinnedNotes.map(note => (
              <NoteCard
                key={note.id}
                note={note}
                onReply={handleReplyToggle}
                onRefresh={handleRefresh}
                replyCount={threadedReplies[note.id]?.length || 0}
              />
            ))}
          </div>
        </div>
      )}

      {/* Composer (only shown when NOT in inline-reply mode at top level) */}
      {!replyingToId && (
        <div className="px-4 pt-3 pb-3 border-b">
          <NoteComposer
            agencyId={agencyId}
            onNoteCreated={handleNoteCreated}
            placeholder="Write a note..."
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="px-4 py-2 border-b bg-muted/20 flex items-center gap-1.5 flex-wrap">
        <Filter className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {[
          { id: 'all', label: 'All' },
          { id: 'pinned', label: 'Pinned', Icon: Pin },
          { id: 'threaded', label: 'Threaded', Icon: MessageCircle },
        ].map(f => (
          <Button
            key={f.id}
            size="sm"
            variant={filterType === f.id && !selectedFocusTag ? 'default' : 'ghost'}
            onClick={() => { setFilterType(f.id); setSelectedFocusTag(null); }}
            className="text-xs h-7 gap-1 px-2"
          >
            {f.Icon && <f.Icon className="h-3 w-3" />}
            {f.label}
          </Button>
        ))}
        <div className="w-px h-4 bg-border mx-1" />
        {noteTags.map(tag => (
          <Badge
            key={tag.id}
            variant={selectedFocusTag === tag.name ? 'default' : 'outline'}
            className="text-xs cursor-pointer h-6 flex items-center"
            style={
              selectedFocusTag === tag.name && tag.color
                ? { background: tag.color, borderColor: tag.color, color: '#fff' }
                : tag.color
                ? { borderColor: tag.color + '88', color: tag.color }
                : {}
            }
            onClick={() => {
              setSelectedFocusTag(prev => prev === tag.name ? null : tag.name);
              setFilterType('all');
            }}
          >
            {tag.name}
          </Badge>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="ml-auto h-7 w-7 p-0 shrink-0"
          title="Refresh notes"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Notes feed */}
      <div className="flex-1 overflow-y-auto">
        {mainNotes.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Lightbulb className="h-8 w-8 mx-auto opacity-30 mb-2" />
            <p className="font-medium text-sm">No notes yet</p>
            <p className="text-xs mt-1 opacity-70">Start by adding a note above</p>
          </div>
        ) : (
          <div className="divide-y">
            {mainNotes.map(note => {
              const replies = (threadedReplies[note.id] || []).sort(
                (a, b) => new Date(a.created_date) - new Date(b.created_date)
              );
              const isReplying = replyingToId === note.id;

              return (
                <div key={note.id} className="px-4 py-3">
                  <NoteCard
                    note={note}
                    onReply={handleReplyToggle}
                    onRefresh={handleRefresh}
                    replyCount={replies.length}
                  />

                  {/* Threaded replies */}
                  {replies.length > 0 && (
                    <div className="mt-2 space-y-2 pl-4 border-l-2 border-blue-200 ml-2">
                      {replies.map(reply => (
                        <NoteCard
                          key={reply.id}
                          note={reply}
                          onReply={() => handleReplyToggle(note.id)} // always reply to root note
                          onRefresh={handleRefresh}
                          isReply
                          replyCount={0}
                        />
                      ))}
                    </div>
                  )}

                  {/* Inline reply composer */}
                  {isReplying && (
                    <div className="mt-2 pl-4 border-l-2 border-primary/30 ml-2">
                      <div className="flex items-center gap-2 mb-2">
                        <CornerDownLeft className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="text-xs font-medium text-primary">
                          Replying to {note.author_name || 'note'}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 px-1 ml-auto text-xs text-muted-foreground"
                          onClick={() => setReplyingToId(null)}
                        >
                          <X className="h-3 w-3" />
                          Cancel
                        </Button>
                      </div>
                      <NoteComposer
                        agencyId={agencyId}
                        onNoteCreated={handleNoteCreated}
                        parentNoteId={note.id}
                        isReply
                        placeholder="Write a reply..."
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}