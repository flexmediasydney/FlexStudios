import { useState, useMemo, useEffect } from "react";
import {
  Search, Building, User, Plus, Camera, BookOpen,
  History, LayoutGrid, Table2, Percent, CheckCircle2, Circle, Tag
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { useEntitiesData, refetchEntityList } from "@/components/hooks/useEntityData";
import PriceMatrixEditor from "@/components/priceMatrix/PriceMatrixEditor";
import PriceMatrixSnapshots from "@/components/priceMatrix/PriceMatrixSnapshots";
import PriceMatrixRulebook from "@/components/priceMatrix/PriceMatrixRulebook";
import PriceMatrixAuditLog from "@/components/priceMatrix/PriceMatrixAuditLog";

export default function PriceMatrixPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [viewTab, setViewTab] = useState("agency");
  const [viewMode, setViewMode] = useState("card"); // "card" | "table"
  const [creating, setCreating] = useState({});
  const [selectedProjectTypeId, setSelectedProjectTypeId] = useState(""); // "" means no type selected yet, user must pick one

  const { data, loading } = useEntitiesData([
    { entityName: "PriceMatrix", sortBy: "-created_date" },
    { entityName: "Agency", sortBy: "name" },
    { entityName: "Agent", sortBy: "name" },
    { entityName: "ProjectType", sortBy: "order" }
  ]);

  const priceMatrix = data.PriceMatrix || [];
  const agencies = data.Agency || [];
  const agents = data.Agent || [];
  const projectTypes = (data.ProjectType || []).filter(t => t.is_active !== false);

  // Auto-select if only one project type exists
  useEffect(() => {
    if (projectTypes.length === 1 && !selectedProjectTypeId) {
      setSelectedProjectTypeId(projectTypes[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectTypes.length]);

  const selectedProjectType = projectTypes.find(t => t.id === selectedProjectTypeId) || null;

  const handleCreate = async (entity, entityType) => {
    if (!selectedProjectTypeId) {
      toast.error("Please select a project type first");
      return;
    }
    const key = `${entityType}-${entity.id}-${selectedProjectTypeId}`;
    setCreating(prev => ({ ...prev, [key]: true }));
    try {
      // Validate required fields
      if (!entity?.id) {
        toast.error("Entity is required");
        setCreating(prev => ({ ...prev, [key]: false }));
        return;
      }
      // Check for duplicate matrix
      const existing = priceMatrix.find(m => m.entity_type === entityType && m.entity_id === entity.id && m.project_type_id === selectedProjectTypeId);
      if (existing) {
        toast.error("A price matrix already exists for this entity and project type");
        setCreating(prev => ({ ...prev, [key]: false }));
        return;
      }
      await api.entities.PriceMatrix.create({
        entity_type: entityType,
        entity_id: entity.id,
        entity_name: entity.name,
        project_type_id: selectedProjectTypeId,
        project_type_name: selectedProjectType?.name,
        use_default_pricing: true,
        product_pricing: [],
        package_pricing: [],
        blanket_discount: { enabled: false, product_percent: 0, package_percent: 0 }
      });
      toast.success(`Price matrix created for ${entity.name} (${selectedProjectType?.name})`);
      await refetchEntityList("PriceMatrix");
    } catch {
      toast.error("Failed to create price matrix");
    } finally {
      setCreating(prev => ({ ...prev, [key]: false }));
    }
  };

  // Filter matrices by selected project type (only show type-specific matrices)
  const filteredMatrices = useMemo(() => {
    if (!selectedProjectTypeId) return [];
    return priceMatrix.filter(pm => pm.project_type_id === selectedProjectTypeId);
  }, [priceMatrix, selectedProjectTypeId]);

  const enrichedAgencies = agencies
    .filter(a => !searchQuery || a.name?.toLowerCase().includes(searchQuery.toLowerCase()))
    .map(agency => ({
      entity: agency,
      matrix: filteredMatrices.find(pm => pm.entity_type === "agency" && pm.entity_id === agency.id) || null,
      creatingKey: `agency-${agency.id}-${selectedProjectTypeId || "global"}`
    }));

  const enrichedAgents = agents
    .filter(a => !searchQuery || a.name?.toLowerCase().includes(searchQuery.toLowerCase()))
    .map(agent => ({
      entity: agent,
      matrix: filteredMatrices.find(pm => pm.entity_type === "agent" && pm.entity_id === agent.id) || null,
      creatingKey: `agent-${agent.id}-${selectedProjectTypeId || "global"}`
    }));

  const agenciesWithMatrix = enrichedAgencies.filter(e => e.matrix).length;
  const agentsWithMatrix = enrichedAgents.filter(e => e.matrix).length;

  const isPricing = viewTab === "agency" || viewTab === "agent";

  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <TooltipProvider>
        <div className="p-6 lg:p-8 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Price Matrix</h1>
              <p className="text-muted-foreground mt-1">Manage custom pricing for organisations and people</p>
            </div>
          </div>

          {/* Project Type Selector + Search + View Toggle */}
          {/* Project Type selector - required */}
          {projectTypes.length > 0 && isPricing && (
            <div className="flex flex-wrap gap-2 items-center">
              <Tag className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground font-medium">Project Type: <span className="text-destructive">*</span></span>
              <div className="text-xs text-muted-foreground italic ml-2">
                {!selectedProjectTypeId && "Required — select a type to view/create pricing"}
              </div>
              {projectTypes.length > 0 && projectTypes.map(type => {
                const isSelected = selectedProjectTypeId === type.id;
                return (
                  <button
                    key={type.id}
                    onClick={() => setSelectedProjectTypeId(type.id)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-sm border-2 transition-all ${isSelected ? "text-white border-transparent" : "border-border text-muted-foreground hover:border-muted-foreground/40"}`}
                    style={isSelected ? { backgroundColor: type.color || "#3b82f6", borderColor: type.color || "#3b82f6" } : {}}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: isSelected ? "rgba(255,255,255,0.7)" : (type.color || "#3b82f6") }} />
                    {type.name}
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            {isPricing && (
              <div className="flex items-center border rounded-lg overflow-hidden bg-background">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setViewMode("card")}
                      className={`px-3 py-2 transition-colors ${viewMode === "card" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                    >
                      <LayoutGrid className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Card view — full editing</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setViewMode("table")}
                      className={`px-3 py-2 transition-colors ${viewMode === "table" ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"}`}
                    >
                      <Table2 className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Table view — quick overview</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>

          <Tabs value={viewTab} onValueChange={setViewTab}>
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="agency">
                <Building className="h-4 w-4 mr-2" />
                Organisations
                {!loading && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {agenciesWithMatrix}/{enrichedAgencies.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="agent">
                <User className="h-4 w-4 mr-2" />
                People
                {!loading && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {agentsWithMatrix}/{enrichedAgents.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="snapshots">
                <Camera className="h-4 w-4 mr-2" />
                Snapshots
              </TabsTrigger>
              <TabsTrigger value="audit">
                <History className="h-4 w-4 mr-2" />
                Audit Log
              </TabsTrigger>
              <TabsTrigger value="rulebook">
                <BookOpen className="h-4 w-4 mr-2" />
                Rulebook
              </TabsTrigger>
            </TabsList>

            <TabsContent value="agency" className="mt-6">
              <MatrixContent
                enriched={enrichedAgencies}
                entityType="agency"
                loading={loading}
                searchQuery={searchQuery}
                viewMode={viewMode}
                creating={creating}
                onCreate={handleCreate}
                selectedProjectType={selectedProjectType}
              />
            </TabsContent>

            <TabsContent value="agent" className="mt-6">
              <MatrixContent
                enriched={enrichedAgents}
                entityType="agent"
                loading={loading}
                searchQuery={searchQuery}
                viewMode={viewMode}
                creating={creating}
                onCreate={handleCreate}
                selectedProjectType={selectedProjectType}
              />
            </TabsContent>

            <TabsContent value="snapshots" className="mt-6">
              <PriceMatrixSnapshots />
            </TabsContent>

            <TabsContent value="audit" className="mt-6">
              <PriceMatrixAuditLog />
            </TabsContent>

            <TabsContent value="rulebook" className="mt-6">
              <PriceMatrixRulebook />
            </TabsContent>
          </Tabs>
        </div>
      </TooltipProvider>
    </PermissionGuard>
  );
}

function MatrixContent({ enriched, entityType, loading, searchQuery, viewMode, creating, onCreate, selectedProjectType }) {
  if (loading) {
    return <div className="py-12 text-center text-sm text-muted-foreground">Loading price matrices...</div>;
  }
  if (enriched.length === 0) {
    return (
      <Card className="p-10 text-center">
        <p className="text-muted-foreground">
          {searchQuery ? `No ${entityType === "agency" ? "organisations" : "people"} match "${searchQuery}"` : `No ${entityType === "agency" ? "organisations" : "people"} found`}
        </p>
      </Card>
    );
  }

  if (viewMode === "table") {
    return <CompactTable enriched={enriched} entityType={entityType} creating={creating} onCreate={onCreate} selectedProjectType={selectedProjectType} />;
  }

  return (
    <div className="space-y-3">
      {enriched.map(({ entity, matrix, creatingKey }) =>
        matrix ? (
          <PriceMatrixEditor key={matrix.id} priceMatrix={matrix} />
        ) : (
          <NoMatrixCard
            key={entity.id}
            entity={entity}
            entityType={entityType}
            onCreate={onCreate}
            isCreating={!!creating[creatingKey]}
            selectedProjectType={selectedProjectType}
          />
        )
      )}
    </div>
  );
}

function CompactTable({ enriched, entityType, creating, onCreate, selectedProjectType }) {
  const Icon = entityType === "agency" ? Building : User;
  const selectedProjectTypeId = selectedProjectType?.id || null;

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left px-4 py-3 font-medium text-muted-foreground w-8"></th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Pricing Mode</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Overrides</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Blanket Discount</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last Modified</th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map(({ entity, matrix, creatingKey }, idx) => (
              <CompactTableRow
                key={entity.id}
                entity={entity}
                matrix={matrix}
                entityType={entityType}
                Icon={Icon}
                isLast={idx === enriched.length - 1}
                isCreating={!!creating[creatingKey]}
                onCreate={onCreate}
                selectedProjectType={selectedProjectType}
                canCreate={!!selectedProjectTypeId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function CompactTableRow({ entity, matrix, entityType, Icon, isLast, isCreating, onCreate, selectedProjectType, canCreate }) {
  const hasMatrix = !!matrix;
  const useDefault = !hasMatrix || matrix?.use_default_pricing !== false;
  const blanket = matrix?.blanket_discount;
  const blanketEnabled = blanket?.enabled || false;
  const productOverrides = matrix?.product_pricing?.filter(p => p.override_enabled)?.length ?? 0;
  const packageOverrides = matrix?.package_pricing?.filter(p => p.override_enabled)?.length ?? 0;
  const totalOverrides = productOverrides + packageOverrides;

  const formatDate = (dateStr) => {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  };

  const pricingMode = () => {
    if (!hasMatrix || useDefault) return { label: "Default", cls: "bg-muted text-muted-foreground border-border" };
    if (blanketEnabled) return {
      label: `Blanket ${blanket?.product_percent ?? 0}% / ${blanket?.package_percent ?? 0}%`,
      cls: "bg-amber-100 text-amber-800 border-amber-200"
    };
    return { label: "Custom", cls: "bg-blue-100 text-blue-800 border-blue-200" };
  };

  const mode = pricingMode();

  return (
    <tr className={`hover:bg-muted/20 transition-colors ${!isLast ? "border-b" : ""}`}>
      <td className="px-4 py-3">
        <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="font-medium">{entity.name}</span>
        {entity.agency_name && (
          <div className="text-xs text-muted-foreground">{entity.agency_name}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <Badge className={`text-xs border ${mode.cls}`}>
          {blanketEnabled && <Percent className="h-3 w-3 mr-1" />}
          {mode.label}
        </Badge>
      </td>
      <td className="px-4 py-3">
        {!hasMatrix || useDefault || blanketEnabled ? (
          <span className="text-xs text-muted-foreground">—</span>
        ) : totalOverrides > 0 ? (
          <span className="text-xs font-medium text-blue-700">
            {productOverrides > 0 && `${productOverrides} product${productOverrides !== 1 ? "s" : ""}`}
            {productOverrides > 0 && packageOverrides > 0 && ", "}
            {packageOverrides > 0 && `${packageOverrides} pkg${packageOverrides !== 1 ? "s" : ""}`}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        )}
      </td>
      <td className="px-4 py-3">
        {blanketEnabled ? (
          <span className="text-xs text-amber-700 font-medium">
            {blanket?.product_percent ?? 0}% / {blanket?.package_percent ?? 0}%
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {formatDate(matrix?.last_modified_at || matrix?.updated_date)}
      </td>
      <td className="px-4 py-3 text-right">
        {hasMatrix ? (
          <div className="flex items-center justify-end gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            <span className="text-xs text-green-700 font-medium">Configured</span>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCreate(entity, entityType)}
            disabled={isCreating || !canCreate}
            className="h-7 text-xs"
            title={!canCreate ? "Select a project type first" : ""}
          >
            <Plus className="h-3 w-3 mr-1" />
            {isCreating ? "Creating..." : `Setup (${selectedProjectType?.name || "select type"})`}
          </Button>
        )}
      </td>
    </tr>
  );
}

function NoMatrixCard({ entity, entityType, onCreate, isCreating, selectedProjectType }) {
  const canCreate = !!selectedProjectType?.id;
  return (
    <Card className="p-4 border-dashed">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
            <Circle className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="font-medium truncate">{entity.name}</div>
            <div className="text-xs text-muted-foreground">
              No {selectedProjectType ? `"${selectedProjectType.name}" ` : ""}price matrix configured — using master default pricing
            </div>
          </div>
        </div>
        <Button
           size="sm"
           variant="outline"
           onClick={() => onCreate(entity, entityType)}
           disabled={isCreating || !canCreate}
           className="flex-shrink-0"
           title={!canCreate ? "Select a project type first" : ""}
         >
           <Plus className="h-4 w-4 mr-1" />
           {isCreating ? "Creating..." : `Setup (${selectedProjectType?.name || "select type"})`}
         </Button>
      </div>
    </Card>
  );
}