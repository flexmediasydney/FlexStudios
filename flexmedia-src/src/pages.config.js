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
import Analytics from './pages/Analytics';
import BountyBoard from './pages/BountyBoard';
import BusinessRequirementsDocument from './pages/BusinessRequirementsDocument';
import Calendar from './pages/Calendar';
import ClientAgents from './pages/ClientAgents';
import ClientGallery from './pages/ClientGallery';
import ClientMonitor from './pages/ClientMonitor';
import Dashboard from './pages/Dashboard';
import EmailSyncSettings from './pages/EmailSyncSettings';
import HierarchyVisualization from './pages/HierarchyVisualization';
import Inbox from './pages/Inbox';
import InternalRoadmap from './pages/InternalRoadmap';
import MarketingWithFlex from './pages/MarketingWithFlex';
import NotificationsPage from './pages/NotificationsPage';
import OrgDetails from './pages/OrgDetails';
import Organisations from './pages/Organisations';
import Packages from './pages/Packages';
import People from './pages/People';
import PersonDetails from './pages/PersonDetails';
import PriceMatrix from './pages/PriceMatrix';
import Products from './pages/Products';
import ProjectDetails from './pages/ProjectDetails';
import Projects from './pages/Projects';
import ProspectDetails from './pages/ProspectDetails';
import Prospecting from './pages/Prospecting';
import Settings from './pages/Settings';
import SettingsClients from './pages/SettingsClients';
import SettingsIntegrations from './pages/SettingsIntegrations';
import SettingsOrganisation from './pages/SettingsOrganisation';
import SettingsPriceMatrix from './pages/SettingsPriceMatrix';
import SettingsProductsPackages from './pages/SettingsProductsPackages';
import SettingsProjectRulebook from './pages/SettingsProjectRulebook';
import SettingsRevisionTemplates from './pages/SettingsRevisionTemplates';
import SettingsTeamsUsers from './pages/SettingsTeamsUsers';
import SettingsTonomoWebhooks from './pages/SettingsTonomoWebhooks';
import SoldWithFlex from './pages/SoldWithFlex';
import TeamDetails from './pages/TeamDetails';
import Teams from './pages/Teams';
import UserSettings from './pages/UserSettings';
import Users from './pages/Users';
import React from 'react';
import __Layout from './Layout.jsx';

// Lazy-loaded heavy pages (code-split into separate chunks)
const BusinessIntelligence = React.lazy(() => import('./pages/BusinessIntelligence'));
const EmployeeUtilization = React.lazy(() => import('./pages/EmployeeUtilization'));
const Reports = React.lazy(() => import('./pages/Reports'));
const SettingsTonomoIntegration = React.lazy(() => import('./pages/SettingsTonomoIntegration'));
const SettingsTonomoMappings = React.lazy(() => import('./pages/SettingsTonomoMappings'));
const TonomoIntegrationDashboard = React.lazy(() => import('./pages/TonomoIntegrationDashboard'));
const TonomoPulse = React.lazy(() => import('./pages/TonomoPulse'));
const SettingsAutomationRules = React.lazy(() => import('./pages/SettingsAutomationRules'));
const SettingsNotifications = React.lazy(() => import('./pages/SettingsNotifications'));
const NotificationsPulse = React.lazy(() => import('./pages/NotificationsPulse'));
const TeamPulsePage = React.lazy(() => import('./pages/TeamPulsePage'));


export const PAGES = {
    "AdminTodoList": AdminTodoList,
    "Analytics": Analytics,
    "BountyBoard": BountyBoard,
    "BusinessIntelligence": BusinessIntelligence,
    "BusinessRequirementsDocument": BusinessRequirementsDocument,
    "Calendar": Calendar,
    "ClientAgents": ClientAgents,
    "ClientGallery": ClientGallery,
    "ClientMonitor": ClientMonitor,
    "Dashboard": Dashboard,
    "EmailSyncSettings": EmailSyncSettings,
    "EmployeeUtilization": EmployeeUtilization,
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
    "ProspectDetails": ProspectDetails,
    "Prospecting": Prospecting,
    "Reports": Reports,
    "Settings": Settings,
    "SettingsAutomationRules": SettingsAutomationRules,
    "SettingsClients": SettingsClients,
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
    "TeamPulsePage": TeamPulsePage,
    "Teams": Teams,
    "TonomoIntegrationDashboard": TonomoIntegrationDashboard,
    "TonomoPulse": TonomoPulse,
    "UserSettings": UserSettings,
    "Users": Users,
}

export const pagesConfig = {
    mainPage: "Dashboard",
    Pages: PAGES,
    Layout: __Layout,
};