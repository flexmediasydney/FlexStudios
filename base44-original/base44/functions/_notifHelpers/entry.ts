/**
 * Helper to fire notifications using the notificationService function
 */
export async function fireNotif(base44: any, params: any) {
  try {
    await base44.asServiceRole.functions.invoke('notificationService', {
      action: 'create',
      userId: params.userId,
      type: params.type,
      category: params.category,
      severity: params.severity,
      title: params.title,
      message: params.message,
      projectId: params.projectId,
      projectName: params.projectName,
      ctaLabel: params.ctaLabel,
      source: params.source,
      idempotencyKey: params.idempotencyKey,
    });
  } catch (err: any) {
    console.warn('fireNotif failed:', err?.message);
  }
}