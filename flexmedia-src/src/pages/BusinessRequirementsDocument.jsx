import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import jsPDF from "jspdf";
import {
  BookOpen, Search, ChevronDown, ChevronRight, FileText, Shield,
  Zap, CheckCircle2, AlertTriangle, Lock, Info, ArrowRight,
  Users, Building, Camera, Calendar, Mail, DollarSign, Package,
  BarChart2, Settings, Clock, History, RefreshCw, Eye, Network,
  Tag, Layers, TrendingUp, GitBranch, Percent, ToggleLeft,
  Database, Cpu, Globe, Smartphone, AlertCircle, Star,
  Target, Activity, Filter, Download, Upload, Bell
} from "lucide-react";

// ─── DOCUMENT METADATA ───────────────────────────────────────────────────────

const DOC_META = {
  title: "Business Requirements Document",
  subtitle: "Flex Studios — Internal System Specification",
  version: "2.8.0",
  status: "Living Document",
  classification: "Internal — Confidential",
  author: "Business Analysis Office",
  lastUpdated: "March 15, 2026",
  description:
    "This document constitutes the authoritative, comprehensive specification of all functional and non-functional requirements for the Flex Studios platform. It is maintained as a living document and updated continuously as the system evolves. All requirements herein have been validated against the implemented system.",
};

// ─── REQUIREMENT TYPE CONFIG ───────────────────────────────────────────────

const TYPE_CONFIG = {
  FR:  { label: "Functional",     short: "FR",  className: "bg-blue-100 text-blue-700 border-blue-200" },
  NFR: { label: "Non-Functional", short: "NFR", className: "bg-purple-100 text-purple-700 border-purple-200" },
  BR:  { label: "Business Rule",  short: "BR",  className: "bg-amber-100 text-amber-700 border-amber-200" },
  CON: { label: "Constraint",     short: "CON", className: "bg-red-100 text-red-700 border-red-200" },
  ARC: { label: "Architecture",   short: "ARC", className: "bg-slate-100 text-slate-700 border-slate-200" },
  SEC: { label: "Security",       short: "SEC", className: "bg-rose-100 text-rose-700 border-rose-200" },
  AUD: { label: "Audit",         short: "AUD", className: "bg-teal-100 text-teal-700 border-teal-200" },
  UX:  { label: "UX / UI",       short: "UX",  className: "bg-indigo-100 text-indigo-700 border-indigo-200" },
  INT: { label: "Integration",    short: "INT", className: "bg-green-100 text-green-700 border-green-200" },
};

