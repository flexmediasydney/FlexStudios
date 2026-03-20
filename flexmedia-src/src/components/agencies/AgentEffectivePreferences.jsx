import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, ExternalLink, FileText, Link2, Sparkles, ChevronRight, File } from "lucide-react";
import { createPageUrl } from '@/utils';

function FieldRow({ label, value, isLink }) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground w-32 flex-shrink-0 pt-0.5">{label}</span>
      {isLink ? (
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline flex items-center gap-1.5 min-w-0 flex-1 break-all"
        >
          <ExternalLink className="h-3 w-3 flex-shrink-0" />
          {value}
        </a>
      ) : (
        <span className="text-xs text-foreground flex-1 whitespace-pre-wrap">{value}</span>
      )}
    </div>
  );
}

function CategoryRow({ pref }) {
  const hasDetails = pref.template_link || pref.notes || (pref.reference_uploads?.length > 0);
  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
      {/* Category header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-muted/20 border-b border-border/40">
        <div className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0" />
        <span className="text-sm font-semibold text-foreground">{pref.category_name}</span>
        <Badge className="ml-auto text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200 font-medium">Active</Badge>
      </div>
      {/* Details */}
      {hasDetails && (
        <div className="px-4 py-1">
          <FieldRow label="Template Link" value={pref.template_link} isLink />
          <FieldRow label="Notes" value={pref.notes} />
          {pref.reference_uploads?.length > 0 && (
            <div className="flex items-start gap-3 py-2.5">
              <span className="text-xs text-muted-foreground w-32 flex-shrink-0 pt-0.5">Reference Files</span>
              <div className="flex flex-wrap gap-2 flex-1">
                {pref.reference_uploads.map(f => (
                  <a
                    key={f.file_url}
                    href={f.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted/60 hover:bg-muted border border-border/50 text-xs text-foreground hover:text-primary transition-colors"
                  >
                    <File className="h-3 w-3 text-muted-foreground" />
                    {f.file_name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {!hasDetails && (
        <div className="px-4 py-2.5">
          <p className="text-xs text-muted-foreground italic">No additional details configured.</p>
        </div>
      )}
    </div>
  );
}

export default function AgentEffectivePreferences({ agent, agency }) {
  const { data: allTypes = [] } = useQuery({
    queryKey: ['projectTypes'],
    queryFn: () => base44.entities.ProjectType.list(),
    staleTime: 30000
  });

  const { data: allCategories = [] } = useQuery({
    queryKey: ['productCategories'],
    queryFn: () => base44.entities.ProductCategory.list(),
    staleTime: 30000
  });

  // Group enabled preferences by project type
  const groupedByType = useMemo(() => {
    if (!agency?.branding_preferences) return [];
    const enabled = agency.branding_preferences.filter(p => p.enabled);
    if (enabled.length === 0) return [];

    // Map category_id -> project_type_id
    const catMap = {};
    allCategories.forEach(c => { catMap[c.id] = c.project_type_id; });

    // Map type_id -> type name
    const typeMap = {};
    allTypes.forEach(t => { typeMap[t.id] = t.name; });

    // Group
    const groups = {};
    enabled.forEach(pref => {
      const typeId = catMap[pref.category_id] || '__unknown__';
      const typeName = typeMap[typeId] || 'Other';
      if (!groups[typeId]) groups[typeId] = { typeId, typeName, prefs: [] };
      groups[typeId].prefs.push(pref);
    });

    return Object.values(groups).sort((a, b) => a.typeName.localeCompare(b.typeName));
  }, [agency?.branding_preferences, allCategories, allTypes]);

  const hasAgencyLevel = agency?.branding_general_notes || agency?.branding_files_link;
  const hasAnything = hasAgencyLevel || groupedByType.length > 0;

  if (!agency) {
    return (
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="pt-8 pb-8 text-center">
          <p className="text-muted-foreground text-sm">Agency information not available.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Inheritance Banner */}
      <div className="flex items-center gap-3 p-4 rounded-xl bg-primary/5 border border-primary/20">
        <div className="p-1.5 rounded-lg bg-primary/10 flex-shrink-0">
          <Building2 className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Inherited from{' '}
            <a
              href={createPageUrl('OrgDetails') + `?id=${agency.id}`}
              className="text-primary hover:underline font-semibold"
            >
              {agency.name}
            </a>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">Read-only. Edit branding preferences on the agency page.</p>
        </div>
        <a
          href={createPageUrl('OrgDetails') + `?id=${agency.id}#branding`}
          className="flex items-center gap-1 text-xs text-primary hover:underline flex-shrink-0"
        >
          View Agency <ChevronRight className="h-3 w-3" />
        </a>
      </div>

      {!hasAnything ? (
        <Card className="bg-muted/30 border-dashed">
          <CardContent className="pt-10 pb-10 text-center space-y-2">
            <Sparkles className="h-6 w-6 text-muted-foreground/40 mx-auto" />
            <p className="text-sm text-muted-foreground">No branding preferences configured for this agency yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* Agency-Level Branding */}
          {hasAgencyLevel && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Agency-Level Branding</p>
                <div className="flex-1 h-px bg-border" />
              </div>
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-1">
                  <FieldRow label="General Notes" value={agency.branding_general_notes} />
                  <FieldRow label="Branding Files" value={agency.branding_files_link} isLink />
                </div>
              </div>
            </div>
          )}

          {/* Category Preferences grouped by Project Type */}
          {groupedByType.length > 0 && (
            <div className="space-y-6">
              {groupedByType.map(group => (
                <div key={group.typeId} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{group.typeName}</p>
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground">{group.prefs.length} categor{group.prefs.length === 1 ? 'y' : 'ies'}</span>
                  </div>
                  <div className="space-y-2.5">
                    {group.prefs.map(pref => (
                      <CategoryRow key={pref.category_id} pref={pref} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}