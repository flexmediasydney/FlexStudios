import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  const existing = await base44.asServiceRole.entities.NotificationPreference.list('-created_date', 5);
  if (existing?.length > 0) {
    return Response.json({ message: 'Already seeded', count: existing.length });
  }

  const CONTRACTOR_OFF = ['financial', 'system', 'tonomo'];
  
  const users = await base44.asServiceRole.entities.User.list('-created_date', 200);
  let created = 0;

  for (const user of users) {
    if (user.role === 'contractor') {
      for (const category of CONTRACTOR_OFF) {
        await base44.asServiceRole.entities.NotificationPreference.create({
          user_id: user.id,
          notification_type: '*',
          category,
          in_app_enabled: false,
          email_enabled: false,
        });
        created++;
      }
    }

    const existingDigest = await base44.asServiceRole.entities.NotificationDigestSettings.list('-created_date', 200);
    const hasMine = existingDigest.some((d: any) => d.user_id === user.id);
    if (!hasMine) {
      await base44.asServiceRole.entities.NotificationDigestSettings.create({
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

  return Response.json({ message: `Seeded ${created} records`, created });
});