import React, { useRef, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import {
  Bold, Italic, Underline, Link2, AtSign, List, ListOrdered,
  AlignLeft, AlignRight, Eraser, Paperclip, X, Loader2
} from 'lucide-react';
import { toast } from 'sonner';

// Use centralized sanitizer — covers script, iframe, object, embed, on* handlers,
// javascript:/data:/vbscript: URIs, base, form, meta, and HTML comments.
import { sanitizeEditorHtml as sanitizeHtml } from '@/utils/sanitizeHtml';

export default function UnifiedNoteComposer({
  agencyId, projectId, agentId, teamId,
  contextType, contextLabel,
  currentUser,
  isReply = false,
  parentNoteId = null,
  replyToAuthor = null,
  initialHtml = null,
  noteId = null,
  onSave,
  onCancel,
}) {
  const queryClient = useQueryClient();
  const editorRef = useRef(null);
  const fileInputRef = useRef(null);
  const mentionDropRef = useRef(null);
  const [editorEmpty, setEditorEmpty] = useState(!initialHtml);
  const [mentions, setMentions] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [uploadingFiles, setUploadingFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [mentionPos, setMentionPos] = useState({ top: 0, left: 0 });

  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.entities.User.list('full_name', 100),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (initialHtml && editorRef.current) {
      editorRef.current.innerHTML = sanitizeHtml(initialHtml);
      setEditorEmpty(false);
    }
  }, [initialHtml]);

  const filteredUsers = mentionQuery
    ? users.filter(u => u.full_name?.toLowerCase().includes((mentionQuery.query || '').toLowerCase())).slice(0, 6)
    : [];

  const checkEmpty = () => {
    const el = editorRef.current;
    return !el || (el.innerText || el.textContent || '').trim() === '';
  };

  const handleInput = () => {
    setEditorEmpty(checkEmpty());

    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) { setMentionQuery(null); return; }
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    if (container.nodeType !== Node.TEXT_NODE) { setMentionQuery(null); return; }

    const text = container.textContent.slice(0, range.startOffset);
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1 || (atIdx > 0 && !/\s/.test(text[atIdx - 1]))) { setMentionQuery(null); return; }
    const query = text.slice(atIdx + 1);
    if (query.includes(' ')) { setMentionQuery(null); return; }

    try {
      const rect = range.getBoundingClientRect();
      const edRect = editorRef.current?.getBoundingClientRect() || { top: 0, left: 0 };
      setMentionPos({ top: rect.bottom - edRect.top + 4, left: Math.max(0, rect.left - edRect.left) });
    } catch {}

    setMentionQuery({ query, textNode: container, startOffset: atIdx });
  };

  const insertMention = (user) => {
    if (!mentionQuery) return;
    const { textNode, startOffset, query } = mentionQuery;
    try {
      const range = document.createRange();
      range.setStart(textNode, startOffset);
      range.setEnd(textNode, startOffset + 1 + query.length);
      range.deleteContents();

      const chip = document.createElement('span');
      chip.contentEditable = 'false';
      chip.dataset.mention = 'true';
      chip.className = 'inline-flex items-center bg-blue-100 text-blue-700 rounded px-1.5 py-0.5 text-sm font-medium mx-0.5';
      chip.textContent = `@${user.full_name}`;
      range.insertNode(chip);

      const space = document.createTextNode('\u00A0');
      chip.after(space);

      const newRange = document.createRange();
      newRange.setStartAfter(space);
      newRange.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(newRange);

      setMentions(prev => [...prev.filter(m => m.userId !== user.id), { userId: user.id, name: user.full_name, email: user.email }]);
    } catch {}
    setMentionQuery(null);
    setEditorEmpty(false);
    editorRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleSave(); return; }
    if (e.key === 'Escape') { mentionQuery ? setMentionQuery(null) : handleCancel(); }
  };

  const handlePaste = (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };

  const toolbarCmd = (cmd, value = null) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
  };

  const handleFileInput = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) {
      const tempId = `${Date.now()}-${Math.random()}`;
      setUploadingFiles(prev => [...prev, { id: tempId, name: file.name }]);
      try {
        const { file_url } = await api.integrations.Core.UploadFile({ file });
        const ft = file.type.startsWith('image/') ? 'image'
          : file.type.startsWith('video/') ? 'video'
          : file.type.startsWith('audio/') ? 'audio'
          : 'document';
        setAttachments(prev => [...prev, { file_url, file_name: file.name, file_size: file.size, file_type: ft }]);
      } catch {
        toast.error(`Failed to upload ${file.name}`);
      } finally {
        setUploadingFiles(prev => prev.filter(f => f.id !== tempId));
      }
    }
  };

  const handleSave = async () => {
    if (!agencyId && !agentId && !teamId && !projectId) { toast.error('Cannot save note — no context available'); return; }
    if (checkEmpty()) return;
    const el = editorRef.current;
    const sanitized = sanitizeHtml(el.innerHTML);
    const plainText = (el.innerText || el.textContent || '').trim();
    setSaving(true);
    try {
      if (noteId) {
        await api.entities.OrgNote.update(noteId, { content: plainText, content_html: sanitized });
      } else {
        await api.entities.OrgNote.create({
          agency_id: agencyId,
          ...(projectId && { project_id: projectId }),
          ...(agentId && { agent_id: agentId }),
          ...(teamId && { team_id: teamId }),
          context_type: contextType,
          context_label: contextLabel,
          content: plainText,
          content_html: sanitized,
          author_name: currentUser?.full_name || 'Unknown',
          author_email: currentUser?.email || '',
          mentions,
          attachments,
          focus_tags: [],
          is_pinned: false,
          ...(parentNoteId && { parent_note_id: parentNoteId }),
        });
        // Auto-update agent's last_contacted_at
        if (agentId) {
          api.entities.Agent.update(agentId, {
            last_contacted_at: new Date().toISOString(),
          }).then(() => {
            queryClient.invalidateQueries({ queryKey: ['agents'] });
          }).catch(() => {});
        }
      }
      if (noteId) {
        // Editing: close the editor; parent re-renders the updated note
        onSave?.();
        onCancel?.();
      } else {
        el.innerHTML = '';
        setMentions([]);
        setAttachments([]);
        setEditorEmpty(true);
        onSave?.();
      }
    } catch {
      toast.error('Failed to save note');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (editorRef.current) editorRef.current.innerHTML = '';
    setMentions([]);
    setAttachments([]);
    setEditorEmpty(true);
    onCancel?.();
  };

  useEffect(() => {
    const handler = (e) => {
      if (mentionDropRef.current && !mentionDropRef.current.contains(e.target)) setMentionQuery(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const bg = isReply ? 'bg-white border border-gray-200' : 'bg-yellow-50 border border-yellow-200';
  const minH = isReply ? 'min-h-[60px]' : 'min-h-[100px]';
  const dividerCls = isReply ? 'border-gray-100' : 'border-yellow-100';

  const TOOLBAR = [
    { icon: Bold, cmd: 'bold', title: 'Bold' },
    { icon: Italic, cmd: 'italic', title: 'Italic' },
    { icon: Underline, cmd: 'underline', title: 'Underline' },
    { icon: Link2, title: 'Link', onClick: () => { const url = window.prompt('Enter URL:'); if (url) toolbarCmd('createLink', url); } },
    { icon: AlignLeft, cmd: 'justifyLeft', title: 'Align left' },
    { icon: AlignRight, cmd: 'justifyRight', title: 'Align right' },
    { icon: List, cmd: 'insertUnorderedList', title: 'Bullet list' },
    { icon: ListOrdered, cmd: 'insertOrderedList', title: 'Numbered list' },
    { icon: Eraser, cmd: 'removeFormat', title: 'Clear formatting' },
  ];

  return (
    <div className={`rounded-lg overflow-hidden ${bg}`}>
      {isReply && replyToAuthor && (
        <div className="px-3 pt-2 text-xs text-muted-foreground">
          Replying to <span className="font-medium">{replyToAuthor}</span>
        </div>
      )}

      {/* Editable area */}
      <div className="relative">
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          data-note-textarea
          className={`w-full px-3 py-2.5 ${minH} text-sm outline-none leading-relaxed`}
          style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        />
        {editorEmpty && (
          <div className="absolute top-2.5 left-3 text-sm text-muted-foreground pointer-events-none select-none">
            {isReply ? 'Write a comment...' : 'Add a note...'}
          </div>
        )}

        {/* Mention dropdown */}
        {mentionQuery && filteredUsers.length > 0 && (
          <div
            ref={mentionDropRef}
            className="absolute z-50 bg-white border rounded-lg shadow-lg min-w-[200px] py-1"
            style={{ top: mentionPos.top, left: mentionPos.left }}
          >
            {filteredUsers.map(u => (
              <button
                key={u.id}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center gap-2"
                onMouseDown={(e) => { e.preventDefault(); insertMention(u); }}
              >
                <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                  {(u.full_name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div>
                  <p className="font-medium leading-tight">{u.full_name}</p>
                  {u.email && <p className="text-[10px] text-muted-foreground">{u.email}</p>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Attachment pills */}
      {(attachments.length > 0 || uploadingFiles.length > 0) && (
        <div className={`px-3 pb-2 flex flex-wrap gap-1.5 border-t ${dividerCls} pt-2`}>
          {uploadingFiles.map(f => (
            <span key={f.id} className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded">
              <Loader2 className="h-3 w-3 animate-spin" /> {f.name}
            </span>
          ))}
          {attachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded border border-blue-100">
              {a.file_name}
              <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}>
                <X className="h-3 w-3 hover:text-red-500" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className={`flex items-center gap-0.5 px-2 py-1.5 border-t ${dividerCls}`}>
        {TOOLBAR.map(({ icon: Icon, cmd, title, onClick }) => (
          <button
            key={title}
            title={title}
            onMouseDown={(e) => { e.preventDefault(); onClick ? onClick() : toolbarCmd(cmd); }}
            className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
        <div className="h-4 w-px bg-border mx-1" />
        <button
          title="@mention"
          onMouseDown={(e) => {
            e.preventDefault();
            editorRef.current?.focus();
            document.execCommand('insertText', false, '@');
            setTimeout(handleInput, 0);
          }}
          className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <AtSign className="h-3.5 w-3.5" />
        </button>
        <button
          title="Attach file"
          onClick={() => fileInputRef.current?.click()}
          className="p-1 rounded hover:bg-black/5 text-muted-foreground hover:text-foreground transition-colors"
        >
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />

        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={handleCancel} className="h-7 text-xs text-muted-foreground">
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || editorEmpty || uploadingFiles.length > 0}
          className="h-7 text-xs bg-green-600 hover:bg-green-700 text-white"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}