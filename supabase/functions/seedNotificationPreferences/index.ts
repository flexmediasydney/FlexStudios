import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
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
