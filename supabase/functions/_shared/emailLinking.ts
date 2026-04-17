/**
 * Shared email↔agent/agency auto-linking utilities.
 *
 * Matching strategy (in order of precedence):
 *   1. `From:` exact address → agent.email   (strongest signal, counter-party sender)
 *   2. Any `To:`/`Cc:` exact address → agent.email (outbound mail from us to agent)
 *   3. `From:` domain → any agent in that agency's domain → use their agency
 *
 * Own-inbox emails (flexmedia.sydney) are excluded from matching so we don't
 * self-link our own team as "agents".
 *
 * Everything is cached per-request by the AgentLookup object to keep this fast
 * during bulk sync / backfill operations.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Our own team's domains — emails from these are NOT matched as external agents
const OWN_DOMAINS = new Set<string>([
  'flexmedia.sydney',
  'flexstudios.app',
]);

// Public consumer / transactional domains we never want to match for agency inference
const GENERIC_DOMAINS = new Set<string>([
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com',
  'yahoo.com.au',
  'icloud.com',
  'live.com',
  'me.com',
  'bigpond.com',
  'optusnet.com.au',
  'proton.me',
  'protonmail.com',
]);

export interface AgentMatch {
  id: string;
  name: string | null;
  current_agency_id: string | null;
  current_agency_name: string | null;
}

export interface AgencyMatch {
  id: string;
  name: string | null;
}

export interface EmailLinkResult {
  agent_id: string | null;
  agent_name: string | null;
  agency_id: string | null;
  agency_name: string | null;
  /** `from`, `to`, `cc`, `domain`, or null */
  matched_via: 'from' | 'to' | 'cc' | 'domain' | null;
}

/** Case-insensitive RFC 2822 email address extractor. Handles `"Name" <addr>`, bare addr, malformed input. */
export function extractEmailAddress(header: string | null | undefined): string {
  if (!header) return '';
  // Try angle-bracketed form first: "Name" <addr@example.com>
  const bracket = header.match(/<\s*([^>\s,]+)\s*>/);
  if (bracket) return bracket[1].trim().toLowerCase();
  // Fall back to first whitespace-delimited token containing an @
  const bareMatch = header.match(/([^\s,<>"]+@[^\s,<>"]+)/);
  if (bareMatch) return bareMatch[1].trim().toLowerCase();
  return header.trim().toLowerCase();
}

/** Parse a header field or JSONB array of recipients into lowercase addresses */
export function parseRecipientList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => extractEmailAddress(String(v)))
      .filter((v) => v && v.includes('@'));
  }
  if (typeof value === 'string') {
    // Split on commas but respect quoted names
    return value
      .split(/,(?![^<]*>)/)
      .map((s) => extractEmailAddress(s))
      .filter((v) => v && v.includes('@'));
  }
  return [];
}

function getDomain(addr: string): string {
  const i = addr.lastIndexOf('@');
  return i >= 0 ? addr.slice(i + 1).toLowerCase() : '';
}

/** True if this address is one of our own team's addresses (should not match as agent). */
export function isOwnAddress(addr: string, accountAddresses?: Set<string>): boolean {
  if (!addr) return true;
  const d = getDomain(addr);
  if (OWN_DOMAINS.has(d)) return true;
  if (accountAddresses?.has(addr)) return true;
  return false;
}

/**
 * Request-scoped lookup cache. Avoids hammering the DB during bulk backfill.
 */
export class AgentLookup {
  private agentByEmail = new Map<string, AgentMatch | null>();
  private agencyByDomain = new Map<string, AgencyMatch | null>();
  private accountAddresses: Set<string>;

  constructor(
    private admin: SupabaseClient,
    accountAddresses: Iterable<string> = [],
  ) {
    this.accountAddresses = new Set(
      Array.from(accountAddresses).map((a) => a.toLowerCase()),
    );
  }

