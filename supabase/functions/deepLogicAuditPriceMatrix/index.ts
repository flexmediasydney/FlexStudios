import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Deep logic audit of the entire price matrix engine
 * Tests 30+ integrity checks across pricing, overrides, discounts, and type safety
 */
serveWithAudit('deepLogicAuditPriceMatrix', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    const findings: { critical: any[]; warnings: any[]; info: any[] } = {
      critical: [],
      warnings: [],
      info: []
    };

    let dataScanCount: any = {
      price_matrices: 0,
      products: 0,
      packages: 0,
      agencies: 0,
      agents: 0,
      projects: 0
    };

    // Fetch all data
    const [priceMatrices, products, packages, agencies, agents, projects] = await Promise.all([
      entities.PriceMatrix.list(),
      entities.Product.list(),
      entities.Package.list(),
      entities.Agency.list(),
      entities.Agent.list(),
      entities.Project.list()
    ]);

    dataScanCount = {
      price_matrices: priceMatrices.length,
      products: products.length,
      packages: packages.length,
      agencies: agencies.length,
      agents: agents.length,
      projects: projects.length
    };

    const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));
    const packageMap = new Map<string, any>(packages.map((pkg: any) => [pkg.id, pkg]));
    const projectTypeMap = new Map();

    // Build project type map from unique project type IDs
    const allProjectTypeIds = new Set<string>();
    products.forEach((p: any) => p.project_type_ids?.forEach((id: string) => allProjectTypeIds.add(id)));
    packages.forEach((pkg: any) => pkg.project_type_ids?.forEach((id: string) => allProjectTypeIds.add(id)));

    for (const ptId of allProjectTypeIds) {
      try {
        const pt = await entities.ProjectType.get(ptId);
        projectTypeMap.set(ptId, pt);
      } catch {
        // Type may have been deleted
      }
    }

    // TEST 1: Price matrix entity_type/entity_id validation
    for (const matrix of priceMatrices) {
      if (!matrix.entity_type || !['agency', 'agent'].includes(matrix.entity_type)) {
        findings.critical.push({
          type: 'INVALID_ENTITY_TYPE',
          matrix_id: matrix.id,
          issue: `Invalid entity_type: ${matrix.entity_type}. Must be 'agency' or 'agent'`
        });
      }

      if (!matrix.entity_id) {
        findings.critical.push({
          type: 'MISSING_ENTITY_ID',
          matrix_id: matrix.id,
          issue: 'Missing entity_id'
        });
      }

      // Validate entity exists
      if (matrix.entity_type === 'agency' && matrix.entity_id) {
        const agency = agencies.find((a: any) => a.id === matrix.entity_id);
        if (!agency) {
          findings.warnings.push({
            type: 'ORPHANED_PRICE_MATRIX',
            matrix_id: matrix.id,
            issue: `References non-existent agency ${matrix.entity_id}`
          });
        } else if (agency.name !== matrix.entity_name) {
          findings.warnings.push({
            type: 'STALE_ENTITY_NAME',
            matrix_id: matrix.id,
            issue: `Cached name '${matrix.entity_name}' does not match current agency name '${agency.name}'`
          });
        }
      }

      if (matrix.entity_type === 'agent' && matrix.entity_id) {
        const agent = agents.find((a: any) => a.id === matrix.entity_id);
        if (!agent) {
          findings.warnings.push({
            type: 'ORPHANED_PRICE_MATRIX',
            matrix_id: matrix.id,
            issue: `References non-existent agent ${matrix.entity_id}`
          });
        } else if (agent.name !== matrix.entity_name) {
          findings.warnings.push({
            type: 'STALE_ENTITY_NAME',
            matrix_id: matrix.id,
            issue: `Cached name '${matrix.entity_name}' does not match current agent name '${agent.name}'`
          });
        }
      }
    }

    // TEST 2: Project type validation
    for (const matrix of priceMatrices) {
      if (matrix.project_type_id) {
        const projectType = projectTypeMap.get(matrix.project_type_id);
        if (!projectType) {
          findings.warnings.push({
            type: 'ORPHANED_PROJECT_TYPE',
            matrix_id: matrix.id,
            issue: `References non-existent project type ${matrix.project_type_id}`
          });
        } else if (projectType.name !== matrix.project_type_name) {
          findings.warnings.push({
            type: 'STALE_PROJECT_TYPE_NAME',
            matrix_id: matrix.id,
            issue: `Cached name '${matrix.project_type_name}' does not match actual '${projectType.name}'`
          });
        }
      }
    }

    // ── Engine v3 validators ──────────────────────────────────────────────
    // Validates tier_overrides shape:
    //   { standard: { enabled, mode, base/unit/price, percent }, premium: {...} }
    // Falls back to legacy validation for rows that haven't been backfilled
    // yet (raises a NEEDS_BACKFILL warning so admins can spot stragglers).
    const VALID_MODES = ['fixed', 'percent_off', 'percent_markup'];
    const TIERS_V3: Array<'standard' | 'premium'> = ['standard', 'premium'];

    const validateProductTierBlock = (matrix: any, productId: string, tier: string, t: any) => {
      if (!t || typeof t !== 'object') {
        findings.warnings.push({
          type: 'MISSING_TIER_BLOCK',
          matrix_id: matrix.id,
          product_id: productId,
          issue: `tier_overrides.${tier} missing on product override`,
        });
        return;
      }
      if (typeof t.enabled !== 'boolean') {
        findings.warnings.push({
          type: 'INVALID_TIER_ENABLED',
          matrix_id: matrix.id,
          product_id: productId,
          issue: `tier_overrides.${tier}.enabled must be boolean (got ${typeof t.enabled})`,
        });
      }
      if (!t.enabled) return; // disabled tiers don't need value validation
      const mode = t.mode || 'fixed';
      if (!VALID_MODES.includes(mode)) {
        findings.warnings.push({
          type: 'INVALID_TIER_MODE',
          matrix_id: matrix.id,
          product_id: productId,
          issue: `tier_overrides.${tier}.mode '${mode}' not in [fixed, percent_off, percent_markup]`,
        });
        return;
      }
      if (mode === 'fixed') {
        if (typeof t.base !== 'number' || t.base < 0) {
          findings.warnings.push({
            type: 'INVALID_OVERRIDE_PRICE',
            matrix_id: matrix.id, product_id: productId,
            issue: `tier_overrides.${tier}.base must be non-negative number (got ${t.base})`,
          });
        }
        if (t.unit != null && (typeof t.unit !== 'number' || t.unit < 0)) {
          findings.warnings.push({
            type: 'INVALID_OVERRIDE_PRICE',
            matrix_id: matrix.id, product_id: productId,
            issue: `tier_overrides.${tier}.unit must be non-negative number (got ${t.unit})`,
          });
        }
      } else {
        // percent modes
        if (typeof t.percent !== 'number' || t.percent < 0 || t.percent > 100) {
          findings.warnings.push({
            type: 'INVALID_TIER_PERCENT',
            matrix_id: matrix.id, product_id: productId,
            issue: `tier_overrides.${tier}.percent must be 0–100 for ${mode} (got ${t.percent})`,
          });
        }
      }
    };

    const validatePackageTierBlock = (matrix: any, packageId: string, tier: string, t: any) => {
      if (!t || typeof t !== 'object') {
        findings.warnings.push({
          type: 'MISSING_TIER_BLOCK',
          matrix_id: matrix.id,
          package_id: packageId,
          issue: `tier_overrides.${tier} missing on package override`,
        });
        return;
      }
      if (typeof t.enabled !== 'boolean') {
        findings.warnings.push({
          type: 'INVALID_TIER_ENABLED',
          matrix_id: matrix.id,
          package_id: packageId,
          issue: `tier_overrides.${tier}.enabled must be boolean (got ${typeof t.enabled})`,
        });
      }
      if (!t.enabled) return;
      const mode = t.mode || 'fixed';
      if (!VALID_MODES.includes(mode)) {
        findings.warnings.push({
          type: 'INVALID_TIER_MODE',
          matrix_id: matrix.id, package_id: packageId,
          issue: `tier_overrides.${tier}.mode '${mode}' not in [fixed, percent_off, percent_markup]`,
        });
        return;
      }
      if (mode === 'fixed') {
        if (typeof t.price !== 'number' || t.price < 0) {
          findings.warnings.push({
            type: 'INVALID_OVERRIDE_PRICE',
            matrix_id: matrix.id, package_id: packageId,
            issue: `tier_overrides.${tier}.price must be non-negative number (got ${t.price})`,
          });
        }
      } else {
        if (typeof t.percent !== 'number' || t.percent < 0 || t.percent > 100) {
          findings.warnings.push({
            type: 'INVALID_TIER_PERCENT',
            matrix_id: matrix.id, package_id: packageId,
            issue: `tier_overrides.${tier}.percent must be 0–100 for ${mode} (got ${t.percent})`,
          });
        }
      }
    };

    // TEST 3: Product pricing overrides validation
    for (const matrix of priceMatrices) {
      if (matrix.product_pricing && Array.isArray(matrix.product_pricing)) {
        for (const productPricing of matrix.product_pricing) {
          const product = productMap.get(productPricing.product_id);
          if (!product) {
            findings.warnings.push({
              type: 'ORPHANED_PRODUCT_OVERRIDE',
              matrix_id: matrix.id,
              product_id: productPricing.product_id,
              issue: `Price matrix has override for non-existent product ${productPricing.product_id}`
            });
          } else if (product.name !== productPricing.product_name) {
            findings.info.push({
              type: 'STALE_PRODUCT_NAME',
              matrix_id: matrix.id,
              product_id: productPricing.product_id,
              issue: `Cached name '${productPricing.product_name}' does not match actual '${product.name}'`
            });
          }

          if (productPricing.tier_overrides) {
            for (const tier of TIERS_V3) {
              validateProductTierBlock(matrix, productPricing.product_id, tier, productPricing.tier_overrides[tier]);
            }
          } else {
            // Pre-backfill row — warn so admins can spot it.
            findings.warnings.push({
              type: 'NEEDS_TIER_OVERRIDES_BACKFILL',
              matrix_id: matrix.id,
              product_id: productPricing.product_id,
              issue: `Product override row missing tier_overrides — migration 361 backfill should have populated this`,
            });
            // Still validate legacy numeric fields when override_enabled.
            if (productPricing.override_enabled) {
              if (typeof productPricing.standard_base !== 'number' || productPricing.standard_base < 0) {
                findings.warnings.push({
                  type: 'INVALID_OVERRIDE_PRICE',
                  matrix_id: matrix.id, product_id: productPricing.product_id,
                  issue: `Invalid standard_base price: ${productPricing.standard_base}`,
                });
              }
              if (typeof productPricing.premium_base !== 'number' || productPricing.premium_base < 0) {
                findings.warnings.push({
                  type: 'INVALID_OVERRIDE_PRICE',
                  matrix_id: matrix.id, product_id: productPricing.product_id,
                  issue: `Invalid premium_base price: ${productPricing.premium_base}`,
                });
              }
            }
          }
        }
      }
    }

    // TEST 4: Package pricing overrides validation
    for (const matrix of priceMatrices) {
      if (matrix.package_pricing && Array.isArray(matrix.package_pricing)) {
        for (const packagePricing of matrix.package_pricing) {
          const pkg = packageMap.get(packagePricing.package_id);
          if (!pkg) {
            findings.warnings.push({
              type: 'ORPHANED_PACKAGE_OVERRIDE',
              matrix_id: matrix.id,
              package_id: packagePricing.package_id,
              issue: `Price matrix has override for non-existent package ${packagePricing.package_id}`
            });
          } else if (pkg.name !== packagePricing.package_name) {
            findings.info.push({
              type: 'STALE_PACKAGE_NAME',
              matrix_id: matrix.id,
              package_id: packagePricing.package_id,
              issue: `Cached name '${packagePricing.package_name}' does not match actual '${pkg.name}'`
            });
          }

          if (packagePricing.tier_overrides) {
            for (const tier of TIERS_V3) {
              validatePackageTierBlock(matrix, packagePricing.package_id, tier, packagePricing.tier_overrides[tier]);
            }
          } else {
            findings.warnings.push({
              type: 'NEEDS_TIER_OVERRIDES_BACKFILL',
              matrix_id: matrix.id,
              package_id: packagePricing.package_id,
              issue: `Package override row missing tier_overrides — migration 361 backfill should have populated this`,
            });
            if (packagePricing.override_enabled) {
              if (typeof packagePricing.standard_price !== 'number' || packagePricing.standard_price < 0) {
                findings.warnings.push({
                  type: 'INVALID_OVERRIDE_PRICE',
                  matrix_id: matrix.id, package_id: packagePricing.package_id,
                  issue: `Invalid standard_price: ${packagePricing.standard_price}`,
                });
              }
              if (typeof packagePricing.premium_price !== 'number' || packagePricing.premium_price < 0) {
                findings.warnings.push({
                  type: 'INVALID_OVERRIDE_PRICE',
                  matrix_id: matrix.id, package_id: packagePricing.package_id,
                  issue: `Invalid premium_price: ${packagePricing.premium_price}`,
                });
              }
            }
          }
        }
      }
    }

    // TEST 5: Blanket discount validation
    for (const matrix of priceMatrices) {
      if (matrix.blanket_discount?.enabled) {
        const prodDiscount = matrix.blanket_discount.product_percent;
        const pkgDiscount = matrix.blanket_discount.package_percent;

        if (typeof prodDiscount !== 'number' || prodDiscount < 0 || prodDiscount > 100) {
          findings.warnings.push({
            type: 'INVALID_BLANKET_DISCOUNT',
            matrix_id: matrix.id,
            issue: `Invalid product discount percentage: ${prodDiscount}. Must be 0-100`
          });
        }

        if (typeof pkgDiscount !== 'number' || pkgDiscount < 0 || pkgDiscount > 100) {
          findings.warnings.push({
            type: 'INVALID_BLANKET_DISCOUNT',
            matrix_id: matrix.id,
            issue: `Invalid package discount percentage: ${pkgDiscount}. Must be 0-100`
          });
        }
      }
    }

    // TEST 6: Duplicate price matrix detection
    const matrixKeys = new Map();
    for (const matrix of priceMatrices) {
      const key = `${matrix.entity_type}:${matrix.entity_id}:${matrix.project_type_id || 'all'}`;
      if (matrixKeys.has(key)) {
        findings.critical.push({
          type: 'DUPLICATE_PRICE_MATRIX',
          matrix_id: matrix.id,
          issue: `Duplicate price matrix for ${matrix.entity_type} ${matrix.entity_id} (project type: ${matrix.project_type_id || 'all'})`
        });
      } else {
        matrixKeys.set(key, matrix.id);
      }
    }

    // TEST 7: Check for projects using stale pricing snapshots
    const projectsWithStaleSnapshots = projects.filter((p: any) => {
      if (!p.price_matrix_snapshot || typeof p.price_matrix_snapshot !== 'object') {
        return false;
      }
      return !p.price_matrix_snapshot.timestamp && p.created_date;
    });

    if (projectsWithStaleSnapshots.length > 0) {
      findings.info.push({
        type: 'PROJECTS_WITH_STALE_SNAPSHOTS',
        count: projectsWithStaleSnapshots.length,
        issue: `${projectsWithStaleSnapshots.length} projects have price matrix snapshots without timestamps`
      });
    }

    // TEST 8: Validate last_modified_by field format
    for (const matrix of priceMatrices) {
      if (matrix.last_modified_by && !matrix.last_modified_by.includes('@')) {
        findings.warnings.push({
          type: 'INVALID_MODIFIED_BY',
          matrix_id: matrix.id,
          issue: `last_modified_by is not an email: ${matrix.last_modified_by}`
        });
      }

      if (matrix.last_modified_at) {
        try {
          const date = new Date(matrix.last_modified_at);
          if (isNaN(date.getTime())) {
            findings.warnings.push({
              type: 'INVALID_TIMESTAMP',
              matrix_id: matrix.id,
              issue: `Invalid last_modified_at timestamp: ${matrix.last_modified_at}`
            });
          }
        } catch {
          findings.warnings.push({
            type: 'INVALID_TIMESTAMP',
            matrix_id: matrix.id,
            issue: `Failed to parse last_modified_at: ${matrix.last_modified_at}`
          });
        }
      }
    }

    return jsonResponse({
      success: true,
      summary: {
        total_findings: findings.critical.length + findings.warnings.length + findings.info.length,
        critical_count: findings.critical.length,
        warning_count: findings.warnings.length,
        info_count: findings.info.length,
        data_scanned: dataScanCount
      },
      findings
    });

  } catch (error: any) {
    return errorResponse(error.message);
  }
});
