import { Card } from "@/components/ui/card";
import React from "react";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";

export default function ProductBrandingSummary({ product, agency }) {
  if (!agency || !product) return null;

  const category = product.category;
  const brandingPreferences = [];

  // Floorplan
  if (category === 'photography' && agency.floorplan_template && 
      (!agency.floorplan_product_category || agency.floorplan_product_category === category)) {
    brandingPreferences.push({
      label: 'Floorplan Template',
      value: agency.floorplan_template,
      notes: agency.branding_notes
    });
  }

  // Images watermark
  if (agency.images_logo_watermark && 
      (!agency.images_product_category || agency.images_product_category === category)) {
    brandingPreferences.push({
      label: 'Logo Watermark',
      value: agency.images_logo_watermark,
      notes: null
    });
  }

  // Drone
  if (category === 'drone' && agency.drone_template && 
      (!agency.drone_product_category || agency.drone_product_category === category)) {
    brandingPreferences.push({
      label: 'Drone Template',
      value: agency.drone_template,
      notes: agency.drone_branding_notes
    });
  }

  // Video
  if (category === 'video' && agency.video_branding && 
      (!agency.video_product_category || agency.video_product_category === category)) {
    brandingPreferences.push({
      label: 'Video Branding',
      value: agency.video_branding,
      notes: agency.video_branding_notes
    });
    if (agency.video_music_preference) {
      brandingPreferences.push({
        label: 'Music Preference',
        value: agency.video_music_preference,
        notes: null
      });
    }
  }

  if (brandingPreferences.length === 0) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 dark:bg-blue-950/30 dark:border-blue-800 rounded-lg p-3 space-y-2 mb-3">
      <p className="text-xs font-semibold text-blue-900 dark:text-blue-200">📋 Branding Preferences</p>
      <div className="space-y-1.5">
        {brandingPreferences.map((pref, idx) => (
          <div key={idx} className="text-xs">
            <div className="flex items-start gap-2">
              <span className="text-blue-700 dark:text-blue-300 font-medium flex-shrink-0">{pref.label}:</span>
              {pref.value.startsWith('http') ? (
                <a 
                  href={pref.value} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1"
                >
                  View <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ) : (
                <span className="text-blue-900 dark:text-blue-200">{pref.value}</span>
              )}
            </div>
            {pref.notes && <p className="text-blue-700 dark:text-blue-300 italic ml-20">{pref.notes}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}