import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { useEntityList } from '@/components/hooks/useEntityData';
import { FileText, Activity, Loader2, Mail, Paperclip } from 'lucide-react';
import Org2Hierarchy from './Org2Hierarchy';
import Org2Feed from './Org2Feed';
import UnifiedNotesPanel from '@/components/notes/UnifiedNotesPanel';
import PriceMatrixSummaryTable from '@/components/priceMatrix/PriceMatrixSummaryTable';
import InteractionLogPanel from '@/components/prospecting/InteractionLogPanel';
import ContactAuditLog from '@/components/contacts/ContactAuditLog';
import ContactActivityLog from '@/components/contacts/ContactActivityLog';
import ContactFiles from '@/components/contacts/ContactFiles';
import EmailActivityLog from '@/components/email/EmailActivityLog';
import EntityEmailTab from '@/components/email/EntityEmailTab';
import EntityActivitiesTab from '@/components/calendar/EntityActivitiesTab';

export default function Org2UnifiedTabs({ agency, agencyId, interactions, notes, projectNotes = [], agents, teams = [], hierarchyLoading, projects = [], onRefresh, activeTab: externalTab, onTabChange, emailActivities = [], onEmailActivity }) {
  const [internalTab, setInternalTab] = useState('notes');
  const activeTab = externalTab !== undefined ? externalTab : internalTab;
  const setActiveTab = (tab) => { setInternalTab(tab); onTabChange?.(tab); };

  const priceMatrixFilter = React.useCallback(
    e => e.entity_type === 'agency' && e.entity_id === agencyId,
    [agencyId]
  );

  const { data: priceMatrix = [] } = useEntityList(
    'PriceMatrix',
    '-updated_date',
    null,
    priceMatrixFilter
  );

  // Always load products/packages — don't clear on tab switch (avoids reload every visit)
  const [pricingRequested, setPricingRequested] = React.useState(activeTab === 'pricing');
  React.useEffect(() => { if (activeTab === 'pricing') setPricingRequested(true); }, [activeTab]);

  const { data: products = [], loading: productsLoading } = useEntityList(
    pricingRequested ? 'Product' : null,
    null,
    200
  );

  const { data: packages = [], loading: packagesLoading } = useEntityList(
    pricingRequested ? 'Package' : null,
    null,
    200
  );

  const pricingLoading = productsLoading || packagesLoading;

  // Only count root notes (not replies) for the badge
  const rootNoteCount = useMemo(() => notes?.filter(n => !n.parent_note_id).length || 0, [notes]);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full h-full flex flex-col">
      <TabsList className="grid grid-cols-9 w-full shrink-0 rounded-none border-b bg-background h-10">
        <TabsTrigger value="notes" className="text-xs rounded-none gap-1 relative">
          <FileText className="h-3.5 w-3.5" />
          Notes
          {rootNoteCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold min-w-[14px] h-[14px] rounded-full flex items-center justify-center px-0.5">
              {rootNoteCount}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="activity-log" className="text-xs rounded-none gap-1">
          <Activity className="h-3.5 w-3.5" />
          Activity
        </TabsTrigger>
        <TabsTrigger value="emails" className="text-xs rounded-none gap-1">
          <Mail className="h-3.5 w-3.5" />
          Emails
        </TabsTrigger>
        <TabsTrigger value="calendar" className="text-xs rounded-none gap-1">
          Activities
        </TabsTrigger>
        <TabsTrigger value="files" className="text-xs rounded-none gap-1">
          <Paperclip className="h-3.5 w-3.5" />
          Files
        </TabsTrigger>
        <TabsTrigger value="hierarchy" className="text-xs rounded-none">
          Hierarchy
        </TabsTrigger>
        <TabsTrigger value="pricing" className="text-xs rounded-none">
          Pricing
        </TabsTrigger>
        <TabsTrigger value="interactions" className="text-xs rounded-none relative">
          Interactions
          {interactions?.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold min-w-[14px] h-[14px] rounded-full flex items-center justify-center px-0.5">
              {interactions.length}
            </span>
          )}
        </TabsTrigger>
        <TabsTrigger value="audit" className="text-xs rounded-none">
          Audit
        </TabsTrigger>
      </TabsList>

      <div className="flex-1 overflow-hidden">
        <TabsContent value="notes" className="h-full overflow-hidden m-0 border-0">
          <UnifiedNotesPanel
            agencyId={agencyId}
            contextLabel={agency?.name || ''}
            contextType="agency"
            relatedProjectIds={projects.map(p => p.id)}
            relatedAgentIds={agents.map(a => a.id)}
            showContextOnNotes={true}
          />
        </TabsContent>

        <TabsContent value="activity-log" className="h-full overflow-y-auto m-0 border-0">
          <ContactActivityLog
            entityType="agency"
            entityId={agencyId}
            entityLabel={agency?.name}
            emailActivities={emailActivities}
          />
        </TabsContent>

        <TabsContent value="emails" className="h-full overflow-hidden m-0 border-0">
          <EntityEmailTab
            entityType="agency"
            entityId={agencyId}
            entityLabel={agency?.name}
            onEmailActivity={onEmailActivity}
            orgAgentIds={agents.map(a => a.id)}
          />
        </TabsContent>

        <TabsContent value="calendar" className="h-full overflow-hidden m-0 border-0">
          {activeTab === 'calendar' && (
            <EntityActivitiesTab
              entityType="agency"
              entityId={agencyId}
              entityLabel={agency?.name || 'Organisation'}
            />
          )}
        </TabsContent>

        <TabsContent value="files" className="h-full overflow-hidden m-0 border-0">
          <ContactFiles
            entityType="agency"
            entityId={agencyId}
            entityLabel={agency?.name}
          />
        </TabsContent>

        <TabsContent value="hierarchy" className="h-full overflow-y-auto m-0 border-0">
          {hierarchyLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Org2Hierarchy
              agency={agency}
              teams={teams}
              agents={agents}
              onRefresh={onRefresh}
            />
          )}
        </TabsContent>

        <TabsContent value="pricing" className="h-full overflow-y-auto m-0 border-0 p-4">
          {!pricingRequested || pricingLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : priceMatrix.length === 0 ? (
            <Card className="bg-muted/30 border-dashed">
              <CardContent className="pt-6 pb-6 text-center">
                <p className="text-muted-foreground text-sm">No pricing configured for this agency</p>
                <p className="text-xs text-muted-foreground mt-1">Set up pricing in Settings → Price Matrix</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {priceMatrix.map(matrix => (
                <Card key={matrix.id} className="border shadow-sm">
                  <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-foreground">{matrix.project_type_name || 'Project Type'}</p>
                      {matrix.use_default_pricing && (
                        <p className="text-[10px] text-muted-foreground">Using default pricing</p>
                      )}
                    </div>
                  </div>
                  <CardContent className="p-0">
                    <PriceMatrixSummaryTable
                      priceMatrix={matrix}
                      products={products}
                      packages={packages}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="interactions" className="h-full overflow-y-auto m-0 border-0 p-4">
          <InteractionLogPanel
            prospect={agency}
            interactions={interactions}
            entityType="Agency"
          />
        </TabsContent>

        <TabsContent value="audit" className="h-full overflow-y-auto m-0 border-0 p-4">
          <ContactAuditLog entityType="agency" entityId={agencyId} />
        </TabsContent>
      </div>
    </Tabs>
  );
}