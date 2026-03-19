import React, { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Send, Paperclip, User as UserIcon, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { cn } from '@/lib/utils';

export default function MessageInput({ 
  onSend, 
  users = [], 
  disabled = false, 
  uploading = false 
}) {
  const [content, setContent] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(-1);
  const [mentionQuery, setMentionQuery] = useState('');
  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  const filteredUsers = mentionQuery
    ? users.filter(u => 
        u.full_name.toLowerCase().includes(mentionQuery.toLowerCase()) ||
        u.email.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : users;

  // Handle @ mentions
  const handleTextChange = (e) => {
    const text = e.target.value;
    setContent(text);

    const lastAt = text.lastIndexOf('@');
    if (lastAt !== -1) {
      const afterAt = text.substring(lastAt + 1);
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionQuery(afterAt);
        setShowMentions(true);
        setMentionIndex(-1);
      } else {
        setShowMentions(false);
      }
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (user) => {
    const lastAt = content.lastIndexOf('@');
    const beforeMention = content.substring(0, lastAt);
    const afterMention = content.substring(content.indexOf(' ', lastAt) + 1 || content.length);
    const newContent = `${beforeMention}@${user.email} ${afterMention}`.trim();
    setContent(newContent);
    setShowMentions(false);
    setMentionQuery('');
    textareaRef.current?.focus();
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        const fileContent = await file.arrayBuffer();
        const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(fileContent)));
        const { file_url } = await base44.integrations.Core.UploadFile({
          file: `data:${file.type};base64,${base64}`
        });
        setAttachments(prev => [...prev, {
          file_url,
          file_name: file.name,
          file_type: file.type
        }]);
      } catch (error) {
        console.error('Upload failed:', error);
      }
    }
  };

  const handleSend = () => {
    if (!content.trim() && attachments.length === 0) return;
    onSend(content, attachments);
    setContent('');
    setAttachments([]);
  };

  const handleKeyDown = (e) => {
    if (showMentions && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      if (e.key === 'ArrowDown') {
        setMentionIndex(prev => 
          prev < filteredUsers.length - 1 ? prev + 1 : prev
        );
      } else {
        setMentionIndex(prev => (prev > 0 ? prev - 1 : -1));
      }
      return;
    }

    if (showMentions && e.key === 'Enter' && mentionIndex >= 0) {
      e.preventDefault();
      insertMention(filteredUsers[mentionIndex]);
      return;
    }

    if (e.key === 'Enter' && e.ctrlKey && content.trim()) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="border-t p-4 space-y-3">
      {/* Attachments Preview */}
      {attachments.length > 0 && (
        <div className="space-y-2">
          {attachments.map((att, idx) => (
            <div key={idx} className="flex items-center gap-2 p-2 rounded-lg bg-muted/50 text-xs">
              <span className="flex-1 truncate">{att.file_name}</span>
              <button
                onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Text Input */}
      <div className="relative">
        <Textarea
          ref={textareaRef}
          placeholder="Type a message... (@ to mention)"
          value={content}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={disabled || uploading}
          className="min-h-12 max-h-24 text-sm resize-none"
        />

        {/* Mention Dropdown */}
        {showMentions && filteredUsers.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-popover border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
            {filteredUsers.map((user, idx) => (
              <button
                key={user.id}
                onClick={() => insertMention(user)}
                className={cn(
                  'w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-muted transition-colors',
                  idx === mentionIndex && 'bg-muted'
                )}
              >
                <UserIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{user.full_name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          accept="*/*"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="gap-1.5"
        >
          <Paperclip className="h-4 w-4" />
          Attach
        </Button>
        <Button
          onClick={handleSend}
          disabled={(!content.trim() && attachments.length === 0) || disabled || uploading}
          size="sm"
          className="ml-auto gap-1.5"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Send
        </Button>
      </div>
    </div>
  );
}