import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

export default function HierarchyVisualizationPage() {
  const navigate = useNavigate();
  useEffect(() => { navigate(createPageUrl("ClientAgents"), { replace: true }); }, []);
  return null;
}