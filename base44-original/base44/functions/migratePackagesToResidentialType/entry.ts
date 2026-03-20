import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Get all project types to find "residential real estate"
    const projectTypes = await base44.entities.ProjectType.list();
    const residentialType = projectTypes.find(t => 
      t.name.toLowerCase().includes('residential') && t.name.toLowerCase().includes('real estate')
    );

    if (!residentialType) {
      return Response.json({ error: 'ProjectType "residential real estate" not found' }, { status: 400 });
    }

    // Get all packages with empty project_type_ids
    const allPackages = await base44.entities.Package.list();
    const packagesToMigrate = allPackages.filter(p => !p.project_type_ids || p.project_type_ids.length === 0);

    if (packagesToMigrate.length === 0) {
      return Response.json({ 
        success: true, 
        message: 'No packages to migrate',
        count: 0 
      });
    }

    // Update each package
    let successCount = 0;
    for (const pkg of packagesToMigrate) {
      try {
        await base44.entities.Package.update(pkg.id, {
          project_type_ids: [residentialType.id]
        });
        successCount++;
      } catch (err) {
        console.error(`Failed to migrate package ${pkg.id}:`, err);
      }
    }

    return Response.json({ 
      success: true,
      message: `Migrated ${successCount} packages to "${residentialType.name}"`,
      count: successCount,
      projectTypeId: residentialType.id,
      projectTypeName: residentialType.name
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});