/**
 * cleanAgentEmails
 *
 * One-shot / on-demand backfill that applies the shared email hygiene rules
 * (`_shared/emailCleanup.ts`) to every `pulse_agents` row:
 *
 *   - Split any comma-joined email string into individual addresses
 *   - Drop CRM middleman / forwarder / generic role aliases
 *   - Pick the best clean primary (agency-domain match preferred)
 *   - Rewrite `email`, `all_emails`, `rejected_emails`, `email_cleaned_at`
 *
 * Safe to run repeatedly — idempotent. Writes nothing when the row is already
 * clean and there is nothing new to add.
 *
 * Invocation: POST with optional body
 *   { dryRun?: bool, limit?: number, onlyUncleaned?: bool }
 *
 * Auth: master_admin users or service-role calls.
 */

import { getAdminClient, getUserFromReq, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import {
  cleanEmailList,
  pickPrimaryEmail,
  rejectedEmailList,
  parseEmailString,
  parseAllEmailsField,
  isMiddlemanEmail,
} from '../_shared/emailCleanup.ts';

const PAGE_SIZE = 500;
const WALL_BUDGET_MS = 55_000;

serveWithAudit('cleanAgentEmails', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();

    // Auth: master_admin user or service-role
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
      if (user.role !== 'master_admin') {
        return errorResponse('Forbidden: Master admin access required', 403);
      }
    }

    let body: Record<string, unknown> = {};
    try { body = await req.json() as Record<string, unknown>; } catch { /* no body */ }
    const dryRun = body.dryRun === true;
    const onlyUncleaned = body.onlyUncleaned === true;
    const requestedLimit = Number.isFinite(body.limit as number) ? Number(body.limit) : 10_000;

    const startedAt = Date.now();
    const now = new Date().toISOString();
    const stats = {
      scanned: 0,
      updated: 0,
      primary_replaced: 0,
      primary_unchanged: 0,
      emails_rejected: 0,
      emails_kept: 0,
      rows_with_rejections: 0,
      examples: [] as Array<{
        id: string;
        full_name: string;
        before_email: string | null;
        after_email: string | null;
        before_all: unknown;
        after_all: string[];
        rejected: string[];
      }>,
      errors: [] as string[],
      hit_wall_budget: false,
    };

    let processed = 0;
    let offset = 0;

    while (processed < requestedLimit) {
      if (Date.now() - startedAt > WALL_BUDGET_MS) {
        stats.hit_wall_budget = true;
        break;
      }

      const pageSize = Math.min(PAGE_SIZE, requestedLimit - processed);

      let q = admin
        .from('pulse_agents')
        // Migration 103: also load email_source + confidence to respect
        // detail-sourced primaries (never clobber a high-confidence detail
        // email with a cleanup-derived scrape pick).
        .select('id, full_name, email, all_emails, rejected_emails, email_cleaned_at, agency_name, email_source, email_confidence')
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (onlyUncleaned) q = q.is('email_cleaned_at', null);

      const { data: rows, error } = await q;
      if (error) {
        stats.errors.push(`fetch@${offset}: ${error.message}`);
        break;
      }
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        stats.scanned++;
        const pool: string[] = [
          ...parseEmailString(row.email),
          ...parseAllEmailsField(row.all_emails),
          // preserve previously-rejected entries so we don't lose the audit trail
          ...parseAllEmailsField(row.rejected_emails),
        ];
        if (pool.length === 0) continue;

        const cleaned = cleanEmailList(pool);
        const rejected = rejectedEmailList(pool);
        stats.emails_kept += cleaned.length;
        stats.emails_rejected += rejected.length;
        if (rejected.length > 0) stats.rows_with_rejections++;

        const beforeEmail = (row.email || '').trim();
        const beforeEmailLc = beforeEmail.toLowerCase();
        const beforeIsMiddleman = isMiddlemanEmail(beforeEmail);
        // If the existing primary is a clean, parseable address that already
        // appears in the cleaned pool, keep it — avoids flipping Mark to his
        // office mailbox just because the local-part happens to be shorter.
        const beforeIsCleanAndInList = beforeEmail.includes('@')
          && !beforeIsMiddleman
          && cleaned.includes(beforeEmailLc);

        let primary: string | null;
        if (beforeIsCleanAndInList) {
          primary = beforeEmailLc;
        } else {
          // Only fall back to a middleman address if we have literally nothing
          // better — downstream code that asks "does this agent have a real
          // email?" should return false for these rows, so we prefer nulling
          // out the primary over storing a known-bad address.
          primary = pickPrimaryEmail(cleaned, row.agency_name, row.full_name);
        }
        const primaryLc = primary ? primary.toLowerCase() : null;

        const updates: Record<string, unknown> = {
          all_emails: cleaned,
          rejected_emails: rejected,
          email_cleaned_at: now,
        };

        // Decide on the new `email` value:
        //   - if we picked a clean primary and it's different → replace
        //   - if the existing email is middleman AND we have no clean primary
        //     → null it out (avoid downstream false positives)
        //   - otherwise leave existing untouched
        const existingNeedsFix = !beforeEmail
          || !beforeEmail.includes('@')
          || beforeIsMiddleman
          || beforeEmail.includes(',');

        // ── Source-aware promotion (migration 103+104) ────────────────────
        // If the current primary was set by detail_page_* at high confidence
        // (>= 85), the cleanup hygiene pass must not demote it. Hygiene is
        // confidence=65 so a simple "source_confidence < existing confidence"
        // check guards against clobbering.
        const existingSource = row.email_source as string | null;
        const existingConfidence = (row.email_confidence as number | null) ?? 0;
        const detailSourced = existingSource === 'detail_page_lister' || existingSource === 'detail_page_agency';
        const HYGIENE_CONFIDENCE = 65;
        const primaryProtected = detailSourced && existingConfidence > HYGIENE_CONFIDENCE;

        if (primary && primaryLc !== beforeEmailLc && existingNeedsFix && !primaryProtected) {
          updates.email = primary;
          // Hygiene stamps itself as the new source — but ONLY when we actually
          // rewrote the primary. Detail-sourced promotions came via pulse_merge_contact.
          updates.email_source = 'hygiene';
          updates.email_confidence = HYGIENE_CONFIDENCE;
          if (beforeEmail && !beforeIsMiddleman) {
            updates.previous_email = beforeEmail;
          }
          stats.primary_replaced++;
        } else if (!primary && beforeEmail && beforeIsMiddleman && !primaryProtected) {
          // All known emails are middleman and nothing clean to replace with
          // — null the primary but keep the audit trail in rejected_emails.
          updates.email = null;
          updates.email_source = null;
          updates.email_confidence = null;
          stats.primary_replaced++;
        } else {
          stats.primary_unchanged++;
        }

        if (stats.examples.length < 10 && (rejected.length > 0 || primaryLc !== beforeEmailLc)) {
          stats.examples.push({
            id: row.id,
            full_name: row.full_name,
            before_email: row.email,
            after_email: primary,
            before_all: row.all_emails,
            after_all: cleaned,
            rejected,
          });
        }

        if (!dryRun) {
          const { error: updErr } = await admin
            .from('pulse_agents')
            .update(updates)
            .eq('id', row.id);
          if (updErr) {
            stats.errors.push(`update ${row.id}: ${updErr.message?.substring(0, 200)}`);
          } else {
            stats.updated++;
          }
        } else {
          stats.updated++;
        }

        processed++;
        if (processed >= requestedLimit) break;
      }

      if (rows.length < pageSize) break;
      offset += rows.length;
    }

    return jsonResponse({
      ok: true,
      dryRun,
      duration_ms: Date.now() - startedAt,
      ...stats,
    }, 200, req);
  } catch (err: any) {
    console.error('cleanAgentEmails error:', err);
    return errorResponse(err?.message || 'cleanAgentEmails failed', 500);
  }
});
