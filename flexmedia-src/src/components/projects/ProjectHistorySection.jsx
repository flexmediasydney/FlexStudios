import { useState } from "react";
import React from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Activity, Mail, FileText, File, Receipt, History } from "lucide-react";
import { fixTimestamp, fmtTimestampCustom } from "@/components/utils/dateUtils";
import HistoryEmailItem from "./HistoryEmailItem";
import ActivityLogItem from "./ActivityLogItem";

export default function ProjectHistorySection({ projectId }) {
  const { data: currentUser } = useCurrentUser();

  // Fetch the current user's own email accounts so we can determine ownership
  const { data: myEmailAccounts = [] } = useQuery({
    queryKey: ["my-email-accounts", currentUser?.id],
    queryFn: () => api.entities.EmailAccount.filter({
      assigned_to_user_id: currentUser?.id,
      is_active: true
    }),
    enabled: !!currentUser?.id
  });

  const myAccountIds = new Set(myEmailAccounts.map(a => a.id));

  const { data: notes = [] } = useQuery({
    queryKey: ["org-notes-project", projectId],
    queryFn: () => api.entities.OrgNote.filter(
      { project_id: projectId },
      "-created_date",
      100
    ),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const { data: activities = [] } = useQuery({
    queryKey: ["project-activities", projectId],
    queryFn: () => api.entities.ProjectActivity.filter({ project_id: projectId }, "-created_date", 200)
  });

  const { data: allProjectEmails = [] } = useQuery({
    queryKey: ["project-emails", projectId],
    queryFn: () => api.entities.EmailMessage.filter({ project_id: projectId }, "-received_at")
  });

  // Pipedrive visibility model:
  //   - shared emails: visible to all project members
  //   - private emails: visible only to the owner (the user whose account sent/received it)
  const emails = allProjectEmails.filter(email =>
    email.visibility === 'shared' || myAccountIds.has(email.email_account_id)
  );

  const allItems = [
    ...notes.map(n => ({
      type: 'note',
      id: n.id,
      timestamp: n.created_date,
      author: n.author_name,
      content: n.content,
      icon: MessageSquare
    })),
    ...activities.map(a => ({
      type: 'activity',
      id: a.id,
      timestamp: a.created_date,
      author: a.user_name,
      description: a.description,
      action: a.action,
      icon: Activity
    })),
    ...emails.map(e => ({
      type: 'email',
      id: e.id,
      timestamp: e.received_at,
      author: e.from_name || e.from,
      subject: e.subject,
      preview: e.body?.replace(/<[^>]*>/g, '').substring(0, 100),
      icon: Mail
    }))
  ].sort((a, b) => new Date(fixTimestamp(b.timestamp)) - new Date(fixTimestamp(a.timestamp)));

  const renderHistoryItem = (item) => {
    switch (item.type) {
      case 'note':
        return (
          <div key={item.id} className="pb-6 relative">
            <div className="flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                  <MessageSquare className="h-4 w-4 text-blue-600 dark:text-blue-300" />
                </div>
                <div className="w-0.5 h-12 bg-border mt-2" />
              </div>
              <div className="pt-1 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {fmtTimestampCustom(item.timestamp, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} • {item.author}
                </p>
                <div className="bg-blue-50 border border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 rounded-lg p-3 mt-2">
                  <p className="text-sm text-foreground/80 whitespace-pre-wrap">{item.content}</p>
                </div>
              </div>
            </div>
          </div>
        );
      
      case 'activity': {
        const fullActivity = activities.find(a => a.id === item.id);
        return fullActivity ? <ActivityLogItem key={item.id} activity={fullActivity} /> : <div key={item.id} className="text-xs text-muted-foreground">Activity data unavailable</div>;
      }
      
      case 'email':
        const fullEmail = emails.find(e => e.id === item.id);
        return fullEmail ? (
          <HistoryEmailItem
            key={item.id}
            email={fullEmail}
            projectId={projectId}
            isOwner={myAccountIds.has(fullEmail.email_account_id)}
          />
        ) : <div key={item.id} className="text-xs text-muted-foreground">Email data unavailable</div>;
      
      default:
        return null;
    }
  };

  const notesCount = notes.length;
  const emailsCount = emails.length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="h-5 w-5" />
          <CardTitle>History</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="all" className="w-full">
          <TabsList className="grid w-full grid-cols-4 mb-4 overflow-x-auto flex-nowrap">
            <TabsTrigger value="all">
              All
            </TabsTrigger>
            <TabsTrigger value="notes">
              Notes {notesCount > 0 && `(${notesCount})`}
            </TabsTrigger>
            <TabsTrigger value="emails">
              Emails {emailsCount > 0 && `(${emailsCount})`}
            </TabsTrigger>
            <TabsTrigger value="changelog">
              Audit Log
            </TabsTrigger>
          </TabsList>

          <TabsContent value="all" className="mt-4">
            <div className="space-y-2">
              {allItems.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No history yet</p>
              ) : (
                allItems.map(item => renderHistoryItem(item))
              )}
            </div>
          </TabsContent>

          <TabsContent value="notes" className="mt-4">
            <div className="space-y-2">
              {notes.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No notes</p>
              ) : (
                notes.map(note => renderHistoryItem({
                  type: 'note',
                  id: note.id,
                  timestamp: note.created_date,
                  author: note.author_name,
                  content: note.content
                }))
              )}
            </div>
          </TabsContent>



          <TabsContent value="emails" className="mt-4">
            <div className="space-y-2">
              {emails.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No emails</p>
              ) : (
                emails.map(email => (
                <HistoryEmailItem
                  key={email.id}
                  email={email}
                  projectId={projectId}
                  isOwner={myAccountIds.has(email.email_account_id)}
                />
              ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="changelog" className="mt-4">
            <div className="pt-2">
              {activities.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No audit events yet</p>
              ) : (
                activities.map(activity => <ActivityLogItem key={activity.id} activity={activity} />)
              )}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}