/**
 * 50 QoL IMPROVEMENTS - CATALOG & PRIORITY MATRIX
 * 
 * All improvements are purely UI/UX focused
 * Organized by category and implementation priority
 */

export const QOL_IMPROVEMENTS = {
  // ========== TIER 1: CRITICAL SAFETY (13) ==========
  TIER_1_SAFETY: [
    {
      id: 'S1.1',
      title: 'Delete confirmation dialogs',
      category: 'Delete Safety',
      impact: 'critical',
      complexity: 'low',
      description: 'Two-step confirmation before any destructive action',
      components: ['RemoveItemConfirmation', 'DeleteConfirmationDialog'],
      status: '✅ DONE'
    },
    {
      id: 'S1.2',
      title: 'Affected items count on delete',
      category: 'Delete Safety',
      impact: 'high',
      complexity: 'low',
      description: 'Show how many related items will be affected',
      components: ['RemoveItemConfirmation'],
      status: '✅ DONE'
    },
    {
      id: 'S1.3',
      title: 'Delete button disabled during save',
      category: 'Button Guard',
      impact: 'critical',
      complexity: 'low',
      description: 'Prevent double-clicks and accidental deletes',
      components: ['ProjectForm'],
      status: '✅ DONE'
    },
    {
      id: 'S1.4',
      title: 'Submit button disabled on validation error',
      category: 'Button Guard',
      impact: 'critical',
      complexity: 'low',
      description: 'Show red error and prevent form submission',
      components: ['SubmitButtonGuard'],
      status: '✅ DONE'
    },
    {
      id: 'S1.5',
      title: 'Character limit warnings',
      category: 'Input Guard',
      impact: 'high',
      complexity: 'low',
      description: 'Yellow@80%, red@100% on text fields',
      components: ['CharacterLimitWarning'],
      status: '✅ DONE'
    },
    {
      id: 'S1.6',
      title: 'Unsaved changes indicator',
      category: 'State Safety',
      impact: 'critical',
      complexity: 'low',
      description: 'Red dot shows form is dirty',
      components: ['UnsavedChangesWarning'],
      status: '✅ DONE'
    },
    {
      id: 'S1.7',
      title: 'Required field indicators (*)',
      category: 'Input Guard',
      impact: 'medium',
      complexity: 'low',
      description: 'Mark required fields clearly',
      components: ['Label'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.8',
      title: 'Real-time validation feedback',
      category: 'Input Guard',
      impact: 'high',
      complexity: 'medium',
      description: 'Show errors as user types, not on blur',
      components: ['ProjectForm', 'AddressInput'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.9',
      title: 'Disable overwrite confirmation',
      category: 'Delete Safety',
      impact: 'medium',
      complexity: 'medium',
      description: 'Warn when overwriting existing data',
      components: ['ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.10',
      title: 'Bulk action confirmation',
      category: 'Delete Safety',
      impact: 'high',
      complexity: 'medium',
      description: 'Confirm before bulk delete/update',
      components: ['EntityDataTable'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.11',
      title: 'Escape key warning',
      category: 'State Safety',
      impact: 'medium',
      complexity: 'low',
      description: 'Warn before closing unsaved form',
      components: ['ProjectForm', 'Dialog'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.12',
      title: 'Copy-to-clipboard feedback',
      category: 'Button Guard',
      impact: 'low',
      complexity: 'low',
      description: 'Toast confirmation when copy succeeds',
      components: ['CopyButton'],
      status: '⏳ TODO'
    },
    {
      id: 'S1.13',
      title: 'Network error retry button',
      category: 'Button Guard',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show "Try Again" on failed API calls',
      components: ['ErrorBoundary'],
      status: '⏳ TODO'
    }
  ],

  // ========== TIER 2: HOVER & TOOLTIPS (15) ==========
  TIER_2_HOVER_TOOLTIPS: [
    {
      id: 'H2.1',
      title: 'Field help tooltips',
      category: 'Hover Info',
      impact: 'high',
      complexity: 'low',
      description: 'Info icon with tooltip on every form field',
      components: ['FieldHelpIcon'],
      status: '✅ DONE'
    },
    {
      id: 'H2.2',
      title: 'Disabled field explanations',
      category: 'Hover Info',
      impact: 'medium',
      complexity: 'low',
      description: 'Lock icon + tooltip explaining why disabled',
      components: ['DisabledFieldTooltip'],
      status: '✅ DONE'
    },
    {
      id: 'H2.3',
      title: 'Agent details on hover',
      category: 'Entity Hover',
      impact: 'high',
      complexity: 'medium',
      description: 'Popup with agent/client info on name hover',
      components: ['HoverCard'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.4',
      title: 'Project status stage flow on hover',
      category: 'Entity Hover',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show possible next stages in tooltip',
      components: ['StagePipeline'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.5',
      title: 'Price calculation breakdown',
      category: 'Calculation Hover',
      impact: 'high',
      complexity: 'medium',
      description: 'Hover price to see base + tier + adjustments',
      components: ['ProjectPricingTable'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.6',
      title: 'Effort estimate breakdown',
      category: 'Calculation Hover',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show hours per task type on total hover',
      components: ['ProjectEffortSummaryV2'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.7',
      title: 'Task dependency chain tooltip',
      category: 'Entity Hover',
      impact: 'medium',
      complexity: 'high',
      description: 'Show blocking/blocked tasks on hover',
      components: ['TaskManagement'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.8',
      title: 'Keyboard shortcut hints',
      category: 'Help Tooltip',
      impact: 'medium',
      complexity: 'low',
      description: 'Show "Ctrl+S to save" in button titles',
      components: ['ProjectForm', 'Dialog'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.9',
      title: 'Invalid state explanations',
      category: 'Error Hover',
      impact: 'high',
      complexity: 'low',
      description: 'Hover error message to see full explanation',
      components: ['FormField'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.10',
      title: 'Role permission hints',
      category: 'Help Tooltip',
      impact: 'medium',
      complexity: 'low',
      description: 'Why button is disabled for your role',
      components: ['Button'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.11',
      title: 'Filter tag explanations',
      category: 'Help Tooltip',
      impact: 'low',
      complexity: 'low',
      description: 'Explain what each active filter does',
      components: ['ProjectFiltersSort'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.12',
      title: 'Status badge color legend',
      category: 'Help Tooltip',
      impact: 'low',
      complexity: 'low',
      description: 'Hover badge to see what color means',
      components: ['ProjectStatusBadge'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.13',
      title: 'Team member availability on hover',
      category: 'Entity Hover',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show utilization % when assigning staff',
      components: ['AssignUsersDialog'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.14',
      title: 'Due date calculation explanation',
      category: 'Calculation Hover',
      impact: 'low',
      complexity: 'low',
      description: 'Show how deadline was calculated',
      components: ['ProjectTask'],
      status: '⏳ TODO'
    },
    {
      id: 'H2.15',
      title: 'Price tier difference tooltip',
      category: 'Calculation Hover',
      impact: 'high',
      complexity: 'low',
      description: 'Show standard vs premium price delta',
      components: ['ProjectPricingTable'],
      status: '⏳ TODO'
    }
  ],

  // ========== TIER 3: DRILL-THROUGH (12) ==========
  TIER_3_DRILL_THROUGH: [
    {
      id: 'D3.1',
      title: 'Clickable project links in feeds',
      category: 'Navigation',
      impact: 'high',
      complexity: 'low',
      description: 'Project name is link to details page',
      components: ['ActivityFeed', 'TeamActivityFeed'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.2',
      title: 'Jump to error button',
      category: 'Navigation',
      impact: 'high',
      complexity: 'medium',
      description: 'Error message has button to jump to field',
      components: ['ValidationBanner'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.3',
      title: 'Breadcrumb navigation in modals',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show path: Project > Tasks > Task Details',
      components: ['Dialog', 'ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.4',
      title: 'Task title clickable to details',
      category: 'Navigation',
      impact: 'high',
      complexity: 'low',
      description: 'Click task name in list to see full details',
      components: ['TaskListView', 'TaskManagement'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.5',
      title: 'Agent name drill to profile',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'low',
      description: 'Click agent to see full contact info',
      components: ['AgentForm', 'ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.6',
      title: 'View in full page button',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'low',
      description: 'Open dialog content in full page view',
      components: ['Dialog'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.7',
      title: 'Recent projects quick access',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'low',
      description: 'Sidebar showing last 5 viewed projects',
      components: ['Sidebar'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.8',
      title: 'Search filter path indicators',
      category: 'Navigation',
      impact: 'low',
      complexity: 'low',
      description: 'Show how many results match this filter',
      components: ['GlobalSearch'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.9',
      title: 'Back to previous view button',
      category: 'Navigation',
      impact: 'high',
      complexity: 'medium',
      description: 'Browser back button integration + custom back',
      components: ['Layout'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.10',
      title: 'Related items quick links',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'medium',
      description: 'Links to related projects/clients/agents',
      components: ['ProjectDetails'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.11',
      title: 'Conflict detection jump button',
      category: 'Navigation',
      impact: 'medium',
      complexity: 'high',
      description: 'If data changed, button jumps to conflict',
      components: ['ConcurrentEditDetector'],
      status: '⏳ TODO'
    },
    {
      id: 'D3.12',
      title: 'Revision history drill-down',
      category: 'Navigation',
      impact: 'low',
      complexity: 'medium',
      description: 'Click revision to see before/after diff',
      components: ['ProjectHistorySection'],
      status: '⏳ TODO'
    }
  ],

  // ========== TIER 4: POP-UPS & MODALS (10) ==========
  TIER_4_POPUPS: [
    {
      id: 'P4.1',
      title: 'Staged delete confirmation',
      category: 'Delete Popup',
      impact: 'high',
      complexity: 'low',
      description: 'Confirm → Verify type name → Delete',
      components: ['DeleteConfirmationDialog'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.2',
      title: 'Error detail expansion',
      category: 'Error Popup',
      impact: 'medium',
      complexity: 'low',
      description: 'Click error to see full stack/details',
      components: ['Alert'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.3',
      title: 'Loading progress indicator',
      category: 'Feedback Popup',
      impact: 'medium',
      complexity: 'medium',
      description: 'Show operation progress (50%, 75%, done)',
      components: ['Dialog', 'ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.4',
      title: 'Password confirmation popup',
      category: 'Security Popup',
      impact: 'medium',
      complexity: 'medium',
      description: 'Ask for password on sensitive ops',
      components: ['Dialog'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.5',
      title: 'Duplicate detection alert',
      category: 'Conflict Popup',
      impact: 'medium',
      complexity: 'medium',
      description: 'Warn if creating duplicate client/agent',
      components: ['ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.6',
      title: 'Impact preview modal',
      category: 'Preview Popup',
      impact: 'high',
      complexity: 'medium',
      description: 'Show what will change before submitting',
      components: ['ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.7',
      title: 'Success celebration toast',
      category: 'Feedback Popup',
      impact: 'low',
      complexity: 'low',
      description: 'Confetti/celebration on major actions',
      components: ['Toast'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.8',
      title: 'Unsaved data recovery popup',
      category: 'State Popup',
      impact: 'high',
      complexity: 'high',
      description: 'Offer to restore last unsaved form',
      components: ['ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.9',
      title: 'Scheduled action confirmation',
      category: 'Schedule Popup',
      impact: 'medium',
      complexity: 'medium',
      description: 'Confirm before scheduling automation',
      components: ['AutomationRuleLog'],
      status: '⏳ TODO'
    },
    {
      id: 'P4.10',
      title: 'Rate limit warning popup',
      category: 'Rate Limit Popup',
      impact: 'low',
      complexity: 'low',
      description: 'Warn if approaching API rate limits',
      components: ['ErrorBoundary'],
      status: '⏳ TODO'
    }
  ],

  // ========== TIER 5: VISUAL FEEDBACK (10) ==========
  TIER_5_FEEDBACK: [
    {
      id: 'V5.1',
      title: 'Loading skeleton screens',
      category: 'Loading State',
      impact: 'high',
      complexity: 'low',
      description: 'Shimmer placeholders while data loads',
      components: ['Skeleton'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.2',
      title: 'Animated state transitions',
      category: 'Animation',
      impact: 'medium',
      complexity: 'low',
      description: 'Fade/slide when status changes',
      components: ['ProjectForm', 'Dialog'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.3',
      title: 'Button loading spinners',
      category: 'Loading State',
      impact: 'high',
      complexity: 'low',
      description: 'Spinner + "Saving..." in button',
      components: ['Button'],
      status: '✅ DONE'
    },
    {
      id: 'V5.4',
      title: 'Success checkmark animation',
      category: 'Success State',
      impact: 'medium',
      complexity: 'low',
      description: 'Animated checkmark on save success',
      components: ['ProjectForm'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.5',
      title: 'Error state highlight',
      category: 'Error State',
      impact: 'high',
      complexity: 'low',
      description: 'Highlight field with red border',
      components: ['FormField'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.6',
      title: 'Active tab indication',
      category: 'Visual Indicator',
      impact: 'medium',
      complexity: 'low',
      description: 'Underline + color on active tab',
      components: ['Tabs'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.7',
      title: 'Pending action indicator',
      category: 'Visual Indicator',
      impact: 'medium',
      complexity: 'low',
      description: 'Pulsing dot on items with pending ops',
      components: ['ProjectCard'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.8',
      title: 'Focus ring on keyboard nav',
      category: 'Accessibility',
      impact: 'high',
      complexity: 'low',
      description: 'Clear focus ring for keyboard users',
      components: ['Button', 'Input'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.9',
      title: 'Hover highlight with shadow',
      category: 'Interaction Hint',
      impact: 'medium',
      complexity: 'low',
      description: 'Button/row lifts on hover',
      components: ['Button', 'Card'],
      status: '⏳ TODO'
    },
    {
      id: 'V5.10',
      title: 'Disabled state opacity',
      category: 'Visual Indicator',
      impact: 'medium',
      complexity: 'low',
      description: 'Greyed out disabled buttons clearly',
      components: ['Button'],
      status: '⏳ TODO'
    }
  ]
};

export const QOL_SUMMARY = {
  total_improvements: 50,
  tier_1_critical: 13,
  tier_2_hover: 15,
  tier_3_drill: 12,
  tier_4_popups: 10,
  tier_5_feedback: 10,
  
  status_breakdown: {
    done: 6,
    todo: 44
  },
  
  recommended_implementation_order: [
    'TIER_1_SAFETY (remaining 7)',
    'TIER_5_FEEDBACK (5 visual only)',
    'TIER_2_HOVER_TOOLTIPS (14)',
    'TIER_3_DRILL_THROUGH (12)',
    'TIER_4_POPUPS (10)'
  ],
  
  estimated_time: {
    tier_1_remaining: '2 hours',
    tier_5_visual: '1.5 hours',
    tier_2_hover: '4 hours',
    tier_3_drill: '4 hours',
    tier_4_popups: '3 hours',
    total: '14.5 hours'
  }
};