  /** Preload ALL agents into cache in one query (for bulk backfill). Costs one round-trip. */
  async preloadAgents(): Promise<void> {
    const { data } = await this.admin
      .from('agents')
      .select('id, name, email, current_agency_id, current_agency_name')
      .not('email', 'is', null);
    if (data) {
      for (const a of data) {
        if (a.email) {
          this.agentByEmail.set(a.email.toLowerCase(), {
            id: a.id,
            name: a.name,
            current_agency_id: a.current_agency_id,
            current_agency_name: a.current_agency_name,
          });
        }
      }
    }
  }

  /**
   * Preload domain→agency map.
   * Primary source: `agencies.email_domains` (direct, admin-curated).
   * Fallback: derive from any agents whose email domain isn't already covered.
   */
  async preloadDomains(): Promise<void> {
    // Primary: direct from agencies.email_domains
    const { data: agenciesData } = await this.admin
      .from('agencies')
      .select('id, name, email_domains');
    const agencyNameById = new Map<string, string | null>();
    if (agenciesData) {
      for (const ag of agenciesData) {
        agencyNameById.set(ag.id, ag.name ?? null);
        const domains: unknown = (ag as { email_domains?: unknown }).email_domains;
        if (!Array.isArray(domains)) continue;
        for (const raw of domains) {
          const d = String(raw || '').toLowerCase().trim();
          if (!d || GENERIC_DOMAINS.has(d) || OWN_DOMAINS.has(d)) continue;
          if (!this.agencyByDomain.has(d)) {
            this.agencyByDomain.set(d, { id: ag.id, name: ag.name ?? null });
          }
        }
      }
    }

    // Fallback: derive from agents whose email domain isn't covered yet
    const { data: agentsData } = await this.admin
      .from('agents')
      .select('email, current_agency_id, current_agency_name')
      .not('email', 'is', null)
      .not('current_agency_id', 'is', null);
    if (agentsData) {
      const tally = new Map<string, Map<string, { count: number; name: string | null }>>();
      for (const a of agentsData) {
        const d = getDomain((a.email || '').toLowerCase());
        if (!d || GENERIC_DOMAINS.has(d) || OWN_DOMAINS.has(d)) continue;
        if (!a.current_agency_id) continue;
        if (this.agencyByDomain.has(d)) continue; // already covered by agencies.email_domains
        if (!tally.has(d)) tally.set(d, new Map());
        const inner = tally.get(d)!;
        const prev = inner.get(a.current_agency_id) || {
          count: 0,
          name: a.current_agency_name ?? agencyNameById.get(a.current_agency_id) ?? null,
        };
        prev.count += 1;
        inner.set(a.current_agency_id, prev);
      }
      for (const [d, agencies] of tally) {
        let best: { id: string; name: string | null; count: number } | null = null;
        for (const [agencyId, info] of agencies) {
          if (!best || info.count > best.count) {
            best = { id: agencyId, name: info.name, count: info.count };
          }
        }
        if (best) {
          this.agencyByDomain.set(d, { id: best.id, name: best.name });
        }
      }
    }
  }

  async findAgentByEmail(email: string): Promise<AgentMatch | null> {
    if (!email) return null;
    const key = email.toLowerCase();
    if (this.agentByEmail.has(key)) return this.agentByEmail.get(key) || null;
    try {
      const { data } = await this.admin
        .from('agents')
        .select('id, name, current_agency_id, current_agency_name')
        .ilike('email', key)
        .limit(1)
        .maybeSingle();
      this.agentByEmail.set(key, data || null);
      return data || null;
    } catch {
      this.agentByEmail.set(key, null);
      return null;
    }
  }

