import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Fix orphaned price matrices and invalid discount percentages
 * Cleans up dangling references in the pricing engine
 */
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    let fixedCount = 0;
    const errors: any[] = [];

    // Fetch all data
    const [priceMatrices, agencies, agents] = await Promise.all([
      entities.PriceMatrix.list(),
      entities.Agency.list(),
      entities.Agent.list()
    ]);

    const agencyIds = new Set(agencies.map((a: any) => a.id));
    const agentIds = new Set(agents.map((a: any) => a.id));

    // FLAW 1: Delete orphaned price matrices (entity no longer exists)
    const orphanedMatrices = priceMatrices.filter((m: any) => {
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
          await entities.PriceMatrix.delete(matrix.id);
          fixedCount++;
        } catch (err: any) {
          errors.push({
            type: 'DELETE_ORPHANED_MATRIX_FAILED',
            matrix_id: matrix.id,
            error: err.message
          });
        }
      }
    }

    // FLAW 2: Fix invalid blanket discount percentages (must be 0-100)
    const matricesWithInvalidDiscounts = priceMatrices.filter((m: any) => {
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

          await entities.PriceMatrix.update(matrix.id, {
            blanket_discount: updated.blanket_discount
          });
          fixedCount++;
        } catch (err: any) {
          errors.push({
            type: 'FIX_INVALID_DISCOUNT_FAILED',
            matrix_id: matrix.id,
            error: err.message
          });
        }
      }
    }

    return jsonResponse({
      success: true,
      fixed_count: fixedCount,
      fixes_applied: {
        orphaned_matrices_deleted: orphanedMatrices.length,
        invalid_discounts_clamped: matricesWithInvalidDiscounts.length
      },
      errors: errors.length > 0 ? errors : null
    });

  } catch (error: any) {
    return errorResponse(error.message);
  }
});
