import { useState, useRef } from "react";
import { LIMITS } from "@/components/hooks/useFormValidation";
import { useMutation } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Loader2, Paperclip, X, FileText, Music, Video, Image as ImageIcon, Send, AtSign } from "lucide-react";
import { toast } from "sonner";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { writeFeedEvent } from "@/components/notifications/createNotification";
import { notifyNoteMentions } from "@/components/notes/noteNotifications";

export default function ProjectNotes({ projectId }) {
  const fileInputRef = useRef(null);
  const { data: currentUser } = useCurrentUser();

  const [noteContent, setNoteContent] = useState("");
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [mentions, setMentions] = useState([]);
  const [showUserSuggestions, setShowUserSuggestions] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: notes = [] } = useEntityList(
    projectId ? "ProjectNote" : null,
    "-created_date",
    50,
    projectId ? (item) => item.project_id === projectId : null
  );
  const { data: allUsers = [] } = useEntityList("User");

  const createNoteMutation = useMutation({
    mutationFn: async (noteData) => api.entities.ProjectNote.create(noteData),
    onSuccess: () => {
      setNoteContent("");
      setSelectedFiles([]);
      setMentions([]);
    },
    onError: (err) => {
      toast.error(err?.message || 'Failed to save note');
      setSubmitting(false);
    },
  });

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    
    for (const file of files) {
      const { file_url } = await api.integrations.Core.UploadFile({ file });
      
      let fileType = "other";
      if (file.type.startsWith("image/")) fileType = "image";
      else if (file.type.startsWith("video/")) fileType = "video";
      else if (file.type.startsWith("audio/")) fileType = "audio";
      else if (file.type.includes("pdf") || file.type.includes("document")) fileType = "document";

      setSelectedFiles(prev => [...prev, { file_url, file_name: file.name, file_type: fileType }]);
    }
  };

  const handleMentionClick = (userEmail) => {
    if (!mentions.includes(userEmail)) {
      setMentions(prev => [...prev, userEmail]);
      setNoteContent(prev => `${prev} @${userEmail.split("@")[0]}`);
    }
    setShowUserSuggestions(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!noteContent.trim()) return;

    setSubmitting(true);
    const created = await createNoteMutation.mutateAsync({
      project_id: projectId,
      content: noteContent,
      attachments: selectedFiles,
      mentions,
      author_name: currentUser?.full_name || "Unknown",
      is_internal: true
    });

    // Notify @mentioned users
    if (mentions.length > 0) {
      const mentionedUserIds = allUsers
        .filter(u => mentions.includes(u.email))
        .map(u => u.id);

      notifyNoteMentions({
        mentionedUserIds,
        noteId: created?.id,
        noteContent,
        contextType: 'project',
        projectId,
        authorName: currentUser?.full_name,
        authorUserId: currentUser?.id,
      }).catch(() => {});
    }

    // Feed event for note creation
    writeFeedEvent({
      eventType: 'note_created', category: 'project', severity: 'info',
      actorId: currentUser?.id, actorName: currentUser?.full_name,
      title: 'Note added',
      description: noteContent.length > 100 ? noteContent.slice(0, 100) + '…' : noteContent,
      projectId,
      entityType: 'note',
    }).catch(() => {});

    setSubmitting(false);
  };

  const getFileIcon = (fileType) => {
    switch (fileType) {
      case "image": return <ImageIcon className="h-4 w-4" />;
      case "video": return <Video className="h-4 w-4" />;
      case "audio": return <Music className="h-4 w-4" />;
      case "document": return <FileText className="h-4 w-4" />;
      default: return <Paperclip className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* New Note Form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add Note</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="relative">
              <Textarea
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value.slice(0, LIMITS.notes))}
                placeholder="Type a note... Use @ to mention team members"
                maxLength={LIMITS.notes}
                rows={3}
                className="resize-none"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute top-2 right-2 h-8 w-8"
                onClick={() => setShowUserSuggestions(!showUserSuggestions)}
                title="Mention a team member"
                aria-label="Mention a team member"
              >
                <AtSign className="h-4 w-4" />
              </Button>
            </div>

            {showUserSuggestions && (
              <div className="border rounded-md p-2 bg-muted/50 max-h-48 overflow-y-auto">
                <p className="text-xs text-muted-foreground mb-2">Tag team members:</p>
                <div className="space-y-1">
                  {allUsers.filter(u => u.is_active !== false).map(user => (
                    <button
                      key={user.id}
                      type="button"
                      onClick={() => handleMentionClick(user.email)}
                      className="w-full text-left px-2 py-1 rounded hover:bg-muted text-sm transition-colors flex items-center justify-between"
                    >
                      <span>{user.full_name}</span>
                      <span className="text-xs text-muted-foreground">{user.email}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {mentions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {mentions.map(email => (
                  <Badge key={email} variant="secondary" className="text-xs">
                    @{email.split("@")[0]}
                    <button
                      type="button"
                      onClick={() => setMentions(prev => prev.filter(m => m !== email))}
                      className="ml-1 hover:opacity-70 transition-opacity"
                      aria-label={`Remove mention of ${email.split("@")[0]}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            {selectedFiles.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedFiles.map((file, idx) => (
                  <div key={idx} className="flex items-center gap-1 px-2 py-1 rounded border bg-muted/50 text-xs">
                    {getFileIcon(file.file_type)}
                    <span className="truncate max-w-[100px]">{file.file_name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedFiles(prev => prev.filter((_, i) => i !== idx))}
                      className="hover:opacity-70 transition-opacity ml-1"
                      aria-label={`Remove file ${file.file_name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileSelect}
                className="hidden"
                accept="image/*,video/*,audio/*,.pdf,.doc,.docx"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                title="Attach a file"
              >
                <Paperclip className="h-4 w-4 mr-1" />
                Attach
              </Button>
              <Button type="submit" disabled={!noteContent.trim() || submitting} className="ml-auto">
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Post
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Notes List */}
      <div className="space-y-3">
        {notes.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              No notes yet. Start by adding one!
            </CardContent>
          </Card>
        ) : (
          notes.map(note => (
            <Card key={note.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="font-medium text-sm">{note.author_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtTimestampCustom(note.created_date, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}
                    </p>
                  </div>
                  {note.is_internal && (
                    <Badge variant="outline" className="text-xs">Internal</Badge>
                  )}
                </div>

                <p className="text-sm whitespace-pre-wrap mb-3">{note.content}</p>

                {note.mentions && note.mentions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {note.mentions.map(email => (
                      <Badge key={email} variant="secondary" className="text-xs">
                        @{email.split("@")[0]}
                      </Badge>
                    ))}
                  </div>
                )}

                {note.attachments && note.attachments.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Attachments:</p>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {note.attachments.map((attachment, idx) => (
                        <a
                          key={idx}
                          href={attachment.file_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 p-2 rounded border hover:bg-muted transition-colors text-xs"
                        >
                          {getFileIcon(attachment.file_type)}
                          <span className="truncate">{attachment.file_name}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}