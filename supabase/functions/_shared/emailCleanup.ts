/**
 * Agent email hygiene: strip CRM middleman / forwarder addresses, pick a sane
 * primary, and keep an audit trail of rejected entries.
 *
 * Context: REA listing payloads return agent.emails as comma-joined strings that
 * mix the agent's real personal/business address with their CRM's capture or
 * lead-drop alias (Agentbox, Rex LeadDrop, Eagle Software, Inspect RE, etc.).
 * Storing the raw value in pulse_agents.email and all_emails pollutes downstream
 * matching (email → agent, agent → agency) and violates user trust. This module
 * normalises the input, filters the known middleman surface, and returns both a
 * clean list and the best-guess primary.
 *
 * Also used by email linking (emailLinking.ts) so we never match a message's
 * From: to a middleman address.
 */

// Exact middleman domains — messages here are never a real personal agent email.
// Australian real estate CRM + portal forwarders.
const MIDDLEMAN_DOMAINS = new Set<string>([
  // Agentbox (subdomains handled via MIDDLEMAN_SUFFIXES)
  'agentbox.com.au',
  'agentboxmail.com.au',
  'agentboxcrm.com.au',

  // Rex Software
  'rexsoftware.com',
  'rex.com.au',
  'leaddrop.rexsoftware.com',

  // Vault
  'vaultrealestate.com.au',
  'vaultre.com.au',
  'vaultre.com',

  // Eagle Software
  'eaglesoftware.com.au',
  'eagle-agency.net',
  'eagleagency.com.au',

  // Ailo
  'ailoy.com.au',
  'ailo.io',

  // Inspect Real Estate
  'inspectrealestate.com.au',
  'mail.inspectrealestate.com.au',
  'inspect.com.au',

  // Kolmeo
  'kolmeo.com',
  'kolmeo.io',

  // Other CRM / portals / tools
  'campaigntrack.com',
  'propertytree.com',
  'console.com.au',
  'sherlock.io',
  'box-digital.com',
  'reb-au.com',
  'rentmanager.com.au',
  'mailcampaigns.com.au',
  'mailchi.mp',
  'mail.mailchimp.com',
  'bossdata.com.au',
  'rpdata.com',
  'corelogic.com.au',
  'realestateview.com.au',
  'homely.com.au',
  'realty.com.au',
  'zenu.com.au',
  'lckdon.co',

  // Task / workflow tools that agencies route leads through
  'boards.trello.com',

  // Generic transactional providers
  'mandrillapp.com',
  'sendgrid.net',
  'sparkpostmail.com',
  'amazonses.com',
]);

// Any domain ending in one of these is treated as middleman (captures all
// agency-specific Agentbox subdomains like `stonerealestate.agentboxmail.com.au`
// or Rex subdomains like `xyz.rex.com.au`).
const MIDDLEMAN_SUFFIXES: readonly string[] = [
  '.agentbox.com.au',
  '.agentboxmail.com.au',
  '.agentboxcrm.com.au',
  '.rex.com.au',
  '.rexsoftware.com',
  '.vaultre.com.au',
  '.vaultrealestate.com.au',
  '.kolmeo.com',
  '.kolmeo.io',
  '.inspectrealestate.com.au',
  '.eaglesoftware.com.au',
  '.campaigntrack.com',
  '.propertytree.com',
  '.mandrillapp.com',
  '.sendgrid.net',
  '.amazonses.com',
];

// Generic noreply / role-account local-parts that are never a real agent
// regardless of domain. Keep these narrow — `admin@` and `info@` at an
// agency domain are sometimes legit (small one-person shops), so we don't
// blanket-block them.
const GENERIC_LOCAL_PATTERNS: readonly RegExp[] = [
  /^noreply$/i,
  /^no-reply$/i,
  /^donotreply$/i,
  /^do-not-reply$/i,
  /^notification$/i,
  /^notifications$/i,
  /^alert$/i,
  /^alerts$/i,
  /^bounce$/i,
  /^bounces$/i,
  /^mailer-daemon$/i,
  /^postmaster$/i,
  /^system$/i,
  /^daemon$/i,
  /^auto-reply$/i,
  /^autoreply$/i,
  /^capture$/i, // Agentbox lead-capture alias (used by every Agentbox agency)
  /^importcontact$/i, // Eagle Software import alias
  /^leaddrop$/i,
  /^leads-drop$/i,
  /^reaenquiries$/i,
  /^rea-enquiries$/i,
  /^pwteam$/i, // shared PM team alias seen in the live data
  /^portal\.leads(\+.*)?$/i, // Zenu-style portal lead forwarders
];

/** Parse a raw string that may be a single address or a comma-joined list into
 * lowercase trimmed addresses. */
export function parseEmailString(raw: unknown): string[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  return s
    .split(/[,;\s]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p.includes('@'));
}

