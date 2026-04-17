import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('seedNotificationPreferences', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    // ── Auth: require master_admin; allow cron/service-role calls without user context ──
    const user = await getUserFromReq(req).catch(() => null);
    if (user && user.role !== 'master_admin') {
      return errorResponse('Only the account owner can run seed functions', 403);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);

    const existing = await entities.NotificationPreference.list('-created_date', 5);
    if (existing?.length > 0) {
      return jsonResponse({ message: 'Already seeded', count: existing.length });
    }

    const users = await entities.User.list('-created_date', 200);
    let created = 0;

    for (const user of users) {
      const existingDigest = await entities.NotificationDigestSettings.list('-created_date', 200);
      const hasMine = existingDigest.some((d: any) => d.user_id === user.id);
      if (!hasMine) {
        await entities.NotificationDigestSettings.create({
          user_id: user.id,
          quiet_hours_enabled: false,
          quiet_hours_start: '22:00',
          quiet_hours_end: '08:00',
          sound_enabled: false,
          show_previews: true,
          badge_count_enabled: true,
        });
        created++;
      }
    }

    return jsonResponse({ message: `Seeded ${created} records`, created });

  } catch (err: any) {
    return errorResponse(err.message);
  }
});
