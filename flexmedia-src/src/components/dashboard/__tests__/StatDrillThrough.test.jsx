/**
 * StatDrillThrough.test.js
 * 
 * Unit tests for the StatDrillThrough drill-through system.
 * Validates all 5 drill types across edge cases.
 */

// Mock data generators
export const createMockProjects = (count = 10) =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    title: `Project ${i}`,
    property_address: `123 Main St ${i}`,
    status: ['pending_review', 'to_be_scheduled', 'onsite', 'uploaded', 'submitted', 'delivered'][i % 6],
    agency_id: `a${i % 3}`,
    agency_name: `Agency ${i % 3}`,
    calculated_price: 1000 + i * 500,
    price: 900 + i * 450,
    invoiced_amount: null,
    payment_status: i % 2 === 0 ? 'paid' : 'unpaid',
    created_date: new Date(Date.now() - i * 86400000).toISOString(),
  }));

export const createMockTasks = (count = 20) =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i}`,
    project_id: `p${i % 5}`,
    is_completed: i % 3 === 0,
    due_date: new Date(Date.now() - (i % 2 === 0 ? -i : i) * 86400000).toISOString(),
    assigned_to_name: `User ${i % 4}`,
    assigned_to: `u${i % 4}`,
  }));

// Test suites
export const testRevenueDrill = (drill) => {
  const testData = createMockProjects(5);
  const result = drill('revenue', testData, {});

  return {
    name: 'Revenue Drill',
    passed: [
      result.icon !== undefined,
      result.records.length === 5,
      result.cta && result.cta.url !== '#',
      result.records.every(r => r.value && r.value.includes('$')),
      result.records.every(r => r.url && r.url.includes('ProjectDetails')),
    ],
  };
};

export const testProjectsDrill = (drill) => {
  const testData = createMockProjects(10);
  const result = drill('projects', testData, { filter: p => !['delivered'].includes(p.status) });

  const expected = testData.filter(p => !['delivered'].includes(p.status)).length;
  return {
    name: 'Projects Drill',
    passed: [
      result.icon !== undefined,
      result.records.length === expected,
      result.records.every(r => r.url && r.url.includes('ProjectDetails')),
      result.cta && result.cta.url.includes('Projects'),
    ],
  };
};

export const testTasksDrill = (drill) => {
  const testData = createMockTasks(20);
  const now = new Date();
  const result = drill('tasks', testData, { filter: t => !t.is_completed && t.due_date && new Date(t.due_date) < now });

  return {
    name: 'Tasks Drill',
    passed: [
      result.icon !== undefined,
      result.records.length > 0,
      result.records.every(r => r.title !== undefined),
      result.cta && result.cta.label !== undefined,
    ],
  };
};

export const testAgenciesDrill = (drill) => {
  const testData = createMockProjects(15);
  const result = drill('agencies', testData, {});

  const uniqueAgencies = [...new Set(testData.map(p => p.agency_id))].length;
  return {
    name: 'Agencies Drill',
    passed: [
      result.icon !== undefined,
      result.records.length === uniqueAgencies,
      result.records.every(r => r.value && r.value.includes('$')),
      result.records.every(r => r.url && r.url.includes('OrgDetails')),
    ],
  };
};

export const testStageDrill = (drill) => {
  const testData = createMockProjects(10);
  const result = drill('stage', testData, { stage: 'onsite' });

  const expected = testData.filter(p => p.status === 'onsite').length;
  return {
    name: 'Stage Drill',
    passed: [
      result.icon !== undefined,
      result.records.length === expected,
      result.records.every(r => r.url && r.url.includes('ProjectDetails')),
    ],
  };
};

// Edge case tests
export const testEmptyData = (drill) => {
  const result = drill('revenue', [], {});
  return {
    name: 'Empty Data Handling',
    passed: [
      result === null,
    ],
  };
};

export const testNullConfig = (drill) => {
  const testData = createMockProjects(5);
  const result = drill('revenue', testData, undefined);
  return {
    name: 'Null Config Handling',
    passed: [
      result !== null,
      result.records.length === 5,
    ],
  };
};

export const testLargeDataset = (drill) => {
  const testData = createMockProjects(500);
  const startTime = performance.now();
  const result = drill('revenue', testData, {});
  const endTime = performance.now();

  return {
    name: 'Large Dataset (500 items)',
    passed: [
      result.records.length <= 10,
      endTime - startTime < 100, // Should complete in <100ms
    ],
    metrics: {
      timeMs: Math.round(endTime - startTime),
      recordsReturned: result.records.length,
    },
  };
};

export const testDataIntegrity = (drill) => {
  const testData = createMockProjects(5);
  const result = drill('revenue', testData, {});

  // Verify totals
  const manualSum = testData.reduce((s, p) => s + (p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0), 0);
  const drillSum = result.records.reduce((s, r) => {
    const val = parseInt(r.value.replace(/[$,k]/g, ''));
    return s + (r.value.includes('k') ? val * 1000 : val);
  }, 0);

  return {
    name: 'Data Integrity',
    passed: [
      Math.abs(drillSum - manualSum) < 1000, // Allow rounding
    ],
  };
};

// Run all tests
export function runAllTests(drillFn) {
  const tests = [
    testRevenueDrill,
    testProjectsDrill,
    testTasksDrill,
    testAgenciesDrill,
    testStageDrill,
    testEmptyData,
    testNullConfig,
    testLargeDataset,
    testDataIntegrity,
  ];

  const results = tests.map(test => test(drillFn));
  const passed = results.reduce((sum, r) => sum + r.passed.filter(Boolean).length, 0);
  const total = results.reduce((sum, r) => sum + r.passed.length, 0);

  return {
    passed,
    total,
    percent: Math.round((passed / total) * 100),
    results,
    summary: `${passed}/${total} tests passed (${Math.round((passed / total) * 100)}%)`,
  };
}

export default runAllTests;