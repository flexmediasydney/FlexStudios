/**
 * QOL COMPONENTS - USAGE GUIDE
 * 
 * All 7 new safety components are reusable across the app.
 * Use this guide to implement them in other pages/forms.
 */

export const COMPONENT_USAGE = {
  // ========== 1. RequiredFieldIndicator ==========
  1: {
    name: 'RequiredFieldIndicator',
    path: 'components/common/RequiredFieldIndicator.jsx',
    purpose: 'Display red asterisk (*) for required form fields',
    usage: `
      import RequiredFieldIndicator from '@/components/common/RequiredFieldIndicator';
      
      <Label>
        Email
        <RequiredFieldIndicator required={true} />
      </Label>
    `,
    props: {
      required: 'boolean - Show asterisk if true',
      className: 'string - Additional CSS classes'
    },
    locations_to_add: [
      'All form fields that are mandatory',
      'ProjectForm (✅ DONE)',
      'AgentForm, ClientForm, TeamForm',
      'Settings pages'
    ]
  },

  // ========== 2. RealtimeValidationFeedback ==========
  2: {
    name: 'RealtimeValidationFeedback',
    path: 'components/common/RealtimeValidationFeedback.jsx',
    purpose: 'Show validation state as user types (green checkmark or red error)',
    usage: `
      import RealtimeValidationFeedback from '@/components/common/RealtimeValidationFeedback';
      
      const [isValid, setIsValid] = useState(null);
      const [errorMsg, setErrorMsg] = useState('');
      
      <input onChange={(e) => {
        const valid = e.target.value.includes('@');
        setIsValid(valid);
        setErrorMsg(valid ? '' : 'Must contain @');
      }} />
      
      <RealtimeValidationFeedback 
        isValid={isValid}
        errorMessage={errorMsg}
        showOnValid={true}
      />
    `,
    props: {
      isValid: 'null | boolean - null=hidden, true=green, false=red',
      errorMessage: 'string - Error text to display',
      showOnValid: 'boolean - Show checkmark when valid (default: true)',
      className: 'string - Additional CSS'
    },
    locations_to_add: [
      'Email fields',
      'Phone number fields',
      'Address validation',
      'Password strength',
      'Any field with live validation'
    ]
  },

  // ========== 3. OverwriteConfirmation ==========
  3: {
    name: 'OverwriteConfirmation',
    path: 'components/common/OverwriteConfirmation.jsx',
    purpose: 'Warn user before overwriting existing data (e.g., changing agent)',
    usage: `
      import OverwriteConfirmation from '@/components/common/OverwriteConfirmation';
      
      const [showConfirm, setShowConfirm] = useState(false);
      
      <OverwriteConfirmation
        open={showConfirm}
        onOpenChange={setShowConfirm}
        itemType="Agent"
        itemName="John Smith"
        existingValue="John Smith"
        newValue="Jane Doe"
        onConfirm={() => {
          // Handle overwrite
          setShowConfirm(false);
        }}
        isLoading={saving}
      />
    `,
    props: {
      open: 'boolean',
      onOpenChange: 'function(boolean)',
      itemType: 'string - Type of item (Agent, Client, etc)',
      itemName: 'string - Name of item being overwritten',
      existingValue: 'string - Current value',
      newValue: 'string - New value',
      onConfirm: 'function - Called when user confirms',
      onCancel: 'function - Called when user cancels',
      isLoading: 'boolean - Disable during operation'
    },
    locations_to_add: [
      'When changing project agent',
      'When reassigning staff',
      'When changing pricing tier',
      'Any significant data change'
    ]
  },

  // ========== 4. BulkActionConfirmation ==========
  4: {
    name: 'BulkActionConfirmation',
    path: 'components/common/BulkActionConfirmation.jsx',
    purpose: 'Confirm before bulk delete/update/archive operations',
    usage: `
      import BulkActionConfirmation from '@/components/common/BulkActionConfirmation';
      
      const [showBulkConfirm, setShowBulkConfirm] = useState(false);
      const [selectedCount, setSelectedCount] = useState(0);
      
      <BulkActionConfirmation
        open={showBulkConfirm}
        onOpenChange={setShowBulkConfirm}
        actionType="delete"
        itemCount={selectedCount}
        itemLabel="projects"
        onConfirm={() => {
          // Handle bulk delete
          setShowBulkConfirm(false);
        }}
        isLoading={deleting}
      />
    `,
    props: {
      open: 'boolean',
      onOpenChange: 'function(boolean)',
      actionType: '"delete" | "update" | "archive"',
      itemCount: 'number - How many items',
      itemLabel: 'string - Plural label (projects, tasks)',
      onConfirm: 'function',
      onCancel: 'function',
      isLoading: 'boolean'
    },
    locations_to_add: [
      'Projects list bulk delete',
      'Tasks bulk operations',
      'Contacts bulk delete',
      'Any multi-select + action pattern'
    ]
  },

  // ========== 5. EscapeKeyWarning (Hook + Banner) ==========
  5: {
    name: 'useEscapeKeyWarning + EscapeKeyWarningBanner',
    path: 'components/common/EscapeKeyWarning.jsx',
    purpose: 'Warn user before closing dialog/page with unsaved changes',
    usage: `
      import { useEscapeKeyWarning, EscapeKeyWarningBanner } from '@/components/common/EscapeKeyWarning';
      
      export default function MyForm() {
        const [unsavedChanges, setUnsavedChanges] = useState(false);
        
        // Hook handles escape key automatically
        useEscapeKeyWarning(unsavedChanges);
        
        return (
          <div>
            {unsavedChanges && <EscapeKeyWarningBanner />}
            {/* form content */}
          </div>
        );
      }
    `,
    hook_name: 'useEscapeKeyWarning(unsavedChanges: boolean)',
    banner_props: {
      unsavedChanges: 'boolean - Show banner if true',
      className: 'string - Additional CSS'
    },
    notes: 'Hook automatically shows browser native confirm dialog',
    locations_to_add: [
      'ProjectForm (✅ DONE)',
      'AgentForm, ClientForm',
      'All modal forms with changes',
      'Rich text editors'
    ]
  },

  // ========== 6. CopyButton ==========
  6: {
    name: 'CopyButton',
    path: 'components/common/CopyFeedback.jsx',
    purpose: 'Copy text to clipboard with toast confirmation',
    usage: `
      import CopyButton from '@/components/common/CopyFeedback';
      
      <CopyButton
        text={projectId}
        label="Copy ID"
        showIcon={true}
        successMessage="Project ID copied!"
      />
    `,
    props: {
      text: 'string - Text to copy',
      label: 'string - Button label',
      variant: 'ghost | outline | default',
      size: 'sm | default | lg | icon',
      showIcon: 'boolean - Show copy icon',
      successMessage: 'string - Toast message',
      className: 'string - Additional CSS'
    },
    locations_to_add: [
      'Project ID display',
      'API keys in settings',
      'Webhook URLs',
      'Share links',
      'Any copyable data'
    ]
  },

  // ========== 7. NetworkErrorRetry ==========
  7: {
    name: 'NetworkErrorRetry',
    path: 'components/common/NetworkErrorRetry.jsx',
    purpose: 'Display network error with prominent "Try Again" button',
    usage: `
      import NetworkErrorRetry from '@/components/common/NetworkErrorRetry';
      
      const [error, setError] = useState(null);
      const [isRetrying, setIsRetrying] = useState(false);
      
      <NetworkErrorRetry
        error={error}
        onRetry={async () => {
          setIsRetrying(true);
          try {
            await saveProject();
            setError(null);
          } catch (err) {
            setError(err);
          } finally {
            setIsRetrying(false);
          }
        }}
        isRetrying={isRetrying}
      />
    `,
    props: {
      error: 'Error | null - Error object to display',
      onRetry: 'function - Called when user clicks retry',
      isRetrying: 'boolean - Disable button during retry',
      className: 'string - Additional CSS',
      variant: 'default - Button variant'
    },
    locations_to_add: [
      'ProjectForm (✅ DONE)',
      'Any form submission',
      'API call error handlers',
      'Upload dialogs'
    ]
  }
};

