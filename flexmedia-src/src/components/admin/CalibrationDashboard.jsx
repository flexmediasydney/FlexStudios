/**
 * Wave 14 — re-export of the calibration dashboard at the per-spec path.
 *
 * The main implementation lives at `pages/CalibrationDashboard.jsx` to match
 * the existing admin-page convention (Stage4Overrides, EngineDashboard,
 * MasterListingReview all live in `pages/`). This component-tree alias lets
 * downstream importers reference the W14 spec path without duplicating code.
 */
export { default } from "@/pages/CalibrationDashboard.jsx";
