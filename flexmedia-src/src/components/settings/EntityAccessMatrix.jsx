import React from "react";
import { useAllEntityAccessRules } from "@/components/auth/useEntityAccess";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { toast } from "sonner";
import { Lock, Eye, Edit3, X } from "lucide-react";

const ENTITY_TYPES = [
  { key: "products", label: "Products" },
  { key: "packages", label: "Packages" },
  { key: "project_types", label: "Project Types" },
  { key: "product_categories", label: "Categories" },
  { key: "role_matrix", label: "Role Matrix" },
  { key: "price_matrices", label: "Price Matrices" },
  { key: "tonomo_mappings", label: "Tonomo Mappings" },
  { key: "internal_teams", label: "Teams" },
  { key: "users", label: "Users" },
  { key: "request_templates", label: "Request Templates" },
  { key: "pricing_visibility", label: "💲 Pricing Visibility" },
];

const ACCESS_LEVELS = ["none", "view", "edit"];

const CELL_CONFIG = {
  none: { bg: "bg-red-50", icon: X, text: "None", textColor: "text-red-600" },
  view: { bg: "bg-amber-50", icon: Eye, text: "View", textColor: "text-amber-700" },
  edit: { bg: "bg-green-50", icon: Edit3, text: "Edit", textColor: "text-green-700" },
};

function cycleLevel(current) {
  const idx = ACCESS_LEVELS.indexOf(current);
  return ACCESS_LEVELS[(idx + 1) % ACCESS_LEVELS.length];
}

export default function EntityAccessMatrix() {
  const { rules, isLoading } = useAllEntityAccessRules();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ ruleId, access_level }) =>
      api.entities.EntityAccessRule.update(ruleId, { access_level }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-access-rules"] });
      toast.success("Access updated");
    },
    onError: () => toast.error("Failed to update access"),
  });

  const roles = [...new Set(rules.map((r) => r.role))].sort();

  const getRuleFor = (entityType, role) =>
    rules.find((r) => r.entity_type === entityType && r.role === role);

  const handleCellClick = (entityType, role) => {
    const rule = getRuleFor(entityType, role);
    if (!rule) return;
    const nextLevel = cycleLevel(rule.access_level || "none");
    updateMutation.mutate({ ruleId: rule.id, access_level: nextLevel });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
        <Lock className="h-4 w-4 mr-2 animate-pulse" />
        Loading access rules...
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
      <div>
        <h3 className="text-sm font-bold text-foreground">Entity Access Control</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Click a cell to cycle access: None &rarr; View &rarr; Edit &rarr; None
        </p>
      </div>

      <div className="border rounded-lg overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/50">
              <th className="text-left px-3 py-2.5 font-bold text-foreground sticky left-0 bg-muted/50 z-10 min-w-[140px]">
                Entity
              </th>
              {roles.map((role) => (
                <th key={role} className="text-center px-3 py-2.5 font-bold text-foreground min-w-[100px]">
                  {role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ENTITY_TYPES.map((entity, i) => (
              <tr key={entity.key} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                <td className="px-3 py-2 font-semibold text-foreground sticky left-0 z-10" style={{ backgroundColor: "inherit" }}>
                  {entity.label}
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
                        disabled={!rule || updateMutation.isPending}
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
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground italic">
        Default for missing rules: none (deny by default)
      </p>
    </div>
  );
}
