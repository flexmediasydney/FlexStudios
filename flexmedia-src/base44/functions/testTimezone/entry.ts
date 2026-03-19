// v5 - elite engine
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { calculatePresetDeadline, getLocalDateComponents, wallClockToUTC, APP_TIMEZONE, resolveTimezone } from './deadlineCalculationUtils.js';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'master_admin') return Response.json({ error: 'Admin access required' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const timezone = resolveTimezone(body.timezone, null);

    const triggerISO = body.trigger || new Date().toISOString();
    const trigger = new Date(triggerISO);
    const now = new Date();

    const localTrigger = getLocalDateComponents(trigger, timezone);
    const localNow = getLocalDateComponents(now, timezone);

    // Test all presets
    const presets = [
      'tonight', 'tomorrow_night', 'tomorrow_am', 'tomorrow_business_am',
      'in_2_nights', 'in_3_nights', 'in_4_nights',
      'next_business_night', '2_business_nights', '3_business_nights'
    ];

    const presetResults = {};
    for (const preset of presets) {
      const d = calculatePresetDeadline(preset, trigger, timezone);
      if (d) {
        const lc = getLocalDateComponents(d, timezone);
        presetResults[preset] = {
          utc: d.toISOString(),
          local: `${lc.year}-${String(lc.month0+1).padStart(2,'0')}-${String(lc.day).padStart(2,'0')} ${String(lc.hour).padStart(2,'0')}:${String(lc.minute).padStart(2,'0')}:${String(lc.second).padStart(2,'0')}`,
        };
      } else {
        presetResults[preset] = null;
      }
    }

    // Round-trip test: can we get 23:59:59 tonight back correctly?
    const rtInput = wallClockToUTC(localNow.year, localNow.month0, localNow.day, 23, 59, 59, timezone);
    const rtCheck = getLocalDateComponents(rtInput, timezone);
    const rtOk = rtCheck.hour === 23 && rtCheck.minute === 59 && rtCheck.second === 59;

    return Response.json({
      appTimezone: APP_TIMEZONE,
      usedTimezone: timezone,
      serverNow: now.toISOString(),
      localNow: `${localNow.year}-${String(localNow.month0+1).padStart(2,'0')}-${String(localNow.day).padStart(2,'0')} ${String(localNow.hour).padStart(2,'0')}:${String(localNow.minute).padStart(2,'0')}`,
      trigger: trigger.toISOString(),
      localTrigger: `${localTrigger.year}-${String(localTrigger.month0+1).padStart(2,'0')}-${String(localTrigger.day).padStart(2,'0')} ${String(localTrigger.hour).padStart(2,'0')}:${String(localTrigger.minute).padStart(2,'0')}`,
      roundTripTest: {
        targetLocal: '23:59:59 tonight',
        outputUTC: rtInput.toISOString(),
        outputLocal: `${rtCheck.hour}:${String(rtCheck.minute).padStart(2,'0')}:${String(rtCheck.second).padStart(2,'0')}`,
        ok: rtOk
      },
      presetResults
    });
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});