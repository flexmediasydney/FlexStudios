import React, { useState } from "react";
import { useAllEntityAccessRules } from "@/components/auth/useEntityAccess";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { Lock, Eye, Edit3, X, RotateCcw, Info } from "lucide-react";

// ─── Grouped Entity Types ───────────────────────────────────────────────────

const ENTITY_SECTIONS = [
  {
    label: "Core Operations",
    entities: [
      { key: "projects", label: "Projects", tip: "Job/shoot projects and their details" },
      { key: "project_tasks", label: "Tasks", tip: "Checklist items and task assignments on projects" },
      { key: "calendar_events", label: "Calendar Events", tip: "Scheduled shoots, meetings, and deadlines" },
      { key: "org_notes", label: "Notes", tip: "Internal notes attached to contacts and projects" },
      { key: "email_messages", label: "Emails", tip: "Sent/received email messages and templates" },
      { key: "notifications", label: "Notifications", tip: "System alerts, reminders, and access requests" },
    ],
  },
  {
    label: "Contacts & CRM",
    entities: [
      { key: "agencies", label: "Agencies", tip: "Real estate offices and brokerage firms" },
      { key: "agents", label: "Agents", tip: "Individual real estate agents linked to agencies" },
      { key: "interaction_logs", label: "Interactions", tip: "Call/email/meeting logs with contacts" },
      { key: "external_listings", label: "External Listings", tip: "Property listings synced from external sources" },
    ],
  },
  {
    label: "Catalog & Pricing",
    entities: [
      { key: "products", label: "Products", tip: "Photography/videography service line items" },
      { key: "packages", label: "Packages", tip: "Bundled product packages with pricing" },
      { key: "product_categories", label: "Categories", tip: "Grouping categories for products" },
      { key: "price_matrices", label: "Price Matrices", tip: "Price grids by property type and tier" },
      { key: "pricing_visibility", label: "Pricing Visibility", tip: "Controls who can see pricing columns" },
    ],
  },
  {
    label: "Administration",
    entities: [
      { key: "users", label: "Users", tip: "Team member accounts and profiles" },
      { key: "internal_teams", label: "Teams", tip: "Internal team groupings (photo, video, editing)" },
      { key: "project_types", label: "Project Types", tip: "Shoot type definitions and configurations" },
      { key: "role_matrix", label: "Role Matrix", tip: "Role-based permission definitions" },
      { key: "request_templates", label: "Request Templates", tip: "Reusable booking/request form templates" },
      { key: "tonomo_mappings", label: "Tonomo Mappings", tip: "Service mapping between CRM and Tonomo portal" },
      { key: "page_access", label: "Page Access", tip: "Route-level page visibility per role" },
    ],
  },
];

const ALL_ENTITIES = ENTITY_SECTIONS.flatMap((s) => s.entities);

const ACCESS_LEVELS = ["none", "view", "edit"];

const CELL_CONFIG = {
  none: { bg: "bg-red-50", icon: X, text: "None", textColor: "text-red-600" },
  view: { bg: "bg-amber-50", icon: Eye, text: "View", textColor: "text-amber-700" },
  edit: { bg: "bg-green-50", icon: Edit3, text: "Edit", textColor: "text-green-700" },
};

// Default access levels for master_admin reset
const MASTER_ADMIN_DEFAULTS = {
  projects: "edit", project_tasks: "edit", calendar_events: "edit",
  org_notes: "edit", email_messages: "edit", notifications: "edit",
  agencies: "edit", agents: "edit", interaction_logs: "edit",
  external_listings: "edit", products: "edit", packages: "edit",
  product_categories: "edit", price_matrices: "edit", pricing_visibility: "edit",
  users: "edit", internal_teams: "edit", project_types: "edit",
  role_matrix: "edit", request_templates: "edit", tonomo_mappings: "edit",
  page_access: "edit",
};

function cycleLevel(current) {
  const idx = ACCESS_LEVELS.indexOf(current);
  return ACCESS_LEVELS[(idx + 1) % ACCESS_LEVELS.length];
}

const ROLE_LABELS = {
  master_admin: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Staff",
  contractor: "Contractor",
};

function formatRole(role) {
  return ROLE_LABELS[role] || role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ");
}

