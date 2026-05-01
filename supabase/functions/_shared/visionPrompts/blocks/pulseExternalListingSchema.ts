/**
 * pulseExternalListingSchema.ts — W15b.1 scoped per-image schema (Gemini Flash).
 *
 * Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.1)
 *
 * This is the LEAN per-image schema sent to Gemini 2.5 Flash for external REA
 * listing photo extraction. It deliberately STRIPS the universal v2 schema
 * down to just:
 *
 *   1. Image-type classification (day/dusk/drone/floorplan/video/headshot)
 *   2. Product-mix booleans (is_day, is_dusk, is_drone, is_floorplan,
 *      is_video_thumbnail) → roll up to package counts in W15b.5.
 *   3. Competitor branding (watermark, photographer credit, agency logo).
 *   4. Quality-gate signal (delivery_quality_score 0-10) — used downstream to
 *      infer the competitor's tier.
 *   5. Canonical-registry feed (observed_objects + observed_attributes) —
 *      W12 organic registry growth still applies on competitor data.
 *   6. High-level architectural archetype (style_archetype, era_hint,
 *      material_palette) — feeds W15c competitor analysis.
 *   7. Brief Flash-grade reasoning (~50 word `analysis`; not the full 250-word
 *      architectural prose Pro emits — Flash is materially cheaper but lower
 *      prose quality, and we don't need full prose for spot-checks).
 *
 * What is INTENTIONALLY OMITTED vs the universal v2 schema:
 *   - aesthetic prose / listing_copy generation (Pro's job in Shape D).
 *   - 22-key signal_scores rollup.
 *   - Every *_specific block except the external_listing competitor signals.
 *   - finals/raw/floorplan-specific classification (different source_type).
 *
 * Cost target (per image, Flash):
 *   ~$0.0015 = (~600 input tokens × $0.30/1M) + (~600 output × $2.50/1M)
 *   At 14 imgs × 33,834 listings = ~$700 full corpus.
 *
 * The `PULSE_EXTERNAL_LISTING_SCHEMA_VERSION` is bumped on every breaking
 * change so persisted rows in `composition_classifications.schema_version`
 * carry an audit trail and re-runs at the same version are no-op via the
 * `pulse_listing_vision_extracts.uniq_pulse_vision_extracts_listing_version`
 * unique index.
 */

export const PULSE_EXTERNAL_LISTING_SCHEMA_VERSION = 'v1.0';

