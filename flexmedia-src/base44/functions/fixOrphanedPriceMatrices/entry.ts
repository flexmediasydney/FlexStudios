import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Fix orphaned price matrices and invalid discount percentages
 * Cleans up dangling references in the pricing engine
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    let fixedCount = 0;
    let errors = [];

    // Fetch all data
    const [priceMatrices, agencies, agents] = await Promise.all([
      base44.entities.PriceMatrix.list(),
      base44.entities.Agency.list(),
      base44.entities.Agent.list()
    ]);

    const agencyIds = new Set(agencies.map(a => a.id));
    const agentIds = new Set(agents.map(a => a.id));

    // FLAW 1: Delete orphaned price matrices (entity no longer exists)
    const orphanedMatrices = priceMatrices.filter(m => {
      if (m.entity_type === 'agency') {
        return !agencyIds.has(m.entity_id);
      } else if (m.entity_type === 'agent') {
        return !agentIds.has(m.entity_id);
      }
      return false;
    });

    if (orphanedMatrices.length > 0) {
      for (const matrix of orphanedMatrices) {
        try {
          await base44.entities.PriceMatrix.delete(matrix.id);
          fixedCount++;
        } catch (err) {
          errors.push({
            type: 'DELETE_ORPHANED_MATRIX_FAILED',
            matrix_id: matrix.id,
            error: err.message
          });
        }
      }
    }

    // FLAW 2: Fix invalid blanket discount percentages (must be 0-100)
    const matricesWithInvalidDiscounts = priceMatrices.filter(m => {
      if (!m.blanket_discount?.enabled) return false;
      const prod = m.blanket_discount.product_percent;
      const pkg = m.blanket_discount.package_percent;
      return (typeof prod !== 'number' || prod < 0 || prod > 100) ||
             (typeof pkg !== 'number' || pkg < 0 || pkg > 100);
    });

    if (matricesWithInvalidDiscounts.length > 0) {
      for (const matrix of matricesWithInvalidDiscounts) {
        try {
          const updated = { ...matrix };
          
          // Clamp to 0-100 range
          if (typeof updated.blanket_discount.product_percent === 'number') {
            updated.blanket_discount.product_percent = Math.max(0, Math.min(100, updated.blanket_discount.product_percent));
          } else {
            updated.blanket_discount.product_percent = 0;
          }

          if (typeof updated.blanket_discount.package_percent === 'number') {
            updated.blanket_discount.package_percent = Math.max(0, Math.min(100, updated.blanket_discount.package_percent));
          } else {
            updated.blanket_discount.package_percent = 0;
          }

          await base44.entities.PriceMatrix.update(matrix.id, {
            blanket_discount: updated.blanket_discount
          });
          fixedCount++;
        } catch (err) {
          errors.push({
            type: 'FIX_INVALID_DISCOUNT_FAILED',
            matrix_id: matrix.id,
            error: err.message
          });
        }
      }
    }

    return Response.json({
      success: true,
      fixed_count: fixedCount,
      fixes_applied: {
        orphaned_matrices_deleted: orphanedMatrices.length,
        invalid_discounts_clamped: matricesWithInvalidDiscounts.length
      },
      errors: errors.length > 0 ? errors : null
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});