export default function EntityAccessMatrix() {
  const { rules, isLoading } = useAllEntityAccessRules();
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [updatingRuleId, setUpdatingRuleId] = useState(null);
  const [resetting, setResetting] = useState(false);
  const isMasterAdmin = currentUser?.role === 'master_admin';

  const updateMutation = useMutation({
    mutationFn: ({ ruleId, access_level }) => {
      setUpdatingRuleId(ruleId);
      return api.entities.EntityAccessRule.update(ruleId, { access_level });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-access-rules"] });
      setUpdatingRuleId(null);
      toast.success("Access updated");
    },
    onError: () => {
      setUpdatingRuleId(null);
      toast.error("Failed to update access");
    },
  });

  const roles = [...new Set(rules.map((r) => r.role))].sort();

  const getRuleFor = (entityType, role) =>
    rules.find((r) => r.entity_type === entityType && r.role === role);

  const handleCellClick = (entityType, role) => {
    if (currentUser?.role !== 'master_admin') {
      toast.error('Only the account owner can modify security rules');
      return;
    }
    const rule = getRuleFor(entityType, role);
    if (!rule || updatingRuleId) return;
    const nextLevel = cycleLevel(rule.access_level || "none");
    updateMutation.mutate({ ruleId: rule.id, access_level: nextLevel });
  };

  const handleResetDefaults = async () => {
    setResetting(true);
    try {
      const masterRules = rules.filter((r) => r.role === "master_admin");
      let changed = 0;
      for (const rule of masterRules) {
        const expected = MASTER_ADMIN_DEFAULTS[rule.entity_type];
        if (expected && rule.access_level !== expected) {
          await api.entities.EntityAccessRule.update(rule.id, { access_level: expected });
          changed++;
        }
      }
      queryClient.invalidateQueries({ queryKey: ["entity-access-rules"] });
      toast.success(changed > 0 ? `Reset ${changed} rules to defaults` : "Already at defaults");
    } catch {
      toast.error("Failed to reset defaults");
    } finally {
      setResetting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Lock className="h-4 w-4 mr-2 animate-pulse" />
        Loading security matrix...
      </div>
    );
  }

  if (roles.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No entity access rules found. Create rules in the database first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-bold text-foreground">Security Matrix</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Click a cell to cycle access: None &rarr; View &rarr; Edit &rarr; None.
            {" "}Hover an entity name for details.
          </p>
        </div>
        <button
          onClick={handleResetDefaults}
          disabled={resetting || !isMasterAdmin}
          title={!isMasterAdmin ? 'Only the account owner can reset defaults' : undefined}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
        >
          <RotateCcw className={`h-3.5 w-3.5 ${resetting ? "animate-spin" : ""}`} />
          Reset Owner Defaults
        </button>
      </div>

      <div className="border rounded-lg overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className="text-left px-3 py-2.5 font-bold text-foreground sticky left-0 bg-muted/50 z-10 min-w-[170px]">
                Entity
              </th>
              {roles.map((role) => (
                <th key={role} className="text-center px-3 py-2.5 font-bold text-foreground min-w-[100px]">
                  {formatRole(role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ENTITY_SECTIONS.map((section) => (
              <React.Fragment key={section.label}>
                {/* Section header row */}
                <tr>
                  <td
                    colSpan={roles.length + 1}
                    className="px-3 py-2 bg-muted/40 border-t border-b"
                  >
                    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                      {section.label}
                    </span>
                  </td>
                </tr>
                {/* Entity rows within section */}
                {section.entities.map((entity, i) => (
                  <tr key={entity.key} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                    <td
                      className="px-3 py-2 font-semibold text-foreground sticky left-0 z-10"
                      style={{ backgroundColor: "inherit" }}
                    >
                      <span className="group relative inline-flex items-center gap-1.5 cursor-help">
                        {entity.label}
                        <Info className="h-3 w-3 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors" />
                        <span className="absolute left-0 bottom-full mb-1 hidden group-hover:block z-50 px-2.5 py-1.5 rounded-md bg-foreground text-background text-[10px] font-normal leading-snug whitespace-nowrap shadow-lg">
                          {entity.tip}
                        </span>
                      </span>
                    </td>
                    {roles.map((role) => {
                      const rule = getRuleFor(entity.key, role);
                      const level = rule?.access_level || "none";
                      const config = CELL_CONFIG[level];
                      const Icon = config.icon;

                      return (
                        <td key={role} className="px-1 py-1 text-center">
                          <button
                            onClick={() => handleCellClick(entity.key, role)}
                            disabled={!rule || updatingRuleId === rule?.id}
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md ${config.bg} ${config.textColor} font-medium transition-all hover:ring-2 hover:ring-offset-1 hover:ring-current/20 disabled:opacity-50 disabled:cursor-not-allowed w-full justify-center`}
                          >
                            <Icon className="h-3.5 w-3.5" />
                            {config.text}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="font-semibold">Legend:</span>
        {Object.entries(CELL_CONFIG).map(([level, config]) => {
          const Icon = config.icon;
          return (
            <span key={level} className={`inline-flex items-center gap-1 ${config.textColor}`}>
              <Icon className="h-3 w-3" />
              {config.text}
              {level === "none" && " = hidden"}
              {level === "view" && " = read-only"}
              {level === "edit" && " = full CRUD"}
            </span>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Default for missing rules: none (deny by default). {ALL_ENTITIES.length} entities &times; {roles.length} roles = {ALL_ENTITIES.length * roles.length} rules.
      </p>
    </div>
  );
}
