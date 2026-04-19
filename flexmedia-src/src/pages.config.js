/**
 * pages.config.js - Page routing configuration
 *
 * This file is AUTO-GENERATED. Do not add imports or modify PAGES manually.
 * Pages are auto-registered when you create files in the ./pages/ folder.
 *
 * THE ONLY EDITABLE VALUE: mainPage
 * This controls which page is the landing page (shown when users visit the app).
 *
 * Example file structure:
 *
 *   import HomePage from './pages/HomePage';
 *   import Dashboard from './pages/Dashboard';
 *   import Settings from './pages/Settings';
 *
 *   export const PAGES = {
 *       "HomePage": HomePage,
 *       "Dashboard": Dashboard,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "HomePage",
 *       Pages: PAGES,
 *   };
 *
 * Example with Layout (wraps all pages):
 *
 *   import Home from './pages/Home';
 *   import Settings from './pages/Settings';
 *   import __Layout from './Layout.jsx';
 *
 *   export const PAGES = {
 *       "Home": Home,
 *       "Settings": Settings,
 *   }
 *
 *   export const pagesConfig = {
 *       mainPage: "Home",
 *       Pages: PAGES,
 *       Layout: __Layout,
 *   };
 *
 * To change the main page from HomePage to Dashboard, use find_replace:
 *   Old: mainPage: "HomePage",
 *   New: mainPage: "Dashboard",
 *
 * The mainPage value must match a key in the PAGES object exactly.
 */
import AdminTodoList from './pages/AdminTodoList';
import BountyBoard from './pages/BountyBoard';
import EdgeFunctionHealth from './pages/EdgeFunctionHealth';
import EdgeFunctionAuditLog from './pages/EdgeFunctionAuditLog';
import EmailSyncSettings from './pages/EmailSyncSettings';
import SettingsEmailSyncHealth from './pages/SettingsEmailSyncHealth';
import HierarchyVisualization from './pages/HierarchyVisualization';
import Inbox from './pages/Inbox';
import InternalRoadmap from './pages/InternalRoadmap';
import MarketingWithFlex from './pages/MarketingWithFlex';
import Settings from './pages/Settings';
import SettingsClients from './pages/SettingsClients';
import SettingsIntegrations from './pages/SettingsIntegrations';
import SettingsOrganisation from './pages/SettingsOrganisation';
import SettingsPriceMatrix from './pages/SettingsPriceMatrix';
import SettingsProductsPackages from './pages/SettingsProductsPackages';
import SettingsProjectRulebook from './pages/SettingsProjectRulebook';
import SettingsRevisionTemplates from './pages/SettingsRevisionTemplates';
import SoldWithFlex from './pages/SoldWithFlex';
import Teams from './pages/Teams';
import UserSettings from './pages/UserSettings';
import React from 'react';
import __Layout from './Layout.jsx';

