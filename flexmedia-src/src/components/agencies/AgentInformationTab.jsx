import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Building2, Users, User, ChevronRight, Pencil, Check, Loader2, X } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { fmtDate, fmtTimestampCustom } from '@/components/utils/dateUtils';

const RELATIONSHIP_STATES = ['Prospecting', 'Active', 'Dormant', 'Do Not Contact'];
const PROSPECT_STATUSES = ['New Lead', 'Researching', 'Attempted Contact', 'Discovery Call Scheduled', 'Proposal Sent', 'Nurturing', 'Qualified', 'Unqualified', 'Converted to Client', 'Lost'];
const SOURCES = ['Referral', 'LinkedIn', 'Web Search', 'Event', 'Manual Import', 'Networking'];
const VALUE_OPTIONS = ['Low', 'Medium', 'High', 'Enterprise'];
const MEDIA_NEEDS = ['Photography', 'Video Production', 'Drone Footage', 'Virtual Staging', 'Social Media Mgmt', 'Website Design', 'Branding'];

// For date-only fields use fmtDate; for timestamps use fmtTimestampCustom
const safeFmt = (isoStr, fmt_str) => {
  if (!isoStr) return null;
  if (String(isoStr).length <= 10) return fmtDate(isoStr, fmt_str.replace(/MMMM/g, 'MMMM').replace(/MMM/g, 'MMM').replace(/d,/g, 'd,'));
  return fmtTimestampCustom(isoStr, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const toInputDate = (isoStr) => isoStr ? String(isoStr).substring(0, 10) : '';
const toInputDT = (isoStr) => isoStr ? String(isoStr).substring(0, 16) : '';

function toForm(agent) {
  return {
    name: agent.name || '',
    title: agent.title || '',
    email: agent.email || '',
    phone: agent.phone || '',
    current_agency_id: agent.current_agency_id || '',
    current_team_id: agent.current_team_id || '',
    relationship_state: agent.relationship_state || 'Prospecting',
    status: agent.status || 'New Lead',
    source: agent.source || '',
    value_potential: agent.value_potential || '',
    media_needs: agent.media_needs || [],
    club_flex: agent.club_flex || false,
    last_contact_date: toInputDT(agent.last_contact_date),
    next_follow_up_date: toInputDT(agent.next_follow_up_date),
    notes: agent.notes || '',
    discovery_call_notes: agent.discovery_call_notes || '',
    reason_unqualified: agent.reason_unqualified || '',
    became_active_date: toInputDate(agent.became_active_date),
    became_dormant_date: toInputDate(agent.became_dormant_date),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div className="bg-card border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b bg-muted/20">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}
function Grid({ children }) { return <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{children}</div>; }
function Field({ label, children, required, span2 }) {
  return (
    <div className={span2 ? 'col-span-full space-y-1.5' : 'space-y-1.5'}>
      <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {children}
    </div>
  );
}
function Val({ children, href, multiline }) {
  if (!children) return <p className="text-sm text-muted-foreground italic">Not set</p>;
  if (href) return <a href={href} className="text-sm text-primary hover:underline">{children}</a>;
  if (multiline) return <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{children}</p>;
  return <p className="text-sm text-foreground font-medium">{children}</p>;
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AgentInformationTab({ agent }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState(() => toForm(agent));

  const { data: agencies = [] } = useEntityList('Agency', 'name');
  const { data: teams = [] } = useEntityList('Team', 'name');

  const availableTeams = useMemo(() => teams.filter(t => t.agency_id === formData.current_agency_id), [teams, formData.current_agency_id]);
  const selectedAgency = useMemo(() => agencies.find(a => a.id === formData.current_agency_id), [agencies, formData.current_agency_id]);
  const selectedTeam = useMemo(() => teams.find(t => t.id === formData.current_team_id), [teams, formData.current_team_id]);

  useEffect(() => { if (!editing) setFormData(toForm(agent)); }, [agent, editing]);

  const set = useCallback((field, value) => setFormData(p => ({ ...p, [field]: value })), []);
  const toggleMediaNeed = (need) => setFormData(p => ({
    ...p,
    media_needs: p.media_needs.includes(need) ? p.media_needs.filter(m => m !== need) : [...p.media_needs, need]
  }));

  const handleSave = async () => {
    if (!formData.name?.trim()) { toast.error('Name is required'); return; }
    if (!formData.current_agency_id) { toast.error('Agency is required'); return; }
    const agency = agencies.find(a => a.id === formData.current_agency_id);
    const team = teams.find(t => t.id === formData.current_team_id);
    setSaving(true);
    try {
      const user = await api.auth.me();
      const payload = {
        name: formData.name.trim(),
        title: formData.title.trim(),
        email: formData.email.trim(),
        phone: formData.phone.trim(),
        current_agency_id: formData.current_agency_id,
        current_agency_name: agency?.name || '',
        current_team_id: formData.current_team_id || '',
        current_team_name: team?.name || '',
        relationship_state: formData.relationship_state,
        status: formData.status,
        source: formData.source,
        value_potential: formData.value_potential,
        media_needs: formData.media_needs,
        club_flex: formData.club_flex,
        last_contact_date: formData.last_contact_date ? new Date(formData.last_contact_date).toISOString() : null,
        next_follow_up_date: formData.next_follow_up_date ? new Date(formData.next_follow_up_date).toISOString() : null,
        notes: formData.notes,
        discovery_call_notes: formData.discovery_call_notes,
        reason_unqualified: formData.reason_unqualified,
        became_active_date: formData.became_active_date || null,
        became_dormant_date: formData.became_dormant_date || null,
      };
      const changedFields = Object.keys(payload)
        .filter(k => JSON.stringify(payload[k]) !== JSON.stringify(agent[k]))
        .map(k => ({ field: k, old_value: String(agent[k] ?? ''), new_value: String(payload[k] ?? '') }));
      await api.entities.Agent.update(agent.id, payload);
      if (changedFields.length > 0) {
        await api.entities.AuditLog.create({
          entity_type: 'agent', entity_id: agent.id, entity_name: formData.name,
          action: 'update', changed_fields: changedFields,
          previous_state: agent, new_state: payload,
          user_name: user.full_name, user_email: user.email
        });
      }
      toast.success('Agent saved');
      setEditing(false);
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">All details for this agent</p>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> Edit Details
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setFormData(toForm(agent)); setEditing(false); }} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* 1. Contact */}
      <Section title="Contact Information">
        <Grid>
          <Field label="Full Name" required>
            {editing ? <Input value={formData.name} onChange={e => set('name', e.target.value)} /> : <Val>{agent.name}</Val>}
          </Field>
          <Field label="Job Title">
            {editing ? <Input value={formData.title} onChange={e => set('title', e.target.value)} placeholder="e.g. Senior Agent" /> : <Val>{agent.title}</Val>}
          </Field>
          <Field label="Email">
            {editing ? <Input type="email" value={formData.email} onChange={e => set('email', e.target.value)} /> : <Val href={agent.email ? `mailto:${agent.email}` : null}>{agent.email}</Val>}
          </Field>
          <Field label="Phone">
            {editing ? <Input type="tel" value={formData.phone} onChange={e => set('phone', e.target.value)} /> : <Val href={agent.phone ? `tel:${agent.phone}` : null}>{agent.phone}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 2. Agency Association */}
      <Section title="Agency Association">
        {!editing ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Link to={createPageUrl('OrgDetails') + `?id=${agent.current_agency_id}`}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/10 transition-colors">
              <Building2 className="h-3.5 w-3.5" />{agent.current_agency_name || '—'}
            </Link>
            {agent.current_team_id && (<>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
              <span className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-muted/50 border text-sm font-medium">
                <Users className="h-3.5 w-3.5 text-muted-foreground" />{agent.current_team_name}
              </span>
            </>)}
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <span className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-muted/20 border text-sm">
              <User className="h-3.5 w-3.5 text-muted-foreground" />{agent.name}
            </span>
          </div>
        ) : (
          <div className="space-y-3">
            <Grid>
              <Field label="Agency" required>
                <Select value={formData.current_agency_id} onValueChange={v => setFormData(p => ({ ...p, current_agency_id: v, current_team_id: '' }))}>
                  <SelectTrigger><SelectValue placeholder="Select agency" /></SelectTrigger>
                  <SelectContent>{agencies.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Team (Optional)">
                <Select value={formData.current_team_id || '__none__'} onValueChange={v => set('current_team_id', v === '__none__' ? '' : v)} disabled={!formData.current_agency_id}>
                  <SelectTrigger><SelectValue placeholder={!formData.current_agency_id ? 'Select agency first' : 'No team'} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No team</SelectItem>
                    {availableTeams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    {formData.current_agency_id && availableTeams.length === 0 && <div className="px-2 py-2 text-xs text-muted-foreground">No teams in this agency</div>}
                  </SelectContent>
                </Select>
              </Field>
            </Grid>
            {formData.current_agency_id && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-wrap">
                <Building2 className="h-3 w-3" /><span>{selectedAgency?.name}</span>
                {formData.current_team_id && selectedTeam && <><ChevronRight className="h-3 w-3" /><span>{selectedTeam.name}</span></>}
                <ChevronRight className="h-3 w-3" /><span className="text-foreground font-medium">{formData.name || agent.name}</span>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* 3. Relationship & Status */}
      <Section title="Relationship & Status">
        <Grid>
          <Field label="Relationship State">
            {editing ? (
              <Select value={formData.relationship_state} onValueChange={v => set('relationship_state', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{RELATIONSHIP_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            ) : <Badge>{agent.relationship_state || '—'}</Badge>}
          </Field>
          <Field label="Prospecting Status">
            {editing ? (
              <Select value={formData.status} onValueChange={v => set('status', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROSPECT_STATUSES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            ) : <Val>{agent.status}</Val>}
          </Field>
          <Field label="Became Active">
            {editing ? <Input type="date" value={formData.became_active_date} onChange={e => set('became_active_date', e.target.value)} /> : <Val>{safeFmt(agent.became_active_date, 'MMM d, yyyy')}</Val>}
          </Field>
          <Field label="Became Dormant">
            {editing ? <Input type="date" value={formData.became_dormant_date} onChange={e => set('became_dormant_date', e.target.value)} /> : <Val>{safeFmt(agent.became_dormant_date, 'MMM d, yyyy')}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 4. Qualification */}
      <Section title="Qualification">
        <Grid>
          <Field label="Source">
            {editing ? (
              <Select value={formData.source || '__none__'} onValueChange={v => set('source', v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Select source" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : <Val>{agent.source}</Val>}
          </Field>
          <Field label="Value Potential">
            {editing ? (
              <Select value={formData.value_potential || '__none__'} onValueChange={v => set('value_potential', v === '__none__' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="Select value" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {VALUE_OPTIONS.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : <Val>{agent.value_potential}</Val>}
          </Field>
        </Grid>
        <div className="mt-4 flex items-center gap-3">
          <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider w-24">Club Flex</Label>
          {editing ? (
            <Switch checked={formData.club_flex} onCheckedChange={v => set('club_flex', v)} />
          ) : (
            <Badge className={agent.club_flex ? 'bg-purple-100 text-purple-700 border-purple-200' : ''} variant={agent.club_flex ? 'outline' : 'secondary'}>
              {agent.club_flex ? 'Enabled' : 'Disabled'}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">Enables special pricing mode</span>
        </div>
        <div className="mt-4 space-y-2">
          <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Media Needs</Label>
          {editing ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 mt-2">
              {MEDIA_NEEDS.map(need => (
                <label key={need} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-muted cursor-pointer transition-colors border border-transparent hover:border-border">
                  <input type="checkbox" checked={formData.media_needs.includes(need)} onChange={() => toggleMediaNeed(need)} className="rounded" />
                  <span className="text-sm">{need}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {(agent.media_needs || []).length > 0 ? (agent.media_needs || []).map(n => <Badge key={n} variant="secondary" className="text-xs">{n}</Badge>) : <span className="text-sm text-muted-foreground italic">None selected</span>}
            </div>
          )}
        </div>
      </Section>

      {/* 5. Follow-up */}
      <Section title="Follow-up">
        <Grid>
          <Field label="Last Contact Date">
            {editing ? <Input type="datetime-local" value={formData.last_contact_date} onChange={e => set('last_contact_date', e.target.value)} /> : <Val>{safeFmt(agent.last_contact_date, 'MMM d, yyyy HH:mm')}</Val>}
          </Field>
          <Field label="Next Follow-up Date">
            {editing ? <Input type="datetime-local" value={formData.next_follow_up_date} onChange={e => set('next_follow_up_date', e.target.value)} /> : <Val>{safeFmt(agent.next_follow_up_date, 'MMM d, yyyy HH:mm')}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 6. Notes & Discovery */}
      <Section title="Notes & Discovery">
        <div className="space-y-4">
          <Field label="General Notes" span2>
            {editing ? <Textarea value={formData.notes} onChange={e => set('notes', e.target.value)} rows={3} placeholder="General notes..." className="resize-none" /> : <Val multiline>{agent.notes}</Val>}
          </Field>
          <Field label="Discovery Call Notes" span2>
            {editing ? <Textarea value={formData.discovery_call_notes} onChange={e => set('discovery_call_notes', e.target.value)} rows={3} placeholder="Notes from discovery calls..." className="resize-none" /> : <Val multiline>{agent.discovery_call_notes}</Val>}
          </Field>
          <Field label="Reason Unqualified" span2>
            {editing ? <Textarea value={formData.reason_unqualified} onChange={e => set('reason_unqualified', e.target.value)} rows={2} placeholder="If unqualified, explain why..." className="resize-none" /> : <Val multiline>{agent.reason_unqualified}</Val>}
          </Field>
        </div>
      </Section>

      {/* 7. Past Affiliations (read-only) */}
      {agent.past_affiliations?.length > 0 && (
        <Section title="Past Affiliations">
          <div className="divide-y rounded-lg border overflow-hidden">
            {agent.past_affiliations.map((aff, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between bg-card">
                <div className="flex items-center gap-2 text-sm">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{aff.agency_name}</span>
                  {aff.team_name && <><ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-muted-foreground">{aff.team_name}</span></>}
                </div>
                <span className="text-xs text-muted-foreground">{aff.start_date} → {aff.end_date || 'present'}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}