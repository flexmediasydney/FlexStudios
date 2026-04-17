import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
import { refetchEntityList, updateEntityInCache } from '@/components/hooks/useEntityData';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { X, Plus, Mail, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

// Generic / personal providers — excluded from agency linking
const GENERIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au',
  'icloud.com', 'me.com', 'live.com', 'protonmail.com', 'proton.me',
  'aol.com', 'bigpond.com', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au',
]);

const OWN_DOMAINS = new Set(['flexmedia.sydney', 'flexstudios.app', 'flexstudios.com.au']);

function sanitiseDomain(raw) {
  if (!raw) return '';
  let d = String(raw).trim().toLowerCase();
  // strip leading @, protocol, path
  d = d.replace(/^@/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  // strip "www."
  d = d.replace(/^www\./, '');
  return d;
}

function validateDomain(d) {
  if (!d) return 'Empty';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return 'Not a valid domain';
  if (GENERIC_DOMAINS.has(d)) return 'Generic provider — cannot link to an agency';
  if (OWN_DOMAINS.has(d)) return 'Internal domain — excluded from matching';
  return null;
}

/**
 * Editable list of email domains for an agency.
 * Incoming emails with a sender/recipient at one of these domains will be
 * auto-linked to this agency by the email-sync resolver.
 */
export default function AgencyEmailDomainsModule({ agency }) {
  const queryClient = useQueryClient();
  const [domains, setDomains] = useState([]);
  const [input, setInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const initial = Array.isArray(agency?.email_domains) ? agency.email_domains : [];
    setDomains(initial.map(d => String(d).toLowerCase()));
    setDirty(false);
  }, [agency?.id, agency?.email_domains]);

  const inputError = useMemo(() => {
    const candidate = sanitiseDomain(input);
    if (!candidate) return null;
    if (domains.includes(candidate)) return 'Already added';
    return validateDomain(candidate);
  }, [input, domains]);

  const addDomain = useCallback(() => {
    const candidate = sanitiseDomain(input);
    if (!candidate) return;
    const err = validateDomain(candidate);
    if (err) { toast.error(err); return; }
    if (domains.includes(candidate)) { toast.error('Already added'); return; }
    setDomains(prev => [...prev, candidate].sort());
    setInput('');
    setDirty(true);
  }, [input, domains]);

  const removeDomain = useCallback((d) => {
    setDomains(prev => prev.filter(x => x !== d));
    setDirty(true);
  }, []);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addDomain();
    }
    if (e.key === 'Backspace' && !input && domains.length > 0) {
      removeDomain(domains[domains.length - 1]);
    }
  }, [addDomain, removeDomain, input, domains]);

  const onSave = useCallback(async () => {
    if (!agency?.id) return;
    setSaving(true);
    try {
      const payload = { email_domains: domains };
      await api.entities.Agency.update(agency.id, payload);
      updateEntityInCache('Agency', agency.id, payload);
      queryClient.invalidateQueries({ queryKey: ['entity', 'Agency', agency.id] });
      refetchEntityList('Agency');
      toast.success('Email domains saved');
      setDirty(false);
    } catch (err) {
      console.error('[AgencyEmailDomains] save failed', err);
      toast.error('Failed to save email domains');
    } finally {
      setSaving(false);
    }
  }, [agency?.id, domains, queryClient]);

  const onReset = useCallback(() => {
    const initial = Array.isArray(agency?.email_domains) ? agency.email_domains : [];
    setDomains(initial.map(d => String(d).toLowerCase()));
    setInput('');
    setDirty(false);
  }, [agency?.email_domains]);

  return (
    <div className="p-6 max-w-3xl space-y-4">
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">Email Domains</CardTitle>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Inbound/outbound emails with an address at any of these domains will be auto-linked to{' '}
            <span className="font-medium text-foreground">{agency?.name || 'this agency'}</span>.
            Generic providers (gmail, hotmail, etc.) are never used for agency matching.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Tag list */}
          <div className="flex flex-wrap gap-1.5 min-h-[32px]">
            {domains.length === 0 ? (
              <p className="text-xs text-muted-foreground italic self-center">No domains configured yet.</p>
            ) : domains.map(d => (
              <Badge
                key={d}
                variant="secondary"
                className="gap-1 pl-2 pr-1 py-1 text-xs font-mono"
              >
                {d}
                <button
                  type="button"
                  onClick={() => removeDomain(d)}
                  className="ml-0.5 rounded-full hover:bg-background/60 p-0.5 transition-colors"
                  title={`Remove ${d}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>

          {/* Input */}
          <div className="flex gap-2 items-start">
            <div className="flex-1">
              <Input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="e.g. raywhite.com  — press Enter or comma to add"
                className="h-8 text-sm font-mono"
              />
              {inputError && (
                <p className="text-[11px] text-red-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {inputError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 shrink-0"
              onClick={addDomain}
              disabled={!input.trim() || !!inputError}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>

          {/* Save / Reset */}
          <div className="flex items-center gap-2 pt-2 border-t">
            <Button
              size="sm"
              onClick={onSave}
              disabled={!dirty || saving}
              className="gap-1.5"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Save Changes
            </Button>
            {dirty && !saving && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onReset}
              >
                Cancel
              </Button>
            )}
            {!dirty && !saving && (
              <span className="text-[11px] text-muted-foreground">All saved.</span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed bg-muted/30">
        <CardContent className="pt-4 pb-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">How email linking works:</span>
            {' '}when a new email arrives, the system matches it in this order:
            <span className="block mt-1.5">
              1. Exact <code className="font-mono bg-background px-1 rounded">From:</code> / <code className="font-mono bg-background px-1 rounded">To:</code> / <code className="font-mono bg-background px-1 rounded">Cc:</code> address matches a known agent → linked to that agent + their agency.
            </span>
            <span className="block mt-1">
              2. Sender/recipient domain matches <span className="font-semibold">any domain in this list</span> → linked to this agency.
            </span>
            <span className="block mt-1">
              3. Fallback: if nothing here matches, the system tries to infer an agency from any agent who happens to use this domain.
            </span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