/** Return true if `email` is a known CRM middleman / forwarder / generic alias. */
export function isMiddlemanEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  const addr = String(email).trim().toLowerCase();
  if (!addr || !addr.includes('@')) return true;
  const at = addr.lastIndexOf('@');
  const local = addr.slice(0, at);
  const domain = addr.slice(at + 1);
  if (!local || !domain) return true;

  // Exact domain match
  if (MIDDLEMAN_DOMAINS.has(domain)) return true;

  // Suffix match (handles wildcarded subdomains like `*.agentboxmail.com.au`)
  for (const suffix of MIDDLEMAN_SUFFIXES) {
    if (domain.endsWith(suffix)) return true;
  }

  // Generic / role local-parts
  for (const pattern of GENERIC_LOCAL_PATTERNS) {
    if (pattern.test(local)) return true;
  }

  return false;
}

/** Derive a best-guess domain from an agency name (strips Pty/Ltd/Realty/etc.)
 * Returns null if nothing usable. Used to prefer agency-domain matches when
 * picking a primary email. */
export function deriveAgencyDomain(
  agencyName: string | null | undefined,
): string | null {
  if (!agencyName) return null;
  // Strip common suburb suffix ("Ray White - Strathfield" → "Ray White")
  const base = String(agencyName)
    .split(/[-–—|]/)[0]
    .replace(/\b(pty\.?\s*ltd\.?|pty|ltd|realty|real estate|properties|property|group|agency)\b/gi, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase()
    .trim();
  if (!base || base.length < 3) return null;
  return base; // caller compares via endsWith('@' + base + ...) loosely
}

/** Pick the best primary email from a list.
 *
 * Order of preference:
 *  1. Non-middleman address whose local-part contains both the agent's first and
 *     last name tokens (e.g. `mark.bathurst@…` wins for "Mark Dwyer" — yes, the
 *     agent's mailbox address often encodes their real name even when
 *     display_name has changed).
 *  2. Non-middleman address matching the agency-derived domain root
 *  3. Non-middleman address whose local-part contains the agent's last name
 *  4. Any non-middleman address — first in input order (preserves scraper
 *     ordering which is usually "primary first")
 *  5. Fallback: first address, even if it's middleman (nothing better)
 *  6. null if the list is empty
 *
 * We avoid the "shortest local-part" heuristic — it misfires on multi-agent
 * listings where several real personal emails sit in the same field and the
 * shortest happens to be another colleague's shared mailbox.
 */
export function pickPrimaryEmail(
  emails: (string | null | undefined)[],
  agencyName?: string | null,
  agentName?: string | null,
): string | null {
  const cleanedAll = Array.from(
    new Set(
      emails
        .flatMap((e) => parseEmailString(e))
        .filter(Boolean),
    ),
  );
  if (cleanedAll.length === 0) return null;

  const nonMiddleman = cleanedAll.filter((e) => !isMiddlemanEmail(e));
  if (nonMiddleman.length === 0) return cleanedAll[0]; // stuck with middleman

  // Tokenise agent name into normalised lowercase alphanumeric parts of length >= 2.
  const nameTokens = String(agentName ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);

  // 1. Agent-name match: local-part contains first AND last name tokens
  if (nameTokens.length >= 2) {
    const first = nameTokens[0];
    const last = nameTokens[nameTokens.length - 1];
    const bothHit = nonMiddleman.find((e) => {
      const local = (e.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      return local.includes(first) && local.includes(last);
    });
    if (bothHit) return bothHit;
  }

  // 2. Agency-domain match
  const agencyRoot = deriveAgencyDomain(agencyName);
  if (agencyRoot) {
    const match = nonMiddleman.find((e) => {
      const d = e.split('@')[1] || '';
      const dRoot = d.replace(/[^a-z0-9]+/gi, '').toLowerCase();
      return dRoot.includes(agencyRoot) || agencyRoot.includes(dRoot);
    });
    if (match) return match;
  }

  // 3. Last-name match
  if (nameTokens.length >= 1) {
    const last = nameTokens[nameTokens.length - 1];
    if (last.length >= 3) {
      const hit = nonMiddleman.find((e) => {
        const local = (e.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        return local.includes(last);
      });
      if (hit) return hit;
    }
  }

  // 4. Preserve input order (scrapers usually list the real agent first)
  return nonMiddleman[0];
}

/** Filter an arbitrary list of emails (may be strings or comma-joined strings)
 * down to unique, normalised, non-middleman addresses. */
export function cleanEmailList(
  emails: (string | null | undefined)[],
): string[] {
  return Array.from(
    new Set(
      emails
        .flatMap((e) => parseEmailString(e))
        .filter((e) => !isMiddlemanEmail(e)),
    ),
  );
}

/** Same normalisation as cleanEmailList, but returns the addresses that WERE
 * filtered out — used to populate `rejected_emails` for audit. */
export function rejectedEmailList(
  emails: (string | null | undefined)[],
): string[] {
  return Array.from(
    new Set(
      emails
        .flatMap((e) => parseEmailString(e))
        .filter((e) => isMiddlemanEmail(e)),
    ),
  );
}

/** Convenience: split `all_emails` from the DB (may be a real jsonb array,
 * may be a single comma-joined string) into a normalised string[]. */
export function parseAllEmailsField(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => parseEmailString(v));
  }
  if (typeof value === 'string') {
    // Try JSON parse first in case it's a stringified array
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.flatMap((v) => parseEmailString(v));
      } catch {
        /* fall through */
      }
    }
    return parseEmailString(value);
  }
  return [];
}