// ========== QUICK INTEGRATION CHECKLIST ==========
export const INTEGRATION_CHECKLIST = {
  for_new_form: [
    '✅ Import RequiredFieldIndicator',
    '✅ Mark required fields with asterisk',
    '✅ Import RealtimeValidationFeedback',
    '✅ Add validation feedback to key fields',
    '✅ Import useEscapeKeyWarning',
    '✅ Wrap form in escape key handler',
    '✅ Show EscapeKeyWarningBanner when unsaved',
    '✅ Import NetworkErrorRetry',
    '✅ Capture errors in try-catch',
    '✅ Show retry button on error'
  ],

  for_delete_operations: [
    '✅ Import RemoveItemConfirmation or DeleteConfirmationDialog',
    '✅ Create state for showing confirmation',
    '✅ On delete button click, show confirmation',
    '✅ On confirm, execute delete + success handling',
    '✅ Disable delete button during operation'
  ],

  for_list_views: [
    '✅ For bulk operations: Import BulkActionConfirmation',
    '✅ Add multi-select checkboxes',
    '✅ Show confirmation before bulk delete',
    '✅ Show item count in warning'
  ]
};

// ========== TESTING CHECKLIST FOR EACH COMPONENT ==========
export const COMPONENT_TEST_CHECKLIST = {
  'RequiredFieldIndicator': [
    'Red asterisk appears for required={true}',
    'No asterisk appears for required={false}',
    'Styling matches design system'
  ],
  
  'RealtimeValidationFeedback': [
    'Green checkmark shows when isValid={true}',
    'Red error shows when isValid={false}',
    'Nothing shows when isValid={null}',
    'Error message displays correctly',
    'Icons are clear and accessible'
  ],
  
  'OverwriteConfirmation': [
    'Dialog appears when open={true}',
    'Shows current and new values',
    'Cancel button closes without changes',
    'Confirm button calls onConfirm',
    'Buttons disabled during isLoading={true}',
    'Color scheme indicates destructive action'
  ],
  
  'BulkActionConfirmation': [
    'Shows correct count of items',
    'Verb matches actionType (delete/update/archive)',
    'Dialog appears and closes correctly',
    'Disabled state shows during operation',
    'Warning message clear and concise'
  ],
  
  'EscapeKeyWarning': [
    'Hook monitors escape key when unsavedChanges={true}',
    'Browser confirm dialog appears on escape',
    'Banner displays when unsavedChanges={true}',
    'No banner when unsavedChanges={false}',
    'Users can bypass warning by confirming'
  ],
  
  'CopyButton': [
    'Button shows copy icon',
    'Click copies text to clipboard',
    'Toast notification appears',
    'Icon changes to checkmark briefly',
    'Works with different text lengths'
  ],
  
  'NetworkErrorRetry': [
    'Error message displays when error exists',
    'Retry button is prominent',
    'Button disabled during isRetrying={true}',
    'Icon animates while retrying',
    'Error clears after successful retry'
  ]
};

export const SUMMARY = {
  total_components: 7,
  reusable_across_app: true,
  production_ready: true,
  test_coverage: 'Manual + integration tested',
  documentation: 'Complete with examples',
  
  where_to_use_next: [
    'AgentForm',
    'ClientForm',
    'Settings pages (Products, Packages, Pricing)',
    'Projects list (bulk operations)',
    'Tasks management (delete, reassign)',
    'Team management (bulk add/remove)',
    'Email templates (copy link)',
    'Any form with validation'
  ]
};