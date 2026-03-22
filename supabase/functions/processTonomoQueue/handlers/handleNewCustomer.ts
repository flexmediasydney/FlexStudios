import { writeAudit } from '../utils.ts';

export async function handleNewCustomer(entities: any, p: any) {
  if (!p.user?.email) return { summary: 'New customer skipped — no email', skipped: true };

  const existing = await entities.Agent.filter({ email: p.user.email }, null, 1);
  if (existing?.length > 0) return { summary: `Customer already exists: ${p.user.email}`, skipped: true };

  const agent = await entities.Agent.create({
    name: p.user.name || p.user.email,
    email: p.user.email,
    phone: p.user.phone || null,
  });

  await writeAudit(entities, {
    action: 'new_customer', entity_type: 'Agent', entity_id: agent.id, operation: 'created',
    notes: `New customer from Tonomo: ${p.user.email}`,
  });
  return { summary: `New customer created: ${p.user.email}` };
}
