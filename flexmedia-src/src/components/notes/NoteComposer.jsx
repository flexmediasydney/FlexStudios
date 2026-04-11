import React, { useState, useRef, useEffect } from 'react';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Paperclip, Send, X, AtSign } from 'lucide-react';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { useQuery } from '@tanstack/react-query';

export default function NoteComposer({ 
  agencyId, 
  onNoteCreated, 
  parentNoteId = null,
  placeholder = "Write a note... (type @ to mention someone)",
  isReply = false
}) {
  const { data: user } = useCurrentUser();
  const { data: availableTags = [] } = useQuery({
    queryKey: ["note-tags"],
    queryFn: () => api.entities.NoteTag.list("order", 100),
    staleTime: 5 * 60 * 1000,
  });
  const { data: allUsers = [] } = useQuery({
    queryKey: ["users-for-mention"],
    queryFn: () => api.entities.User.list(),
    staleTime: 10 * 60 * 1000,
  });

  const [content, setContent] = useState("");
  const [mentions, setMentions] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [focusTags, setFocusTags] = useState([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // @mention dropdown state
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const textareaRef = useRef(null);

  const filteredUsers = allUsers.filter(u =>
    mentionQuery === '' || u.full_name?.toLowerCase().includes(mentionQuery.toLowerCase()) || u.email?.toLowerCase().includes(mentionQuery.toLowerCase())
  ).slice(0, 6);

  const handleContentChange = (e) => {
    const value = e.target.value;
    setContent(value);

    // Detect @query before cursor
    const cursor = e.target.selectionStart;
    const textBeforeCursor = value.substring(0, cursor);
    const atMatch = textBeforeCursor.match(/@([\w\s]*)$/);
    if (atMatch !== null) {
      setMentionQuery(atMatch[1]);
      setMentionOpen(true);
    } else {
      setMentionOpen(false);
      setMentionQuery('');
    }
  };

  const handleSelectMention = (selectedUser) => {
    const cursor = textareaRef.current?.selectionStart ?? content.length;
    const textBeforeCursor = content.substring(0, cursor);
    const atMatch = textBeforeCursor.match(/@([\w\s]*)$/);
    if (atMatch) {
      const replacement = `@${selectedUser.full_name} `;
      const newContent =
        content.substring(0, cursor - atMatch[0].length) +
        replacement +
        content.substring(cursor);
      setContent(newContent);
    }
    if (!mentions.find(m => m.email === selectedUser.email)) {
      setMentions(prev => [...prev, { email: selectedUser.email, name: selectedUser.full_name }]);
    }
    setMentionOpen(false);
    setMentionQuery('');
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (!textareaRef.current?.contains(e.target)) setMentionOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleAddAttachment = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = Array.from(e.target.files);
      for (const file of files) {
        const result = await api.integrations.Core.UploadFile({ file });
        setAttachments(prev => [...prev, {
          file_url: result.file_url,
          file_name: file.name,
          file_size: file.size,
          file_type: file.type,
          uploaded_at: new Date().toISOString()
        }]);
      }
    };
    input.click();
  };

  const handleSaveNote = async () => {
    if (!content.trim()) return;
    setIsSubmitting(true);
    try {
      await api.entities.OrgNote.create({
        agency_id: agencyId,
        content,
        author_name: user?.full_name,
        author_email: user?.email,
        mentions,
        attachments,
        focus_tags: focusTags,
        parent_note_id: parentNoteId || undefined,
      });
      setContent("");
      setMentions([]);
      setAttachments([]);
      setFocusTags([]);
      onNoteCreated?.();
    } catch (error) {
      toast.error("Failed to save note: " + (error.message || "Unknown error"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && mentionOpen) {
      setMentionOpen(false);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSaveNote();
    }
  };

  return (
    <Card className={`p-3 space-y-2 ${isReply ? 'bg-blue-50/60' : ''}`}>
      {/* Textarea with @mention dropdown */}
      <div className="relative">
        <Textarea
          ref={textareaRef}
          placeholder={placeholder}
          value={content}
          onChange={handleContentChange}
          onKeyDown={handleKeyDown}
          data-note-textarea
          className={`min-h-[72px] resize-none text-sm ${isReply ? 'bg-background' : 'bg-yellow-50 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800'}`}
        />

        {/* @mention dropdown */}
        {mentionOpen && filteredUsers.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 bg-popover border rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
            {filteredUsers.map(u => (
              <button
                key={u.id}
                type="button"
                className="w-full text-left px-3 py-2 hover:bg-muted/60 flex items-center gap-2 text-sm transition-colors"
                onMouseDown={(e) => { e.preventDefault(); handleSelectMention(u); }}
              >
                <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <span className="text-[10px] font-bold text-primary">{(u.full_name || '?')[0].toUpperCase()}</span>
                </div>
                <div className="min-w-0">
                  <p className="font-medium truncate">{u.full_name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{u.email}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="space-y-1">
          {attachments.map((att, idx) => (
            <div key={idx} className="flex items-center justify-between p-2 bg-gray-50 rounded text-xs">
              <span className="truncate">{att.file_name}</span>
              <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Focus Tags */}
      {availableTags.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          <span className="text-[10px] text-muted-foreground font-medium mr-1">Tags:</span>
          {availableTags.map(tag => {
            const active = focusTags.includes(tag.name);
            return (
              <Badge
                key={tag.id}
                variant={active ? 'default' : 'outline'}
                className="text-xs cursor-pointer h-5 flex items-center gap-1"
                style={active && tag.color ? { background: tag.color, borderColor: tag.color, color: '#fff' } : tag.color ? { borderColor: tag.color + '88', color: tag.color } : {}}
                onClick={() => setFocusTags(prev => active ? prev.filter(t => t !== tag.name) : [...prev, tag.name])}
              >
                {tag.name}
                {active && <X className="h-2.5 w-2.5" onClick={(e) => { e.stopPropagation(); setFocusTags(prev => prev.filter(t => t !== tag.name)); }} />}
              </Badge>
            );
          })}
        </div>
      )}

      {/* Mentions chips */}
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {mentions.map(m => (
            <Badge key={m.email} className="bg-blue-100 text-blue-700 gap-1 text-xs">
              <AtSign className="h-2.5 w-2.5" />
              {m.name}
              <X className="h-3 w-3 cursor-pointer" onClick={() => setMentions(prev => prev.filter(x => x.email !== m.email))} />
            </Badge>
          ))}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" className="gap-2" onClick={handleAddAttachment}>
          <Paperclip className="h-4 w-4" />
          Attach
        </Button>
        <Button size="sm" onClick={handleSaveNote} disabled={!content.trim() || isSubmitting} className="gap-2">
          <Send className="h-4 w-4" />
          {isSubmitting ? "Saving..." : "Save"}
        </Button>
      </div>
    </Card>
  );
}