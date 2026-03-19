import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Comprehensive stress test for Product page and ProductFormDialog
 * Tests 50+ edge cases, crash scenarios, and data integrity issues
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const results = [];
    const errors = [];

    // Test 1-5: Null safety on tier objects
    results.push({ test: 1, name: "Create product with null standard_tier", status: "running" });
    try {
      const p1 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NULL_STANDARD",
        standard_tier: null,
        premium_tier: { base_price: 100 }
      });
      await base44.asServiceRole.entities.Product.delete(p1.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 1, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 2, name: "Create product with null premium_tier", status: "running" });
    try {
      const p2 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NULL_PREMIUM",
        standard_tier: { base_price: 50 },
        premium_tier: null
      });
      await base44.asServiceRole.entities.Product.delete(p2.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 2, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 3, name: "Create product with missing tier properties", status: "running" });
    try {
      const p3 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_INCOMPLETE_TIER",
        standard_tier: { base_price: 50 },
        premium_tier: {}
      });
      await base44.asServiceRole.entities.Product.delete(p3.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 3, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 4-8: Task template edge cases
    results.push({ test: 4, name: "Product with empty task templates array", status: "running" });
    try {
      const p4 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_EMPTY_TASKS",
        standard_task_templates: [],
        premium_task_templates: []
      });
      await base44.asServiceRole.entities.Product.delete(p4.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 4, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 5, name: "Task with circular dependency", status: "running" });
    try {
      const p5 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_CIRCULAR_DEP",
        standard_task_templates: [
          { title: "Task 1", depends_on_indices: [1] },
          { title: "Task 2", depends_on_indices: [0] }
        ]
      });
      await base44.asServiceRole.entities.Product.delete(p5.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 5, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 6, name: "Task with self-reference dependency", status: "running" });
    try {
      const p6 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_SELF_REF",
        standard_task_templates: [
          { title: "Task 1", depends_on_indices: [0] }
        ]
      });
      await base44.asServiceRole.entities.Product.delete(p6.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 6, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 7-12: Pricing edge cases
    results.push({ test: 7, name: "Per-unit product with 0 unit_price", status: "running" });
    try {
      const p7 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_ZERO_UNIT",
        pricing_type: "per_unit",
        standard_tier: { unit_price: 0, base_price: 50 },
        premium_tier: { unit_price: 0, base_price: 75 }
      });
      await base44.asServiceRole.entities.Product.delete(p7.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 7, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 8, name: "Negative pricing values", status: "running" });
    try {
      const p8 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NEGATIVE",
        standard_tier: { base_price: -50 },
        premium_tier: { base_price: -75 }
      });
      await base44.asServiceRole.entities.Product.delete(p8.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 8, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 9, name: "Extremely large pricing values", status: "running" });
    try {
      const p9 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_LARGE_PRICE",
        standard_tier: { base_price: 999999999 },
        premium_tier: { base_price: 999999999 }
      });
      await base44.asServiceRole.entities.Product.delete(p9.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 9, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 10-15: Quantity constraints
    results.push({ test: 10, name: "Min quantity = 0", status: "running" });
    try {
      const p10 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_MIN_ZERO",
        min_quantity: 0
      });
      await base44.asServiceRole.entities.Product.delete(p10.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 10, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 11, name: "Max quantity < min quantity", status: "running" });
    try {
      const p11 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_MAX_LT_MIN",
        min_quantity: 10,
        max_quantity: 5
      });
      await base44.asServiceRole.entities.Product.delete(p11.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 11, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 12, name: "Negative min quantity", status: "running" });
    try {
      const p12 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NEG_MIN",
        min_quantity: -5
      });
      await base44.asServiceRole.entities.Product.delete(p12.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 12, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 13-18: String/type coercion issues
    results.push({ test: 13, name: "Pricing type as number", status: "running" });
    try {
      const p13 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_PRICE_TYPE_NUM",
        pricing_type: 123
      });
      await base44.asServiceRole.entities.Product.delete(p13.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 13, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 14, name: "Empty string name", status: "running" });
    try {
      const p14 = await base44.asServiceRole.entities.Product.create({
        name: "",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p14.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 14, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 15, name: "Whitespace-only name", status: "running" });
    try {
      const p15 = await base44.asServiceRole.entities.Product.create({
        name: "   ",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p15.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 15, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 16-20: Invalid category/project_type_ids
    results.push({ test: 16, name: "Invalid category", status: "running" });
    try {
      const p16 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_INVALID_CAT",
        category: "nonexistent_category_xyz"
      });
      await base44.asServiceRole.entities.Product.delete(p16.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 16, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 17, name: "Empty project_type_ids array", status: "running" });
    try {
      const p17 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_EMPTY_TYPES",
        project_type_ids: []
      });
      await base44.asServiceRole.entities.Product.delete(p17.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 17, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 18, name: "project_type_ids with invalid IDs", status: "running" });
    try {
      const p18 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_INVALID_TYPE_IDS",
        project_type_ids: ["invalid-uuid-123", "another-bad-id"]
      });
      await base44.asServiceRole.entities.Product.delete(p18.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 18, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 19-24: Task template deadline edge cases
    results.push({ test: 19, name: "Task with deadline_preset but no timer_trigger", status: "running" });
    try {
      const p19 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_PRESET_NO_TRIGGER",
        standard_task_templates: [{
          title: "Task",
          timer_trigger: "none",
          deadline_preset: "tonight"
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p19.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 19, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 20, name: "Task with negative deadline_hours", status: "running" });
    try {
      const p20 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NEG_HOURS",
        standard_task_templates: [{
          title: "Task",
          timer_trigger: "project_onsite",
          deadline_hours_after_trigger: -24
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p20.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 20, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 21, name: "Task with invalid timer_trigger value", status: "running" });
    try {
      const p21 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_INVALID_TRIGGER",
        standard_task_templates: [{
          title: "Task",
          timer_trigger: "invalid_trigger_xyz"
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p21.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 21, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 22-27: Task dependency stress tests
    results.push({ test: 22, name: "Task with out-of-bounds dependency index", status: "running" });
    try {
      const p22 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_OOB_DEP",
        standard_task_templates: [
          { title: "Task 1", depends_on_indices: [99] }
        ]
      });
      await base44.asServiceRole.entities.Product.delete(p22.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 22, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 23, name: "Task with negative dependency index", status: "running" });
    try {
      const p23 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NEG_DEP",
        standard_task_templates: [
          { title: "Task 1" },
          { title: "Task 2", depends_on_indices: [-1] }
        ]
      });
      await base44.asServiceRole.entities.Product.delete(p23.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 23, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 24, name: "Task with duplicate dependencies", status: "running" });
    try {
      const p24 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_DUP_DEP",
        standard_task_templates: [
          { title: "Task 1" },
          { title: "Task 2", depends_on_indices: [0, 0, 0] }
        ]
      });
      await base44.asServiceRole.entities.Product.delete(p24.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 24, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 25-30: Invalid role assignments
    results.push({ test: 25, name: "Task with invalid auto_assign_role", status: "running" });
    try {
      const p25 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_INVALID_ROLE",
        standard_task_templates: [{
          title: "Task",
          auto_assign_role: "invalid_role_xyz"
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p25.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 25, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 26, name: "Task with null auto_assign_role", status: "running" });
    try {
      const p26 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_NULL_ROLE",
        standard_task_templates: [{
          title: "Task",
          auto_assign_role: null
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p26.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 26, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 27-32: Very long strings
    results.push({ test: 27, name: "Product name 1000 chars", status: "running" });
    try {
      const p27 = await base44.asServiceRole.entities.Product.create({
        name: "A".repeat(1000),
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p27.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 27, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 28, name: "Task description 10000 chars", status: "running" });
    try {
      const p28 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_LONG_DESC",
        standard_task_templates: [{
          title: "Task",
          description: "B".repeat(10000)
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p28.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 28, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 29-35: Special characters and XSS
    results.push({ test: 29, name: "Name with HTML tags", status: "running" });
    try {
      const p29 = await base44.asServiceRole.entities.Product.create({
        name: "<script>alert('xss')</script>Product",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p29.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 29, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 30, name: "Name with emoji", status: "running" });
    try {
      const p30 = await base44.asServiceRole.entities.Product.create({
        name: "🎥 Video Package 📸",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p30.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 30, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 31-36: Array operations
    results.push({ test: 31, name: "100 task templates in standard tier", status: "running" });
    try {
      const tasks = Array.from({ length: 100 }, (_, i) => ({ title: `Task ${i + 1}` }));
      const p31 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_100_TASKS",
        standard_task_templates: tasks
      });
      await base44.asServiceRole.entities.Product.delete(p31.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 31, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 32, name: "Task with 50 dependencies", status: "running" });
    try {
      const tasks = Array.from({ length: 51 }, (_, i) => ({
        title: `Task ${i + 1}`,
        depends_on_indices: i === 50 ? Array.from({ length: 50 }, (_, j) => j) : []
      }));
      const p32 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_50_DEPS",
        standard_task_templates: tasks
      });
      await base44.asServiceRole.entities.Product.delete(p32.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 32, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 33-38: Boolean coercion
    results.push({ test: 33, name: "is_active as string 'true'", status: "running" });
    try {
      const p33 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_ACTIVE_STRING",
        is_active: "true"
      });
      await base44.asServiceRole.entities.Product.delete(p33.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 33, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 34, name: "dusk_only as number 1", status: "running" });
    try {
      const p34 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_DUSK_NUM",
        dusk_only: 1
      });
      await base44.asServiceRole.entities.Product.delete(p34.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 34, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 35-40: Unicode and internationalization
    results.push({ test: 35, name: "Product name in Chinese", status: "running" });
    try {
      const p35 = await base44.asServiceRole.entities.Product.create({
        name: "摄影服务包",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p35.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 35, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 36, name: "Product name in Arabic (RTL)", status: "running" });
    try {
      const p36 = await base44.asServiceRole.entities.Product.create({
        name: "خدمة التصوير",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.delete(p36.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 36, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 37-42: Decimal precision
    results.push({ test: 37, name: "Price with 10 decimal places", status: "running" });
    try {
      const p37 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_PRECISION",
        standard_tier: { base_price: 123.4567890123 }
      });
      await base44.asServiceRole.entities.Product.delete(p37.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 37, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 38, name: "Scientific notation pricing", status: "running" });
    try {
      const p38 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_SCIENTIFIC",
        standard_tier: { base_price: 1.23e+5 }
      });
      await base44.asServiceRole.entities.Product.delete(p38.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 38, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 39-44: Mixed tier configurations
    results.push({ test: 39, name: "Standard complete, Premium empty", status: "running" });
    try {
      const p39 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_MIXED_TIERS",
        standard_tier: { base_price: 100, unit_price: 10, onsite_time: 30 },
        premium_tier: {}
      });
      await base44.asServiceRole.entities.Product.delete(p39.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 39, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 40, name: "Only standard_task_templates, no premium", status: "running" });
    try {
      const p40 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_ONLY_STD_TASKS",
        standard_task_templates: [{ title: "Task 1" }],
        premium_task_templates: []
      });
      await base44.asServiceRole.entities.Product.delete(p40.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 40, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 41-46: Update operations
    results.push({ test: 41, name: "Update product to have null tiers", status: "running" });
    try {
      const p41 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_UPDATE_NULL",
        standard_tier: { base_price: 50 }
      });
      await base44.asServiceRole.entities.Product.update(p41.id, {
        standard_tier: null,
        premium_tier: null
      });
      await base44.asServiceRole.entities.Product.delete(p41.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 41, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 42, name: "Update to invalid category mid-lifecycle", status: "running" });
    try {
      const p42 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_UPDATE_CAT",
        category: "photography"
      });
      await base44.asServiceRole.entities.Product.update(p42.id, {
        category: "invalid_xyz"
      });
      await base44.asServiceRole.entities.Product.delete(p42.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 42, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 43-48: Delete operations and orphan handling
    results.push({ test: 43, name: "Delete product with invalid ID", status: "running" });
    try {
      await base44.asServiceRole.entities.Product.delete("invalid-id-xyz");
      results[results.length - 1].status = "fail"; // Should have thrown
      errors.push({ test: 43, error: "Delete should have failed but didn't" });
    } catch (e) {
      results[results.length - 1].status = "pass";
    }

    results.push({ test: 44, name: "Delete already-deleted product", status: "running" });
    try {
      const p44 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_DOUBLE_DELETE"
      });
      await base44.asServiceRole.entities.Product.delete(p44.id);
      await base44.asServiceRole.entities.Product.delete(p44.id);
      results[results.length - 1].status = "fail"; // Should have thrown
      errors.push({ test: 44, error: "Double delete should have failed" });
    } catch (e) {
      results[results.length - 1].status = "pass";
    }

    // Test 45-50: Concurrency and race conditions
    results.push({ test: 45, name: "Create 10 products simultaneously", status: "running" });
    try {
      const promises = Array.from({ length: 10 }, (_, i) =>
        base44.asServiceRole.entities.Product.create({
          name: `TEST_CONCURRENT_${i}`,
          standard_tier: { base_price: i * 10 }
        })
      );
      const created = await Promise.all(promises);
      await Promise.all(created.map(p => base44.asServiceRole.entities.Product.delete(p.id)));
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 45, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 46, name: "Update same product 5 times rapidly", status: "running" });
    try {
      const p46 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_RAPID_UPDATE"
      });
      await Promise.all(Array.from({ length: 5 }, (_, i) =>
        base44.asServiceRole.entities.Product.update(p46.id, { name: `Updated ${i}` })
      ));
      await base44.asServiceRole.entities.Product.delete(p46.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 46, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 47-52: Missing required imports/constants
    results.push({ test: 47, name: "Task with undefined TASK_TYPE_LABELS value", status: "running" });
    try {
      const p47 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_UNDEF_TYPE",
        standard_task_templates: [{
          title: "Task",
          task_type: "undefined_type"
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p47.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 47, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 48, name: "Task with undefined ROLE_LABELS value", status: "running" });
    try {
      const p48 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_UNDEF_ROLE",
        standard_task_templates: [{
          title: "Task",
          auto_assign_role: "undefined_role"
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p48.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 48, error: e.message });
      results[results.length - 1].status = "fail";
    }

    // Test 49-55: Null/undefined prop drilling
    results.push({ test: 49, name: "Product with all optional fields null", status: "running" });
    try {
      const p49 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_ALL_NULL",
        description: null,
        notes: null,
        max_quantity: null,
        project_type_ids: null,
        standard_task_templates: null,
        premium_task_templates: null
      });
      await base44.asServiceRole.entities.Product.delete(p49.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 49, error: e.message });
      results[results.length - 1].status = "fail";
    }

    results.push({ test: 50, name: "Task with all optional fields undefined", status: "running" });
    try {
      const p50 = await base44.asServiceRole.entities.Product.create({
        name: "TEST_UNDEF_FIELDS",
        standard_task_templates: [{
          title: "Task",
          description: undefined,
          estimated_minutes: undefined,
          depends_on_indices: undefined
        }]
      });
      await base44.asServiceRole.entities.Product.delete(p50.id);
      results[results.length - 1].status = "pass";
    } catch (e) {
      errors.push({ test: 50, error: e.message });
      results[results.length - 1].status = "fail";
    }

    const passCount = results.filter(r => r.status === "pass").length;
    const failCount = results.filter(r => r.status === "fail").length;

    return Response.json({
      summary: {
        total: results.length,
        passed: passCount,
        failed: failCount,
        success_rate: `${((passCount / results.length) * 100).toFixed(1)}%`
      },
      results,
      errors,
      recommendations: [
        "All tier objects should have default values initialized",
        "All array operations should check for null/undefined",
        "All numeric inputs should validate parseFloat/parseInt results",
        "All task dependency operations should validate indices",
        "All project_type_ids operations should check array length before accessing [0]",
        "Loading states should be shown while fetching projectTypes/productCategories",
        "Form reset should happen in useEffect with proper dependencies"
      ]
    });

  } catch (error) {
    return Response.json({ 
      error: error.message,
      stack: error.stack 
    }, { status: 500 });
  }
});