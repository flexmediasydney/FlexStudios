import { handleCors, jsonResponse, errorResponse, getAdminClient, getUserFromReq, createEntities, isQuietHours, serveWithAudit } from '../_shared/supabase.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

type CadenceHealth = 'on_track' | 'due_soon' | 'overdue' | 'critical';
type WarmthTrend = 'improving' | 'declining' | 'stable';

interface Agent {
  id: string;
  name: string;
  relationship_state: string | null;
  cadence_interval_days: number | null;
  title: string | null;
  position: string | null;
  last_touchpoint_at: string | null;
  last_contacted_at: string | null;
  cadence_health: CadenceHealth | null;
  warmth_score: number | null;
  engagement_type: string | null;
}

interface Touchpoint {
  logged_at: string;
  outcome: string | null;
  sentiment: string | null;
  touchpoint_type_name: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_DAYS = 30;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(from: string | Date, to: Date): number {
  const ms = to.getTime() - new Date(from).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function computeCadenceHealth(daysSince: number | null, interval: number): CadenceHealth {
  if (daysSince === null) return 'critical';
  if (daysSince < interval * 0.7) return 'on_track';
  if (daysSince < interval) return 'due_soon';
  if (daysSince < interval * 1.5) return 'overdue';
  return 'critical';
}

function computeRecencyScore(daysSince: number | null): number {
  if (daysSince === null) return 0;
  if (daysSince <= 7) return 40;
  if (daysSince <= 14) return 35;
  if (daysSince <= 21) return 28;
  if (daysSince <= 30) return 20;
  if (daysSince <= 60) return 10;
  if (daysSince <= 90) return 5;
  return 0;
}

function computeFrequencyScore(touchpointCount: number, interval: number): number {
  const expectedMonthlyRate = 30 / interval;
  const actualMonthlyRate = touchpointCount / 3; // over 90 days = 3 months
  const ratio = expectedMonthlyRate > 0 ? actualMonthlyRate / expectedMonthlyRate : 0;
  if (ratio >= 1.0) return 20;
  if (ratio >= 0.7) return 15;
  if (ratio >= 0.4) return 10;
  if (ratio >= 0.2) return 5;
  return 0;
}

function computeSentimentScore(touchpoints: Touchpoint[]): number {
  const recent = touchpoints.slice(0, 5);
  if (recent.length === 0) return 0;

  const sentimentValue = (s: string | null): number => {
    if (!s) return 0.5;
    switch (s.toLowerCase()) {
      case 'positive': return 1;
      case 'neutral': return 0.5;
      case 'negative': return 0;
      default: return 0.5;
    }
  };

  const total = recent.reduce((sum, tp) => sum + sentimentValue(tp.sentiment), 0);
  return Math.round((total / recent.length) * 15);
}

function computeMilestoneScore(milestoneCount: number): number {
  if (milestoneCount >= 4) return 15;
  if (milestoneCount === 3) return 12;
  if (milestoneCount === 2) return 9;
  if (milestoneCount === 1) return 5;
  return 0;
}

function computeEngagementScore(engagementType: string | null): number {
  if (!engagementType) return 0;
  switch (engagementType.toLowerCase()) {
    case 'exclusive': return 10;
    case 'non_exclusive': return 5;
    default: return 0;
  }
}

function computeWarmthTrend(newScore: number, previousScore: number | null): WarmthTrend {
  if (previousScore === null) return 'stable';
  const diff = newScore - previousScore;
  if (diff > 5) return 'improving';
  if (diff < -5) return 'declining';
  return 'stable';
}

// ─── Notification helper (mirrors detectAtRiskContacts) ──────────────────────

async function canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    if (await isQuietHours(userId)) return false;
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch {
    return true;
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

serveWithAudit('computeCadenceHealth', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth check — callable by service-role (pg_cron) or admin users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json().catch(() => ({}));
    const source = body.source || 'manual';
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const ninetyDaysAgo = new Date(now.getTime() - NINETY_DAYS_MS).toISOString();

    console.log(`[computeCadenceHealth] Starting run — source: ${source}, date: ${todayStr}`);

    // ── Step 0: Load cadence rules once ──────────────────────────────────────
    const { data: rules = [] } = await admin
      .from('cadence_rules')
      .select('position, default_interval_days');
    const ruleMap: Record<string, number> = Object.fromEntries(
      (rules || []).map((r: any) => [r.position, r.default_interval_days])
    );

    // ── Load all agents with relevant states ─────────────────────────────────
    const agents: Agent[] = await entities.Agent.list('-created_at', 5000);
    const watchedAgents = agents.filter(
      (a: Agent) => a.relationship_state === 'Prospecting' || a.relationship_state === 'Active'
    );

    console.log(`[computeCadenceHealth] Found ${watchedAgents.length} watched agents (of ${agents.length} total)`);

    const distribution: Record<CadenceHealth, number> = {
      on_track: 0,
      due_soon: 0,
      overdue: 0,
      critical: 0,
    };
    let totalWarmth = 0;
    const newlyCritical: Array<{ id: string; name: string }> = [];

    for (const agent of watchedAgents) {
      try {
        // ── Step 1: Determine effective cadence interval ──────────────────
        let interval = DEFAULT_INTERVAL_DAYS;
        if (agent.cadence_interval_days && agent.cadence_interval_days > 0) {
          interval = agent.cadence_interval_days;
        } else {
          const positionKey = agent.title || agent.position;
          if (positionKey && ruleMap[positionKey]) {
            interval = ruleMap[positionKey];
          }
        }

        // ── Step 2: Compute cadence_health ───────────────────────────────
        const lastContact = agent.last_touchpoint_at || agent.last_contacted_at;
        const daysSince = lastContact ? daysBetween(lastContact, now) : null;
        const health = computeCadenceHealth(daysSince, interval);
        distribution[health]++;

        // ── Step 3: Compute warmth_score ──────────────────────────────────

        // Load recent touchpoints (last 90 days)
        const { data: recentTps = [] } = await admin
          .from('touchpoints')
          .select('logged_at, outcome, sentiment, touchpoint_type_name')
          .eq('agent_id', agent.id)
          .gte('logged_at', ninetyDaysAgo)
          .order('logged_at', { ascending: false });

        // Load conversion milestones
        const { data: milestones = [] } = await admin
          .from('conversion_milestones')
          .select('id')
          .eq('agent_id', agent.id);

        const recency = computeRecencyScore(daysSince);
        const frequency = computeFrequencyScore((recentTps || []).length, interval);
        const sentiment = computeSentimentScore(recentTps || []);
        const milestone = computeMilestoneScore((milestones || []).length);
        const engagement = computeEngagementScore(agent.engagement_type);

        const warmthScore = Math.min(100, recency + frequency + sentiment + milestone + engagement);
        totalWarmth += warmthScore;

        // ── Step 4: Compute warmth_trend ─────────────────────────────────
        const warmthTrend = computeWarmthTrend(warmthScore, agent.warmth_score);

        // ── Step 5: Update agent ─────────────────────────────────────────
        await admin
          .from('agents')
          .update({
            cadence_health: health,
            warmth_score: warmthScore,
            warmth_trend: warmthTrend,
          })
          .eq('id', agent.id);

        // ── Step 6: Track newly critical agents ──────────────────────────
        if (health === 'critical' && agent.cadence_health !== 'critical') {
          newlyCritical.push({ id: agent.id, name: agent.name });
        }
      } catch (err: any) {
        console.error(`[computeCadenceHealth] Error processing agent ${agent.id} (${agent.name}):`, err.message);
        // Continue processing other agents
      }
    }

    // ── Notify admins about newly critical agents ────────────────────────────
    if (newlyCritical.length > 0) {
      console.log(`[computeCadenceHealth] ${newlyCritical.length} agent(s) newly critical — notifying admins`);

      const adminUsers = await entities.User.list('-created_at', 200);
      const admins = adminUsers.filter(
        (u: any) => u.role === 'master_admin' || u.role === 'admin'
      );

      const nameList = newlyCritical.slice(0, 5).map((a) => a.name).join(', ');
      const overflow = newlyCritical.length > 5 ? ` +${newlyCritical.length - 5} more` : '';

      for (const adm of admins) {
        const allowed = await canNotify(entities, adm.id, 'cadence_critical', 'system');
        if (!allowed) continue;

        await entities.Notification.create({
          user_id: adm.id,
          type: 'cadence_critical',
          category: 'system',
          severity: 'warning',
          title: `${newlyCritical.length} contact${newlyCritical.length > 1 ? 's' : ''} now cadence-critical`,
          message: `${nameList}${overflow} — cadence overdue and needs attention.`,
          cta_label: 'View Contacts',
          is_read: false,
          is_dismissed: false,
          source: 'cadence_health_engine',
          idempotency_key: `cadence_critical:${todayStr}`,
          created_date: now.toISOString(),
        }).catch((err: any) => {
          console.warn(`[computeCadenceHealth] Failed to notify admin ${adm.id}:`, err.message);
        });
      }
    }

    const avgWarmth = watchedAgents.length > 0 ? Math.round(totalWarmth / watchedAgents.length) : 0;

    console.log(
      `[computeCadenceHealth] Done — ` +
      `processed: ${watchedAgents.length}, ` +
      `distribution: ${JSON.stringify(distribution)}, ` +
      `avg_warmth: ${avgWarmth}, ` +
      `newly_critical: ${newlyCritical.length}`
    );

    return jsonResponse({
      status: 'ok',
      agents_processed: watchedAgents.length,
      cadence_distribution: distribution,
      avg_warmth: avgWarmth,
      newly_critical: newlyCritical.length,
    });
  } catch (err: any) {
    console.error('[computeCadenceHealth] Fatal error:', err);
    return errorResponse(err.message);
  }
});
