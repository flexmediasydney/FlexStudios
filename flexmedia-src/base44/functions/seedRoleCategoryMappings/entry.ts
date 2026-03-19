import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const DEFAULTS = [
  {
    role: "project_owner",
    label: "Project Owner",
    categories: null,
    always_required: true,
    description: "Assigned to every project regardless of services",
    order: 0,
    is_active: true,
  },
  {
    role: "photographer",
    label: "Photographer",
    categories: JSON.stringify(["photography", "drone", "virtual_staging"]),
    always_required: false,
    description: "Required when project includes photography, drone, or virtual staging",
    order: 1,
    is_active: true,
  },
  {
    role: "videographer",
    label: "Videographer",
    categories: JSON.stringify(["video"]),
    always_required: false,
    description: "Required when project includes video services",
    order: 2,
    is_active: true,
  },
  {
    role: "image_editor",
    label: "Image Editor",
    categories: JSON.stringify(["photography", "drone", "virtual_staging"]),
    always_required: false,
    description: "Required when project includes photography, drone, or virtual staging",
    order: 3,
    is_active: true,
  },
  {
    role: "video_editor",
    label: "Video Editor",
    categories: JSON.stringify(["video"]),
    always_required: false,
    description: "Required when project includes video services",
    order: 4,
    is_active: true,
  },
  {
    role: "floorplan_editor",
    label: "Floorplan Editor",
    categories: JSON.stringify(["floorplan", "editing"]),
    always_required: false,
    description: "Required when project includes editing or floorplan services",
    order: 5,
    is_active: true,
  },
  {
    role: "drone_editor",
    label: "Drone Editor",
    categories: JSON.stringify(["drone"]),
    always_required: false,
    description: "Required when project includes drone services",
    order: 6,
    is_active: true,
  },
];

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (user?.role !== 'admin' && user?.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const existing = await base44.asServiceRole.entities.RoleCategoryMapping.list();
    const existingRoles = new Set((existing || []).map(r => r.role));

    const created = [];
    const skipped = [];

    for (const mapping of DEFAULTS) {
      if (existingRoles.has(mapping.role)) {
        skipped.push(mapping.role);
      } else {
        await base44.asServiceRole.entities.RoleCategoryMapping.create(mapping);
        created.push(mapping.role);
      }
    }

    return Response.json({
      success: true,
      created,
      skipped,
      message: `Created ${created.length} mappings, skipped ${skipped.length} (already exist).`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});