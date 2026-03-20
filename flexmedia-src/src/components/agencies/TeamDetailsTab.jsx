import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Building2, Users, User, ChevronRight, Pencil, Check, Loader2, Mail, Phone } from 'lucide-react';
import { createPageUrl } from '@/utils';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';

function toForm(team) {
  return {
    name: team.name || '',
    email: team.email || '',
    phone: team.phone || '',
    notes: team.notes || '',
    agency_id: team.agency_id || '',
  };
}

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
function Field({ label, children, span2 }) {
  return (
    <div className={span2 ? 'col-span-full space-y-1.5' : 'space-y-1.5'}>
      <Label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{label}</Label>
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

export default function TeamDetailsTab({ team }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState(() => toForm(team));

  const { data: agencies = [] } = useEntityList('Agency', 'name');
  const agentFilter = useCallback(a => a.current_team_id === team.id, [team.id]);
  const { data: teamAgents = [] } = useEntityList('Agent', 'name', null, agentFilter);

  useEffect(() => { if (!editing) setFormData(toForm(team)); }, [team, editing]);

  const selectedAgency = useMemo(() => agencies.find(a => a.id === formData.agency_id), [agencies, formData.agency_id]);

  const set = useCallback((field, value) => setFormData(p => ({ ...p, [field]: value })), []);

  const handleSave = async () => {
    if (!formData.name?.trim()) { toast.error('Team name is required'); return; }
    if (!formData.agency_id) { toast.error('Agency is required'); return; }
    const agency = agencies.find(a => a.id === formData.agency_id);
    setSaving(true);
    try {
      const user = await base44.auth.me();
      const payload = {
        name: formData.name.trim(),
        email: formData.email.trim(),
        phone: formData.phone.trim(),
        notes: formData.notes.trim(),
        agency_id: formData.agency_id,
        agency_name: agency?.name || '',
      };
      const changedFields = Object.keys(payload)
        .filter(k => String(payload[k] ?? '') !== String(team[k] ?? ''))
        .map(k => ({ field: k, old_value: String(team[k] ?? ''), new_value: String(payload[k] ?? '') }));
      await base44.entities.Team.update(team.id, payload);
      if (changedFields.length > 0) {
        await base44.entities.AuditLog.create({
          entity_type: 'team', entity_id: team.id, entity_name: formData.name,
          action: 'update', changed_fields: changedFields,
          previous_state: team, new_state: payload,
          user_name: user.full_name, user_email: user.email
        });
      }
      toast.success('Team saved');
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
        <p className="text-xs text-muted-foreground">All details for this team</p>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> Edit Details
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setFormData(toForm(team)); setEditing(false); }} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* 1. Contact */}
      <Section title="Team Information">
        <Grid>
          <Field label="Team Name">
            {editing ? <Input value={formData.name} onChange={e => set('name', e.target.value)} /> : <Val>{team.name}</Val>}
          </Field>
          <Field label="Agency">
            {editing ? (
              <Select value={formData.agency_id} onValueChange={v => set('agency_id', v)}>
                <SelectTrigger><SelectValue placeholder="Select agency" /></SelectTrigger>
                <SelectContent>{agencies.map(a => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <Link to={createPageUrl('OrgDetails') + `?id=${team.agency_id}`} className="text-sm text-primary hover:underline flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" />{team.agency_name}
              </Link>
            )}
          </Field>
          <Field label="Email">
            {editing ? <Input type="email" value={formData.email} onChange={e => set('email', e.target.value)} /> : <Val href={team.email ? `mailto:${team.email}` : null}>{team.email}</Val>}
          </Field>
          <Field label="Phone">
            {editing ? <Input type="tel" value={formData.phone} onChange={e => set('phone', e.target.value)} /> : <Val href={team.phone ? `tel:${team.phone}` : null}>{team.phone}</Val>}
          </Field>
          <Field label="Notes" span2>
            {editing ? <Textarea value={formData.notes} onChange={e => set('notes', e.target.value)} rows={3} className="resize-none" /> : <Val multiline>{team.notes}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 2. Hierarchy */}
      <Section title="Hierarchy">
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={createPageUrl('OrgDetails') + `?id=${team.agency_id}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20 text-primary text-sm font-medium hover:bg-primary/10 transition-colors">
            <Building2 className="h-3.5 w-3.5" />{team.agency_name || '—'}
          </Link>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
          <span className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-muted/50 border text-sm font-semibold">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />{team.name}
          </span>
        </div>
      </Section>

      {/* 3. Agents in this team */}
      <Section title={`Agents (${teamAgents.length})`}>
        {teamAgents.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No agents assigned to this team yet.</p>
        ) : (
          <div className="divide-y -mx-5 -mb-5 -mt-0">
            {teamAgents.map(agent => (
              <Link key={agent.id} to={createPageUrl('PersonDetails') + `?id=${agent.id}`}
                className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors group">
                <div className="p-1.5 rounded-md bg-muted/60 flex-shrink-0">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium group-hover:text-primary transition-colors">{agent.name}</p>
                  <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                    {agent.title && <span className="text-xs text-muted-foreground">{agent.title}</span>}
                    {agent.email && <span className="text-xs text-muted-foreground flex items-center gap-1"><Mail className="h-3 w-3" />{agent.email}</span>}
                    {agent.phone && <span className="text-xs text-muted-foreground flex items-center gap-1"><Phone className="h-3 w-3" />{agent.phone}</span>}
                  </div>
                </div>
                <Badge variant="outline" className="text-[10px] flex-shrink-0">{agent.relationship_state}</Badge>
              </Link>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}