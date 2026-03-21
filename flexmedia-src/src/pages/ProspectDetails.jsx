import React, { useState } from 'react';
import { useEntityList, useEntityData } from '@/components/hooks/useEntityData';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { api } from '@/api/supabaseClient';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Mail, Phone, Building, AlertCircle } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';
import ProspectEditPanel from '@/components/prospecting/ProspectEditPanel';
import InteractionLogPanel from '@/components/prospecting/InteractionLogPanel';
import ProspectTimeline from '@/components/prospecting/ProspectTimeline';
import ProspectStatusManager from '@/components/prospecting/ProspectStatusManager';

export default function ProspectDetails() {
  const urlParams = new URLSearchParams(window.location.search);
  const agentId = urlParams.get('id');
  const { data: currentUser } = useCurrentUser();
  const { data: agent, loading, error } = useEntityData('Agent', agentId);
   const { data: interactions = [] } = useEntityList(agentId ? 'InteractionLog' : null, '-date_time', 500, agentId ? { entity_type: 'Agent', entity_id: agentId } : null);
   const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

   const prospectInteractions = interactions?.sort((a, b) => new Date(b.date_time) - new Date(a.date_time)) || [];

  const handleDelete = async () => {
    try {
      // Clean up orphans BEFORE deleting the agent
      const [logs, matrices, events] = await Promise.all([
        api.entities.InteractionLog.filter({ entity_id: agentId, entity_type: 'Agent' }, null, 500).catch(() => []),
        api.entities.PriceMatrix.filter({ entity_type: 'agent', entity_id: agentId }, null, 10).catch(() => []),
        api.entities.CalendarEvent.filter({ agent_id: agentId }, null, 100).catch(() => []),
      ]);
      await Promise.all([
        ...logs.map(l => api.entities.InteractionLog.delete(l.id).catch(() => {})),
        ...matrices.map(m => api.entities.PriceMatrix.delete(m.id).catch(() => {})),
        ...events.map(ev => api.entities.CalendarEvent.update(ev.id, { agent_id: null }).catch(() => {})),
      ]);
    } catch { /* non-fatal — proceed with delete */ }

    // Create audit log before deleting
    await api.entities.AuditLog.create({
      entity_type: "agent",
      entity_id: agentId,
      entity_name: agent?.name,
      action: "delete",
      changed_fields: [],
      previous_state: agent || {},
      new_state: {},
      user_name: currentUser?.full_name,
      user_email: currentUser?.email
    }).catch(() => {}); // non-fatal

    await api.entities.Agent.delete(agentId);
    window.location.href = createPageUrl('Prospecting');
  };

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin h-8 w-8 border-3 border-primary/30 border-t-primary rounded-full mx-auto mb-4"></div>
          <p className="text-muted-foreground animate-pulse">Loading prospect details...</p>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="p-8 min-h-screen">
        <Link to={createPageUrl('Prospecting')}>
          <Button variant="ghost" className="gap-2 mb-4">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-red-900">Person Not Found</h3>
            <p className="text-red-800 text-sm mt-1">This person may have been deleted or you don't have access.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 min-h-screen bg-gradient-to-br from-background to-muted/20">
      <div className="max-w-6xl mx-auto">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-2 text-sm mb-6 pb-4 border-b">
          <Link to={createPageUrl('Prospecting')} className="text-muted-foreground hover:text-foreground transition-colors">
            Prospecting
          </Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium text-foreground">{agent?.name}</span>
        </div>

        {/* Back Button */}
        <Link to={createPageUrl('Prospecting')} className="mb-6 inline-block">
          <Button variant="outline" size="sm" className="gap-2 hover:bg-primary/10">
            <ArrowLeft className="h-4 w-4" />
            Back to Prospects
          </Button>
        </Link>

        {/* Header Card with Depth Indicator */}
        <div className="bg-card border border-l-4 border-l-primary rounded-xl p-8 mb-6 shadow-md hover:shadow-lg transition-shadow">
          <div className="flex items-start justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold">{agent.name}</h1>
              <p className="text-muted-foreground mt-1">{agent.title}</p>
            </div>
            <ProspectStatusManager prospect={agent} />
          </div>

          {/* Contact Info */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {agent.email && (
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Email</p>
                  <p className="text-sm font-medium truncate">{agent.email}</p>
                </div>
              </div>
            )}
            {agent.phone && (
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">Phone</p>
                  <p className="text-sm font-medium">{agent.phone}</p>
                </div>
              </div>
            )}
            <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
              <Building className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Organisation</p>
                <p className="text-sm font-medium truncate">{agent.current_agency_name}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs defaultValue="interactions" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="interactions">Interactions ({prospectInteractions.length})</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>

          <TabsContent value="interactions" className="mt-6">
            <InteractionLogPanel
              prospect={agent}
              interactions={prospectInteractions}
              entityType="Agent"
            />
          </TabsContent>

          <TabsContent value="timeline" className="mt-6">
            <ProspectTimeline prospect={agent} interactions={prospectInteractions} />
          </TabsContent>

          <TabsContent value="details" className="mt-6">
            <ProspectEditPanel prospect={agent} />
          </TabsContent>
        </Tabs>

        {/* Delete Section */}
        <div className="mt-12 pt-8 border-t">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Delete Person</h3>
              <p className="text-sm text-muted-foreground mt-1">This action cannot be undone</p>
            </div>
            <Button
              variant="destructive"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete
            </Button>
          </div>

          {showDeleteConfirm && (
            <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-lg flex gap-3 items-center">
              <div className="flex-1">
                <p className="font-semibold text-sm">Confirm deletion?</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleDelete}
                >
                  Delete Person
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}