// Lazy-loaded pages (code-split into separate chunks)
const GoalDetails = React.lazy(() => import('./pages/GoalDetails'));
const Goals = React.lazy(() => import('./pages/Goals'));
const BusinessRequirementsDocument = React.lazy(() => import('./pages/BusinessRequirementsDocument'));
const Calendar = React.lazy(() => import('./pages/Calendar'));
const ClientAgents = React.lazy(() => import('./pages/ClientAgents'));
const ClientGallery = React.lazy(() => import('./pages/ClientGallery'));
const ClientMonitor = React.lazy(() => import('./pages/ClientMonitor'));
const IndustryPulse = React.lazy(() => import('./pages/IndustryPulse'));
const SalesCommand = React.lazy(() => import('./pages/SalesCommand'));
const SalesMap = React.lazy(() => import('./pages/SalesMap'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const FieldMode = React.lazy(() => import('./pages/FieldMode'));
const NotificationsPage = React.lazy(() => import('./pages/NotificationsPage'));
const NotificationsPulse = React.lazy(() => import('./pages/NotificationsPulse'));
const OrgDetails = React.lazy(() => import('./pages/OrgDetails'));
const Organisations = React.lazy(() => import('./pages/Organisations'));
const Packages = React.lazy(() => import('./pages/Packages'));
const People = React.lazy(() => import('./pages/People'));
const PersonDetails = React.lazy(() => import('./pages/PersonDetails'));
const PriceMatrix = React.lazy(() => import('./pages/PriceMatrix'));
const Products = React.lazy(() => import('./pages/Products'));
const ProjectDetails = React.lazy(() => import('./pages/ProjectDetails'));
const Properties = React.lazy(() => import('./pages/Properties'));
const PropertyDetails = React.lazy(() => import('./pages/PropertyDetails'));
const PropertyProspects = React.lazy(() => import('./pages/PropertyProspects'));
const PropertyMergeTool = React.lazy(() => import('./pages/PropertyMergeTool'));
const Projects = React.lazy(() => import('./pages/Projects'));
const ProspectDetails = React.lazy(() => import('./pages/ProspectDetails'));
const Prospecting = React.lazy(() => import('./pages/Prospecting'));
const Reports = React.lazy(() => import('./pages/Reports'));
const LegacyMarketShareReport = React.lazy(() => import('./pages/LegacyMarketShareReport'));
const SocialMedia = React.lazy(() => import('./pages/SocialMedia'));
const Tasks = React.lazy(() => import('./pages/Tasks'));
const SettingsAutomationRules = React.lazy(() => import('./pages/SettingsAutomationRules'));
const SettingsNotifications = React.lazy(() => import('./pages/SettingsNotifications'));
const SettingsTeamsUsers = React.lazy(() => import('./pages/SettingsTeamsUsers'));
const SettingsTonomoIntegration = React.lazy(() => import('./pages/SettingsTonomoIntegration'));
const SettingsTonomoMappings = React.lazy(() => import('./pages/SettingsTonomoMappings'));
// SettingsStaffDefaults removed — now a subtab in SettingsTeamsUsers
const SettingsAI = React.lazy(() => import('./pages/SettingsAI'));
const SettingsDataConsistency = React.lazy(() => import('./pages/SettingsDataConsistency'));
const SettingsLegacyPackageMapping = React.lazy(() => import('./pages/SettingsLegacyPackageMapping'));
const SettingsLegacyImport = React.lazy(() => import('./pages/SettingsLegacyImport'));
const SettingsLegacyCrmReconciliation = React.lazy(() => import('./pages/SettingsLegacyCrmReconciliation'));
const SettingsTonomoWebhooks = React.lazy(() => import('./pages/SettingsTonomoWebhooks'));
const AIAuditLog = React.lazy(() => import('./pages/AIAuditLog'));
const TeamDetails = React.lazy(() => import('./pages/TeamDetails'));
const TonomoIntegrationDashboard = React.lazy(() => import('./pages/TonomoIntegrationDashboard'));
const TonomoPulse = React.lazy(() => import('./pages/TonomoPulse'));
const TalentPulse = React.lazy(() => import('./pages/TalentPulse'));
const Users = React.lazy(() => import('./pages/Users'));


export const PAGES = {
    "AdminTodoList": AdminTodoList,
    "AIAuditLog": AIAuditLog,
    "BountyBoard": BountyBoard,
    "BusinessRequirementsDocument": BusinessRequirementsDocument,
    "Calendar": Calendar,
    "ClientAgents": ClientAgents,
    "ClientGallery": ClientGallery,
    "ClientMonitor": ClientMonitor,
    "IndustryPulse": IndustryPulse,
    "SalesCommand": SalesCommand,
    "SalesMap": SalesMap,
    "Dashboard": Dashboard,
    "EdgeFunctionHealth": EdgeFunctionHealth,
    "EdgeFunctionAuditLog": EdgeFunctionAuditLog,
    "EmailSyncSettings": EmailSyncSettings,
    "SettingsEmailSyncHealth": SettingsEmailSyncHealth,
    "FieldMode": FieldMode,
    "GoalDetails": GoalDetails,
    "Goals": Goals,
    "HierarchyVisualization": HierarchyVisualization,
    "Inbox": Inbox,
    "InternalRoadmap": InternalRoadmap,
    "MarketingWithFlex": MarketingWithFlex,
    "NotificationsPage": NotificationsPage,
    "NotificationsPulse": NotificationsPulse,
    "OrgDetails": OrgDetails,
    "Organisations": Organisations,
    "Packages": Packages,
    "People": People,
    "PersonDetails": PersonDetails,
    "PriceMatrix": PriceMatrix,
    "Products": Products,
    "ProjectDetails": ProjectDetails,
    "Projects": Projects,
    "Properties": Properties,
    "PropertyDetails": PropertyDetails,
    "PropertyProspects": PropertyProspects,
    "PropertyMergeTool": PropertyMergeTool,
    "ProspectDetails": ProspectDetails,
    "Prospecting": Prospecting,
    "Reports": Reports,
    "Reports/LegacyMarketShare": LegacyMarketShareReport,
    "Settings": Settings,
    "SettingsAI": SettingsAI,
    "SettingsAutomationRules": SettingsAutomationRules,
    "SocialMedia": SocialMedia,
    "Tasks": Tasks,
    "SettingsClients": SettingsClients,
    "SettingsDataConsistency": SettingsDataConsistency,
    "SettingsLegacyPackageMapping": SettingsLegacyPackageMapping,
    "SettingsLegacyImport": SettingsLegacyImport,
    "SettingsLegacyCrmReconciliation": SettingsLegacyCrmReconciliation,
    "SettingsIntegrations": SettingsIntegrations,
    "SettingsNotifications": SettingsNotifications,
    "SettingsOrganisation": SettingsOrganisation,
    "SettingsPriceMatrix": SettingsPriceMatrix,
    "SettingsProductsPackages": SettingsProductsPackages,
    "SettingsProjectRulebook": SettingsProjectRulebook,
    "SettingsRevisionTemplates": SettingsRevisionTemplates,
    "SettingsTeamsUsers": SettingsTeamsUsers,
    "SettingsTonomoIntegration": SettingsTonomoIntegration,
    "SettingsTonomoMappings": SettingsTonomoMappings,
    "SettingsTonomoWebhooks": SettingsTonomoWebhooks,
    "SoldWithFlex": SoldWithFlex,
    "TeamDetails": TeamDetails,
    "Teams": Teams,
    "TonomoIntegrationDashboard": TonomoIntegrationDashboard,
    "TalentPulse": TalentPulse,
    "TonomoPulse": TonomoPulse,
    "UserSettings": UserSettings,
    "Users": Users,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};
