import React, { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, Search, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
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

  if (!activeChat || !openChats.length) return null;

  const chatKey = activeChat;
  const currentChat = openChats.find(c => `${c.type}:${c.type === 'task' ? c.taskId : 'project'}` === chatKey);
  
  if (!currentChat) return null;

  const { type: chatType, projectId, taskId, taskTitle, projectTitle } = currentChat;
  const entityName = chatType === 'task' ? 'TaskChat' : 'ProjectChat';
  const filterQuery = chatType === 'task' ? { task_id: taskId, project_id: projectId } : { project_id: projectId };

  // Fetch messages, project users, and project data
  const { data: allMessages = [], isLoading } = useQuery({
    queryKey: [entityName, filterQuery],
    queryFn: () => base44.entities[entityName].filter(filterQuery, '-created_date', 500)
  });

  const { data: users = [] } = useQuery({
    queryKey: ['projectUsers', projectId],
    queryFn: () => base44.entities.User.list(),
  });

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => base44.entities.Project.list().then(p => p.find(x => x.id === projectId)),
    enabled: !!projectId
  });

  // Real-time subscription
  useEffect(() => {
    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      if (chatType === 'task' && event.data?.task_id === taskId) {
        queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
      } else if (chatType === 'project' && event.data?.project_id === projectId && !event.data?.task_id) {
        queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
      }
    });
    return unsubscribe;
  }, [entityName, filterQuery, chatType, taskId, projectId, queryClient]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
        return await base44.entities[entityName].create(data);
      } finally {
        setIsUploading(false);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Pin mutation
  const pinMutation = useMutation({
    mutationFn: ({ messageId, isPinned }) => 
      base44.entities[entityName].update(messageId, { is_pinned: !isPinned }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: (messageId) => base44.entities[entityName].delete(messageId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [entityName, filterQuery] });
    }
  });

  // Filter and sort messages
  let filteredMessages = allMessages;

  if (searchQuery) {
    filteredMessages = filteredMessages.filter(m =>
      m.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.author_name.toLowerCase().includes(searchQuery.toLowerCase())
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
    project?.assigned_users?.includes(u.id) || 
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
            authorName: currentUserEmail.split('@')[0],
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
  const mentionRegex = /@([a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+)/g;
  const matches = content.match(mentionRegex) || [];
  return matches.map(m => m.slice(1));
}