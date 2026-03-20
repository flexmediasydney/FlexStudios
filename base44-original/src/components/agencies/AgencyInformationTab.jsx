import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Pencil, Check, Loader2, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { fmtDate } from '@/components/utils/dateUtils';
import AgencyProjectTypesCompact from '@/components/agencies/AgencyProjectTypesCompact';
import CompactBrandingPreferences from '@/components/agencies/CompactBrandingPreferences';

const RELATIONSHIP_STATES = ['Prospecting', 'Active', 'Dormant', 'Do Not Contact'];
const safeFmt = (isoStr, fmt_str) => fmtDate(isoStr, fmt_str);
const toInputDate = (isoStr) => isoStr ? String(isoStr).substring(0, 10) : '';

function toForm(agency) {
  return {
    name: agency.name || '',
    email: agency.email || '',
    phone: agency.phone || '',
    address: agency.address || '',
    relationship_state: agency.relationship_state || 'Prospecting',
    onboarding_date: toInputDate(agency.onboarding_date),
    became_active_date: toInputDate(agency.became_active_date),
    became_dormant_date: toInputDate(agency.became_dormant_date),
    primary_marketing_contact: agency.primary_marketing_contact || '',
    primary_accounts_contact: agency.primary_accounts_contact || '',
    primary_partner: agency.primary_partner || '',
    whatsapp_group_chat: agency.whatsapp_group_chat || '',
    pricing_agreement: agency.pricing_agreement || '',
    pricing_notes: agency.pricing_notes || '',
    notes: agency.notes || '',
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function Section({ title, children, action }) {
  return (
    <div className="bg-card border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b bg-muted/20 flex items-center justify-between">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{title}</p>
        {action}
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
  if (href) return <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1">{children}<ExternalLink className="h-3 w-3" /></a>;
  if (multiline) return <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">{children}</p>;
  return <p className="text-sm text-foreground font-medium">{children}</p>;
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AgencyInformationTab({ agency }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState(() => toForm(agency));

  useEffect(() => { if (!editing) setFormData(toForm(agency)); }, [agency, editing]);

  const set = useCallback((field, value) => setFormData(p => ({ ...p, [field]: value })), []);

  const handleSave = async () => {
    if (!formData.name?.trim()) { toast.error('Agency name is required'); return; }
    setSaving(true);
    try {
      const user = await base44.auth.me();
      const payload = {
        name: formData.name.trim(),
        email: formData.email.trim(),
        phone: formData.phone.trim(),
        address: formData.address.trim(),
        relationship_state: formData.relationship_state,
        onboarding_date: formData.onboarding_date || null,
        became_active_date: formData.became_active_date || null,
        became_dormant_date: formData.became_dormant_date || null,
        primary_marketing_contact: formData.primary_marketing_contact.trim(),
        primary_accounts_contact: formData.primary_accounts_contact.trim(),
        primary_partner: formData.primary_partner.trim(),
        whatsapp_group_chat: formData.whatsapp_group_chat.trim(),
        pricing_agreement: formData.pricing_agreement.trim(),
        pricing_notes: formData.pricing_notes.trim(),
        notes: formData.notes.trim(),
      };
      const changedFields = Object.keys(payload)
        .filter(k => String(payload[k] ?? '') !== String(agency[k] ?? ''))
        .map(k => ({ field: k, old_value: String(agency[k] ?? ''), new_value: String(payload[k] ?? '') }));
      await base44.entities.Agency.update(agency.id, payload);
      if (changedFields.length > 0) {
        await base44.entities.AuditLog.create({
          entity_type: 'agency', entity_id: agency.id, entity_name: formData.name,
          action: 'update', changed_fields: changedFields,
          previous_state: agency, new_state: payload,
          user_name: user.full_name, user_email: user.email
        });
      }
      toast.success('Agency saved');
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
        <p className="text-xs text-muted-foreground">All details for this agency</p>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="gap-1.5">
            <Pencil className="h-3.5 w-3.5" /> Edit Details
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setFormData(toForm(agency)); setEditing(false); }} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Save Changes
            </Button>
          </div>
        )}
      </div>

      {/* 1. Agency Information */}
      <Section title="Agency Information">
        <Grid>
          <Field label="Agency Name" span2={editing}>
            {editing ? <Input value={formData.name} onChange={e => set('name', e.target.value)} className="max-w-md" /> : <Val>{agency.name}</Val>}
          </Field>
          <Field label="Email">
            {editing ? <Input type="email" value={formData.email} onChange={e => set('email', e.target.value)} /> : <Val href={agency.email ? `mailto:${agency.email}` : null}>{agency.email}</Val>}
          </Field>
          <Field label="Phone">
            {editing ? <Input type="tel" value={formData.phone} onChange={e => set('phone', e.target.value)} /> : <Val href={agency.phone ? `tel:${agency.phone}` : null}>{agency.phone}</Val>}
          </Field>
          <Field label="Address" span2={editing}>
            {editing ? <Input value={formData.address} onChange={e => set('address', e.target.value)} /> : <Val>{agency.address}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 2. Relationship */}
      <Section title="Relationship">
        <Grid>
          <Field label="Relationship State">
            {editing ? (
              <Select value={formData.relationship_state} onValueChange={v => {
                set('relationship_state', v);
                const today = new Date().toISOString().substring(0, 10);
                if (v === 'Active' && !formData.became_active_date) set('became_active_date', today);
                if (v === 'Dormant' && !formData.became_dormant_date) set('became_dormant_date', today);
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{RELATIONSHIP_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            ) : <Badge>{agency.relationship_state || '—'}</Badge>}
          </Field>
          <Field label="Onboarding Date">
            {editing ? <Input type="date" value={formData.onboarding_date} onChange={e => set('onboarding_date', e.target.value)} /> : <Val>{safeFmt(agency.onboarding_date, 'MMM d, yyyy')}</Val>}
          </Field>
          <Field label="Became Active">
            {editing ? <Input type="date" value={formData.became_active_date} onChange={e => set('became_active_date', e.target.value)} /> : <Val>{safeFmt(agency.became_active_date, 'MMM d, yyyy')}</Val>}
          </Field>
          <Field label="Became Dormant">
            {editing ? <Input type="date" value={formData.became_dormant_date} onChange={e => set('became_dormant_date', e.target.value)} /> : <Val>{safeFmt(agency.became_dormant_date, 'MMM d, yyyy')}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 3. Key Contacts */}
      <Section title="Key Contacts">
        <Grid>
          <Field label="Marketing Contact">
            {editing ? <Input value={formData.primary_marketing_contact} onChange={e => set('primary_marketing_contact', e.target.value)} placeholder="Name or email" /> : <Val>{agency.primary_marketing_contact}</Val>}
          </Field>
          <Field label="Accounts Contact">
            {editing ? <Input value={formData.primary_accounts_contact} onChange={e => set('primary_accounts_contact', e.target.value)} placeholder="Name or email" /> : <Val>{agency.primary_accounts_contact}</Val>}
          </Field>
          <Field label="Primary Partner">
            {editing ? <Input value={formData.primary_partner} onChange={e => set('primary_partner', e.target.value)} /> : <Val>{agency.primary_partner}</Val>}
          </Field>
          <Field label="WhatsApp Group">
            {editing ? <Input type="url" value={formData.whatsapp_group_chat} onChange={e => set('whatsapp_group_chat', e.target.value)} placeholder="https://chat.whatsapp.com/..." /> : <Val href={agency.whatsapp_group_chat}>{agency.whatsapp_group_chat}</Val>}
          </Field>
        </Grid>
      </Section>

      {/* 4. Default Project Types */}
      <Section title="Default Project Types">
        <AgencyProjectTypesCompact agency={agency} />
      </Section>

      {/* 7. Branding Preferences */}
      <Section title="Branding Preferences">
        <CompactBrandingPreferences agency={agency} />
      </Section>
    </div>
  );
}