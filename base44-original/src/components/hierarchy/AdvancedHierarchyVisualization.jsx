import React, { useEffect, useRef, useCallback, useMemo, useState } from "react";
import * as d3 from "d3";
import { ChevronDown, ZoomIn, ZoomOut, RefreshCw, Download, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const COLORS = {
  agency: "#3b82f6",
  team: "#8b5cf6",
  agent: "#10b981",
  projectType: "#f59e0b",
  category: "#ec4899",
};

const HierarchyVisualization = ({ agencies, teams, agents, projectTypes, products, onNodeClick }) => {
  const svgRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [hoveredNode, setHoveredNode] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [collapsed, setCollapsed] = useState({});

  // Build hierarchical data
  const hierarchyData = useMemo(() => {
    const buildAgencyNode = (agency) => {
      const agencyTeams = teams.filter((t) => t.agency_id === agency.id);
      const agencyAgents = agents.filter((a) => a.current_agency_id === agency.id && !a.current_team_id);
      const agencyProjectTypes = (agency.default_project_type_ids || [])
        .map((ptId) => projectTypes.find((pt) => pt.id === ptId))
        .filter(Boolean);

      return {
        id: `agency-${agency.id}`,
        name: agency.name,
        type: "agency",
        data: agency,
        icon: "🏢",
        color: COLORS.agency,
        children: [
          // Teams
          ...agencyTeams.map((team) => ({
            id: `team-${team.id}`,
            name: team.name,
            type: "team",
            data: team,
            icon: "👥",
            color: COLORS.team,
            parent: `agency-${agency.id}`,
            children: agents
              .filter((a) => a.current_team_id === team.id)
              .map((agent) => ({
                id: `agent-${agent.id}`,
                name: agent.name,
                type: "agent",
                data: agent,
                icon: "👤",
                color: COLORS.agent,
                parent: `team-${team.id}`,
              })),
          })),
          // Direct agents
          ...agencyAgents.map((agent) => ({
            id: `agent-${agent.id}`,
            name: agent.name,
            type: "agent",
            data: agent,
            icon: "👤",
            color: COLORS.agent,
            parent: `agency-${agency.id}`,
          })),
          // Project types
          ...agencyProjectTypes.map((pt) => ({
            id: `project-type-${pt.id}`,
            name: pt.name,
            type: "projectType",
            data: pt,
            icon: "📋",
            color: COLORS.projectType,
            parent: `agency-${agency.id}`,
            children: products
              .filter((p) => p.is_active && (p.project_type_ids || []).includes(pt.id))
              .slice(0, 5) // Limit display
              .map((prod) => ({
                id: `product-${prod.id}`,
                name: prod.name,
                type: "product",
                data: prod,
                icon: "📦",
                color: COLORS.category,
                category: prod.category,
                parent: `project-type-${pt.id}`,
              })),
          })),
        ],
      };
    };

    return {
      name: "Organization",
      type: "root",
      icon: "🌐",
      children: agencies.map(buildAgencyNode),
    };
  }, [agencies, teams, agents, projectTypes, products]);

  // D3 Visualization
  useEffect(() => {
    if (!svgRef.current || !hierarchyData) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    // Clear previous
    d3.select(svgRef.current).selectAll("*").remove();

    // Create SVG
    const svg = d3
      .select(svgRef.current)
      .attr("width", width)
      .attr("height", height)
      .style("background", "#f9fafb");

    // Add grid
    const gridGroup = svg.append("defs");
    gridGroup
      .append("pattern")
      .attr("id", "grid")
      .attr("width", 40)
      .attr("height", 40)
      .attr("patternUnits", "userSpaceOnUse")
      .append("path")
      .attr("d", "M 40 0 L 0 0 0 40")
      .attr("fill", "none")
      .attr("stroke", "#e5e7eb")
      .attr("stroke-width", 0.5);

    svg.append("rect").attr("width", width).attr("height", height).attr("fill", "url(#grid)");

    const g = svg.append("g").attr("transform", `translate(${panX},${panY}) scale(${zoom})`);

    // Tree layout
    const tree = d3.tree().size([width * 1.5, height * 1.5]);
    const root = d3.hierarchy(hierarchyData);
    tree(root);

    // Links
    g.selectAll(".link")
      .data(root.links())
      .join("line")
      .attr("class", "link")
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y)
      .attr("stroke", "#cbd5e1")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", (d) => (d.target.data.type === "agent" ? "5,5" : "0"));

    // Nodes
    const nodes = g
      .selectAll(".node")
      .data(root.descendants())
      .join("g")
      .attr("class", "node")
      .attr("transform", (d) => `translate(${d.x},${d.y})`)
      .on("click", (e, d) => {
        setSelectedNode(d.data.id);
        onNodeClick?.(d.data);
      })
      .on("mouseenter", (e, d) => setHoveredNode(d.data.id))
      .on("mouseleave", () => setHoveredNode(null));

    // Node circles
    nodes
      .append("circle")
      .attr("r", (d) => {
        const radii = { root: 0, agency: 20, team: 16, agent: 12, projectType: 14, product: 10 };
        return radii[d.data.type] || 10;
      })
      .attr("fill", (d) => d.data.color || "#94a3b8")
      .attr("stroke", (d) => (hoveredNode === d.data.id ? "#000" : "white"))
      .attr("stroke-width", (d) => (hoveredNode === d.data.id ? 3 : 2))
      .style("cursor", "pointer")
      .style("transition", "all 0.2s")
      .style("filter", (d) => (hoveredNode === d.data.id ? "drop-shadow(0 0 8px rgba(0,0,0,0.3))" : "none"));

    // Node labels
    nodes
      .append("text")
      .attr("dy", "0.31em")
      .attr("text-anchor", "middle")
      .attr("font-size", (d) => {
        const sizes = { root: 0, agency: 11, team: 9, agent: 8, projectType: 8, product: 7 };
        return sizes[d.data.type] || 8;
      })
      .attr("font-weight", (d) => (d.data.type === "agency" ? "bold" : "600"))
      .attr("fill", "white")
      .text((d) => (d.data.type === "root" ? "" : d.data.name))
      .style("pointer-events", "none")
      .style("text-shadow", "0 1px 3px rgba(0,0,0,0.5)");

    // Zoom & pan
    const zoom_behavior = d3
      .zoom()
      .on("zoom", (e) => {
        g.attr("transform", e.transform);
        setZoom(e.transform.k);
        setPanX(e.transform.x);
        setPanY(e.transform.y);
      });
    svg.call(zoom_behavior);
  }, [hierarchyData, hoveredNode, panX, panY, zoom, onNodeClick]);

  // Tooltip
  const tooltipNode = useMemo(() => {
    if (!hoveredNode) return null;
    const findNode = (data) => {
      if (data.id === hoveredNode) return data;
      if (data.children) {
        for (const child of data.children) {
          const found = findNode(child);
          if (found) return found;
        }
      }
      return null;
    };
    return findNode(hierarchyData);
  }, [hoveredNode, hierarchyData]);

  return (
    <div className="w-full h-full flex flex-col bg-background rounded-lg border">
      {/* Controls */}
      <div className="flex items-center gap-2 p-4 border-b bg-card">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setZoom(1);
            setPanX(0);
            setPanY(0);
          }}
          className="gap-1"
        >
          <RefreshCw className="h-4 w-4" />
          Reset
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setZoom((z) => Math.min(z + 0.2, 3))}
          className="gap-1"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setZoom((z) => Math.max(z - 0.2, 0.5))}
          className="gap-1"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">Zoom: {(zoom * 100).toFixed(0)}%</span>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        <svg ref={svgRef} style={{ width: "100%", height: "100%" }} />

        {/* Tooltip */}
        {tooltipNode && (
          <div className="absolute top-4 right-4 bg-popover border rounded-lg p-3 text-sm max-w-xs shadow-lg z-10">
            <div className="font-semibold flex items-center gap-2">
              <span>{tooltipNode.icon}</span>
              {tooltipNode.name}
            </div>
            <Badge variant="secondary" className="mt-2 text-xs">
              {tooltipNode.type}
            </Badge>
            {tooltipNode.data?.email && <p className="text-xs text-muted-foreground mt-2">{tooltipNode.data.email}</p>}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="p-4 border-t bg-card flex flex-wrap gap-4 text-xs">
        {Object.entries(COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-muted-foreground capitalize">{type.replace(/([A-Z])/g, " $1").trim()}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default HierarchyVisualization;