  async findAgencyByDomain(domain: string): Promise<AgencyMatch | null> {
    if (!domain || GENERIC_DOMAINS.has(domain) || OWN_DOMAINS.has(domain)) return null;
    if (this.agencyByDomain.has(domain)) return this.agencyByDomain.get(domain) || null;
    try {
      // Primary: direct lookup on agencies.email_domains
      const { data: agencyHit } = await this.admin
        .from('agencies')
        .select('id, name')
        .contains('email_domains', [domain])
        .limit(1)
        .maybeSingle();
      if (agencyHit?.id) {
        const out = { id: agencyHit.id, name: agencyHit.name ?? null };
        this.agencyByDomain.set(domain, out);
        return out;
      }
      // Fallback: derive from any agent at this domain
      const { data } = await this.admin
        .from('agents')
        .select('current_agency_id, current_agency_name')
        .ilike('email', `%@${domain}`)
        .not('current_agency_id', 'is', null)
        .limit(1)
        .maybeSingle();
      const out = data?.current_agency_id
        ? { id: data.current_agency_id, name: data.current_agency_name }
        : null;
      this.agencyByDomain.set(domain, out);
      return out;
    } catch {
      this.agencyByDomain.set(domain, null);
      return null;
    }
  }

  /**
   * Resolve links for an email message.
   * Matches From: first, then To:, then Cc:, then domain fallback on From.
   */
  async resolve(params: {
    from?: string | null;
    to?: unknown;
    cc?: unknown;
  }): Promise<EmailLinkResult> {
    const fromAddr = extractEmailAddress(params.from);
    const toList = parseRecipientList(params.to);
    const ccList = parseRecipientList(params.cc);

    // Priority 1: From: matches agent (skip if it's us)
    if (fromAddr && !isOwnAddress(fromAddr, this.accountAddresses)) {
      const agent = await this.findAgentByEmail(fromAddr);
      if (agent) {
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          agency_id: agent.current_agency_id,
          agency_name: agent.current_agency_name,
          matched_via: 'from',
        };
      }
    }

    // Priority 2: Any To: matches an agent (outbound mail from us to agent)
    for (const addr of toList) {
      if (isOwnAddress(addr, this.accountAddresses)) continue;
      const agent = await this.findAgentByEmail(addr);
      if (agent) {
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          agency_id: agent.current_agency_id,
          agency_name: agent.current_agency_name,
          matched_via: 'to',
        };
      }
    }

    // Priority 3: Any Cc: matches an agent
    for (const addr of ccList) {
      if (isOwnAddress(addr, this.accountAddresses)) continue;
      const agent = await this.findAgentByEmail(addr);
      if (agent) {
        return {
          agent_id: agent.id,
          agent_name: agent.name,
          agency_id: agent.current_agency_id,
          agency_name: agent.current_agency_name,
          matched_via: 'cc',
        };
      }
    }

    // Priority 4: Domain fallback — From:@agency-domain → that agency
    if (fromAddr && !isOwnAddress(fromAddr, this.accountAddresses)) {
      const d = getDomain(fromAddr);
      const agency = await this.findAgencyByDomain(d);
      if (agency) {
        return {
          agent_id: null,
          agent_name: null,
          agency_id: agency.id,
          agency_name: agency.name,
          matched_via: 'domain',
        };
      }
    }

    // Priority 5: Domain fallback on any external To:/Cc:
    for (const addr of [...toList, ...ccList]) {
      if (isOwnAddress(addr, this.accountAddresses)) continue;
      const d = getDomain(addr);
      const agency = await this.findAgencyByDomain(d);
      if (agency) {
        return {
          agent_id: null,
          agent_name: null,
          agency_id: agency.id,
          agency_name: agency.name,
          matched_via: 'domain',
        };
      }
    }

    return {
      agent_id: null,
      agent_name: null,
      agency_id: null,
      agency_name: null,
      matched_via: null,
    };
  }
}

/** Compact entry point: one-off match for a single email (does its own DB calls). */
export async function matchEmailLinks(
  admin: SupabaseClient,
  email: { from?: string | null; to?: unknown; cc?: unknown },
  ownAddresses: Iterable<string> = [],
): Promise<EmailLinkResult> {
  const lookup = new AgentLookup(admin, ownAddresses);
  return lookup.resolve(email);
}
