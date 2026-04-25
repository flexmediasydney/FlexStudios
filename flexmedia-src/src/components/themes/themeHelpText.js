/**
 * THEME_HELP_TEXT — centralized help dictionary for the drone ThemeEditor.
 *
 * Keys are dot-paths matching the theme config schema in
 * `modal/drone_render/themes/__schema__.json`. Each entry has:
 *   - title:   short label (under 5 words) that mirrors the UI field
 *   - desc:    1-2 plain-language sentences explaining what the field does
 *   - example: 1 concrete value or scenario to anchor the description
 *
 * Audience: real-estate photographers / agency operators. Avoid jargon —
 * explain photographically (cropping, contrast, glance-readability) instead
 * of in pixel-buffer terms.
 *
 * Render context: drone shots are annotated at full source resolution
 * (typically ~4000-5500px wide from a Mavic 3 Pro). All "px" values below
 * are at that full size — they get scaled down on Instagram crops, MLS
 * web, etc. via output_variants.
 *
 * Behaviour-of-record for each field is in `modal/drone_render/render_engine.py`
 * and `modal/drone_render/render_worker.py`. If you change a field's effect
 * in the renderer, update the help here too.
 */

export const THEME_HELP_TEXT = {
  // ─────────────────────────────────────────────────────────────────────
  // Anchor line — the line that connects each POI marker to its label
  // ─────────────────────────────────────────────────────────────────────
  "anchor_line.shape": {
    title: "Anchor line shape",
    desc: "How the line connecting a POI marker to its label is drawn. 'Thin' is a single hairline, 'thick bar' is a chunky vertical rectangle, 'dashed' is intermittent, 'gradient' fades from full opacity at the marker to ~30% at the label, and 'none' hides the connector entirely.",
    example: "Most operators use 'thin' for a clean modern look or 'thick bar' for high-contrast aerial output.",
  },
  "anchor_line.width_px": {
    title: "Anchor line width",
    desc: "Line thickness in pixels at full render resolution (~4000px wide source). Gets scaled down on Instagram/MLS crops automatically.",
    example: "3px reads cleanly on a 4K display; 6-8px for high-contrast or printed media.",
  },
  "anchor_line.color": {
    title: "Anchor line color",
    desc: "Hex color of the connector line. Pick something that contrasts with both the sky and the rooftops in your typical shot.",
    example: "#FFFFFF (white) is the safest default; #000000 or your brand colour for stylised themes.",
  },
  "anchor_line.opacity": {
    title: "Anchor line opacity",
    desc: "How solid the line is, from 0 (invisible) to 1 (fully opaque). Lower values let the photograph show through.",
    example: "1.0 for a hard graphic look; 0.7 for a softer overlay.",
  },
  "anchor_line.min_length_px": {
    title: "Minimum line length",
    desc: "The shortest the renderer will draw an anchor line. Below this, labels are pushed further from their target so the connector remains visible.",
    example: "40px keeps even tightly-packed labels from sitting right on the marker.",
  },
  "anchor_line.max_length_px": {
    title: "Maximum line length",
    desc: "Preferred line length — the renderer aims for this when laying out a label above its POI. Longer means labels sit higher and freer in the sky.",
    example: "220px works well for residential aerials; bump to 300px+ for sweeping rural shots.",
  },
  "anchor_line.flip_below_target_threshold_px": {
    title: "Flip-below threshold",
    desc: "If a label's anchor would have to be shorter than this (because the POI is too close to the top of the frame), the renderer flips the label to BELOW the POI instead of above. Prevents cramped labels at the sky edge.",
    example: "80px — POIs less than ~80px from the top get their labels flipped underneath.",
  },
  "anchor_line.end_marker.shape": {
    title: "End marker shape",
    desc: "What's drawn AT the POI itself, where the anchor line ends. 'Dot' is a filled circle, 'circle' adds a stroke ring, 'diamond' is a rotated square, 'cross' is a plus sign, 'none' hides the marker.",
    example: "'dot' is the most common; 'diamond' for editorial / luxury themes.",
  },
  "anchor_line.end_marker.size_px": {
    title: "End marker size",
    desc: "Diameter of the marker that lands on the POI's exact GPS location.",
    example: "14px sits subtly on the photo; 24-30px reads clearly in print.",
  },
  "anchor_line.end_marker.fill_color": {
    title: "Marker fill color",
    desc: "Hex color of the marker's interior. Usually matches or contrasts with the anchor line.",
    example: "#FFFFFF for max visibility on aerial photography.",
  },
  "anchor_line.end_marker.stroke_color": {
    title: "Marker stroke color",
    desc: "Hex color of the ring around the marker (only drawn when stroke width > 0). Lets you ring a white dot in black, etc.",
    example: "#000000 for a white-on-dark theme contrast.",
  },
  "anchor_line.end_marker.stroke_width_px": {
    title: "Marker stroke width",
    desc: "Thickness of the marker outline. Set to 0 for a solid filled marker with no ring.",
    example: "0 = filled only; 2-3px adds a defining ring.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // POI label — the box of text naming each point of interest
  // ─────────────────────────────────────────────────────────────────────
  "poi_label.enabled": {
    title: "POI labels master toggle",
    desc: "Master switch. When OFF, no POI name labels are drawn at all on rendered shots, regardless of how many POIs are in the data. Use it to ship hero shots with no clutter.",
    example: "Turn off for a clean cinematic master shot; on for the buyer-info gallery shots.",
  },
  "poi_label.shape": {
    title: "Label box shape",
    desc: "Geometry of the rectangle behind each POI name. 'Rectangle' is sharp corners, 'rounded rectangle' adds slight rounding, 'pill' is fully capsule-shaped.",
    example: "'Rectangle' for editorial themes; 'pill' for friendlier consumer marketing.",
  },
  "poi_label.corner_radius_px": {
    title: "Corner radius",
    desc: "How rounded the label box corners are, in pixels. Only meaningful when shape is 'rounded rectangle'.",
    example: "0 = sharp; 12-20px = soft rounded; large values to push toward pill.",
  },
  "poi_label.fill": {
    title: "Label fill color",
    desc: "Background color of the label box. Use 'transparent' or leave blank to skip the box and rely on the foreground style for legibility.",
    example: "#FFFFFF for white-on-dark; 'transparent' for an outlined-text-only look.",
  },
  "poi_label.border.color": {
    title: "Label border color",
    desc: "Hex color of the box outline. Only drawn when border width > 0.",
    example: "#000000 for high-contrast outlined boxes.",
  },
  "poi_label.border.width_px": {
    title: "Label border width",
    desc: "Thickness of the box outline. Set to 0 for no border.",
    example: "0 for flat fills; 2-3px for an editorial bordered look.",
  },
  "poi_label.padding_px.top": {
    title: "Padding — top",
    desc: "Space between the top of the label box and the text inside. More padding = chunkier label.",
    example: "12px is comfortable; 20px+ for premium spacious feel.",
  },
  "poi_label.padding_px.right": {
    title: "Padding — right",
    desc: "Space between the right side of the label box and the text. Larger horizontal padding makes the box look more like a banner.",
    example: "24px is balanced; 40px+ for stretched-out luxury labels.",
  },
  "poi_label.padding_px.bottom": {
    title: "Padding — bottom",
    desc: "Space between the bottom of the label box and the text. Usually matches top padding for a balanced look.",
    example: "12px to match top.",
  },
  "poi_label.padding_px.left": {
    title: "Padding — left",
    desc: "Space between the left side of the label box and the text. Usually matches right padding.",
    example: "24px to match right.",
  },
  "poi_label.text_color": {
    title: "Label text color",
    desc: "Hex color of the POI name text. Should contrast strongly with the label fill.",
    example: "#000000 on a white fill, or #FFFFFF on a black fill.",
  },
  "poi_label.secondary_text_color": {
    title: "Secondary text color",
    desc: "Hex color of the smaller second line (typically the distance). Often muted vs. the main name.",
    example: "#666666 for a muted grey; falls back to text_color if blank.",
  },
  "poi_label.text_case": {
    title: "Text case",
    desc: "Whether to display the POI name as-is, ALL CAPS, or Title Case. UPPERCASE reads bolder on aerial backgrounds.",
    example: "'uppercase' for a confident editorial style; 'titlecase' for friendly consumer marketing.",
  },
  "poi_label.font_family": {
    title: "Font family",
    desc: "Font used for the label name. Must be a font installed in the renderer's font directory (DejaVu Sans, Roboto, Inter, etc.) — see the brand-fonts list for available options.",
    example: "'DejaVu Sans' is the safe default; switch to your brand font for agency themes.",
  },
  "poi_label.font_size_px": {
    title: "Label font size",
    desc: "Size of the main POI name text in pixels (at full source resolution ~4000px wide). Scales down with output variants automatically.",
    example: "36px reads clearly; 48-56px for big-print luxury markets.",
  },
  "poi_label.letter_spacing": {
    title: "Letter spacing",
    desc: "Horizontal spacing between letters. Positive values spread the text out (editorial / luxury); negative tightens it.",
    example: "0 for normal; 0.05-0.15 for a wider editorial feel.",
  },
  "poi_label.line_height": {
    title: "Line height",
    desc: "Vertical spacing multiplier between the main and secondary text lines. 1.2 means each line gets 120% of font height.",
    example: "1.2 is balanced; 1.4 for airier two-line labels.",
  },
  "poi_label.text_template": {
    title: "Label text template",
    desc: "Template for the main label line. {name} is replaced with the POI's name. Use this to add prefixes/suffixes globally.",
    example: "'{name}' shows just the name; '→ {name}' adds an arrow prefix.",
  },
  "poi_label.secondary_text.enabled": {
    title: "Show second line",
    desc: "Whether to render a smaller second line of text under the POI name. Used for distance, category, or any extra context.",
    example: "Turn ON to show '850m' under each POI name.",
  },
  "poi_label.secondary_text.template": {
    title: "Second line template",
    desc: "Template string for the second line. {distance} is auto-formatted (e.g. '850m' or '1.5km'). {name} and {type} are also available.",
    example: "'{distance}' → '850m'; 'walk: {distance}' → 'walk: 850m'.",
  },
  "poi_label.secondary_text.color": {
    title: "Second line color",
    desc: "Hex color of the smaller second-line text. Often muted compared to the main name.",
    example: "#666666 for a soft grey under a black main name.",
  },
  "poi_label.show_distance_as_secondary": {
    title: "Show distance",
    desc: "Shortcut: show the metres-from-property as the second line on every POI label (e.g. '850m', '1.5km'). Helps buyers gauge proximity at a glance.",
    example: "Turn ON for buyer-info gallery shots; OFF for hero shots.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // POI label foreground — alternative outlined-text style (no box)
  // ─────────────────────────────────────────────────────────────────────
  "poi_label_foreground.enabled": {
    title: "Foreground text style",
    desc: "Use the alternate 'outlined text' POI style instead of a filled label box. The POI name floats on the photo with a stroke around each letter for readability.",
    example: "Turn ON for a minimalist Belle Property look; OFF for the standard boxed labels.",
  },
  "poi_label_foreground.style": {
    title: "Foreground style",
    desc: "Which foreground treatment to use. 'outlined_text' draws each letter with a coloured stroke. 'label_box_same' falls back to the standard boxed style.",
    example: "'outlined_text' for editorial overlay text.",
  },
  "poi_label_foreground.text_color": {
    title: "Foreground text color",
    desc: "Hex color of the letter fill in foreground mode.",
    example: "#FFFFFF — white text outlined in black is the most legible combo on aerial photos.",
  },
  "poi_label_foreground.text_outline_color": {
    title: "Outline color",
    desc: "Hex color of the stroke around each letter. Should contrast strongly with the text color so it reads on busy backgrounds.",
    example: "#000000 to black-outline white text.",
  },
  "poi_label_foreground.text_outline_width_px": {
    title: "Outline width",
    desc: "Thickness of the letter outline. Larger values keep text legible against very busy or bright photo backgrounds.",
    example: "3px is standard; 5-6px for very high-contrast on cluttered scenes.",
  },
  "poi_label_foreground.font_size_px": {
    title: "Foreground font size",
    desc: "Letter size when using foreground / outlined-text mode. Tends to be slightly larger than boxed labels because there's no box to anchor the eye.",
    example: "40-48px for outlined POI names.",
  },
  "poi_label_foreground.anchor_line": {
    title: "Foreground anchor line",
    desc: "Whether to still draw a small connecting line between the outlined label and the POI marker. 'mini' draws a short stub; 'none' relies on proximity alone.",
    example: "'mini' helps the eye associate text with marker; 'none' for the cleanest look.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Property pin — the main marker drawn at the property's GPS centroid
  // ─────────────────────────────────────────────────────────────────────
  "property_pin.enabled": {
    title: "Property pin master toggle",
    desc: "Master switch. When OFF, no property pin is drawn at all (regardless of mode / size / address label). Use it for shots where the pin would obstruct the building.",
    example: "OFF for the front-on hero shot; ON for the orientation shots.",
  },
  "property_pin.mode": {
    title: "Pin style",
    desc: "Which style of marker is drawn at the property's GPS centroid. 'Pill with address' is text-heavy, 'teardrop with logo' is the most branded option, 'line up with house icon' is a vertical pole topped with a house icon (FlexMedia default), 'teardrop plain' is a clean unbranded marker.",
    example: "'line_up_with_house_icon' is the FlexMedia default; 'teardrop_with_logo' for fully-branded agency themes.",
  },
  "property_pin.size_px": {
    title: "Pin size",
    desc: "Overall size of the pin in pixels. Affects the head/teardrop diameter and the icon/monogram inside.",
    example: "120px reads cleanly on a 4K aerial; bump to 160-200px for big-print marketing.",
  },
  "property_pin.fill_color": {
    title: "Pin fill color",
    desc: "Hex color of the pin's main shape (teardrop body, pill background, line-up box). Pick a colour that contrasts the property roof.",
    example: "#FFFFFF for max visibility; brand colour for stylised themes.",
  },
  "property_pin.stroke_color": {
    title: "Pin stroke color",
    desc: "Hex color of the outline around the pin shape. Only drawn when stroke width > 0.",
    example: "#000000 to ring a white pin in black.",
  },
  "property_pin.stroke_width_px": {
    title: "Pin stroke width",
    desc: "Thickness of the pin outline. Set to 0 for a solid filled pin with no border.",
    example: "0 = clean solid; 3-5px for a defined edge.",
  },
  "property_pin.content.type": {
    title: "Pin content type",
    desc: "What's inside the pin head. 'icon' draws a built-in glyph (house, etc.), 'monogram' shows 1-3 letters (agency initials), 'logo' renders a logo image, 'text' shows arbitrary text, 'none' leaves the pin head empty.",
    example: "'icon' with house icon for FlexMedia default; 'monogram' for agency-branded pins.",
  },
  "property_pin.content.text": {
    title: "Pin text",
    desc: "Arbitrary text shown inside the pin (only used when content type is 'text' or for 'pill_with_address' mode). Often the address.",
    example: "'42 OAK ST' for a pill-with-address style.",
  },
  "property_pin.content.monogram": {
    title: "Pin monogram",
    desc: "1-3 letter monogram shown in the pin head when content type is 'monogram'. Agency initials work well.",
    example: "'BP' for Belle Property; 'FM' for FlexMedia.",
  },
  "property_pin.content.icon_name": {
    title: "Pin icon",
    desc: "Which built-in icon to draw inside the pin. Currently 'home' is the only built-in (a roof + body shape).",
    example: "'home' draws a small house glyph.",
  },
  "property_pin.content.logo_asset_ref": {
    title: "Pin logo asset",
    desc: "Reference to a brand logo asset to render inside the pin (used when content type is 'logo'). Looked up from your branding assets.",
    example: "'agency_logo_white' to use your white-version logo.",
  },
  "property_pin.content.text_color": {
    title: "Pin text color",
    desc: "Hex color of any text/monogram drawn inside the pin head.",
    example: "#000000 on a white pin; #FFFFFF on a coloured pin.",
  },
  "property_pin.content.text_font": {
    title: "Pin text font",
    desc: "Font family used for monogram / pin text. Bold is recommended for legibility at small sizes.",
    example: "'DejaVu Sans' default; switch to brand font for premium themes.",
  },
  "property_pin.content.text_size_px": {
    title: "Pin text size",
    desc: "Font size of the monogram or text inside the pin. Should fit visually inside the pin head.",
    example: "30px for a 120px-wide pin head.",
  },
  "property_pin.content.icon_color": {
    title: "Icon color",
    desc: "Hex color of the built-in icon glyph (e.g. the house) inside the pin head. Distinct from text color so you can mix.",
    example: "#000000 for a black house icon on a white pin.",
  },
  "property_pin.content.content_b64": {
    title: "Custom SVG (base64)",
    desc: "Base64-encoded SVG bytes — used when pin mode is 'custom_svg'. Lets you bring your own pin artwork without a network fetch.",
    example: "Used by the upload UI; you should never paste this manually.",
  },
  "property_pin.content.url": {
    title: "Custom SVG URL",
    desc: "HTTPS URL to fetch an SVG — used when pin mode is 'custom_svg' and base64 isn't supplied. Restricted to flexmedia.sydney / flexstudios.app / *.dropboxusercontent.com for security.",
    example: "https://cdn.flexmedia.sydney/pins/agency-pin.svg",
  },
  "property_pin.address_label.enabled": {
    title: "Show address under pin",
    desc: "Render the property's street address as a small label near the pin. Helps when you have multiple properties in the same shot.",
    example: "ON for orientation shots; OFF for hero shots.",
  },
  "property_pin.address_label.position": {
    title: "Address label position",
    desc: "Where the address sits relative to the pin. 'Below' is most common; 'above' is used when a roof crowds the bottom of the pin.",
    example: "'below' for the FlexMedia default.",
  },
  "property_pin.address_label.text_color": {
    title: "Address label text color",
    desc: "Hex color of the address text under the pin.",
    example: "#FFFFFF on a black background label.",
  },
  "property_pin.address_label.bg_color": {
    title: "Address label background",
    desc: "Hex color of the background behind the address text. Use 'transparent' for no fill.",
    example: "#000000 for a dark address chip; 'transparent' for floating text.",
  },
  "property_pin.address_label.font_size_px": {
    title: "Address label font size",
    desc: "Size of the address text in pixels. Should be smaller than the pin so it doesn't compete visually.",
    example: "24px for a 120px pin.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Boundary — drawing the property's land parcel polygon
  // ─────────────────────────────────────────────────────────────────────
  "boundary.enabled": {
    title: "Boundary master toggle",
    desc: "Master switch for the entire boundary pass — line, exterior treatment, side measurements, sqm total, address overlay. When OFF, the property's land parcel polygon is not drawn even if it's available in the data.",
    example: "ON for top-down/orbit shots that show the lot; OFF for ground-level oblique shots.",
  },
  "boundary.line.style": {
    title: "Boundary line style",
    desc: "How the property boundary polygon is stroked. 'Solid' is a continuous line, 'dashed' shows ~20px dashes with gaps, 'dotted' shows tight 2px dots with gaps.",
    example: "'solid' for cadastral-style boundaries; 'dashed' for a softer suggested-area look.",
  },
  "boundary.line.width_px": {
    title: "Boundary line width",
    desc: "Thickness of the boundary line in pixels at full render resolution.",
    example: "6px reads cleanly on aerials; 10-12px for high-contrast prints.",
  },
  "boundary.line.color": {
    title: "Boundary line color",
    desc: "Hex color of the boundary stroke. Pick something that contrasts with both grass and concrete for indoor/outdoor lots.",
    example: "#FFFFFF on most photography; brand colour for marketing themes.",
  },
  "boundary.line.corner_radius_px": {
    title: "Boundary corner radius",
    desc: "Corner softening for the boundary polygon. 0 keeps the cadastral angles sharp; higher values round the corners.",
    example: "0 for accurate parcel boundaries; 8-12px for a softer presentation.",
  },
  "boundary.line.shadow.enabled": {
    title: "Boundary shadow",
    desc: "Whether to drop a soft shadow behind the boundary line. Adds visual lift so the line reads against busy backgrounds.",
    example: "ON for high-contrast lift on bright sunny aerials.",
  },
  "boundary.line.shadow.color": {
    title: "Shadow color",
    desc: "Hex color of the boundary line drop shadow. Almost always black for maximum lift.",
    example: "#000000 for the standard drop shadow.",
  },
  "boundary.line.shadow.offset_x_px": {
    title: "Shadow offset X",
    desc: "Horizontal shift of the shadow from the line, in pixels. Positive moves it right.",
    example: "0 for a centred shadow; 2-4px for a directional cast.",
  },
  "boundary.line.shadow.offset_y_px": {
    title: "Shadow offset Y",
    desc: "Vertical shift of the shadow from the line, in pixels. Positive moves it down (most natural — sun above).",
    example: "4px for a soft drop below the line.",
  },
  "boundary.line.shadow.blur_px": {
    title: "Shadow blur",
    desc: "How much the shadow is softened. Larger values produce a more diffuse, premium feel.",
    example: "6px is balanced; 12-20px for very soft glow.",
  },
  "boundary.exterior_treatment.blur_enabled": {
    title: "Blur outside boundary",
    desc: "Blur everything OUTSIDE the property's land parcel so the eye is drawn to the property. Common in agency marketing renders to mute neighbours and streets.",
    example: "ON for a focus-on-property marketing render; OFF for an honest geographic context shot.",
  },
  "boundary.exterior_treatment.blur_strength_px": {
    title: "Blur strength",
    desc: "How much to blur the area outside the boundary, in pixels (Gaussian kernel size). Higher = softer / more dreamlike.",
    example: "0 = no blur; 11-21px for a noticeable soft-focus halo around the lot.",
  },
  "boundary.exterior_treatment.darken_factor": {
    title: "Darken outside",
    desc: "Multiplier applied to the brightness of the exterior. 1.0 = unchanged; lower values darken the surroundings to push the property forward.",
    example: "1.0 = no change; 0.6 darkens the outside ~40% for a vignette effect.",
  },
  "boundary.exterior_treatment.hue_shift_degrees": {
    title: "Hue shift outside",
    desc: "Rotates the colours outside the boundary by N degrees on the colour wheel. Use sparingly — strong shifts look unnatural.",
    example: "0 = no shift; 15-30° for a subtle warm/cool exterior.",
  },
  "boundary.exterior_treatment.saturation_factor": {
    title: "Saturation outside",
    desc: "Multiplier applied to the colour intensity outside the boundary. 1.0 = unchanged; below 1 desaturates (good for focus); above 1 boosts.",
    example: "1.0 = no change; 0.4 = nearly black-and-white outside, 'pop' the lot.",
  },
  "boundary.exterior_treatment.lightness_factor": {
    title: "Lightness outside",
    desc: "Multiplier applied to the lightness/value outside the boundary. Compounds with darken_factor — usually leave this at 1.0 and use darken_factor instead.",
    example: "1.0 in most themes; tweak for fine HSV control.",
  },
  "boundary.side_measurements.enabled": {
    title: "Side measurements",
    desc: "Label each edge of the property polygon with its real-world length (calculated from the GPS coords). Helpful for buyers gauging frontage.",
    example: "ON for cadastral-style site plans; OFF for clean marketing shots.",
  },
  "boundary.side_measurements.unit": {
    title: "Measurement unit",
    desc: "Whether to show side lengths in metres or feet. Choose based on your market — Australia / NZ / EU use metres; US uses feet.",
    example: "'metres' for AU/NZ; 'feet' for US listings.",
  },
  "boundary.side_measurements.decimals": {
    title: "Decimal places",
    desc: "How many decimal places to show on each side measurement. 0 for whole metres, 1 for one-decimal precision, 2 for survey-level detail.",
    example: "1 → '12.4m'; 0 → '12m'.",
  },
  "boundary.side_measurements.position": {
    title: "Measurement position",
    desc: "Whether to draw side labels OUTSIDE the polygon (cleaner on busy interiors) or INSIDE (cleaner on busy exteriors).",
    example: "'outside' is the safe default for most lots.",
  },
  "boundary.side_measurements.text_color": {
    title: "Measurement text color",
    desc: "Hex color of the side-length text.",
    example: "#FFFFFF for white text on aerials.",
  },
  "boundary.side_measurements.text_outline_color": {
    title: "Measurement outline color",
    desc: "Hex color of the stroke around each measurement letter — keeps text readable against any background.",
    example: "#000000 to outline white text in black.",
  },
  "boundary.side_measurements.text_outline_width_px": {
    title: "Measurement outline width",
    desc: "Thickness of the stroke around each measurement letter. Larger = more legible on busy backgrounds.",
    example: "3px is balanced; 5px for very busy aerial backgrounds.",
  },
  "boundary.side_measurements.font_size_px": {
    title: "Measurement font size",
    desc: "Size of the side-length text in pixels.",
    example: "28px reads well at MLS web; 36-44px for big-print site plans.",
  },
  "boundary.side_measurements.font_family": {
    title: "Measurement font",
    desc: "Font family for side measurements. A bold sans-serif works best at small sizes.",
    example: "'DejaVu Sans' default; consider a brand font for premium themes.",
  },
  "boundary.sqm_total.enabled": {
    title: "Total area label",
    desc: "Render the total area of the polygon (in square metres) somewhere near or inside the boundary. Useful headline for site plans.",
    example: "ON for site plans / land sales; OFF for clean photography.",
  },
  "boundary.sqm_total.text_template": {
    title: "Total area template",
    desc: "Template for the area label. {sqm} is replaced with the calculated area as an integer with thousands separators.",
    example: "'{sqm} sqm approx' → '1,250 sqm approx'.",
  },
  "boundary.sqm_total.position": {
    title: "Total area position",
    desc: "Where the total-area label sits relative to the polygon. 'Centroid' is the visual centre; the corner options place it near a polygon extremity.",
    example: "'centroid' for visual balance; 'top_left' to keep it out of the building.",
  },
  "boundary.sqm_total.text_color": {
    title: "Total area text color",
    desc: "Hex color of the area total text.",
    example: "#FFFFFF on a transparent or dark background.",
  },
  "boundary.sqm_total.bg_color": {
    title: "Total area background",
    desc: "Hex color of the rectangle behind the area text. Use 'transparent' for floating text.",
    example: "'transparent' for floating; #000000 with ~80% opacity for a chip.",
  },
  "boundary.sqm_total.font_size_px": {
    title: "Total area font size",
    desc: "Font size of the total-area headline. Typically the largest text on the boundary, since this is the headline number.",
    example: "64px for site-plan headline; 88-96px for marketing renders.",
  },
  "boundary.sqm_total.shadow.enabled": {
    title: "Total area shadow",
    desc: "Whether to drop a soft shadow behind the area total text. Helps it read against busy backgrounds.",
    example: "ON for big-format prints; OFF for plain backgrounds.",
  },
  "boundary.sqm_total.shadow.color": {
    title: "Total area shadow color",
    desc: "Hex color of the area-total drop shadow.",
    example: "#000000 for the standard black drop.",
  },
  "boundary.sqm_total.shadow.offset_x_px": {
    title: "Total area shadow X",
    desc: "Horizontal shift of the shadow from the text, in pixels.",
    example: "2px for a slight directional cast.",
  },
  "boundary.sqm_total.shadow.offset_y_px": {
    title: "Total area shadow Y",
    desc: "Vertical shift of the shadow from the text, in pixels (positive = down).",
    example: "4px for a natural drop.",
  },
  "boundary.sqm_total.shadow.blur_px": {
    title: "Total area shadow blur",
    desc: "How much the shadow is softened.",
    example: "8px for a soft premium drop.",
  },
  "boundary.address_overlay.enabled": {
    title: "Address overlay",
    desc: "Render the property's address as text near the boundary polygon. Useful when the boundary is shown without a property pin.",
    example: "ON for site-plan style renders; OFF when the property pin already shows the address.",
  },
  "boundary.address_overlay.position": {
    title: "Address overlay position",
    desc: "Where to place the address relative to the polygon centroid. 'centroid' overlaps with the sqm total; 'below_sqm' sits just under it; 'above_sqm' sits just above.",
    example: "'below_sqm' to stack address under the area headline.",
  },
  "boundary.address_overlay.text_template": {
    title: "Address overlay template",
    desc: "Template for the address text. {address} is the full string; {street_number} and {street_name} let you compose custom formats.",
    example: "'{street_number} {street_name}' → '42 Oak Street'.",
  },
  "boundary.address_overlay.text_color": {
    title: "Address overlay color",
    desc: "Hex color of the address overlay text.",
    example: "#FFFFFF on dark backgrounds; brand colour for stylised themes.",
  },
  "boundary.address_overlay.font_size_px": {
    title: "Address overlay font size",
    desc: "Font size of the address overlay text. Usually smaller than the sqm total headline.",
    example: "36px to sit under a 64px sqm headline.",
  },
  "boundary.address_overlay.shadow_enabled": {
    title: "Address shadow",
    desc: "Whether to draw a soft shadow behind the address text for readability on busy backgrounds.",
    example: "ON for marketing renders shot over patchy lots.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // POI selection — which POIs are picked from the data
  // ─────────────────────────────────────────────────────────────────────
  "poi_selection.radius_m": {
    title: "POI search radius",
    desc: "Distance from the property to search for points of interest, in metres. 1500m = ~10-min walk. Increase for rural properties; decrease for dense urban areas where there are too many candidates.",
    example: "1500m for typical suburbs; 3000m for rural / acreage; 800m for dense CBD apartments.",
  },
  "poi_selection.max_pins_per_shot": {
    title: "Max POIs per shot",
    desc: "Hard cap on how many POI labels appear on each rendered shot. Too many = visual clutter. 5-8 is the sweet spot for residential drone deliverables.",
    example: "6 for residential; 3-4 for clean hero shots; 10 for buyer-info gallery shots.",
  },
  "poi_selection.min_separation_px": {
    title: "Minimum label separation",
    desc: "Minimum distance in pixels between two adjacent POI labels. The renderer drops lower-priority POIs that would overlap their neighbours.",
    example: "220px keeps labels visually distinct on a 4K aerial.",
  },
  "poi_selection.curation": {
    title: "POI curation mode",
    desc: "How the POI list is built. 'auto' uses the type quotas to fill in nearby POIs automatically. 'manual_only' renders ONLY the POIs explicitly attached to the listing — nothing auto-discovered.",
    example: "'auto' for standard listings; 'manual_only' for premium hand-curated marketing decks.",
  },
  "poi_selection.type_quotas": {
    title: "POI type quotas",
    desc: "Which POI categories appear on rendered shots, with per-type caps. Default selection covers the major real-estate-relevant categories (schools, trains, hospitals, shopping centres, parks, beaches). De-select what's not relevant to your market. Per-type Max sets how many of that type can appear; Priority decides which types fill the global Max-pins-per-shot budget first when there are too many candidates.",
    example: "Schools (priority 1, max 2) means schools fill the budget first, capped at 2 — un-tick them entirely if you don't want any.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Branding ribbon — top/bottom strip with logo + address (optional)
  // ─────────────────────────────────────────────────────────────────────
  "branding_ribbon.enabled": {
    title: "Branding ribbon",
    desc: "Whether to draw a coloured strip across the top or bottom of the rendered image with logo + address text. Adds an obvious branded edge to deliverables.",
    example: "ON for fully-branded MLS renders; OFF for clean editorial shots.",
  },
  "branding_ribbon.position": {
    title: "Ribbon position",
    desc: "Where to place the ribbon strip. 'bottom' is the most common (won't compete with sky for hero shots); 'top' for letterhead-style framing; 'none' hides it.",
    example: "'bottom' for the FlexMedia default.",
  },
  "branding_ribbon.height_px": {
    title: "Ribbon height",
    desc: "Height of the ribbon strip in pixels at full source resolution.",
    example: "80px for a slim chip; 120-160px for a chunkier letterhead feel.",
  },
  "branding_ribbon.bg_color": {
    title: "Ribbon background color",
    desc: "Hex color of the ribbon strip. Usually a brand colour or pure black.",
    example: "#000000 for a clean black bar; #C8102E for Belle Property red.",
  },
  "branding_ribbon.text_color": {
    title: "Ribbon text color",
    desc: "Hex color of any text shown on the ribbon (address, shot ID).",
    example: "#FFFFFF on a black ribbon.",
  },
  "branding_ribbon.show_org_logo": {
    title: "Show logo on ribbon",
    desc: "Whether to render your agency logo on the ribbon. Pulled from the brand asset reference below.",
    example: "ON for branded deliverables; OFF for plain text-only ribbons.",
  },
  "branding_ribbon.logo_asset_ref": {
    title: "Logo asset",
    desc: "Reference to a branding asset used as the logo on the ribbon. Looked up from your brand assets list.",
    example: "'agency_logo_white' for the white-on-dark version.",
  },
  "branding_ribbon.logo_position": {
    title: "Logo position",
    desc: "Whether the logo sits on the left or right edge of the ribbon. The opposite side typically holds the address.",
    example: "'left' for logo-then-address; 'right' for address-then-logo.",
  },
  "branding_ribbon.logo_height_px": {
    title: "Logo height",
    desc: "Height of the logo image on the ribbon, in pixels. Should fit comfortably inside the ribbon height.",
    example: "60px inside an 80px ribbon (leaves 10px padding top + bottom).",
  },
  "branding_ribbon.show_address": {
    title: "Show address on ribbon",
    desc: "Whether to print the property's address on the ribbon. Most agencies do this on every deliverable.",
    example: "ON for standard MLS renders.",
  },
  "branding_ribbon.address_font_size_px": {
    title: "Ribbon address font size",
    desc: "Size of the address text on the ribbon, in pixels.",
    example: "28px in an 80px ribbon for balanced spacing.",
  },
  "branding_ribbon.show_shot_id": {
    title: "Show shot ID",
    desc: "Whether to include the internal shot identifier on the ribbon. Useful for QA / proofing rounds; usually OFF for client-delivered renders.",
    example: "ON during QA passes; OFF for final deliverables.",
  },

  // ─────────────────────────────────────────────────────────────────────
  // Output variants — per-deliverable resize + recompress
  // ─────────────────────────────────────────────────────────────────────
  "output_variants[].name": {
    title: "Variant name",
    desc: "Internal name for this output variant — surfaced in filenames and the deliverables UI. Use snake_case.",
    example: "'mls_web', 'instagram_square', 'hero_print'.",
  },
  "output_variants[].format": {
    title: "Image format",
    desc: "File format for this variant. JPEG is smaller (best for web/MLS), PNG is lossless (best for graphics with hard edges), TIFF is for print pipelines that demand it.",
    example: "JPEG for MLS / Instagram; PNG when transparency or hard graphics matter.",
  },
  "output_variants[].quality": {
    title: "JPEG quality",
    desc: "JPEG compression quality (1-100). Higher = larger files but cleaner detail. The renderer auto-steps quality DOWN if max_bytes is set and exceeded.",
    example: "88 is the agency-quality sweet spot; 92+ for premium print; 75 for tiny thumbnails.",
  },
  "output_variants[].target_width_px": {
    title: "Target width",
    desc: "Target output width in pixels. The renderer resizes down from the full source resolution; height comes from the chosen aspect.",
    example: "2400 for MLS web; 1080 for Instagram; 4000 for print masters.",
  },
  "output_variants[].aspect": {
    title: "Aspect / crop",
    desc: "How the rendered image is cropped. 'preserve' keeps the original 4:3 from the drone; 'crop_1_1' for Instagram square; 'crop_16_9' for YouTube / hero banners; 'crop_4_5' for Instagram portrait.",
    example: "'preserve' for MLS; 'crop_1_1' for Instagram feed; 'crop_4_5' for IG portrait.",
  },
  "output_variants[].max_bytes": {
    title: "Maximum file size",
    desc: "Hard limit on file size in bytes. If a JPEG variant exceeds this, the renderer steps quality down (in 5pt increments down to 50) until it fits. Ignored for PNG/TIFF.",
    example: "4_000_000 (4 MB) is a safe MLS upload limit; 1_500_000 for fast-loading Instagram.",
  },
  "output_variants[].color_profile": {
    title: "Color profile",
    desc: "Colour space tag baked into the output. 'sRGB' is the universal web standard. 'Adobe RGB' is wider-gamut for print pipelines that handle it correctly.",
    example: "'sRGB' for MLS / web / Instagram (always); 'Adobe_RGB' only when the print shop confirms support.",
  },
};

/**
 * Convenience helper — returns the help record for a key, or null. Avoids
 * subagent B having to import THEME_HELP_TEXT separately when integrating.
 */
export function getHelp(fieldKey) {
  return THEME_HELP_TEXT[fieldKey] || null;
}