export const pulseExternalListingSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    // ─── Image-type classification ────────────────────────────────────────
    image_type: {
      type: 'string',
      enum: [
        'is_day',
        'is_dusk',
        'is_drone',
        'is_floorplan',
        'is_video_thumbnail',
        'is_agent_headshot',
        'is_detail_shot',
        'is_other',
      ],
      description:
        'Single best label for this image. Mutually exclusive — pick the dominant one.',
    },

    // ─── Product-mix booleans (roll up to W15b.5 package counts) ──────────
    is_dusk: {
      type: 'boolean',
      description:
        'TRUE when the image is a dusk shot (sunset / twilight golden hour). '
        + 'Drives `dusk_count` in the photo_breakdown rollup.',
    },
    is_drone: {
      type: 'boolean',
      description:
        'TRUE when the image is an aerial / drone perspective. Drives '
        + '`drone_count` in the photo_breakdown rollup.',
    },
    is_floorplan: {
      type: 'boolean',
      description:
        'TRUE when the image is a 2D or 3D floorplan diagram. Drives '
        + '`floorplan_count` in the photo_breakdown rollup.',
    },
    is_video_thumbnail: {
      type: 'boolean',
      description:
        'TRUE when the image is a still thumbnail used to launch a video '
        + '(typically has a play-button overlay or video-format aspect ratio).',
    },
    is_day: {
      type: 'boolean',
      description:
        'TRUE when the image is a daylight shot (interior with daylight or '
        + 'exterior in daylight). Drives `day_count` in the photo_breakdown '
        + 'rollup.',
    },

    // ─── Competitor branding ──────────────────────────────────────────────
    watermark_visible: {
      type: 'boolean',
      description:
        'TRUE when ANY watermark (logo, text overlay, photographer credit, '
        + 'agency stamp) is visible on the image.',
    },
    photographer_credit: {
      type: 'string',
      nullable: true,
      description:
        'Photographer or studio name visible on the image (text overlay or '
        + 'watermark). NULL when not visible.',
    },
    agency_logo_text: {
      type: 'string',
      nullable: true,
      description:
        'Agency logo text or branding visible on the image. NULL when not '
        + 'visible.',
    },

    // ─── Quality gate (downstream tier inference) ─────────────────────────
    delivery_quality_score: {
      type: 'number',
      description:
        'Observational delivery quality 0-10. Anchored: 0=heavy distortion / '
        + 'cluttered / hand-held phone snap, 5=competent professional, 10=top '
        + 'editorial standard. Used downstream to infer the competitor\'s tier '
        + '(premium vs standard vs approachable).',
    },

    // ─── W12 canonical registry feed ──────────────────────────────────────
    observed_objects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw_label: {
            type: 'string',
            description: 'Free-form noun phrase as seen (e.g. "kitchen island bench").',
          },
          proposed_canonical_id: {
            type: 'string',
            nullable: true,
            description:
              'Best-guess canonical object id from the seeded W12 registry. '
              + 'NULL when no confident match.',
          },
          confidence: {
            type: 'number',
            description: 'Detection confidence 0-1.',
          },
          bounding_box: {
            type: 'object',
            properties: {
              x_pct: { type: 'number' },
              y_pct: { type: 'number' },
              w_pct: { type: 'number' },
              h_pct: { type: 'number' },
            },
            description: 'Normalised 0-100% bounding box.',
          },
        },
      },
      description:
        'Observed canonical-eligible objects in this image. Feeds W12 organic '
        + 'registry growth even when the source is competitor data.',
    },
    observed_attributes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          raw_label: {
            type: 'string',
            description:
              'Free-form attribute phrase (e.g. "marble splashback", '
              + '"timber floors"). ',
          },
          canonical_attribute_id: {
            type: 'string',
            nullable: true,
            description:
              'Best-guess canonical attribute id. NULL when no confident match.',
          },
          confidence: {
            type: 'number',
            description: 'Attribute confidence 0-1.',
          },
        },
      },
      description:
        'Observed material / finish attributes. Feeds the W12 attribute '
        + 'registry alongside observed_objects.',
    },

    // ─── High-level architectural for W15c competitor analysis ────────────
    style_archetype: {
      type: 'string',
      nullable: true,
      description:
        'Free-form short label for the dominant style (e.g. "Federation '
        + 'restoration", "warehouse conversion", "1970s ranch"). NULL when not '
        + 'classifiable from a single image.',
    },
    era_hint: {
      type: 'string',
      nullable: true,
      description:
        'Era hint (Federation, Edwardian, Victorian, Mid-century, '
        + 'contemporary, modernist, art-deco, Hamptons, etc.). NULL when not '
        + 'classifiable.',
    },
    material_palette: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Materials visible in this image (e.g. "oak floorboards", "marble '
        + 'splashback", "burnished concrete"). 0-12 entries.',
    },

    // ─── Brief Flash reasoning ────────────────────────────────────────────
    analysis: {
      type: 'string',
      description:
        'Brief reasoning (~50 words) for why these classifications were '
        + 'picked. Lower quality than Pro\'s full architectural prose but '
        + 'useful for spot checks.',
    },
  },
  required: [
    'image_type',
    'is_dusk',
    'is_drone',
    'is_floorplan',
    'is_video_thumbnail',
    'is_day',
    'watermark_visible',
    'delivery_quality_score',
    'observed_objects',
    'observed_attributes',
    'analysis',
  ],
};
