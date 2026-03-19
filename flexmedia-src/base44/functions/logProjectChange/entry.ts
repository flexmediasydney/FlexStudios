import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    const payload = await req.json();

    const { event, data, old_data } = payload;

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const changedFields = [];
    let description = '';

    if (event.type === 'update' && old_data && data) {
      for (const key in data) {
        if (JSON.stringify(old_data[key]) !== JSON.stringify(data[key])) {
          let oldVal = old_data[key];
          let newVal = data[key];
          
          // Format nested objects for display
          if (typeof oldVal === 'object' && oldVal !== null) oldVal = JSON.stringify(oldVal);
          if (typeof newVal === 'object' && newVal !== null) newVal = JSON.stringify(newVal);
          
          changedFields.push({
            field: key,
            old_value: oldVal ? String(oldVal) : '',
            new_value: newVal ? String(newVal) : ''
          });
        }
      }
      
      // Build human-readable description with field changes
      const fieldDescriptions = changedFields.map(f => {
        // Human-readable descriptions for products/packages changes
        if (f.field === 'products' || f.field === 'packages') {
          try {
            const oldArr = JSON.parse(f.old_value || '[]');
            const newArr = JSON.parse(f.new_value || '[]');
            const idKey = f.field === 'products' ? 'product_id' : 'package_id';
            const nameKey = f.field === 'products' ? 'product_name' : 'package_name';
            const label = f.field === 'products' ? 'Product' : 'Package';

            // Detect added
            const added = newArr.filter(n => !oldArr.find(o => o[idKey] === n[idKey]));
            // Detect removed
            const removed = oldArr.filter(o => !newArr.find(n => n[idKey] === o[idKey]));
            // Detect qty changes
            const qtyChanged = newArr.filter(n => {
              const old = oldArr.find(o => o[idKey] === n[idKey]);
              return old && old.quantity !== n.quantity;
            });

            const parts = [];
            for (const item of added) parts.push(`${label} added: ${item[nameKey] || item[idKey]}`);
            for (const item of removed) parts.push(`${label} removed: ${item[nameKey] || item[idKey]}`);
            for (const item of qtyChanged) {
              const old = oldArr.find(o => o[idKey] === item[idKey]);
              parts.push(`${item[nameKey] || item[idKey]} qty: ${old.quantity} → ${item.quantity}`);
            }
            return parts.length > 0 ? parts.join('; ') : `${f.field} updated`;
          } catch {
            return `${f.field} updated`;
          }
        }
        if (f.field === 'price' || f.field === 'calculated_price') {
          const fieldLabel = f.field.replace(/_/g, ' ');
          return `${fieldLabel}: $${parseFloat(f.old_value || 0).toFixed(2)} → $${parseFloat(f.new_value || 0).toFixed(2)}`;
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

    // Omit large state blobs to avoid CPU/payload limits
    await base44.asServiceRole.entities.ProjectActivity.create({
      project_id: event.entity_id,
      project_title: data?.title || old_data?.title || 'Unknown',
      action: event.type,
      changed_fields: changedFields.slice(0, 20), // cap at 20 fields
      description: description.slice(0, 1000),
      user_name: user.full_name,
      user_email: user.email,
      timestamp: new Date().toISOString()
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});