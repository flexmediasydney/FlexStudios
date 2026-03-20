import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const deletionReport = {
      timestamp: new Date().toISOString(),
      entitiesProcessed: {},
      totalDeleted: 0
    };

    // Sleep helper
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // Helper to delete records matching test patterns with retry
    const deleteTestRecords = async (entityName, identifierField = 'name') => {
      try {
        let allRecords = [];
        let retries = 0;
        
        // Fetch with retry
        while (retries < 3) {
          try {
            allRecords = await base44.asServiceRole.entities[entityName].list();
            break;
          } catch (err) {
            if (err.message?.includes('Rate limit')) {
              retries++;
              await sleep(2000 * retries); // Exponential backoff
            } else {
              throw err;
            }
          }
        }

        if (allRecords.length === 0) return;

        // Test patterns: "Iter", "Test", "Stress", demo names
        const testPatterns = ['Iter', 'Test', 'Stress', 'Demo', 'test_', 'stress_'];
        const toDelete = [];

        for (const record of allRecords) {
          const fieldValue = record[identifierField]?.toString()?.toLowerCase() || '';
          if (testPatterns.some(pattern => fieldValue.includes(pattern.toLowerCase()))) {
            toDelete.push(record.id);
          }
        }

        // Delete with rate limit handling
        let deletedCount = 0;
        for (const id of toDelete) {
          let deleteRetries = 0;
          while (deleteRetries < 3) {
            try {
              await base44.asServiceRole.entities[entityName].delete(id);
              deletedCount++;
              break;
            } catch (err) {
              if (err.message?.includes('Rate limit')) {
                deleteRetries++;
                await sleep(1000 * deleteRetries);
              } else {
                throw err;
              }
            }
          }
        }

        if (deletedCount > 0) {
          deletionReport.entitiesProcessed[entityName] = deletedCount;
          deletionReport.totalDeleted += deletedCount;
        }
      } catch (err) {
        deletionReport.entitiesProcessed[entityName] = `Error: ${err.message}`;
      }
    };

    // Clean up all entities that might contain test data
    const entitiesToClean = [
      'Product',
      'Package',
      'Agency',
      'Agent',
      'Client',
      'Team',
      'Project',
      'ProjectTask',
      'ProjectNote',
      'ProjectMedia',
      'ProjectActivity',
      'ProjectRevision',
      'PriceMatrix',
      'PriceMatrixAuditLog',
      'ProjectStageTimer',
      'TaskTimeLog',
      'ProjectEffort',
      'EmailMessage',
      'EmailActivity',
      'InteractionLog',
      'AuditLog'
    ];

    for (const entity of entitiesToClean) {
      await deleteTestRecords(entity);
    }

    return Response.json(deletionReport);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});