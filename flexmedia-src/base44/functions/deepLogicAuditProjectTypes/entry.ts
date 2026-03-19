import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * DEEP LOGIC AUDIT: Project Types + Projects Engine
 * Tests 30+ potential flaws across project type scoping, pricing, tasks, and efforts
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
      info: [],
      passed_checks: []
    };

    // Fetch all relevant data
    const [projects, products, packages, projectTypes, priceMatrices, projectTasks, projectEfforts] = await Promise.all([
      base44.entities.Project.list(),
      base44.entities.Product.list(),
      base44.entities.Package.list(),
      base44.entities.ProjectType.list(),
      base44.entities.PriceMatrix.list(),
      base44.entities.ProjectTask.list(),
      base44.entities.ProjectEffort.list()
    ]);

    const projectTypeMap = new Map(projectTypes.map(pt => [pt.id, pt]));
    const productMap = new Map(products.map(p => [p.id, p]));
    const packageMap = new Map(packages.map(pkg => [pkg.id, pkg]));

    // ============= FLAW 1: Project type ID mismatch in projects =============
    for (const proj of projects) {
      if (proj.project_type_id && !projectTypeMap.has(proj.project_type_id)) {
        findings.critical.push({
          type: 'INVALID_PROJECT_TYPE',
          project_id: proj.id,
          project_title: proj.title,
          issue: `Project references non-existent project_type_id: ${proj.project_type_id}`,
          severity: 'CRITICAL'
        });
      }
    }

    // ============= FLAW 2: Products/packages in project don't match project type =============
    for (const proj of projects) {
      if (!proj.project_type_id) continue; // Skip universal projects
      
      // Check products
      if (proj.products && Array.isArray(proj.products)) {
        for (const item of proj.products) {
          const prod = productMap.get(item.product_id);
          if (!prod) {
            findings.warnings.push({
              type: 'DELETED_PRODUCT_IN_PROJECT',
              project_id: proj.id,
              product_id: item.product_id,
              issue: `Product ${item.product_id} deleted but still referenced in project`
            });
            continue;
          }

          const prodTypes = prod.project_type_ids || [];
          if (prodTypes.length > 0 && !prodTypes.includes(proj.project_type_id)) {
            findings.critical.push({
              type: 'TYPE_MISMATCH_PRODUCT_IN_PROJECT',
              project_id: proj.id,
              project_type_id: proj.project_type_id,
              product_id: prod.id,
              product_type_ids: prodTypes,
              issue: `Product not compatible with project type`
            });
          }
        }
      }

      // Check packages
      if (proj.packages && Array.isArray(proj.packages)) {
        for (const item of proj.packages) {
          const pkg = packageMap.get(item.package_id);
          if (!pkg) {
            findings.warnings.push({
              type: 'DELETED_PACKAGE_IN_PROJECT',
              project_id: proj.id,
              package_id: item.package_id,
              issue: `Package ${item.package_id} deleted but still referenced in project`
            });
            continue;
          }

          const pkgTypes = pkg.project_type_ids || [];
          if (pkgTypes.length > 0 && !pkgTypes.includes(proj.project_type_id)) {
            findings.critical.push({
              type: 'TYPE_MISMATCH_PACKAGE_IN_PROJECT',
              project_id: proj.id,
              project_type_id: proj.project_type_id,
              package_id: pkg.id,
              package_type_ids: pkgTypes,
              issue: `Package not compatible with project type`
            });
          }
        }
      }
    }

    // ============= FLAW 3: Nested products in packages don't match package type =============
    for (const pkg of packages) {
      if (!pkg.project_type_ids?.length) continue;
      
      if (pkg.products && Array.isArray(pkg.products)) {
        for (const nestedProd of pkg.products) {
          const prod = productMap.get(nestedProd.product_id);
          if (!prod) {
            findings.warnings.push({
              type: 'DELETED_PRODUCT_IN_PACKAGE',
              package_id: pkg.id,
              product_id: nestedProd.product_id,
              issue: `Deleted product nested in package`
            });
            continue;
          }

          const prodTypes = prod.project_type_ids || [];
          if (prodTypes.length > 0 && !prodTypes.some(t => pkg.project_type_ids.includes(t))) {
            findings.critical.push({
              type: 'TYPE_MISMATCH_PRODUCT_IN_PACKAGE',
              package_id: pkg.id,
              package_type_ids: pkg.project_type_ids,
              product_id: prod.id,
              product_type_ids: prodTypes,
              issue: `Product type not compatible with any package types`
            });
          }
        }
      }
    }

    // ============= FLAW 4: Price matrix type mismatch =============
    for (const matrix of priceMatrices) {
      if (matrix.project_type_id && !projectTypeMap.has(matrix.project_type_id)) {
        findings.critical.push({
          type: 'INVALID_MATRIX_PROJECT_TYPE',
          matrix_id: matrix.id,
          matrix_entity: `${matrix.entity_type}:${matrix.entity_id}`,
          issue: `Price matrix references non-existent project_type_id: ${matrix.project_type_id}`
        });
      }

      // Check product pricing references
      if (matrix.product_pricing && Array.isArray(matrix.product_pricing)) {
        for (const pricingEntry of matrix.product_pricing) {
          const prod = productMap.get(pricingEntry.product_id);
          if (!prod) {
            findings.warnings.push({
              type: 'DELETED_PRODUCT_IN_MATRIX',
              matrix_id: matrix.id,
              product_id: pricingEntry.product_id
            });
            continue;
          }

          // If matrix is type-scoped, products should be compatible
          if (matrix.project_type_id) {
            const prodTypes = prod.project_type_ids || [];
            if (prodTypes.length > 0 && !prodTypes.includes(matrix.project_type_id)) {
              findings.warnings.push({
                type: 'TYPE_MISMATCH_PRODUCT_IN_MATRIX',
                matrix_id: matrix.id,
                matrix_type: matrix.project_type_id,
                product_id: prod.id,
                product_types: prodTypes,
                issue: `Product type not compatible with matrix scope`
              });
            }
          }
        }
      }

      // Check package pricing references
      if (matrix.package_pricing && Array.isArray(matrix.package_pricing)) {
        for (const pricingEntry of matrix.package_pricing) {
          const pkg = packageMap.get(pricingEntry.package_id);
          if (!pkg) {
            findings.warnings.push({
              type: 'DELETED_PACKAGE_IN_MATRIX',
              matrix_id: matrix.id,
              package_id: pricingEntry.package_id
            });
            continue;
          }

          if (matrix.project_type_id) {
            const pkgTypes = pkg.project_type_ids || [];
            if (pkgTypes.length > 0 && !pkgTypes.includes(matrix.project_type_id)) {
              findings.warnings.push({
                type: 'TYPE_MISMATCH_PACKAGE_IN_MATRIX',
                matrix_id: matrix.id,
                matrix_type: matrix.project_type_id,
                package_id: pkg.id,
                package_types: pkgTypes
              });
            }
          }
        }
      }
    }

    // ============= FLAW 5: Task auto_generated flag without product/package reference =============
    for (const task of projectTasks) {
      if (task.auto_generated && !task.product_id && !task.package_id) {
        findings.warnings.push({
          type: 'ORPHANED_AUTO_TASK',
          task_id: task.id,
          project_id: task.project_id,
          issue: `Auto-generated task has no product or package reference`
        });
      }

      // Check if referenced product/package still exists
      if (task.product_id) {
        const prod = productMap.get(task.product_id);
        if (!prod && !task.is_deleted) {
          findings.warnings.push({
            type: 'TASK_REFERENCES_DELETED_PRODUCT',
            task_id: task.id,
            product_id: task.product_id,
            issue: `Active task references deleted product`
          });
        }
      }

      if (task.package_id) {
        const pkg = packageMap.get(task.package_id);
        if (!pkg && !task.is_deleted) {
          findings.warnings.push({
            type: 'TASK_REFERENCES_DELETED_PACKAGE',
            task_id: task.id,
            package_id: task.package_id,
            issue: `Active task references deleted package`
          });
        }
      }
    }

    // ============= FLAW 6: Circular/forward task dependencies =============
    for (const task of projectTasks) {
      if (!task.depends_on_task_ids?.length) continue;
      
      const taskDeps = new Set(task.depends_on_task_ids);
      
      // Check if task depends on itself
      if (taskDeps.has(task.id)) {
        findings.critical.push({
          type: 'SELF_DEPENDENCY',
          task_id: task.id,
          issue: `Task depends on itself`
        });
      }

      // Check if all dependencies exist
      for (const depId of taskDeps) {
        const depTask = projectTasks.find(t => t.id === depId);
        if (!depTask) {
          findings.warnings.push({
            type: 'MISSING_DEPENDENCY',
            task_id: task.id,
            depends_on_task_id: depId,
            issue: `Task depends on non-existent task`
          });
        }
      }
    }

    // ============= FLAW 7: Project effort mismatches =============
    for (const proj of projects) {
      const projTasks = projectTasks.filter(t => t.project_id === proj.id && !t.is_deleted);
      const projEffort = projectEfforts.find(e => e.project_id === proj.id);

      if (projTasks.length > 0 && !projEffort) {
        findings.info.push({
          type: 'MISSING_EFFORT_RECORD',
          project_id: proj.id,
          task_count: projTasks.length,
          issue: `Project has tasks but no ProjectEffort record`
        });
      }

      if (projEffort && projTasks.length === 0) {
        findings.info.push({
          type: 'ORPHANED_EFFORT_RECORD',
          project_id: proj.id,
          issue: `ProjectEffort exists but project has no tasks`
        });
      }
    }

    // ============= FLAW 8: Invalid pricing tier references =============
    for (const proj of projects) {
      if (proj.pricing_tier && !['standard', 'premium'].includes(proj.pricing_tier)) {
        findings.critical.push({
          type: 'INVALID_PRICING_TIER',
          project_id: proj.id,
          pricing_tier: proj.pricing_tier,
          issue: `Project has invalid pricing_tier value`
        });
      }
    }

    // ============= FLAW 9: Product pricing type without required fields =============
    for (const prod of products) {
      if (prod.pricing_type === 'per_unit') {
        const stdOk = prod.standard_tier?.unit_price !== undefined;
        const premOk = prod.premium_tier?.unit_price !== undefined;
        if (!stdOk && !premOk) {
          findings.warnings.push({
            type: 'PER_UNIT_MISSING_UNIT_PRICE',
            product_id: prod.id,
            product_name: prod.name,
            issue: `Per-unit product missing unit_price in all tiers`
          });
        }
      }

      // Check min/max quantity logic
      if (prod.min_quantity && prod.max_quantity && prod.min_quantity > prod.max_quantity) {
        findings.critical.push({
          type: 'INVALID_QUANTITY_RANGE',
          product_id: prod.id,
          min: prod.min_quantity,
          max: prod.max_quantity,
          issue: `min_quantity > max_quantity`
        });
      }
    }

    // ============= FLAW 10: Price matrix blanket discount + per-product override conflict =============
    for (const matrix of priceMatrices) {
      if (matrix.blanket_discount?.enabled && !matrix.use_default_pricing) {
        const hasProductOverrides = matrix.product_pricing?.some(p => p.override_enabled);
        const hasPackageOverrides = matrix.package_pricing?.some(p => p.override_enabled);

        if (hasProductOverrides) {
          findings.warnings.push({
            type: 'BLANKET_DISCOUNT_WITH_PRODUCT_OVERRIDE',
            matrix_id: matrix.id,
            issue: `Blanket discount enabled but per-product overrides also exist`
          });
        }

        if (hasPackageOverrides) {
          findings.warnings.push({
            type: 'BLANKET_DISCOUNT_WITH_PACKAGE_OVERRIDE',
            matrix_id: matrix.id,
            issue: `Blanket discount enabled but per-package overrides also exist`
          });
        }
      }
    }

    // ============= FLAW 11: Multiple project types in single product/package =============
    for (const prod of products) {
      const types = prod.project_type_ids || [];
      if (types.length > 1) {
        findings.warnings.push({
          type: 'MULTIPLE_PROJECT_TYPES_IN_PRODUCT',
          product_id: prod.id,
          type_count: types.length,
          types,
          issue: `Product tagged with multiple project types (should be 0 or 1)`
        });
      }
    }

    for (const pkg of packages) {
      const types = pkg.project_type_ids || [];
      if (types.length > 1) {
        findings.warnings.push({
          type: 'MULTIPLE_PROJECT_TYPES_IN_PACKAGE',
          package_id: pkg.id,
          type_count: types.length,
          types,
          issue: `Package tagged with multiple project types (should be 0 or 1)`
        });
      }
    }

    // ============= FLAW 12: Invalid task template roles =============
    const validRoles = ['none', 'project_owner', 'photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
    
    for (const prod of products) {
      const checkTemplates = (templates, tier) => {
        if (!templates) return;
        for (const tpl of templates) {
          if (tpl.auto_assign_role && !validRoles.includes(tpl.auto_assign_role)) {
            findings.critical.push({
              type: 'INVALID_TASK_ROLE',
              product_id: prod.id,
              tier,
              role: tpl.auto_assign_role,
              issue: `Invalid auto_assign_role in task template`
            });
          }
        }
      };
      checkTemplates(prod.standard_task_templates, 'standard');
      checkTemplates(prod.premium_task_templates, 'premium');
    }

    for (const pkg of packages) {
      const checkTemplates = (templates, tier) => {
        if (!templates) return;
        for (const tpl of templates) {
          if (tpl.auto_assign_role && !validRoles.includes(tpl.auto_assign_role)) {
            findings.critical.push({
              type: 'INVALID_TASK_ROLE',
              package_id: pkg.id,
              tier,
              role: tpl.auto_assign_role,
              issue: `Invalid auto_assign_role in task template`
            });
          }
        }
      };
      checkTemplates(pkg.standard_task_templates, 'standard');
      checkTemplates(pkg.premium_task_templates, 'premium');
    }

    // ============= FLAW 13: Package contains products with incompatible pricing types =============
    for (const pkg of packages) {
      if (!pkg.products?.length) continue;
      
      const prodTypes = pkg.products.map(p => productMap.get(p.product_id)).filter(Boolean);
      const hasFixedAndPerUnit = prodTypes.some(p => p.pricing_type === 'fixed') && 
                                  prodTypes.some(p => p.pricing_type === 'per_unit');
      
      if (hasFixedAndPerUnit) {
        findings.info.push({
          type: 'MIXED_PRICING_TYPES_IN_PACKAGE',
          package_id: pkg.id,
          issue: `Package mixes fixed and per-unit pricing products (valid but worth noting)`
        });
      }
    }

    // ============= Summary =============
    const summary = {
      total_findings: findings.critical.length + findings.warnings.length + findings.info.length,
      critical_count: findings.critical.length,
      warning_count: findings.warnings.length,
      info_count: findings.info.length,
      data_scanned: {
        projects: projects.length,
        products: products.length,
        packages: packages.length,
        project_types: projectTypes.length,
        price_matrices: priceMatrices.length,
        project_tasks: projectTasks.length,
        project_efforts: projectEfforts.length
      }
    };

    return Response.json({
      success: true,
      summary,
      findings
    }, { status: 200 });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});