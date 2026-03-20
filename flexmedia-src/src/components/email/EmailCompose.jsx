/**
 * EmailCompose — thin backward-compat wrapper around EmailComposeDialog.
 *
 * Accepts the legacy `account` / `onClose` / `onSent` interface used by
 * EmailInbox and delegates everything to the unified compose dialog.
 */
import EmailComposeDialog from "./EmailComposeDialog";

export default function EmailCompose({ account, onClose, onSent, ...rest }) {
  return (
    <EmailComposeDialog
      account={account}
      onClose={onClose}
      onSent={onSent}
      type="compose"
      {...rest}
    />
  );
}
