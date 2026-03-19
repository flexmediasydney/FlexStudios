import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const results = [];

    // Scenario 1: Simple task, no deadline
    const s1 = await testScenario(base44, 1, {
      standard: [{ title: "Basic Task", description: "", auto_assign_role: "none", timer_trigger: "none", deadline_type: "custom", deadline_hours_after_trigger: 0 }]
    });
    results.push(s1);

    // Scenario 2: Task with custom 24-hour deadline + project_onsite trigger
    const s2 = await testScenario(base44, 2, {
      standard: [{ title: "Edit Photos", description: "Basic editing", auto_assign_role: "image_editor", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 }]
    });
    results.push(s2);

    // Scenario 3: Task with preset deadline (tonight)
    const s3 = await testScenario(base44, 3, {
      standard: [{ title: "QA Check", description: "", auto_assign_role: "none", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tonight", deadline_hours_after_trigger: 0 }]
    });
    results.push(s3);

    // Scenario 4: Multiple tasks, mixed custom & preset
    const s4 = await testScenario(base44, 4, {
      standard: [
        { title: "Task 1", description: "", auto_assign_role: "photographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 12 },
        { title: "Task 2", description: "", auto_assign_role: "image_editor", timer_trigger: "project_submitted", deadline_type: "preset", deadline_preset: "tomorrow_night", deadline_hours_after_trigger: 0 },
        { title: "Task 3", description: "", auto_assign_role: "video_editor", timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 48 }
      ]
    });
    results.push(s4);

    // Scenario 5: Task with all preset options tested
    const presets = ["tonight", "tomorrow_night", "tomorrow_am", "tomorrow_business_am", "in_2_nights", "in_3_nights", "in_4_nights", "next_business_night", "2_business_nights", "3_business_nights"];
    const s5 = await testScenario(base44, 5, {
      premium: presets.map((preset, idx) => ({ 
        title: `Preset ${preset}`, 
        description: "", 
        auto_assign_role: "none", 
        timer_trigger: "project_uploaded", 
        deadline_type: "preset", 
        deadline_preset: preset,
        deadline_hours_after_trigger: 0
      }))
    });
    results.push(s5);

    // Scenario 6: All timer triggers tested
    const s6 = await testScenario(base44, 6, {
      standard: [
        { title: "Onsite trigger", description: "", auto_assign_role: "photographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Uploaded trigger", description: "", auto_assign_role: "image_editor", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 36 },
        { title: "Submitted trigger", description: "", auto_assign_role: "videographer", timer_trigger: "project_submitted", deadline_type: "custom", deadline_hours_after_trigger: 48 },
        { title: "Dependencies trigger", description: "", auto_assign_role: "video_editor", timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 12 }
      ]
    });
    results.push(s6);

    // Scenario 7: Tasks with dependencies
    const s7 = await testScenario(base44, 7, {
      standard: [
        { title: "Step 1", description: "", auto_assign_role: "none", depends_on_indices: [], timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Step 2", description: "", auto_assign_role: "none", depends_on_indices: [0], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 12 },
        { title: "Step 3", description: "", auto_assign_role: "none", depends_on_indices: [0, 1], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 8 }
      ]
    });
    results.push(s7);

    // Scenario 8: All auto_assign roles
    const roles = ["none", "project_owner", "photographer", "videographer", "image_editor", "video_editor"];
    const s8 = await testScenario(base44, 8, {
      premium: roles.map((role, idx) => ({ 
        title: `Auto-assign ${role}`, 
        description: "", 
        auto_assign_role: role, 
        timer_trigger: "project_onsite", 
        deadline_type: "custom", 
        deadline_hours_after_trigger: 24
      }))
    });
    results.push(s8);

    // Scenario 9: Both standard and premium tiers with different configs
    const s9 = await testScenario(base44, 9, {
      standard: [
        { title: "STD Task 1", description: "Standard tier task", auto_assign_role: "photographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "STD Task 2", description: "", auto_assign_role: "image_editor", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tomorrow_night", deadline_hours_after_trigger: 0 }
      ],
      premium: [
        { title: "PRE Task 1", description: "Premium tier task", auto_assign_role: "videographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 48 },
        { title: "PRE Task 2", description: "", auto_assign_role: "video_editor", timer_trigger: "project_submitted", deadline_type: "preset", deadline_preset: "in_3_nights", deadline_hours_after_trigger: 0 }
      ]
    });
    results.push(s9);

    // Scenario 10: Custom hours with various values (0, 0.5, 1, 12, 24, 72, 168)
    const s10 = await testScenario(base44, 10, {
      standard: [0, 0.5, 1, 12, 24, 72, 168].map(hours => ({
        title: `${hours}h deadline`,
        description: "",
        auto_assign_role: "none",
        timer_trigger: "project_onsite",
        deadline_type: "custom",
        deadline_hours_after_trigger: hours
      }))
    });
    results.push(s10);

    // Scenario 11: Null/undefined edge cases
    const s11 = await testScenario(base44, 11, {
      standard: [
        { title: "Task with nulls", description: null, auto_assign_role: "none", depends_on_indices: [], timer_trigger: "none", deadline_type: "custom", deadline_hours_after_trigger: 0 },
        { title: "Task minimal fields", auto_assign_role: "photographer", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tonight" }
      ]
    });
    results.push(s11);

    // Scenario 12: Empty descriptions and various string lengths
    const s12 = await testScenario(base44, 12, {
      premium: [
        { title: "No desc", description: "", auto_assign_role: "none", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Short desc", description: "Edit", auto_assign_role: "image_editor", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 36 },
        { title: "Long desc", description: "This is a very long task description that spans multiple words and contains detailed instructions for the assigned user to follow carefully", auto_assign_role: "video_editor", timer_trigger: "dependencies_cleared", deadline_type: "preset", deadline_preset: "tomorrow_night", deadline_hours_after_trigger: 0 }
      ]
    });
    results.push(s12);

    // Scenario 13: Complex dependency chains (5+ tasks)
    const s13 = await testScenario(base44, 13, {
      standard: [
        { title: "T1", description: "", auto_assign_role: "none", depends_on_indices: [], timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "T2", description: "", auto_assign_role: "none", depends_on_indices: [0], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 12 },
        { title: "T3", description: "", auto_assign_role: "none", depends_on_indices: [1], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 8 },
        { title: "T4", description: "", auto_assign_role: "none", depends_on_indices: [0, 2], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 6 },
        { title: "T5", description: "", auto_assign_role: "none", depends_on_indices: [1, 2, 3], timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 4 }
      ]
    });
    results.push(s13);

    // Scenario 14: Switching trigger types (same task different triggers)
    const s14 = await testScenario(base44, 14, {
      standard: [
        { title: "Multi-trigger 1", description: "", auto_assign_role: "photographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Multi-trigger 2", description: "", auto_assign_role: "photographer", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Multi-trigger 3", description: "", auto_assign_role: "photographer", timer_trigger: "project_submitted", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Multi-trigger 4", description: "", auto_assign_role: "photographer", timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Multi-trigger 5", description: "", auto_assign_role: "photographer", timer_trigger: "none", deadline_type: "custom", deadline_hours_after_trigger: 0 }
      ]
    });
    results.push(s14);

    // Scenario 15: Mixed deadline types with same trigger
    const s15 = await testScenario(base44, 15, {
      premium: [
        { title: "Custom 24h", description: "", auto_assign_role: "none", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 24 },
        { title: "Preset tonight", description: "", auto_assign_role: "none", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tonight", deadline_hours_after_trigger: 0 },
        { title: "Custom 48h", description: "", auto_assign_role: "none", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 48 },
        { title: "Preset tomorrow", description: "", auto_assign_role: "none", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tomorrow_night", deadline_hours_after_trigger: 0 }
      ]
    });
    results.push(s15);

    // Scenario 16: Maximum complexity - all features at once
    const s16 = await testScenario(base44, 16, {
      standard: [
        { title: "Complex 1", description: "Photo session setup", auto_assign_role: "photographer", timer_trigger: "project_onsite", deadline_type: "custom", deadline_hours_after_trigger: 24, depends_on_indices: [] },
        { title: "Complex 2", description: "Photo review and culling", auto_assign_role: "image_editor", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tomorrow_business_am", deadline_hours_after_trigger: 0, depends_on_indices: [0] },
        { title: "Complex 3", description: "Final editing and exports", auto_assign_role: "video_editor", timer_trigger: "dependencies_cleared", deadline_type: "custom", deadline_hours_after_trigger: 36, depends_on_indices: [1] },
        { title: "Complex 4", description: "QA and final checks", auto_assign_role: "project_owner", timer_trigger: "dependencies_cleared", deadline_type: "preset", deadline_preset: "in_2_nights", deadline_hours_after_trigger: 0, depends_on_indices: [0, 2] }
      ],
      premium: [
        { title: "Premium 1", description: "Advanced color grading", auto_assign_role: "image_editor", timer_trigger: "project_uploaded", deadline_type: "custom", deadline_hours_after_trigger: 48, depends_on_indices: [] },
        { title: "Premium 2", description: "Custom video effects", auto_assign_role: "video_editor", timer_trigger: "dependencies_cleared", deadline_type: "preset", deadline_preset: "3_business_nights", deadline_hours_after_trigger: 0, depends_on_indices: [0] }
      ]
    });
    results.push(s16);

    // Scenario 17: Fractional hours (0.5, 1.5, 2.5, etc.)
    const s17 = await testScenario(base44, 17, {
      standard: [0.5, 1.5, 2.5, 3.5, 4.5, 12.5].map((h, idx) => ({
        title: `Fractional ${h}h`,
        description: "",
        auto_assign_role: idx % 2 === 0 ? "photographer" : "image_editor",
        timer_trigger: "project_onsite",
        deadline_type: "custom",
        deadline_hours_after_trigger: h
      }))
    });
    results.push(s17);

    // Scenario 18: Preset-only tasks (no custom hours for comparison)
    const s18 = await testScenario(base44, 18, {
      premium: [
        { title: "Tonight", description: "", auto_assign_role: "none", timer_trigger: "project_onsite", deadline_type: "preset", deadline_preset: "tonight", deadline_hours_after_trigger: 0 },
        { title: "Tomorrow Night", description: "", auto_assign_role: "photographer", timer_trigger: "project_uploaded", deadline_type: "preset", deadline_preset: "tomorrow_night", deadline_hours_after_trigger: 0 },
        { title: "In 3 Nights", description: "", auto_assign_role: "image_editor", timer_trigger: "project_submitted", deadline_type: "preset", deadline_preset: "in_3_nights", deadline_hours_after_trigger: 0 },
        { title: "Next Business Night", description: "", auto_assign_role: "videographer", timer_trigger: "dependencies_cleared", deadline_type: "preset", deadline_preset: "next_business_night", deadline_hours_after_trigger: 0 }
      ]
    });
    results.push(s18);

    // Scenario 19: No-trigger tasks (timer_trigger: none) with various other configs
    const s19 = await testScenario(base44, 19, {
      standard: [
        { title: "Manual Task 1", description: "No auto deadline", auto_assign_role: "photographer", timer_trigger: "none", deadline_type: "custom", deadline_hours_after_trigger: 0 },
        { title: "Manual Task 2", description: "No deadline setup", auto_assign_role: "image_editor", timer_trigger: "none", depends_on_indices: [0] },
        { title: "Manual Task 3", description: "Self-assigned", auto_assign_role: "video_editor", timer_trigger: "none", depends_on_indices: [1] }
      ]
    });
    results.push(s19);

    // Scenario 20: Extreme scale (10 tasks, mixed configs)
    const s20 = await testScenario(base44, 20, {
      premium: Array.from({ length: 10 }, (_, idx) => ({
        title: `Batch Task ${idx + 1}`,
        description: `Task in batch of 10 - index ${idx}`,
        auto_assign_role: ["none", "photographer", "videographer", "image_editor", "video_editor"][idx % 5],
        timer_trigger: ["project_onsite", "project_uploaded", "project_submitted", "dependencies_cleared", "none"][idx % 5],
        deadline_type: idx % 2 === 0 ? "custom" : "preset",
        deadline_preset: idx % 2 === 1 ? ["tonight", "tomorrow_night", "in_2_nights", "in_3_nights"][idx % 4] : null,
        deadline_hours_after_trigger: idx % 2 === 0 ? [24, 12, 48, 6, 36][idx % 5] : 0,
        depends_on_indices: idx > 0 ? [idx - 1] : []
      }))
    });
    results.push(s20);

    return Response.json({
      success: true,
      total_scenarios: results.length,
      results: results.map((r, idx) => ({
        scenario: idx + 1,
        status: r.passed ? 'PASS' : 'FAIL',
        message: r.message,
        details: r.details
      }))
    });
  } catch (error) {
    console.error('Test error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function testScenario(base44, scenarioNum, taskTemplates) {
  try {
    const productName = `Test Product ${scenarioNum} - ${new Date().getTime()}`;
    
    // Create product with task templates
    const product = await base44.entities.Product.create({
      name: productName,
      description: `Scenario ${scenarioNum} test`,
      category: "photography",
      pricing_type: "fixed",
      standard_tier: { base_price: 100 },
      premium_tier: { base_price: 150 },
      standard_task_templates: taskTemplates.standard || [],
      premium_task_templates: taskTemplates.premium || [],
      is_active: true
    });

    // Reload product to verify persistence
    const reloaded = await base44.entities.Product.get(product.id);

    // Deep validation - compare field by field (ignore deadline_preset if not explicitly set)
    const validateTasks = (saved, expected) => {
      if (!saved || !expected) return saved?.length === expected?.length;
      if (saved.length !== expected.length) return false;
      
      return saved.every((task, idx) => {
        const exp = expected[idx];
        // Only check deadline_preset if it was explicitly set in expected
        const presetMatch = exp.deadline_preset ? task.deadline_preset === exp.deadline_preset : true;
        
        return (
          task.title === exp.title &&
          task.description === exp.description &&
          task.auto_assign_role === exp.auto_assign_role &&
          task.timer_trigger === exp.timer_trigger &&
          task.deadline_type === exp.deadline_type &&
          presetMatch &&
          task.deadline_hours_after_trigger === exp.deadline_hours_after_trigger &&
          JSON.stringify(task.depends_on_indices || []) === JSON.stringify(exp.depends_on_indices || [])
        );
      });
    };

    const stdMatch = validateTasks(reloaded.standard_task_templates, taskTemplates.standard);
    const premMatch = validateTasks(reloaded.premium_task_templates, taskTemplates.premium);
    // If no premium templates were expected, don't fail on premMatch
    const hasPremium = taskTemplates.premium && taskTemplates.premium.length > 0;
    const passed = stdMatch && (hasPremium ? premMatch : true);

    // Cleanup
    await base44.entities.Product.delete(product.id);

    return {
      passed,
      message: passed ? `Scenario ${scenarioNum}: All fields persisted correctly` : `Scenario ${scenarioNum}: Mismatch in persisted data`,
      details: {
        standardTasksCount: reloaded.standard_task_templates?.length || 0,
        premiumTasksCount: reloaded.premium_task_templates?.length || 0,
        stdMatch,
        premMatch,
        firstStdTask: reloaded.standard_task_templates?.[0],
        expectedStdTask: taskTemplates.standard?.[0]
      }
    };
  } catch (error) {
    return {
      passed: false,
      message: `Scenario ${scenarioNum}: Error - ${error.message}`,
      details: { error: error.message }
    };
  }
}