const PRIORITY_CONFIG = {
  Critical: { className: "bg-red-500 text-white border-0" },
  High:     { className: "bg-orange-100 text-orange-700 border-orange-200" },
  Medium:   { className: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  Low:      { className: "bg-slate-100 text-slate-600 border-slate-200" },
};

// ─── ALL REQUIREMENTS ──────────────────────────────────────────────────────

const MODULES = [
  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "platform",
    title: "1. Platform Architecture & Infrastructure",
    icon: Cpu,
    color: "text-slate-700",
    bg: "bg-slate-50",
    border: "border-slate-300",
    headerBg: "bg-slate-50/80",
    summary: "Core infrastructure, technology stack, data model, and platform-level constraints.",
    requirements: [
      { id: "P-001", type: "ARC", priority: "Critical", title: "Technology Stack", desc: "The platform is built on React 18 (frontend), Base44 platform (backend-as-a-service), Tailwind CSS (styling), and shadcn/ui (component library). All business logic that requires elevated permissions or external API calls must be implemented as Deno-based backend functions." },
      { id: "P-002", type: "ARC", priority: "Critical", title: "Database Model", desc: "All entities are stored in the Base44 managed database. Every entity record automatically carries built-in fields: id (UUID), created_date, updated_date, and created_by (email of creating user). No entity may re-define these fields." },
      { id: "P-003", type: "NFR", priority: "Critical", title: "Real-Time Subscriptions", desc: "All list views and detail pages subscribe to real-time entity change events via Base44 SDK. Any create, update, or delete event emitted by any user is reflected in all connected sessions within under 1 second without requiring a page reload." },
      { id: "P-004", type: "NFR", priority: "High", title: "Query Performance", desc: "Frequently accessed names (agency_name, client_name, product_name, etc.) are denormalised and cached directly on referencing records to eliminate the need for join-style multi-fetch operations on list views." },
      { id: "P-005", type: "ARC", priority: "High", title: "React Query Caching", desc: "All entity data fetching uses TanStack React Query with staleTime: 0 and gcTime: 0 configured globally to ensure data freshness across navigation without stale cache serving outdated records." },
      { id: "P-006", type: "NFR", priority: "High", title: "Responsive Design", desc: "Every page and component must be fully functional on screens from 375px (mobile) through to 2560px (large desktop). Sidebar navigation collapses to a hamburger menu on viewports below 1024px (lg breakpoint)." },
      { id: "P-007", type: "SEC", priority: "Critical", title: "Authentication Gateway", desc: "All pages are protected by the Base44 authentication layer. Unauthenticated users are redirected to the platform login. Session tokens are managed by the Base44 SDK and are not stored in application code." },
      { id: "P-008", type: "ARC", priority: "Critical", title: "Role-Based Access Control (RBAC)", desc: "Two user roles exist: master_admin (full system access) and employee (operational access including settings). All access checks are enforced both client-side (component rendering) and server-side (backend function guards)." },
      { id: "P-009", type: "NFR", priority: "Medium", title: "Error Boundary Behaviour", desc: "Runtime errors in non-critical UI sections must not crash the entire application. Critical path errors (auth, data load) surface clearly. Non-critical errors are surfaced inline. Try-catch is only used in backend functions and intentional async flows." },
      { id: "P-010", type: "ARC", priority: "High", title: "Backend Function Pattern", desc: "All backend functions follow the Deno.serve() handler pattern, authenticate the calling user via createClientFromRequest(req), validate role if required, and return a structured JSON response. Functions are invoked from the frontend exclusively via base44.functions.invoke()." },
      { id: "P-011", type: "CON", priority: "Critical", title: "Project Type Required for Price Matrix", desc: "All PriceMatrix records must have a non-null project_type_id. Global/legacy pricing matrices (with null project_type_id) are no longer permitted. The pricing hierarchy is strictly project-type-specific: Agent Matrix (for type X) → Agency Matrix (for type X) → Master Default pricing (for type X). Attempting to create a price matrix without selecting a project type is rejected at both the UI and backend entity level." },
      ],
      },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "auth_rbac",
    title: "2. Authentication & Role Management",
    icon: Shield,
    color: "text-rose-700",
    bg: "bg-rose-50",
    border: "border-rose-200",
    headerBg: "bg-rose-50/60",
    summary: "User authentication, role definitions, permission matrices, and access enforcement.",
    requirements: [
      { id: "A-001", type: "FR", priority: "Critical", title: "User Roles Defined", desc: "master_admin: unrestricted access, can manage all users, settings, pricing, and data. employee: can access settings (Products, Pricing, Organisation) and all projects." },
      { id: "A-002", type: "SEC", priority: "Critical", title: "Admin-Only Backend Guards", desc: "Any backend function performing sensitive operations (data resets, admin-level writes, snapshot generation) must validate the calling user's role is 'master_admin' and return HTTP 403 if not." },
      { id: "A-003", type: "FR", priority: "High", title: "PermissionGuard Component", desc: "A usePermissions hook exposes a structured permissions object. Key permissions include: canManageUsers, canSeePricing, canSeeAllProjects, canEditProject. Components consume these flags to conditionally render actions and fields." },
      { id: "A-004", type: "BR", priority: "Low", title: "Staff Assignment Visibility", desc: "All users (master_admin and employee) can see all projects. Staff role assignments are used for workflow purposes only, not access control." },
      { id: "A-005", type: "FR", priority: "Medium", title: "User Invitation Flow", desc: "Only authenticated users with admin or employee roles can invite new users via base44.users.inviteUser(email, role). Admin-level invitation (role='admin') is restricted to master_admin users only." },
      { id: "A-006", type: "UX", priority: "Medium", title: "Role Visibility in UI", desc: "The sidebar footer displays the currently authenticated user's full name and role badge (colour-coded: red=Admin, blue=Employee, amber=Contractor). Users can always identify their own role without navigating to settings." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "client_hierarchy",
    title: "3. Client Hierarchy (Agencies, Teams, Agents)",
    icon: Network,
    color: "text-blue-700",
    bg: "bg-blue-50",
    border: "border-blue-200",
    headerBg: "bg-blue-50/60",
    summary: "Three-tier client structure, hierarchy rules, deletion constraints, and relationship management.",
    requirements: [
      { id: "C-001", type: "BR", priority: "Critical", title: "Three-Tier Hierarchy", desc: "The client data model follows a strict three-tier hierarchy: Agency (top) → Team (optional middle) → Agent (bottom). An Agent must belong to exactly one Agency. Team membership is optional. An Agency may have zero or more Teams and zero or more Agents directly." },
      { id: "C-002", type: "CON", priority: "Critical", title: "Agency Deletion Constraint", desc: "An Agency cannot be deleted if it has any associated Teams or Agents. The system must check and reject the deletion attempt with a clear user-facing message listing the blocking dependencies." },
      { id: "C-003", type: "CON", priority: "Critical", title: "Team Deletion Constraint", desc: "A Team cannot be deleted if it has any associated Agents. The system must check and reject the deletion attempt, listing the blocking Agents." },
      { id: "C-004", type: "FR", priority: "High", title: "Agent Free Deletion", desc: "Individual Agents can be deleted without dependency checks. Deletion is a hard delete — the Agent record is permanently removed from the database." },
      { id: "C-005", type: "AUD", priority: "High", title: "Full Audit Trail for Client Hierarchy", desc: "Every create, update, and delete operation on Agency, Team, and Agent entities is logged to the AuditLog entity, capturing: entity_type, entity_id, entity_name, action, changed_fields (field-level old→new diffs), previous_state, new_state, user_name, and user_email." },
      { id: "C-006", type: "BR", priority: "High", title: "Relationship State Lifecycle", desc: "Agencies and Agents carry a relationship_state field with values: Prospecting, Active, Dormant, Do Not Contact. State transitions are tracked with became_active_date and became_dormant_date timestamps to support lifecycle analytics." },
      { id: "C-007", type: "FR", priority: "High", title: "Agent Prospecting Status", desc: "Agents in Prospecting state have a granular status field (New Lead, Researching, Attempted Contact, Discovery Call Scheduled, Proposal Sent, Nurturing, Qualified, Unqualified, Converted to Client, Lost) for CRM pipeline tracking." },
      { id: "C-008", type: "FR", priority: "Medium", title: "Multiple Hierarchy View Modes", desc: "The Clients module must support at minimum five visualisation modes for hierarchy data: Tree, Org Chart, List, Grid, and Table. Users can switch between modes without data loss." },
      { id: "C-009", type: "FR", priority: "Medium", title: "Cross-Entity Search", desc: "Search within the Clients module must operate across Agency name, Team name, Agent name, and Agent email simultaneously. Search is case-insensitive and performs substring matching." },
      { id: "C-010", type: "ARC", priority: "Medium", title: "Denormalised Name Caching", desc: "Agent records cache current_agency_name and current_team_name. Projects cache client_name (agent name). These cached values must be updated whenever the source entity name is changed to maintain display consistency." },
      { id: "C-011", type: "FR", priority: "Medium", title: "Past Affiliations History", desc: "Agents maintain a past_affiliations array recording previous Agency and Team affiliations with start_date and end_date. This preserves the full employment/agency history of each agent." },
      { id: "C-012", type: "FR", priority: "Low", title: "Club Flex Membership Flag", desc: "Agents have a boolean club_flex field that enables a special pricing mode when true. This flag is checked by the pricing engine to apply Club Flex-specific pricing rules." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "projects",
    title: "4. Projects — Lifecycle & Management",
    icon: Camera,
    color: "text-indigo-700",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Project creation, lifecycle stages, status transitions, assignments, and outcome management.",
    requirements: [
      { id: "PR-001", type: "FR", priority: "Critical", title: "Project Required Fields", desc: "A project must have: title (string), client_id (reference to Agent entity), and property_address. All other fields are optional at creation. The system must reject project creation if any required field is absent." },
      { id: "PR-002", type: "BR", priority: "Critical", title: "Eight Lifecycle Stages", desc: "Projects move through eight ordered stages: To Be Scheduled → Scheduled → Onsite → Uploaded → Submitted → In Progress → Ready for Partial → Delivered. These stages are the single source of truth for project workflow position. (Simplified from eleven stages.)" },
      { id: "PR-003", type: "FR", priority: "Critical", title: "Non-Linear Stage Navigation", desc: "Projects can be moved to any stage directly — they are not restricted to sequential forward-only progression. Backwards and skip-forward transitions are permitted and recorded in the activity log." },
      { id: "PR-004", type: "FR", priority: "High", title: "Stage Entry/Re-Entry Tracking", desc: "The system distinguishes between 'entered' and 're-entered' for each lifecycle stage. Re-entry resets the time-in-stage timer. A counter tracks the total number of times a project has entered each stage, displayed as a ×N badge on the pipeline." },
      { id: "PR-005", type: "FR", priority: "High", title: "Stage Time Tracking", desc: "For every stage a project visits, the system records entry time and exit time. The pipeline UI shows: a live timer for the current stage, elapsed time for past stages, and a '—' indicator for stages not yet reached." },
      { id: "PR-006", type: "FR", priority: "High", title: "Project Outcome Tracking", desc: "Projects carry an outcome field with three values: open, won, or lost. This is independent of the lifecycle stage — a project can be 'delivered' but still 'open' from a commercial perspective." },
      { id: "PR-007", type: "FR", priority: "High", title: "Payment Status Tracking", desc: "Projects carry a payment_status field: unpaid or paid. This is independent of both stage and outcome. Marking a project paid does not automatically change its stage." },
      { id: "PR-008", type: "BR", priority: "High", title: "Single Package Constraint", desc: "A project may contain at most one Package at any time. Adding a second Package while one already exists is rejected by the system. The existing Package must be removed before a new one can be added." },
      { id: "PR-009", type: "BR", priority: "High", title: "Package Quantity Always 1", desc: "Packages on a project have a hardcoded quantity of 1. The quantity field for package line items is locked — it is not editable in any UI and is always stored as 1 in the database." },
      { id: "PR-010", type: "BR", priority: "High", title: "Product Quantity Constraints", desc: "Standalone product quantities on a project must respect the product's min_quantity (floor) and max_quantity (ceiling, if defined). These constraints are enforced by both the frontend UI stepper controls and the backend calculateProjectPricing function." },
      { id: "PR-011", type: "FR", priority: "High", title: "Quantity Change Confirmation Dialog", desc: "Any quantity change to a project's products (or any item add/remove) that has been verified by the backend must be confirmed by the user via a double-confirmation dialog that shows the backend-verified total before committing to the database." },
      { id: "PR-012", type: "FR", priority: "High", title: "Staff Assignments", desc: "Projects support multiple staff assignment roles: Project Owner, Onsite Staff 1 (Photographer), Onsite Staff 2 (Videographer), Image Editor, Video Editor. Each role can be assigned to either a User or an InternalTeam." },
      { id: "PR-013", type: "FR", priority: "Medium", title: "Staff Role Assignments", desc: "Projects use role-based staff assignments (project owner, onsite staff, image editor, video editor) for contractor visibility filtering and notification targeting." },
      { id: "PR-014", type: "FR", priority: "Medium", title: "Priority Flag", desc: "Projects have a priority field: low, normal, high, urgent. This is a display and filtering flag only — it does not affect pricing or workflow logic." },
      { id: "PR-015", type: "FR", priority: "Medium", title: "Delivery Link Management", desc: "Projects can store a delivery_link URL which is made available to clients. A delivery date field tracks when media is expected to be delivered." },
      { id: "PR-016", type: "FR", priority: "High", title: "Property Type Classification", desc: "Projects are classified by property type: residential, commercial, luxury, rental, or land. This classification is used for reporting and may affect pricing tier resolution in future rule sets." },
      { id: "PR-017", type: "AUD", priority: "High", title: "Project Activity Log", desc: "Every status change, field update, and key event on a project is logged to ProjectActivity. Each log entry records: action, changed_fields with old→new values, human-readable description, previous_state, new_state, user_name, and user_email." },
      { id: "PR-018", type: "FR", priority: "Medium", title: "Shoot Date & Time", desc: "Projects store a shoot_date (date) and shoot_time (string) for scheduling. These are used by the calendar integration and onsite timer logic." },
      { id: "PR-019", type: "FR", priority: "High", title: "Outcome & Payment Status Independence", desc: "Projects carry independent outcome (open, won, lost) and payment_status (unpaid, paid) fields. These are orthogonal to the lifecycle stage — a delivered project can still be 'open' commercially, or a project in any stage can be marked paid." },
      { id: "PR-020", type: "FR", priority: "High", title: "Staff Assignment Roles", desc: "Projects support role-based staff assignments: Project Owner, Onsite Staff 1 (Photographer), Onsite Staff 2 (Videographer), Image Editor, Video Editor. Each role can assign to either a User or InternalTeam." },
      { id: "PR-021", type: "FR", priority: "Medium", title: "Staff Role Visibility", desc: "Contractor visibility is determined by role-based staff assignments. Contractors see projects only if assigned to a staff role on that project." },
      { id: "PR-022", type: "FR", priority: "Critical", title: "Project Owner is Mandatory", desc: "Every project must have a project_owner_id assigned at creation. This field is required and serves as the fallback assignee for production role tasks (photographer, videographer, image_editor, video_editor) when their designated project roles are unassigned." },
      { id: "PR-023", type: "FR", priority: "Critical", title: "Project Readiness Validation Gate", desc: "Before a project can be saved (ProjectForm) or approved from pending_review (TonomoTab), the validateProjectReadiness function must pass. This function performs comprehensive validation of project completeness and returns a structured { valid: boolean, errors: [], warnings: [] } response." },
      { id: "PR-024", type: "BR", priority: "Critical", title: "Validation: Property Address Required", desc: "A project cannot be saved or approved without a non-empty property_address value. The validateProjectReadiness function checks: project.property_address?.trim() is truthy. Attempting to save/approve without an address generates the error: 'Property address is required'." },
      { id: "PR-025", type: "BR", priority: "Critical", title: "Validation: Agent Required", desc: "A project cannot be saved or approved without an agent_id. The validateProjectReadiness function checks: project.agent_id is defined and non-null. Attempting to save/approve without an agent generates the error: 'Agent is required'." },
      { id: "PR-026", type: "BR", priority: "Critical", title: "Validation: Project Type Required", desc: "A project cannot be saved or approved without a project_type_id (reference to ProjectType entity). The validateProjectReadiness function checks: project.project_type_id is defined and non-null. Attempting to save/approve without a project type generates the error: 'Project type is required'." },
      { id: "PR-027", type: "BR", priority: "High", title: "Validation: Products or Packages Required", desc: "A project must contain at least one Product or one Package before it can be saved or approved. The validateProjectReadiness function checks: (project.products?.length || 0) > 0 OR (project.packages?.length || 0) > 0. Attempting to save/approve an empty project generates the error: 'At least one product or package is required'." },
      { id: "PR-028", type: "BR", priority: "High", title: "Validation: Pricing Tier Default Warning", desc: "If a project has no pricing_tier set, validateProjectReadiness returns a warning (not an error): 'Pricing tier not set — will default to Standard'. The project can still be saved/approved, but the warning alerts admins to the default behaviour." },
      { id: "PR-029", type: "BR", priority: "High", title: "Validation: Photographer Required by Product Category", desc: "If a project contains products/packages with categories photography, drone, virtual_staging, or floor_plan, the project must have a photographer assigned (project.photographer_id OR project.onsite_staff_1_id). Validation error: 'Photographer required — booking includes photography, drone, floor plan, or virtual staging services'." },
      { id: "PR-030", type: "BR", priority: "High", title: "Validation: Videographer Required by Product Category", desc: "If a project contains products/packages with category video, the project must have a videographer assigned (project.videographer_id OR project.onsite_staff_2_id). Validation error: 'Videographer required — booking includes video services'." },
      { id: "PR-031", type: "BR", priority: "High", title: "Validation: Nested Product Category Resolution", desc: "When validating role requirements, the system checks product categories both at the standalone product level AND within packages (nested products). A package that contains a photography product requires a photographer, even if the package itself has a different category classification." },
      { id: "PR-032", type: "BR", priority: "Critical", title: "Validation: Cancellation Review Type Bypass", desc: "When project.pending_review_type === 'cancellation', the validateProjectReadiness function skips ALL validation and returns { valid: true, errors: [], warnings: [] }. This allows cancellation confirmations to proceed without standard readiness checks." },
      ],
      },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "pricing",
    title: "5. Pricing Engine & Price Matrix",
    icon: DollarSign,
    color: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    headerBg: "bg-emerald-50/60",
    summary: "Master pricing, matrix hierarchy, discount modes, project price locking, and calculation engine.",
    requirements: [
      { id: "PM-001", type: "BR", priority: "Critical", title: "Pricing Resolution Priority", desc: "When calculating a project's price, the engine resolves pricing in this order: (1) Agent-specific PriceMatrix → (2) Agency-level PriceMatrix → (3) Master default pricing on Products/Packages. The most specific setting always wins. The first match terminates the lookup." },
      { id: "PM-002", type: "BR", priority: "Critical", title: "Price Lock at Project Creation", desc: "When a project is created (or pricing is saved after an edit), the calculated price is locked into the project record. Subsequent changes to the price matrix or master prices do NOT retroactively affect any existing project." },
      { id: "PM-003", type: "BR", priority: "Critical", title: "Price Matrix Snapshot on Project", desc: "A full snapshot of the price matrix settings applied at calculation time is stored on the project record (price_matrix_snapshot). This snapshot provides complete audit transparency for historical price reconstruction." },
      { id: "PM-004", type: "FR", priority: "Critical", title: "Three Pricing Modes", desc: "A PriceMatrix entity can operate in exactly one of three modes at any time: (1) Default Mode (use_default_pricing = true): master prices applied directly. (2) Blanket Discount Mode (blanket.enabled = true): single percentage discount applied to all products/packages. (3) Per-Item Override Mode: individual product/package prices set independently with per-item toggle." },
      { id: "PM-005", type: "BR", priority: "High", title: "Blanket Discount Independence", desc: "Within Blanket Discount Mode, product_percent and package_percent are independent fields. A 10% product discount and 5% package discount can be applied simultaneously. Discounts are always calculated from master prices — never from previously stored override values." },
      { id: "PM-006", type: "CON", priority: "High", title: "Blanket Disables Per-Item Overrides", desc: "Enabling Blanket Discount Mode disables all per-item override toggles. Switching back to Per-Item mode re-enables overrides — existing override data in the database is preserved and not lost during mode switching." },
      { id: "PM-007", type: "BR", priority: "High", title: "Per-Item Override Pre-Fill", desc: "When a per-item override is toggled ON for a product or package, all price fields are automatically pre-populated with the current master prices as a starting point. Admins can then adjust from that baseline." },
      { id: "PM-008", type: "FR", priority: "High", title: "Two Product Override Fields", desc: "Products support four independent override fields per PriceMatrix entry: Standard Base Price, Standard Unit Price, Premium Base Price, Premium Unit Price. Each field is independently editable." },
      { id: "PM-009", type: "FR", priority: "High", title: "Two Package Override Fields", desc: "Packages support two flat override price fields: Standard Price and Premium Price. No unit-based pricing applies to packages." },
      { id: "PM-010", type: "FR", priority: "High", title: "Pricing Tier per Project", desc: "Each project has a pricing_tier field: standard or premium. This tier determines which tier's prices are applied from the resolved price matrix at calculation time." },
      { id: "PM-011", type: "FR", priority: "High", title: "Fixed vs Per-Unit Product Pricing", desc: "Products have a pricing_type: 'fixed' (flat price regardless of quantity) or 'per_unit' (base_price + unit_price × quantity). For per_unit products, quantity controls are enabled in the project pricing table. For fixed products, quantity is displayed but the control is locked." },
      { id: "PM-012", type: "NFR", priority: "High", title: "Backend-Authoritative Calculation", desc: "All final project pricing must be calculated server-side by the calculateProjectPricing backend function. Frontend pricing calculators are for live display only and must never be used as the source of truth for values written to the database." },
      { id: "PM-013", type: "FR", priority: "High", title: "Automatic Catalogue Sync Detection", desc: "The price matrix editor automatically detects when new products or packages are added to the master catalogue via real-time subscription. New items are highlighted with a badge and a notification banner prompts admins to review pricing for the new items." },
      { id: "PM-014", type: "BR", priority: "High", title: "New Items Inherit Correct Mode Pricing", desc: "When a new product/package appears: Default Mode — included automatically at master price. Blanket Mode — automatically covered by the blanket discount. Per-Item Mode — appears with override OFF, falls back to master price; admin can optionally set an override." },
      { id: "PM-015", type: "CON", priority: "High", title: "No Auto-Save on Catalogue Change", desc: "Detecting a new catalogue item does NOT auto-save the price matrix. The admin must explicitly save after reviewing the new item's pricing." },
      { id: "PM-016", type: "BR", priority: "Medium", title: "Master Price Drift Detection", desc: "When a per-item override is active, the master price at the time the override was set is captured. If the master price subsequently changes, a drift indicator ('was $X') is displayed in the editor, alerting admins that the master has moved since the override was established." },
      { id: "PM-017", type: "SEC", priority: "High", title: "Admin-Only Price Matrix Editing", desc: "Only users with master_admin or employee roles can modify price matrices. Non-admin users see a Read Only badge and all inputs are disabled. This restriction is enforced at both the UI component level and the backend function level." },
      { id: "PM-018", type: "NFR", priority: "Medium", title: "Price Validation & Clamping", desc: "All numeric pricing inputs are validated: negative prices floored to 0, discount percentages clamped to 0–100. This validation is performed both client-side on blur and server-side in calculateProjectPricing before any persistence." },
      { id: "PM-019", type: "AUD", priority: "High", title: "Price Matrix Audit Log", desc: "Every save to a PriceMatrix entity is recorded in PriceMatrixAuditLog with a field-level diff of all changed values, the user who made the change, and a timestamp." },
      { id: "PM-020", type: "AUD", priority: "Medium", title: "Monthly Price Matrix Snapshots", desc: "On the 1st of each month, a scheduled automation runs generateMonthlyPriceMatrixSnapshots, saving a full snapshot of all PriceMatrix records to PriceMatrixSnapshot. Manual snapshots can be triggered by admins at any time." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "products_packages",
    title: "6. Products & Packages Catalogue",
    icon: Package,
    color: "text-violet-700",
    bg: "bg-violet-50",
    border: "border-violet-200",
    headerBg: "bg-violet-50/60",
    summary: "Product and package definitions, pricing structure, task templates, and catalogue management.",
    requirements: [
      { id: "PP-001", type: "FR", priority: "Critical", title: "Product Two-Tier Structure", desc: "Every product has independent Standard and Premium tier configurations. Each tier contains: base_price, unit_price, onsite_time (minutes), onsite_time_increment (per unit, minutes), admin_time (minutes), and editor_time (minutes)." },
      { id: "PP-002", type: "BR", priority: "Critical", title: "Fixed vs Per-Unit Pricing Type", desc: "Products declare a pricing_type: 'fixed' (one flat price regardless of quantity) or 'per_unit' (base_price plus unit_price multiplied by quantity). This type governs both the display and calculation behaviour at the project level." },
      { id: "PP-003", type: "FR", priority: "High", title: "Min/Max Quantity Enforcement", desc: "Products can define min_quantity (the floor, cannot go below) and max_quantity (the ceiling, optional). These constraints are enforced in both the project booking UI and the calculateProjectPricing backend function." },
      { id: "PP-004", type: "FR", priority: "High", title: "Product Classification Fields", desc: "Products have two classification fields: product_type (core or addon) and category (photography, video, drone, editing, virtual_staging, other). These are used for display grouping and filtering — they do not affect pricing calculation." },
      { id: "PP-005", type: "FR", priority: "High", title: "Dusk Only Flag", desc: "Products can be flagged as dusk_only = true, indicating availability only for dusk shoots. This is a display/booking-stage advisory flag and does not restrict the product programmatically." },
      { id: "PP-006", type: "FR", priority: "High", title: "Task Templates per Tier", desc: "Products carry separate standard_task_templates and premium_task_templates arrays. Each template specifies: title, description, auto_assign_role (none, project_owner, photographer, videographer, image_editor, video_editor), and depends_on_indices for task dependency chaining within the same product." },
      { id: "PP-007", type: "FR", priority: "High", title: "Package = Bundle of Products", desc: "A Package references one or more products by ID with a specified quantity per product. The package has its own flat Standard and Premium prices, independent of the sum of individual product prices. Packages also carry per-tier time estimates." },
      { id: "PP-008", type: "FR", priority: "High", title: "Package Task Templates", desc: "Packages carry standard_task_templates and premium_task_templates arrays with the same structure as product task templates, applied at the package level when a package is booked." },
      { id: "PP-009", type: "BR", priority: "High", title: "Soft Deactivation Preferred Over Deletion", desc: "Products and packages should be deactivated (is_active = false) rather than permanently deleted. Deactivated items are hidden from booking UIs and excluded from pricing calculations. All audit history and price matrix overrides are preserved." },
      { id: "PP-010", type: "BR", priority: "High", title: "Inactive Items Excluded from Pricing", desc: "The calculateProjectPricing backend function filters out all products and packages where is_active = false before computing any totals. Inactive items are silently skipped and never contribute to project pricing." },
      { id: "PP-011", type: "CON", priority: "Medium", title: "Deletion is Permanent and Audited", desc: "Permanent deletion of a product or package requires explicit double confirmation. Deletion is logged in the ProductAuditLog or PackageAuditLog with the full previous state. Price matrix override data for the deleted item becomes orphaned (preserved in DB, no longer shown)." },
      { id: "PP-012", type: "AUD", priority: "High", title: "Full Catalogue Change Audit", desc: "Every create, update, and delete operation on Product and Package entities is logged to ProductAuditLog and PackageAuditLog respectively, with field-level diffs, user context, and timestamps." },
      { id: "PP-013", type: "AUD", priority: "Medium", title: "Monthly Catalogue Snapshots", desc: "On the 1st of each month, full snapshots of all Product records are saved to ProductSnapshot and all Package records to PackageSnapshot. Manual snapshots are also available." },
      { id: "PP-014", type: "SEC", priority: "Medium", title: "Access Restricted to Admin/Employee", desc: "The Products & Packages settings module is accessible only to users with master_admin or employee roles. Contractors have no access to this module." },
      { id: "PP-015", type: "FR", priority: "High", title: "Nested Product Quantity Management in Packages", desc: "When a package is booked on a project, users can modify the quantity of each included product. The quantity cannot go below the package-included quantity (default), but can be increased up to the product's max_quantity, triggering per-unit pricing for extras." },
      { id: "PP-016", type: "FR", priority: "High", title: "Product Pricing Type Consistency", desc: "Fixed products ignore quantity multipliers (qty is display-only, price is base_price). Per-unit products use (base_price + unit_price × qty) calculation. This type is consistent across all pricing matrix contexts — master, blanket, and per-item overrides." },
      { id: "PP-017", type: "BR", priority: "High", title: "Per-Unit Pricing Base Quantity Inclusion", desc: "For per-unit products, the base_price covers a minimum quantity (min_quantity). Per-unit charges only apply to quantities BEYOND the minimum included amount. Example: a product with min_quantity=1 and unit_price=$50 costs base_price + ($50 × (qty - 1))." },
      ],
      },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "tasks",
    title: "7. Project Tasks & Workflow Automation",
    icon: CheckCircle2,
    color: "text-teal-700",
    bg: "bg-teal-50",
    border: "border-teal-200",
    headerBg: "bg-teal-50/60",
    summary: "Task creation, auto-generation from templates, dependency chains, blocking logic, and re-sync rules.",
    requirements: [
      { id: "T-001", type: "FR", priority: "High", title: "Manual Task Creation", desc: "Users can manually create tasks on any project. Each task requires a project_id and title. Optional fields include: description, due_date, assigned_to (user or team), order, and parent_task_id for subtask nesting." },
      { id: "T-002", type: "FR", priority: "High", title: "Auto-Generation from Templates", desc: "When products or packages are added to a project, the system can auto-generate tasks from the applicable tier's task templates. Auto-generated tasks are flagged with auto_generated = true and carry a template_id for stable identity across re-sync operations." },
      { id: "T-003", type: "FR", priority: "High", title: "Template ID for Re-Sync Matching", desc: "Each auto-generated task carries a template_id in the format product_id:tier:index or package_id:tier:index. This stable identifier allows the re-sync engine to match existing tasks to their templates without duplication." },
      { id: "T-004", type: "FR", priority: "High", title: "Auto-Assignment by Role", desc: "Task templates specify an auto_assign_role. When tasks are auto-generated, the system resolves the corresponding project staff assignment (e.g. photographer → onsite_staff_1) and assigns the task automatically to that user or team." },
      { id: "T-005", type: "FR", priority: "High", title: "Task Dependency Chains", desc: "Tasks can declare depends_on_task_ids — a list of task IDs that must be completed before this task is unblocked. The system maintains is_blocked = true on tasks with incomplete dependencies and updates this flag as dependencies are resolved." },
      { id: "T-005a", type: "FR", priority: "High", title: "Circular Dependency Prevention", desc: "The system prevents circular task dependencies. Before adding a dependency, the validateTaskDependencies backend function performs cycle detection (depth-first search) and rejects any dependency chain that would create a cycle. Users receive a clear error message if a circular dependency is attempted." },
      { id: "T-005b", type: "FR", priority: "High", title: "Task Blocking State Visualization", desc: "Blocked tasks display a lock icon (🔒) and are coloured orange-tinted (bg-orange-50). The task row shows: (1) which dependencies are incomplete with a counter (e.g. '2/3 complete'), and (2) the title of each incomplete dependency task. Blocked tasks cannot be marked complete until all dependencies are resolved." },
      { id: "T-005c", type: "FR", priority: "High", title: "Reverse Dependency Visualization", desc: "When a task is not yet complete, the system displays which OTHER tasks depend on it (reverse dependencies). This is shown as a 'Blocks:' section listing the blocked downstream tasks, helping users understand task criticality." },
      { id: "T-005d", type: "FR", priority: "Medium", title: "Dependency Task Embedding", desc: "Task rows include an embedded snapshot of each dependency task's data (via _depTasks array). This allows real-time status display (Done ✓, Blocked 🔒) without additional API calls, and enables immediate UI updates when dependency tasks are completed." },
      { id: "T-006", type: "FR", priority: "Medium", title: "Template-Level Dependency Indices", desc: "Within a task template list (per product/tier), depends_on_indices defines dependency relationships between sibling tasks by array index. This enables the system to wire up intra-product task chains automatically at generation time." },
      { id: "T-007", type: "FR", priority: "Medium", title: "Task Completion Propagation", desc: "When a task is marked as completed (is_completed = true), the system evaluates all dependent tasks that listed this task as a dependency and updates their is_blocked status accordingly." },
      { id: "T-008", type: "FR", priority: "Medium", title: "Subtask Nesting", desc: "Tasks support one level of parent–child nesting via parent_task_id. Subtasks are visually nested under their parent task in all task list views. Task completion for a parent does not automatically complete subtasks." },
      { id: "T-009", type: "BR", priority: "High", title: "Production Role Fallback to Project Owner", desc: "When auto-generating tasks for production roles (photographer, videographer, image_editor, video_editor), if the designated role is unassigned on the project, the task automatically assigns to the project_owner_id instead. Project owner assignment is mandatory for this rule to function." },
      { id: "T-010", type: "BR", priority: "High", title: "Package Task Inheritance from Products", desc: "When a package is booked on a project, auto-generated tasks are created from two sources: (1) the package's own standard/premium task templates, and (2) the templates of each product the package contains. This ensures all workflow steps for both the package and its constituent products are represented." },
      ],
      },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "calendar",
    title: "8. Calendar & Scheduling",
    icon: Calendar,
    color: "text-sky-700",
    bg: "bg-sky-50",
    border: "border-sky-200",
    headerBg: "bg-sky-50/60",
    summary: "Internal calendar events, Google Calendar integration, two-way sync, and scheduling rules.",
    requirements: [
      { id: "CAL-001", type: "FR", priority: "High", title: "Internal Calendar Events", desc: "CalendarEvent entities are the internal representation of scheduled events. Required fields: title, start_time. Optional: description, end_time, location, project_id (linking to a project), google_event_id (for sync), calendar_account, and is_synced flag." },
      { id: "CAL-002", type: "INT", priority: "High", title: "Google Calendar OAuth Integration", desc: "The system integrates with Google Calendar via OAuth 2.0. Users connect their Google Calendar account through a managed OAuth flow. Access and refresh tokens are stored on the CalendarConnection entity per account." },
      { id: "CAL-003", type: "INT", priority: "High", title: "Two-Way Calendar Sync", desc: "The syncGoogleCalendar backend function performs bidirectional synchronisation between internal CalendarEvent records and the connected Google Calendar account. New internal events are pushed to Google; Google events not in the system are pulled in." },
      { id: "CAL-004", type: "FR", priority: "Medium", title: "Project-Linked Events", desc: "Calendar events can be linked to a project via project_id. Linked events appear in the project's Calendar tab and on the main calendar view with a visual link indicator." },
      { id: "CAL-005", type: "FR", priority: "Medium", title: "Multiple Calendar Connections", desc: "The system supports multiple Google Calendar accounts per installation via the CalendarConnection entity. Each connection can be independently enabled/disabled and assigned a display colour." },
      { id: "CAL-006", type: "NFR", priority: "Medium", title: "Delivery Settings", desc: "The DeliverySettings entity stores working hours (per day of week, with enabled flag and start/end time) and countdown threshold configuration (yellow_start, yellow_end, red_threshold in hours before due date). These settings drive the delivery countdown timer colours." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "email",
    title: "9. Email & Inbox",
    icon: Mail,
    color: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    headerBg: "bg-amber-50/60",
    summary: "Gmail integration, inbox management, email threading, project linking, and tracking.",
    requirements: [
      { id: "E-001", type: "INT", priority: "High", title: "Gmail OAuth Integration", desc: "Email accounts are connected via Gmail OAuth (scopes: gmail.modify, gmail.readonly, email). Access and refresh tokens are stored on the EmailAccount entity. Multiple accounts can be connected per installation." },
      { id: "E-002", type: "FR", priority: "High", title: "Email Sync", desc: "The syncGmailMessages backend function syncs emails from connected Gmail accounts into EmailMessage records. Sync tracks the latest gmail_history_id per account and fetches only incremental changes." },
      { id: "E-003", type: "FR", priority: "High", title: "Email Threading", desc: "Emails are grouped by gmail_thread_id for conversation-style threading in the inbox. Thread participants are extracted and displayed. Replies are correctly threaded under the root message." },
      { id: "E-004", type: "FR", priority: "High", title: "Project Email Linking", desc: "Emails can be linked to a project via the project_id field. Linked emails appear in the project's Emails tab. The visibility field (private/shared) controls whether an email is shared with a project or kept account-private." },
      { id: "E-005", type: "FR", priority: "High", title: "Email Labels", desc: "Emails support custom labels defined via the EmailLabel entity. Labels can be applied to and removed from individual messages. Multiple labels can be applied per email." },
      { id: "E-006", type: "FR", priority: "Medium", title: "Email Priority", desc: "Emails carry a priority field: low, medium, attention, or completed. Priority is set manually by users and is used for inbox triage and filtering." },
      { id: "E-007", type: "FR", priority: "Medium", title: "Send Email via Gmail", desc: "The sendGmailMessage backend function sends emails via the connected Gmail account's OAuth token. Sent messages are stored as EmailMessage records with is_sent = true." },
      { id: "E-008", type: "FR", priority: "Medium", title: "Email Open Tracking", desc: "When track_opens = true on an EmailAccount, outbound emails include a tracking pixel. Open events are logged to EmailActivity with timestamp and metadata." },
      { id: "E-009", type: "FR", priority: "Medium", title: "Email Link Click Tracking", desc: "When track_clicks = true, outbound email links are rewritten to route through the trackLinkClick function. Click events are logged to EmailLinkClick with link URL, click timestamp, and email context." },
      { id: "E-010", type: "FR", priority: "Medium", title: "Email Templates", desc: "Reusable email templates are stored in the EmailTemplate entity. Templates support field placeholder substitution (e.g. client name, project address). Templates can be selected when composing new emails." },
      { id: "E-011", type: "FR", priority: "Medium", title: "Blocked Address Management", desc: "The EmailBlockedAddress entity maintains a list of email addresses from which incoming emails should be suppressed. Blocked addresses are filtered from inbox display." },
      { id: "E-012", type: "FR", priority: "Low", title: "User Email Signatures", desc: "Individual users can store a personal email signature in the UserSignature entity. Signatures are automatically appended to new composed emails when the user's account is selected." },
      { id: "E-013", type: "FR", priority: "Medium", title: "Draft Email Support", desc: "Emails with is_draft = true are stored locally without being sent. Drafts are visible in the draft folder view and can be edited and sent at a later time." },
      { id: "E-014", type: "FR", priority: "Low", title: "Auto-Project Linking", desc: "When auto_link_to_projects = true on an EmailAccount, the system attempts to automatically detect and link incoming emails to relevant projects based on address and subject matching heuristics." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "prospecting",
    title: "10. Prospecting & CRM Pipeline",
    icon: Target,
    color: "text-orange-700",
    bg: "bg-orange-50",
    border: "border-orange-200",
    headerBg: "bg-orange-50/60",
    summary: "Lead management, prospecting pipeline, interaction logging, and relationship nurturing.",
    requirements: [
      { id: "PRO-001", type: "FR", priority: "High", title: "Prospecting Module Scope", desc: "The Prospecting module manages Agents and Agencies in 'Prospecting' relationship state. It provides CRM-style pipeline views, interaction logging, status progression tracking, and conversion workflows." },
      { id: "PRO-002", type: "FR", priority: "High", title: "Kanban Pipeline View", desc: "Agents in Prospecting state are visualisable in a Kanban board grouped by their granular status field. Cards can be dragged between columns to update status. Column progression follows the defined prospecting pipeline order." },
      { id: "PRO-003", type: "FR", priority: "High", title: "Interaction Logging", desc: "Every touchpoint with a prospect (call, email, meeting, demo) is logged as an InteractionLog record linked to the Agent or Agency. Interaction logs capture: date, type, outcome, notes, and the user who logged it." },
      { id: "PRO-004", type: "FR", priority: "High", title: "Relationship State Transitions", desc: "When an agent's relationship_state changes (e.g. Prospecting → Active), the handleProspectingStateChange backend function fires, updating became_active_date or became_dormant_date timestamps and logging the transition to the audit trail." },
      { id: "PRO-005", type: "FR", priority: "Medium", title: "Next Follow-Up Scheduling", desc: "Agents and Agencies carry next_follow_up_date and last_contact_date fields. The prospecting dashboard surfaces agents with overdue follow-ups as a prioritised list." },
      { id: "PRO-006", type: "FR", priority: "Medium", title: "Media Needs Tagging", desc: "Agents carry a media_needs array enumerating the services they're interested in (Photography, Video Production, Drone Footage, Virtual Staging, Social Media Mgmt, Website Design, Branding). Used for segmentation and campaign targeting." },
      { id: "PRO-007", type: "FR", priority: "Medium", title: "Value Potential Scoring", desc: "Agents have a value_potential field (Low, Medium, High, Enterprise) for rough commercial opportunity sizing. Used to prioritise prospecting effort." },
      { id: "PRO-008", type: "FR", priority: "Medium", title: "Agent Assignment", desc: "Prospecting leads can be assigned to a specific team member via assigned_to_user_id. The assigned team member is responsible for progressing the relationship." },
      { id: "PRO-009", type: "FR", priority: "Low", title: "Unqualified Reason Capture", desc: "When an agent's status is set to 'Unqualified', the reason_unqualified field must be populated to explain why the lead was disqualified. This data informs future lead scoring improvements." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "media",
    title: "11. Media Delivery & Dropbox Integration",
    icon: Upload,
    color: "text-cyan-700",
    bg: "bg-cyan-50",
    border: "border-cyan-200",
    headerBg: "bg-cyan-50/60",
    summary: "Client media delivery, Dropbox file management, access control, and delivery settings.",
    requirements: [
      { id: "MD-001", type: "FR", priority: "High", title: "Media Delivery Record per Project", desc: "Each project can have one ProjectMedia record that stores: dropbox_link, optional access_code, is_published flag, expiry_date, download_enabled, and watermark_enabled settings." },
      { id: "MD-002", type: "FR", priority: "High", title: "Dropbox File Integration", desc: "The listDropboxFiles and listDropboxFolders backend functions access the company Dropbox account using the DROPBOX_API_TOKEN secret to list and browse files. getDropboxFilePreview fetches preview URLs for images." },
      { id: "MD-003", type: "FR", priority: "Medium", title: "Share Link Generation", desc: "listDropboxShareLink generates a shareable Dropbox link for a given file path. This link is used to provide clients with direct access to specific deliverables." },
      { id: "MD-004", type: "FR", priority: "Medium", title: "Media Publication Control", desc: "is_published = false means the media delivery is not yet visible to the client. Setting it to true makes the delivery link and access code available to share. Publication state does not automatically change the project's lifecycle stage." },
      { id: "MD-005", type: "FR", priority: "Low", title: "View Count Tracking", desc: "ProjectMedia tracks view_count (number of times client accessed media) and last_viewed timestamp. These metrics are displayed on the project's media delivery card." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "dashboard",
    title: "12. Dashboard & Reporting",
    icon: BarChart2,
    color: "text-pink-700",
    bg: "bg-pink-50",
    border: "border-pink-200",
    headerBg: "bg-pink-50/60",
    summary: "Dashboard metrics, project views, Kanban board, and reporting components.",
    requirements: [
      { id: "D-001", type: "FR", priority: "High", title: "Kanban Board View", desc: "Projects are viewable in a Kanban board organised by lifecycle stage. Cards display key project metadata. Cards are draggable between columns to trigger stage transitions directly from the board (with appropriate permission checks)." },
      { id: "D-002", type: "FR", priority: "High", title: "Project List & Table Views", desc: "Projects are viewable in a list/table format with sortable columns, filterable status, and configurable visible fields. Users can customise which card fields are shown via the CardFieldsCustomizer component." },
      { id: "D-002a", type: "FR", priority: "High", title: "Advanced Filtering & Sorting", desc: "The Projects view supports multi-select filters for: products, packages, agents, agencies, and internal teams. Sorting options include: Last Updated, Task Deadline, Next Activity, and Date Created. Filters are persisted in UI state with active filter count display and quick reset." },
      { id: "D-003", type: "FR", priority: "High", title: "Statistics Cards", desc: "The dashboard displays summary statistics: total active projects, projects by stage, revenue metrics, task completion rates. Stats are computed from live entity data with no caching delay." },
      { id: "D-004", type: "FR", priority: "Medium", title: "Project Heat Map", desc: "A geographic heat map visualisation of projects is available, plotting property addresses on a map with colour intensity indicating project density by area." },
      { id: "D-005", type: "FR", priority: "Medium", title: "Task Reporting Dashboard", desc: "A dedicated task reporting view shows task completion rates, overdue tasks, tasks by assigned user, and tasks by project for operational management." },
      { id: "D-006", type: "FR", priority: "Medium", title: "Dropbox File Feed", desc: "The dashboard includes a Dropbox file feed showing recently modified files in the connected Dropbox account, enabling quick access to recently uploaded media." },
      { id: "D-007", type: "FR", priority: "High", title: "Advanced Project Filtering & Sorting", desc: "Projects view supports multi-select filters for products, packages, agents, agencies, and internal teams/employees with AND logic. Sorting options: Last Updated, Task Deadline, Next Activity, Date Created. Active filters shown as dismissible chips with active filter count badge." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "notifications",
    title: "13. Notifications & Alerts",
    icon: Bell,
    color: "text-yellow-700",
    bg: "bg-yellow-50",
    border: "border-yellow-200",
    headerBg: "bg-yellow-50/60",
    summary: "In-app notification bar, email notifications, and system alert rules.",
    requirements: [
      { id: "N-001", type: "FR", priority: "High", title: "Global Notification Bar", desc: "A GlobalNotificationBar component renders at the top of the application for all authenticated users. It displays system-level notifications, alerts, and actionable messages. Notifications are context-aware (per-user or global)." },
      { id: "N-002", type: "FR", priority: "Medium", title: "Email Notifications via Integration", desc: "The Core.SendEmail integration is available for backend functions to send transactional emails (e.g. status change notifications, assignment alerts). Emails are sent from the app's configured sending domain." },
      { id: "N-003", type: "FR", priority: "Medium", title: "Delivery Countdown Timer", desc: "Projects with a delivery_date display a countdown timer. The timer colour changes based on DeliverySettings thresholds: neutral → yellow (yellow_start hours remaining) → orange (yellow_end hours) → red (red_threshold hours)." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
   {
     id: "timers",
     title: "14. Timer Defense & Inactivity Protection",
     icon: Clock,
     color: "text-red-700",
     bg: "bg-red-50",
     border: "border-red-200",
     headerBg: "bg-red-50/80",
     summary: "Multi-layered defense mechanisms to prevent accidental long-running timers.",
     requirements: [
       { id: "TMR-001", type: "FR", priority: "Critical", title: "Global Active Timers Indicator", desc: "A persistent indicator in the bottom-right corner of the application displays the count of active running timers across all projects. Clicking reveals which tasks have running timers. This provides always-visible awareness of active time tracking activity." },
       { id: "TMR-002", type: "FR", priority: "Critical", title: "Project-Level Active Timers Banner", desc: "Each project detail page displays a prominent banner when one or more active timers are running on tasks within that project. The banner lists which users/roles have active timers, making it impossible to miss active tracking on the current project." },
       { id: "TMR-003", type: "FR", priority: "High", title: "30-Minute Auto-Pause on Inactivity", desc: "TaskTimeLogger monitors user activity on the page. If no interaction (clicks, inputs) occurs for 30 minutes while a timer is running, the timer automatically pauses with a confirmation dialog explaining the auto-pause. This prevents forgotten timers from running indefinitely." },
       { id: "TMR-004", type: "FR", priority: "High", title: "Inactivity Warning Dialog", desc: "When the 30-minute inactivity threshold is reached, a clear modal dialog surfaces: 'Timer Auto-Paused' with explanation 'Your timer has been automatically paused due to 30 minutes of inactivity.' User acknowledges with a Dismiss button." },
       { id: "TMR-005", type: "BR", priority: "High", title: "Activity Tracking on Timer Actions", desc: "Every timer action (Start, Resume, Finish, Continue) records an activity timestamp. The 30-minute inactivity clock resets on any of these actions, ensuring that actively using the timer interface prevents auto-pause." },
       { id: "TMR-006", type: "NFR", priority: "High", title: "Real-Time Timer Subscription Updates", desc: "All active timer indicators (global and project-level) subscribe to real-time TaskTimeLog updates. When any user creates, updates, or completes a timer, all connected clients immediately reflect the change without polling." },
     ],
   },

   // ═══════════════════════════════════════════════════════════════════════
   {
     id: "nfr",
     title: "15. Non-Functional Requirements",
     icon: Activity,
     color: "text-slate-700",
     bg: "bg-slate-50",
     border: "border-slate-200",
     headerBg: "bg-slate-50/80",
     summary: "Performance, scalability, security, maintainability, accessibility, and data governance standards.",
     requirements: [
       { id: "NF-001", type: "NFR", priority: "Critical", title: "Real-Time Data Freshness", desc: "All entity list views and detail pages must reflect database state within ≤1 second of any change made by any user in the system, without requiring manual page refresh. Achieved via Base44 real-time entity subscriptions." },
      { id: "NF-002", type: "NFR", priority: "High", title: "Concurrent User Safety", desc: "Unsaved local edits in any editor (price matrix, project form, task list) must be protected from being overwritten by concurrent real-time updates from other users until the local user explicitly saves or discards their changes." },
      { id: "NF-003", type: "NFR", priority: "High", title: "Mobile-First Responsive Design", desc: "All UI must be fully usable on mobile devices (≥375px width). Navigation collapses to a mobile sidebar. Tables scroll horizontally. No content must be clipped or unreachable on small screens." },
      { id: "NF-004", type: "SEC", priority: "Critical", title: "No Client-Side Secret Exposure", desc: "OAuth tokens, API keys, and other secrets must never be exposed in frontend code or client-side network responses. All operations requiring secrets must be performed in backend functions." },
      { id: "NF-005", type: "SEC", priority: "Critical", title: "Server-Side Authorization Enforcement", desc: "All permission checks that gate sensitive operations must be enforced server-side in backend functions, not solely in the frontend UI. UI-only permission gates can be bypassed and must not be the sole line of defence." },
      { id: "NF-006", type: "NFR", priority: "High", title: "Optimistic UI with Server Confirmation", desc: "For pricing changes, the UI must perform a backend verification call before displaying the confirmed total to the user. Displayed estimates are clearly labelled as estimates. Only backend-confirmed values are written to the database." },
      { id: "NF-007", type: "NFR", priority: "High", title: "Data Integrity on Cached Fields", desc: "All denormalised cached name fields (agency_name, client_name, product_name, etc.) must be re-synchronised whenever the source entity name is updated. Stale cached names are a data quality defect." },
      { id: "NF-008", type: "NFR", priority: "High", title: "Audit Completeness", desc: "The system maintains full audit trails for: price matrix changes, product/package changes, client hierarchy changes, and project status changes. No audited action may bypass the audit log." },
      { id: "NF-009", type: "NFR", priority: "Medium", title: "Code Componentisation", desc: "UI components must be kept focused and small. Pages may not exceed reasonable complexity thresholds. Logic that crosses multiple pages must be extracted into shared hooks or utility components. Spaghetti code is a defect." },
      { id: "NF-010", type: "NFR", priority: "Medium", title: "No Dead Imports or Unused Variables in Backend", desc: "Backend functions must pass Deno lint validation before deployment. Syntax errors, undeclared variables, and structural issues cause deployment rejection. Style issues (let vs const) are warned but not rejected." },
      { id: "NF-011", type: "NFR", priority: "Medium", title: "Soft Delete by Default", desc: "Where possible, entities should be deactivated (soft-deleted) rather than permanently deleted. Permanent deletion is reserved for deliberate administrative actions with double confirmation. Soft deletion preserves audit history and allows recovery." },
      { id: "NF-012", type: "ARC", priority: "High", title: "Single Source of Truth for Status Labels", desc: "Project stage values, labels, and colour configurations are defined in a single projectStatuses.js file. All components consuming stage information must import from this file. Duplicate hardcoded stage strings are a defect." },
      { id: "NF-013", type: "NFR", priority: "Low", title: "Accessibility (WCAG AA)", desc: "Interactive elements (buttons, inputs, selects) must have accessible labels. Focus states must be visible. Colour contrast ratios must meet WCAG AA standards. Tooltip content must be keyboard-accessible." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "integrations",
    title: "16. External Integrations",
    icon: Globe,
    color: "text-green-700",
    bg: "bg-green-50",
    border: "border-green-200",
    headerBg: "bg-green-50/60",
    summary: "All third-party service integrations, OAuth connectors, and API dependencies.",
    requirements: [
      { id: "I-001", type: "INT", priority: "Critical", title: "Gmail OAuth Connector", desc: "Gmail is integrated via Base44 OAuth app connector (scopes: gmail.modify, gmail.readonly, email). Access tokens are retrieved server-side via base44.asServiceRole.connectors.getAccessToken('gmail'). The connector is used for reading, sending, and managing emails." },
      { id: "I-002", type: "INT", priority: "High", title: "Google Calendar OAuth", desc: "Google Calendar integration uses a custom OAuth flow (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET secrets). The OAuth flow is handled by getGoogleCalendarOAuthUrl and handleGoogleCalendarOAuthCallback backend functions. Tokens are stored per CalendarConnection record." },
      { id: "I-003", type: "INT", priority: "High", title: "Dropbox API Integration", desc: "Dropbox is accessed via the DROPBOX_API_TOKEN secret (long-lived token). Backend functions (listDropboxFiles, listDropboxFolders, getDropboxFilePreview, listDropboxShareLink) use this token to interact with the Dropbox API for file browsing and link generation." },
      { id: "I-004", type: "INT", priority: "Medium", title: "AI / LLM Integration", desc: "The Core.InvokeLLM integration provides access to AI language model capabilities for use in automated content generation, data extraction, and intelligent suggestions. The integration supports structured JSON output, internet context, and file/image attachments." },
      { id: "I-005", type: "INT", priority: "Medium", title: "File Upload Integration", desc: "Core.UploadFile provides file upload to the Base44 managed file storage. Returns a public file_url. Core.UploadPrivateFile uploads to private storage; Core.CreateFileSignedUrl generates a time-limited signed URL for private file access." },
      { id: "I-006", type: "INT", priority: "Low", title: "Tonomo Integration", desc: "The TonomoIntegration entity stores configuration for Tonomo API integration (api_key, api_endpoint, sync_enabled). Sync operations are managed via the stored configuration and last_sync timestamp." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "revisions",
    title: "17. Project Revisions & Change Requests",
    icon: RefreshCw,
    color: "text-indigo-700",
    bg: "bg-indigo-50",
    border: "border-indigo-200",
    headerBg: "bg-indigo-50/60",
    summary: "Revision workflows, request kinds, status management, pricing impact application, and automatic project stage transitions.",
    requirements: [
      { id: "REV-001", type: "FR", priority: "Critical", title: "Two Request Kinds", desc: "ProjectRevision records support request_kind field with values: 'revision' (minor adjustments) or 'change_request' (significant scope changes). This distinction is displayed with distinct visual badges — violet for revisions, rose/red for change requests." },
      { id: "REV-002", type: "FR", priority: "Critical", title: "Revision Request Types", desc: "Each revision/change request specifies revision_type: images, drones, floorplan, or video. Combined with request_kind, this provides granular categorisation of what work is being requested." },
      { id: "REV-003", type: "FR", priority: "Critical", title: "Revision Status Lifecycle — 6 States", desc: "Revisions have status field with 6 values: identified (initial state), in_progress (work started), completed (all tasks done), delivered (completed and client notified/delivered), cancelled (request deleted with all tasks), stuck (paused with timers stopped). Status transitions are tracked with timestamps. State machine enforces valid transitions." },
      { id: "REV-003a", type: "BR", priority: "Critical", title: "Minimum One Task Requirement", desc: "A revision cannot be created without at least one associated task (auto-generated from template or manually added). The system rejects revision creation attempts with zero tasks. At least one task must exist before saving the revision." },
      { id: "REV-003b", type: "BR", priority: "High", title: "Completion Requires All Tasks Done", desc: "A revision can only transition to 'completed' status if all of its non-deleted tasks are marked is_completed=true. The system prevents premature completion and displays an error listing incomplete tasks." },
      { id: "REV-003c", type: "FR", priority: "High", title: "Stuck Status — Pause & Resume", desc: "When marked 'stuck', the revision pauses all associated running timers and prevents new effort logging via is_locked=true on its tasks. The previous_status field stores the state before entering stuck (identified/in_progress/completed). On resume (clicking 'Resolve Stuck'), the revision returns to previous_status and timers are unlocked." },
      { id: "REV-003d", type: "FR", priority: "High", title: "Cancellation with Atomic Cleanup", desc: "When a revision is marked 'cancelled', the handleRevisionCancellation backend function atomically: (1) marks all associated tasks as is_deleted=true, (2) stops any running timers, (3) logs the cancellation to ProjectActivity. Soft-deleted tasks are hidden from task lists but data is preserved for audit." },
      { id: "REV-003e", type: "FR", priority: "High", title: "Revision Stuck Status Timer Management", desc: "The handleRevisionStuckStatus backend function orchestrates timer pausing when a revision enters stuck state. It pauses all active TaskTimeLog timers for the revision's tasks, capturing pause_time and preventing further effort accumulation until the revision is resumed." },
      { id: "REV-004", type: "BR", priority: "Critical", title: "Auto Stage Transition to in_revision", desc: "When a project has ANY unclosed revision (status not completed, delivered, or cancelled), the project's status automatically transitions to 'in_revision'. The project's previous_status field caches the stage before entering revision, allowing automatic reversion once all revisions are closed." },
      { id: "REV-005", type: "BR", priority: "Critical", title: "Auto Revert from in_revision", desc: "Once all revisions on a project are closed (marked completed, delivered, or cancelled), the project's status automatically reverts to the previous_status that was cached when it first entered 'in_revision' mode. This is enforced by the updateRevisionStatus automation on ProjectTask and TaskTimeLog changes." },
      { id: "REV-006", type: "FR", priority: "High", title: "Revision Template Application", desc: "Revisions can optionally use a RevisionTemplate to auto-generate tasks. Templates are filtered by request_kind and revision_type to show only applicable templates. Template-based tasks inherit all their configuration from the template." },
      { id: "REV-007", type: "FR", priority: "High", title: "Revision Task Auto-Generation", desc: "When a revision is created with a template, ProjectTask records are auto-generated from the template's task_templates array. Auto-generated revision tasks are prefixed with [Revision #N] to link them visually to the revision." },
      { id: "REV-008", type: "FR", priority: "High", title: "Manual Task Creation in Revisions", desc: "In addition to template-based tasks, users can manually add custom tasks to a revision via an inline task list UI. Manual tasks inherit the revision number in their title prefix." },
      { id: "REV-009", type: "FR", priority: "High", title: "Revision Pricing Impact", desc: "Revisions can declare a pricing_impact object containing: products_added (array), products_removed (array), quantity_changes (array), and estimated_price_delta. The impact is tracked but not automatically applied." },
      { id: "REV-010", type: "FR", priority: "High", title: "Pricing Impact Application", desc: "When a revision is marked completed or delivered (or manually via Apply Now button), any pricing_impact is applied to the project: products added/removed, quantities adjusted, and the project pricing is recalculated. The applied_date and applied flag are set." },
      { id: "REV-011", type: "FR", priority: "Medium", title: "Revision Priority & Due Date", desc: "Revisions have priority (low, normal, high, urgent) and optional due_date. These are used for display and filtering in the revisions list and dashboard." },
      { id: "REV-012", type: "FR", priority: "Medium", title: "Revision File Attachments", desc: "Revisions support attachments array containing file uploads (file_url, file_name, uploaded_at). Users can attach supporting files (mockups, specification documents) when creating or editing revisions." },
      { id: "REV-013", type: "FR", priority: "High", title: "Revision Template Entity", desc: "RevisionTemplate records define reusable revision request configurations per request_kind and revision_type. Each template contains task_templates array with auto-assign roles, deadline triggers, and estimated hours." },
      { id: "REV-014", type: "FR", priority: "Medium", title: "Revision Number Sequence", desc: "Each project maintains an auto-incrementing revision_number counter. Revisions are displayed as '#1', '#2', etc. for easy reference in task titles and discussions." },
      { id: "REV-015", type: "AUD", priority: "High", title: "Revision Activity Logging", desc: "All changes to a revision (status updates, pricing applications, task additions, template selections) are logged to ProjectActivity with user context and timestamp." },
      { id: "REV-016", type: "FR", priority: "High", title: "Revision Visual Distinction", desc: "Revision cards display distinctive visual styling based on request_kind: violet borders/gradients for revisions, rose/red borders/gradients for change requests. This provides immediate visual categorisation in the project details tab." },
    ],
  },

  // ═══════════════════════════════════════════════════════════════════════
  {
    id: "settings",
    title: "18. Settings & Organisation Management",
    icon: Settings,
    color: "text-slate-600",
    bg: "bg-slate-50",
    border: "border-slate-200",
    headerBg: "bg-slate-50/60",
    summary: "System-wide settings, user management, internal teams, delivery configuration, and integration management.",
    requirements: [
      { id: "S-001", type: "FR", priority: "High", title: "Internal Team Management", desc: "InternalTeam entities represent internal operational teams (photography teams, editing teams). Each team has a name, description, colour (for visual identification), and is_active flag. Internal teams can be assigned to projects as staff." },
      { id: "S-002", type: "FR", priority: "High", title: "User Management (Admin)", desc: "master_admin users can view all system users, update roles, and invite new users. The SettingsTeamsUsers page is restricted to master_admin only." },
      { id: "S-003", type: "FR", priority: "High", title: "Delivery Settings Configuration", desc: "Working hours per day of week (enabled, start time, end time) and countdown colour thresholds (yellow, orange, red) are configurable in a single DeliverySettings record. These settings apply globally to all project delivery timers." },
      { id: "S-004", type: "FR", priority: "Medium", title: "Organisation Settings Page", desc: "The SettingsOrganisation page provides access to: Project Rules, Client Structure Rules, and links to other settings sub-modules. Acts as a settings hub for non-pricing operational configuration." },
      { id: "S-005", type: "FR", priority: "Medium", title: "Integration Settings Page", desc: "The SettingsIntegrations page allows admins to configure and test external service integrations (Dropbox, Calendar, Email, Tonomo). Connection status is displayed per integration." },
      ],
      },

      // ═══════════════════════════════════════════════════════════════════════
      {
      id: "request_templates",
      title: "19. Request Templates Management",
      icon: FileText,
      color: "text-purple-700",
      bg: "bg-purple-50",
      border: "border-purple-200",
      headerBg: "bg-purple-50/60",
      summary: "Template creation, task template inheritance, deadline automation, and template filtering by request type.",
      requirements: [
      { id: "RT-001", type: "FR", priority: "High", title: "Template Filtering by Request Kind", desc: "The Request Templates management page filters templates by request_kind (revision or change_request). Creating or editing a template requires specifying its request_kind and revision_type. Templates only appear when creating revisions of matching kind/type." },
      { id: "RT-002", type: "FR", priority: "High", title: "Task Templates in Revision Templates", desc: "Each RevisionTemplate contains a task_templates array. Each task template specifies: title, description, task_type (onsite/back_office), auto_assign_role, estimated_minutes, and deadline triggers (timer_trigger, deadline_type, preset, hours_after_trigger)." },
      { id: "RT-003", type: "FR", priority: "High", title: "Deadline Trigger Types", desc: "Revision task templates support four trigger types: none (manual deadline), project_onsite (triggered by shoot date), project_uploaded (triggered by content upload), project_submitted (triggered by submission), dependencies_cleared (triggered when all dependencies complete). Timer triggers automatically calculate due_date when the trigger event occurs." },
      { id: "RT-004", type: "FR", priority: "High", title: "Deadline Calculation Modes", desc: "For triggered deadlines, templates support two modes: preset (e.g. 'tomorrow_night', 'next_business_night') or custom (hours_after_trigger). Deadline presets use timezone-aware calculation (Australia/Sydney) with business day logic." },
      { id: "RT-005", type: "FR", priority: "High", title: "Task Dependencies in Templates", desc: "Task templates within a revision template can declare dependencies via depends_on_indices array. These sibling-index dependencies are automatically wired when tasks are auto-generated, creating multi-step task workflows automatically." },
      { id: "RT-006", type: "FR", priority: "Medium", title: "Template Name & Description", desc: "Each RevisionTemplate carries a human-readable name and optional description explaining when/why this template is used. Names and descriptions appear in the template picker when creating revisions." },
      { id: "RT-007", type: "FR", priority: "Medium", title: "Template Active/Inactive Toggle", desc: "RevisionTemplates have an is_active flag. Inactive templates are hidden from the template picker and from the template management list but their data is preserved." },
      ],
      },
      ];

// ─── COMPONENTS ────────────────────────────────────────────────────────────

function RequirementRow({ req, sectionBg, sectionColor }) {
  const typeCfg = TYPE_CONFIG[req.type] || TYPE_CONFIG.FR;
  const priCfg = PRIORITY_CONFIG[req.priority] || PRIORITY_CONFIG.Medium;
  return (
    <div className="flex items-start gap-4 p-4 hover:bg-muted/10 transition-colors border-b last:border-b-0">
      <div className={`w-8 h-8 rounded-lg ${sectionBg} flex items-center justify-center flex-shrink-0 mt-0.5`}>
        <span className={`text-[9px] font-black ${sectionColor}`}>{req.id.split("-")[0]}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span className="font-mono text-[10px] text-muted-foreground">{req.id}</span>
          <span className="font-semibold text-sm">{req.title}</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${typeCfg.className}`}>
            {typeCfg.short}
          </Badge>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${priCfg.className}`}>
            {req.priority}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{req.desc}</p>
      </div>
    </div>
  );
}

function ModuleSection({ module, defaultOpen = false, searchQuery = "" }) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = module.icon;

  const filtered = module.requirements.filter(r =>
    !searchQuery ||
    r.title.toLowerCase().includes(searchQuery) ||
    r.desc.toLowerCase().includes(searchQuery) ||
    r.id.toLowerCase().includes(searchQuery) ||
    r.type.toLowerCase().includes(searchQuery) ||
    r.priority.toLowerCase().includes(searchQuery)
  );

  if (searchQuery && filtered.length === 0) return null;
  const isOpen = open || (!!searchQuery && filtered.length > 0);

  const frCount = filtered.filter(r => r.type === "FR").length;
  const nfrCount = filtered.filter(r => r.type === "NFR").length;
  const critCount = filtered.filter(r => r.priority === "Critical").length;

  return (
    <Card className={`border ${module.border} overflow-hidden`}>
      <button
        className={`w-full text-left px-5 py-4 flex items-center justify-between gap-3 hover:bg-muted/20 transition-colors ${module.headerBg}`}
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-10 h-10 rounded-xl ${module.bg} flex items-center justify-center flex-shrink-0`}>
            <Icon className={`h-5 w-5 ${module.color}`} />
          </div>
          <div className="text-left min-w-0">
            <div className="font-bold text-sm">{module.title}</div>
            <div className="text-xs text-muted-foreground mt-0.5 truncate">{module.summary}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {critCount > 0 && (
            <Badge className="text-[10px] px-1.5 py-0 bg-red-500 text-white border-0 hidden sm:flex">
              {critCount} Critical
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px] hidden sm:flex">
            {filtered.length} req
          </Badge>
          {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>

      {isOpen && (
        <CardContent className="p-0">
          <div className="border-t">
            {filtered.map((req) => (
              <RequirementRow key={req.id} req={req} sectionBg={module.bg} sectionColor={module.color} />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// ─── MAIN PAGE ─────────────────────────────────────────────────────────────

export default function BusinessRequirementsDocument() {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("All");

  const sq = searchQuery.toLowerCase();

  const exportToPDF = () => {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    let yPos = 20;
    const pageHeight = doc.internal.pageSize.height;
    const margin = 15;
    const maxWidth = doc.internal.pageSize.width - margin * 2;

    // Header
    doc.setFontSize(18);
    doc.setFont(undefined, "bold");
    doc.text(DOC_META.title, margin, yPos);
    yPos += 10;

    doc.setFontSize(10);
    doc.setFont(undefined, "normal");
    doc.text(`Version: ${DOC_META.version} | Status: ${DOC_META.status}`, margin, yPos);
    yPos += 6;
    doc.text(`Last Updated: ${DOC_META.lastUpdated}`, margin, yPos);
    yPos += 12;

    // Summary stats
    const totalReqs = MODULES.reduce((s, m) => s + m.requirements.length, 0);
    const criticalCount = MODULES.reduce((s, m) => s + m.requirements.filter(r => r.priority === "Critical").length, 0);
    doc.setFontSize(9);
    doc.text(`Total Requirements: ${totalReqs} | Critical: ${criticalCount}`, margin, yPos);
    yPos += 10;

    // Add each module and requirement
    MODULES.forEach((module) => {
      // Module title
      if (yPos > pageHeight - margin - 20) {
        doc.addPage();
        yPos = margin;
      }
      
      doc.setFontSize(12);
      doc.setFont(undefined, "bold");
      doc.text(module.title, margin, yPos);
      yPos += 8;

      // Requirements
      module.requirements.forEach((req) => {
        if (yPos > pageHeight - margin - 10) {
          doc.addPage();
          yPos = margin;
        }

        doc.setFontSize(8);
        doc.setFont(undefined, "bold");
        doc.text(`${req.id}: ${req.title}`, margin + 3, yPos);
        yPos += 5;

        doc.setFont(undefined, "normal");
        doc.setFontSize(7);
        const wrappedDesc = doc.splitTextToSize(req.desc, maxWidth - 6);
        doc.text(wrappedDesc, margin + 3, yPos);
        yPos += wrappedDesc.length * 4 + 3;

        // Type and priority badges
        doc.setFontSize(6);
        doc.text(`[${req.type}] [${req.priority}]`, margin + 3, yPos);
        yPos += 6;
      });

      yPos += 4;
    });

    doc.save(`FlexStudios-BRD-v${DOC_META.version}.pdf`);
  };

  const totalReqs = MODULES.reduce((s, m) => s + m.requirements.length, 0);
  const criticalCount = MODULES.reduce((s, m) => s + m.requirements.filter(r => r.priority === "Critical").length, 0);
  const frCount = MODULES.reduce((s, m) => s + m.requirements.filter(r => r.type === "FR").length, 0);
  const nfrCount = MODULES.reduce((s, m) => s + m.requirements.filter(r => r.type === "NFR").length, 0);

  const typeFilters = ["All", "FR", "NFR", "BR", "CON", "SEC", "AUD", "ARC", "INT", "UX"];

  const filterQuery = activeFilter === "All" ? sq : sq ? `${sq} ${activeFilter}`.trim() : activeFilter.toLowerCase();

  function matchesFilter(req) {
    const typeMatch = activeFilter === "All" || req.type === activeFilter;
    const searchMatch = !sq ||
      req.title.toLowerCase().includes(sq) ||
      req.desc.toLowerCase().includes(sq) ||
      req.id.toLowerCase().includes(sq) ||
      req.priority.toLowerCase().includes(sq);
    return typeMatch && searchMatch;
  }

  function filterModule(module) {
    return module.requirements.filter(matchesFilter);
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto space-y-6">

      {/* ── Document Header ─────────────────────────────────── */}
      <div className="bg-gradient-to-br from-slate-900 to-slate-700 rounded-2xl p-8 text-white">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-4">
            <div className="w-14 h-14 rounded-xl bg-white/10 flex items-center justify-center flex-shrink-0">
              <FileText className="h-7 w-7 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-3 flex-wrap mb-1">
                <h1 className="text-2xl font-black tracking-tight">{DOC_META.title}</h1>
                <Badge className="bg-amber-400 text-amber-900 border-0 font-semibold">v{DOC_META.version}</Badge>
                <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30">{DOC_META.status}</Badge>
              </div>
              <p className="text-slate-300 text-sm font-medium">{DOC_META.subtitle}</p>
              <p className="text-slate-400 text-xs mt-1">{DOC_META.classification} · {DOC_META.author} · Last Updated: {DOC_META.lastUpdated}</p>
            </div>
          </div>
        </div>

        <Separator className="my-5 bg-white/10" />

        <p className="text-slate-300 text-sm leading-relaxed max-w-4xl">
          {DOC_META.description}
        </p>

        {/* Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
          {[
            { label: "Total Requirements", value: totalReqs, color: "bg-white/10" },
            { label: "Critical Priority", value: criticalCount, color: "bg-red-500/20" },
            { label: "Functional (FR)", value: frCount, color: "bg-blue-500/20" },
            { label: "Non-Functional (NFR)", value: nfrCount, color: "bg-purple-500/20" },
          ].map(stat => (
            <div key={stat.label} className={`${stat.color} rounded-xl px-4 py-3`}>
              <div className="text-2xl font-black text-white">{stat.value}</div>
              <div className="text-xs text-slate-300 mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Legend ─────────────────────────────────────────── */}
      <Card className="border-dashed">
        <CardHeader className="pb-2 pt-4 px-5">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            <Info className="h-4 w-4" /> Requirement Type Legend
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          <div className="flex flex-wrap gap-2">
            {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
              <Badge key={key} variant="outline" className={`text-xs ${cfg.className}`}>
                <span className="font-black mr-1">{cfg.short}</span> {cfg.label}
              </Badge>
            ))}
            <Separator orientation="vertical" className="h-5" />
            {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
              <Badge key={key} variant="outline" className={`text-xs ${cfg.className}`}>
                {key}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Search & Filter ─────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search requirements by title, description, ID, or priority..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
        <Button 
          onClick={exportToPDF}
          variant="outline"
          className="gap-2"
        >
          <Download className="h-4 w-4" />
          Export PDF
        </Button>
        <div className="flex gap-1.5 flex-wrap">
          {typeFilters.map(f => {
            const cfg = TYPE_CONFIG[f];
            return (
              <button
                key={f}
                onClick={() => setActiveFilter(f)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all",
                  activeFilter === f
                    ? "bg-primary text-primary-foreground border-primary shadow"
                    : "bg-background text-muted-foreground border-border hover:bg-muted"
                )}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Module Sections ─────────────────────────────────── */}
      <div className="space-y-3">
        {MODULES.map((module, idx) => {
          const filtered = filterModule(module);
          if (filtered.length === 0 && (searchQuery || activeFilter !== "All")) return null;

          // pass filtered for display, full for section
          return (
            <ModuleSection
              key={module.id}
              module={{ ...module, requirements: filtered.length > 0 || (!searchQuery && activeFilter === "All") ? module.requirements : [] }}
              defaultOpen={idx === 0}
              searchQuery={activeFilter !== "All" ? activeFilter.toLowerCase() : sq}
            />
          );
        })}
      </div>

      {/* ── Document Footer ─────────────────────────────────── */}
      <Card className="border-dashed bg-muted/30">
        <CardContent className="pt-6 pb-5">
          <div className="flex items-start gap-3">
            <Star className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div>
              <h4 className="font-semibold text-sm mb-2">Document Governance</h4>
              <ul className="text-xs text-muted-foreground space-y-1.5">
                <li>• This document is the single authoritative source for all system requirements. Any feature or behaviour not documented here should be treated as undocumented and reviewed for inclusion.</li>
                <li>• All requirement IDs follow the format MODULE-NNN. IDs are stable and must not be reused after a requirement is deprecated.</li>
                <li>• Requirements marked <strong>Critical</strong> represent core system invariants — any change to Critical requirements requires a formal impact assessment.</li>
                <li>• This document must be updated before or alongside any significant feature change, constraint modification, or architectural decision.</li>
                <li>• Deprecated requirements should be marked as such with a deprecation note, not deleted, to preserve the historical requirements trail.</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}