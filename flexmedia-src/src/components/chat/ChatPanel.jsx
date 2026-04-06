import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, Search, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import ChatMessage from './ChatMessage';
import MessageInput from './MessageInput';

export default function ChatPanel({
  openChats,
  activeChat,
  onSetActiveChat,
  onClose,
  currentUserEmail
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState('newest');
  const [selectedUser, setSelectedUser] = useState('all');
  const [isUploading, setIsUploading] = useState(false);
  const scrollRef = useRef(null);
  const queryClient = useQueryClient();

  // Derive chat data unconditionally (before hooks that depend on it)
  const chatKey = activeChat || null;
  const currentChat = (activeChat && openChats.length)
    ? openChats.find(c => `${c.type}:${c.type === 'task' ? c.taskId : 'project'}` === chatKey)
    : null;

  const chatType = currentChat?.type || null;
  const projectId = currentChat?.projectId || null;
  const taskId = currentChat?.taskId || null;
  const taskTitle = currentChat?.taskTitle || null;
  const projectTitle = currentChat?.projectTitle || null;
  const entityName = chatType === 'task' ? 'TaskChat' : 'ProjectChat';
  const filterQuery = useMemo(
    () => chatType === 'task' ? { task_id: taskId, project_id: projectId } : { project_id: projectId },
    [chatType, taskId, projectId]
  );
  const hasValidChat = !!currentChat;

  // Fetch messages, project users, and project data
  const { data: allMessages = [], isLoading } = useQuery({
    queryKey: [entityName, filterQuery],
    queryFn: () => api.entities[entityName].filter(filterQuery, '-created_date', 500),
    enabled: hasValidChat
  });

  const { data: users = [] } = useQuery({
    queryKey: ['projectUsers', projectId],
    queryFn: () => api.entities.User.list(),
    enabled: hasValidChat
  });

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.entities.Project.list().then(p => p.find(x => x.id === projectId)),
    enabled: hasValidChat && !!projectId
  });

  // Real-time subscription
  useEffect(() => {
    if (!hasValidChat) return;
    const unsubscribe = api.entities[entityName].subscribe((event) => {
      if (chatType === 'task' && event.data?.task_id === taskId) {
        queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
      } else if (chatType === 'project' && event.data?.project_id === projectId && !event.data?.task_id) {
        queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
      }
    });
    return unsubscribe;
  }, [hasValidChat, entityName, filterQuery, chatType, taskId, projectId, queryClient]);

  // Auto-scroll to bottom — ScrollArea ref points to the Root;
  // the actual scrollable element is the Radix Viewport child.
  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [allMessages]);

  // Create message mutation
  const createMutation = useMutation({
    mutationFn: async (payload) => {
      setIsUploading(true);
      try {
        const data = {
          content: payload.content,
          project_id: projectId,
          author_email: currentUserEmail,
          author_name: payload.authorName,
          author_id: payload.authorId,
          mentions: extractMentions(payload.content),
          attachments: payload.attachments
        };
        if (chatType === 'task') {
          data.task_id = taskId;
        }
        return await api.entities[entityName].create(data);
      } finally {
        setIsUploading(false);
      }
    },
    onMutate: async (payload) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: [entityName, filterQuery] });
      const previous = queryClient.getQueryData([entityName, filterQuery]);
      const optimistic = {
        id: `optimistic-${Date.now()}`,
        content: payload.content,
        project_id: projectId,
        task_id: taskId,
        author_email: currentUserEmail,
        author_name: payload.authorName,
        author_id: payload.authorId,
        mentions: extractMentions(payload.content),
        attachments: payload.attachments || [],
        created_date: new Date().toISOString(),
        is_pinned: false,
        _optimistic: true
      };
      queryClient.setQueryData([entityName, filterQuery], (old = []) => [optimistic, ...old]);
      return { previous };
    },
    onError: (_err, _payload, context) => {
      // Roll back optimistic update on failure
      if (context?.previous) {
        queryClient.setQueryData([entityName, filterQuery], context.previous);
      }
      toast.error('Failed to send message. Please try again.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Pin mutation
  const pinMutation = useMutation({
    mutationFn: ({ messageId, isPinned }) =>
      api.entities[entityName].update(messageId, { is_pinned: !isPinned }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (messageId) => api.entities[entityName].delete(messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Early returns AFTER all hooks
  if (!activeChat || !openChats.length) return null;
  if (!currentChat) return null;

  // Filter and sort messages
  let filteredMessages = allMessages;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredMessages = filteredMessages.filter(m =>
      (m.content || '').toLowerCase().includes(q) ||
      (m.author_name || '').toLowerCase().includes(q)
    );
  }

  if (selectedUser !== 'all') {
    filteredMessages = filteredMessages.filter(m => m.author_email === selectedUser);
  }

  const pinnedMessages = filteredMessages.filter(m => m.is_pinned);
  const regularMessages = filteredMessages.filter(m => !m.is_pinned);

  if (sortBy === 'oldest') {
    regularMessages.reverse();
  }

  const sortedMessages = [
    ...pinnedMessages.sort((a, b) => new Date(b.created_date) - new Date(a.created_date)),
    ...regularMessages
  ];

  const projectUsers = users.filter(u =>
    [project?.project_owner_id, project?.onsite_staff_1_id, project?.onsite_staff_2_id,
     project?.image_editor_id, project?.video_editor_id].includes(u.id)
  ).filter(Boolean);

  const uniqueMessageAuthors = Array.from(
    new Map(allMessages.map(m => [m.author_email, m])).values()
  ).map(m => ({ email: m.author_email, name: m.author_name }));

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-96 bg-background border-l z-40 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="border-b bg-card p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 min-w-0">
            <Select value={chatKey} onValueChange={onSetActiveChat}>
              <SelectTrigger className="h-8 text-sm font-semibold border-0 p-0 hover:bg-muted/50 rounded px-2">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {openChats.map(chat => (
                  <SelectItem key={`${chat.type}:${chat.type === 'task' ? chat.taskId : 'project'}`} value={`${chat.type}:${chat.type === 'task' ? chat.taskId : 'project'}`}>
                    {chat.type === 'task' ? `${chat.taskTitle} (Task)` : `${chat.projectTitle} (Project)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">{sortedMessages.length} messages</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Filters */}
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search messages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>

          <div className="flex gap-2">
            <Select value={selectedUser} onValueChange={setSelectedUser}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <Filter className="h-3 w-3 mr-1" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Users</SelectItem>
                {uniqueMessageAuthors.map(author => (
                  <SelectItem key={author.email} value={author.email}>
                    {author.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger className="h-8 text-xs w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
                <SelectItem value="pinned">Pinned</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" ref={scrollRef}>
        {isLoading ? (
          <p className="text-center text-sm text-muted-foreground py-8">Loading...</p>
        ) : sortedMessages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground py-8">No messages yet. Start the conversation!</p>
        ) : (
          <div className="space-y-3 pr-4">
            {sortedMessages.map((msg) => (
              <ChatMessage
                key={msg.id}
                message={msg}
                currentUserEmail={currentUserEmail}
                onPin={(id, isPinned) => pinMutation.mutate({ messageId: id, isPinned })}
                onDelete={(id) => deleteMutation.mutate(id)}
                isEditable={msg.author_email === currentUserEmail}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Input */}
      <MessageInput
        onSend={(content, attachments) => {
          createMutation.mutate({
            content,
            attachments,
            authorName: (currentUserEmail || '').split('@')[0] || 'User',
            authorId: users.find(u => u.email === currentUserEmail)?.id || currentUserEmail
          });
        }}
        users={users}
        disabled={createMutation.isPending}
        uploading={isUploading}
      />
    </div>
  );
}

// Helper function to extract mentions (@email)
function extractMentions(content) {
  if (!content) return [];
  const mentionRegex = /@([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+)/g;
  const matches = content.match(mentionRegex) || [];
  return matches.map(m => m.slice(1));
}