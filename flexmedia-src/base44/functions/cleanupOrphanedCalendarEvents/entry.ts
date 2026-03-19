import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || (user.role !== 'master_admin' && user.role !== 'admin')) {
      return Response.json({ error: 'Forbidden: admin required' }, { status: 403 });
    }

    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try { return await fn(); } catch (err: any) {
          if (err?.status === 429 && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
            continue;
          }
          throw err;
        }
      }
    };

    const [allEvents, allProjects, allConnections] = await Promise.all([
      retryWithBackoff(() => base44.asServiceRole.entities.CalendarEvent.list('-start_time', 5000)),
      retryWithBackoff(() => base44.asServiceRole.entities.Project.list('-created_date', 2000)),
      retryWithBackoff(() => base44.asServiceRole.entities.CalendarConnection.list('-created_date', 1000)),
    ]);

    const projectIds = new Set(allProjects.map((p: any) => p.id));
    const activeAccounts = new Set(
      allConnections
        .filter((c: any) => c.is_enabled)
        .map((c: any) => c.account_email)
    );

    const results = {
      orphaned_project_links: 0,
      orphaned_account_events: 0,
      errors: [] as string[],
    };

    const batchSize = 10;

    // 1. Find events with a project_id pointing to a deleted project
    const orphanedByProject = allEvents.filter((ev: any) =>
      ev.project_id && !projectIds.has(ev.project_id)
    );

    for (let i = 0; i < orphanedByProject.length; i += batchSize) {
      const batch = orphanedByProject.slice(i, i + batchSize);
      await Promise.all(batch.map((ev: any) =>
        retryWithBackoff(() => base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
          project_id: null,
          auto_linked: false,
          link_source: null,
        })).then(() => {
          results.orphaned_project_links++;
        }).catch((err: any) => {
          results.errors.push(`Event ${ev.id}: ${err.message}`);
        })
      ));
    }

    // 2. Find Google-source events whose account is no longer connected
    const orphanedByAccount = allEvents.filter((ev: any) =>
      ev.event_source === 'google' &&
      ev.calendar_account &&
      !activeAccounts.has(ev.calendar_account)
    );

    for (let i = 0; i < orphanedByAccount.length; i += batchSize) {
      const batch = orphanedByAccount.slice(i, i + batchSize);
      await Promise.all(batch.map((ev: any) =>
        retryWithBackoff(() => base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
          is_done: true,
          calendar_account: null,
        })).then(() => {
          results.orphaned_account_events++;
        }).catch((err: any) => {
          results.errors.push(`Event ${ev.id}: ${err.message}`);
        })
      ));
    }

    return Response.json({
      success: true,
      ...results,
      total_events_scanned: allEvents.length,
      message: `Cleaned ${results.orphaned_project_links} dangling project links, ${results.orphaned_account_events} orphaned account events.`,
    });

  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});