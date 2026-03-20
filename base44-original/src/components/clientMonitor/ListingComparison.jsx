import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, AlertCircle, Trash2 } from "lucide-react";

export default function ListingComparison({
  internalProjects,
  externalListings,
  agent,
  onRefresh,
}) {
  const [expandedId, setExpandedId] = useState(null);
  const [isUpdating, setIsUpdating] = useState(null);

  const handleMatch = async (externalListingId, projectId) => {
    setIsUpdating(externalListingId);
    try {
      const project = internalProjects.find(p => p.id === projectId);
      await base44.entities.ExternalListing.update(externalListingId, {
        matched_project_id: projectId,
        matched_project_title: project?.title,
        match_status: "matched",
      });
      onRefresh();
    } finally {
      setIsUpdating(null);
    }
  };

  const handleDelete = async (externalListingId) => {
    if (!confirm("Delete this external listing?")) return;
    setIsUpdating(externalListingId);
    try {
      await base44.entities.ExternalListing.delete(externalListingId);
      onRefresh();
    } finally {
      setIsUpdating(null);
    }
  };

  const unmatchedListings = externalListings.filter(
    (e) => e.match_status === "unmatched"
  );
  const matchedListings = externalListings.filter(
    (e) => e.match_status !== "unmatched"
  );

  return (
    <div className="space-y-6">
      {/* Unmatched Listings */}
      {unmatchedListings.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-amber-600" />
            Unmatched External Listings ({unmatchedListings.length})
          </h2>
          <div className="space-y-3">
            {unmatchedListings.map((listing) => (
              <Card key={listing.id} className="p-4">
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div>
                    <div className="text-sm text-slate-600">Address</div>
                    <div className="font-medium text-slate-900">
                      {listing.address}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-slate-600">Portal</div>
                    <div className="flex gap-2 items-center">
                      <Badge variant="outline" className="capitalize">
                        {listing.source_portal}
                      </Badge>
                      <Badge variant="secondary" className="capitalize">
                        {listing.status.replace("_", " ")}
                      </Badge>
                    </div>
                  </div>
                </div>

                {listing.price && (
                  <div className="mb-4 text-sm">
                    <span className="text-slate-600">Price: </span>
                    <span className="font-medium text-slate-900">
                      ${listing.price.toLocaleString()}
                    </span>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700">
                    Match to Internal Project
                  </label>
                  <div className="flex gap-2">
                    <Select
                      defaultValue=""
                      onValueChange={(projectId) =>
                        projectId && handleMatch(listing.id, projectId)
                      }
                      disabled={isUpdating === listing.id}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select project..." />
                      </SelectTrigger>
                      <SelectContent>
                        {internalProjects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.title} (
                            {project.property_address})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(listing.id)}
                      disabled={isUpdating === listing.id}
                    >
                      <Trash2 className="h-4 w-4 text-red-600" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Matched Listings */}
      {matchedListings.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-green-600" />
            Matched Listings ({matchedListings.length})
          </h2>
          <div className="space-y-2">
            {matchedListings.map((listing) => (
              <Card key={listing.id} className="p-4 bg-green-50 border-green-200">
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <div className="text-xs text-slate-600">External</div>
                    <div className="font-medium text-slate-900">
                      {listing.address}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-600">Internal Project</div>
                    <div className="font-medium text-slate-900">
                      {listing.matched_project_title}
                    </div>
                  </div>
                  <div className="flex justify-end items-center">
                    <Badge className="bg-green-600">Matched</Badge>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {externalListings.length === 0 && (
        <Card className="p-8 text-center">
          <div className="text-slate-500 text-sm">
            No external listings added yet. Add listings from Domain or REA to get started.
          </div>
        </Card>
      )}

      {/* Uncovered Projects */}
      {internalProjects.length > externalListings.length && (
        <div>
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            Internal Projects Without External Listings
          </h2>
          <div className="space-y-2">
            {internalProjects
              .filter(
                (p) =>
                  !externalListings.some(
                    (e) => e.matched_project_id === p.id
                  )
              )
              .map((project) => (
                <Card key={project.id} className="p-4 bg-slate-50">
                  <div className="text-sm">
                    <div className="font-medium text-slate-900">
                      {project.title}
                    </div>
                    <div className="text-slate-600">
                      {project.property_address}
                    </div>
                  </div>
                </Card>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}