import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('logProjectChange', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    const payload = await req.json().catch(() => ({} as any));

    const { event, data, old_data } = payload;

    if (!user) return errorResponse('Unauthorized', 401, req);
    if (!event?.type) return errorResponse('event.type required', 400, req);

    const changedFields: any[] = [];
    let description = '';

    if (event.type === 'update' && old_data && data) {
      for (const key in data) {
        if (JSON.stringify(old_data[key]) !== JSON.stringify(data[key])) {
          let oldVal = old_data[key];
          let newVal = data[key];

          if (typeof oldVal === 'object' && oldVal !== null) oldVal = JSON.stringify(oldVal);
          if (typeof newVal === 'object' && newVal !== null) newVal = JSON.stringify(newVal);

          changedFields.push({
            field: key,
            old_value: oldVal ? String(oldVal) : '',
            new_value: newVal ? String(newVal) : '',
          });
        }
      }

      const fieldDescriptions = changedFields.map((f: any) => {
        if (f.field === 'products' || f.field === 'packages') {
          try {
            const oldArr = JSON.parse(f.old_value || '[]');
            const newArr = JSON.parse(f.new_value || '[]');
            const idKey = f.field === 'products' ? 'product_id' : 'package_id';
            const nameKey = f.field === 'products' ? 'product_name' : 'package_name';
            const label = f.field === 'products' ? 'Product' : 'Package';

            const added = newArr.filter((n: any) => !oldArr.find((o: any) => o[idKey] === n[idKey]));
            const removed = oldArr.filter((o: any) => !newArr.find((n: any) => n[idKey] === o[idKey]));
            const qtyChanged = newArr.filter((n: any) => {
              const old = oldArr.find((o: any) => o[idKey] === n[idKey]);
              return old && old.quantity !== n.quantity;
            });

            const parts: string[] = [];
            for (const item of added) parts.push(`${label} added: ${item[nameKey] || item[idKey]}`);
            for (const item of removed) parts.push(`${label} removed: ${item[nameKey] || item[idKey]}`);
            for (const item of qtyChanged) {
              const old = oldArr.find((o: any) => o[idKey] === item[idKey]);
              parts.push(`${item[nameKey] || item[idKey]} qty: ${old.quantity} → ${item.quantity}`);
            }
            return parts.length > 0 ? parts.join('; ') : `${f.field} updated`;
          } catch {
            return `${f.field} updated`;
          }
        }
        if (f.field === 'price' || f.field === 'calculated_price') {
          const fieldLabel = f.field.replace(/_/g, ' ');
          return `${fieldLabel}: $${parseFloat(f.old_value || '0').toFixed(2)} → $${parseFloat(f.new_value || '0').toFixed(2)}`;
        }
        const fieldLabel = f.field.replace(/_/g, ' ').toLowerCase();
        if (f.old_value && f.new_value) {
          return `${fieldLabel}: ${f.old_value} → ${f.new_value}`;
        } else if (f.new_value) {
          return `${fieldLabel} added: ${f.new_value}`;
        } else {
          return `${fieldLabel} removed`;
        }
      });

      description = fieldDescriptions.length > 0
        ? fieldDescriptions.join('; ')
        : 'Project updated';
    } else if (event.type === 'create') {
      description = `Project created`;
    } else if (event.type === 'delete') {
      description = `Project deleted`;
    }

    await entities.ProjectActivity.create({
      project_id: event.entity_id,
      project_title: data?.title || old_data?.title || 'Unknown',
      action: event.type,
      changed_fields: changedFields.slice(0, 20),
      description: description.slice(0, 1000),
      user_name: user.full_name,
      user_email: user.email,
      timestamp: new Date().toISOString(),
    });

    return jsonResponse({ success: true });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});
