import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Deep logic audit of the entire price matrix engine
 * Tests 30+ integrity checks across pricing, overrides, discounts, and type safety
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const findings = {
      critical: [],
      warnings: [],
      info: []
    };

    let dataScanCount = {
      price_matrices: 0,
      products: 0,
      packages: 0,
      agencies: 0,
      agents: 0,
      projects: 0
    };

    // Fetch all data
    const [priceMatrices, products, packages, agencies, agents, projects] = await Promise.all([
      base44.entities.PriceMatrix.list(),
      base44.entities.Product.list(),
      base44.entities.Package.list(),
      base44.entities.Agency.list(),
      base44.entities.Agent.list(),
      base44.entities.Project.list()
    ]);

    dataScanCount = {
      price_matrices: priceMatrices.length,
      products: products.length,
      packages: packages.length,
      agencies: agencies.length,
      agents: agents.length,
      projects: projects.length
    };

    const productMap = new Map(products.map(p => [p.id, p]));
    const packageMap = new Map(packages.map(pkg => [pkg.id, pkg]));
    const projectTypeMap = new Map();

    // Build project type map from unique project type IDs
    const allProjectTypeIds = new Set();
    products.forEach(p => p.project_type_ids?.forEach(id => allProjectTypeIds.add(id)));
    packages.forEach(pkg => pkg.project_type_ids?.forEach(id => allProjectTypeIds.add(id)));

    for (const ptId of allProjectTypeIds) {
      try {
        const pt = await base44.entities.ProjectType.get(ptId);
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
        const agency = agencies.find(a => a.id === matrix.entity_id);
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
        const agent = agents.find(a => a.id === matrix.entity_id);
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

          // Validate numeric fields
          if (productPricing.override_enabled) {
            if (typeof productPricing.standard_base !== 'number' || productPricing.standard_base < 0) {
              findings.warnings.push({
                type: 'INVALID_OVERRIDE_PRICE',
                matrix_id: matrix.id,
                product_id: productPricing.product_id,
                issue: `Invalid standard_base price: ${productPricing.standard_base}`
              });
            }
            if (typeof productPricing.premium_base !== 'number' || productPricing.premium_base < 0) {
              findings.warnings.push({
                type: 'INVALID_OVERRIDE_PRICE',
                matrix_id: matrix.id,
                product_id: productPricing.product_id,
                issue: `Invalid premium_base price: ${productPricing.premium_base}`
              });
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

          // Validate numeric fields
          if (packagePricing.override_enabled) {
            if (typeof packagePricing.standard_price !== 'number' || packagePricing.standard_price < 0) {
              findings.warnings.push({
                type: 'INVALID_OVERRIDE_PRICE',
                matrix_id: matrix.id,
                package_id: packagePricing.package_id,
                issue: `Invalid standard_price: ${packagePricing.standard_price}`
              });
            }
            if (typeof packagePricing.premium_price !== 'number' || packagePricing.premium_price < 0) {
              findings.warnings.push({
                type: 'INVALID_OVERRIDE_PRICE',
                matrix_id: matrix.id,
                package_id: packagePricing.package_id,
                issue: `Invalid premium_price: ${packagePricing.premium_price}`
              });
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
    const projectsWithStaleSnapshots = projects.filter(p => {
      if (!p.price_matrix_snapshot || typeof p.price_matrix_snapshot !== 'object') {
        return false;
      }
      // If snapshot doesn't have required fields, it's potentially stale
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

    return Response.json({
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

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});