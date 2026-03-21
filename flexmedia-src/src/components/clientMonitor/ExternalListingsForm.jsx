import React, { useState } from "react";
import { api } from "@/api/supabaseClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

export default function ExternalListingsForm({ agent, onSuccess, onCancel }) {
  const [formData, setFormData] = useState({
    address: "",
    price: "",
    property_type: "residential",
    status: "for_sale",
    source_portal: "domain",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    // Validate required fields
    if (!formData.address?.trim()) {
      setError("Property address is required");
      setIsSubmitting(false);
      return;
    }
    if (formData.price && isNaN(Number(formData.price))) {
      setError("Price must be a valid number");
      setIsSubmitting(false);
      return;
    }

    try {
      await api.entities.ExternalListing.create({
        agent_id: agent.id,
        agent_name: agent.name,
        agency_id: agent.current_agency_id,
        agency_name: agent.current_agency_name,
        address: formData.address.trim(),
        price: formData.price ? (isNaN(Number(formData.price)) ? null : Number(formData.price)) : null,
        property_type: formData.property_type,
        status: formData.status,
        source_portal: formData.source_portal,
        match_status: "unmatched",
      });

      setFormData({
        address: "",
        price: "",
        property_type: "residential",
        status: "for_sale",
        source_portal: "domain",
      });
      onSuccess();
    } catch (err) {
      setError(err.message || "Failed to add listing");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="address">Property Address *</Label>
        <Input
          id="address"
          placeholder="Enter full property address"
          value={formData.address}
          onChange={(e) => setFormData({ ...formData, address: e.target.value })}
          required
          className="mt-1"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="price">Price (AUD)</Label>
          <Input
            id="price"
            type="number"
            placeholder="e.g., 750000"
            value={formData.price}
            onChange={(e) => setFormData({ ...formData, price: e.target.value })}
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="property_type">Property Type</Label>
          <Select
            value={formData.property_type}
            onValueChange={(value) =>
              setFormData({ ...formData, property_type: value })
            }
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="residential">Residential</SelectItem>
              <SelectItem value="commercial">Commercial</SelectItem>
              <SelectItem value="land">Land</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <Label htmlFor="status">Status</Label>
          <Select
            value={formData.status}
            onValueChange={(value) =>
              setFormData({ ...formData, status: value })
            }
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="for_sale">For Sale</SelectItem>
              <SelectItem value="sold">Sold</SelectItem>
              <SelectItem value="withdrawn">Withdrawn</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label htmlFor="source_portal">Portal</Label>
          <Select
            value={formData.source_portal}
            onValueChange={(value) =>
              setFormData({ ...formData, source_portal: value })
            }
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="domain">Domain</SelectItem>
              <SelectItem value="realestate">REA</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-3 pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting || !formData.address}
          className="gap-2"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Add Listing
        </Button>
      </div>
    </form>
  );
}