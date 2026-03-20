/**
 * EmailReplyCompose — thin backward-compat wrapper around EmailComposeDialog.
 *
 * Accepts the legacy `thread` / `account` / `onClose` interface and maps
 * them to the unified compose dialog props with mode='reply'.
 */
import EmailComposeDialog from "./EmailComposeDialog";

export default function EmailReplyCompose({ thread, account, onClose, ...rest }) {
  // Build an email-shaped object from the thread so EmailComposeDialog can
  // populate recipients, subject, and the quoted reply block.
  const latestMsg = thread?.messages?.[thread.messages.length - 1] || thread?.messages?.[0];
  const emailFromThread = latestMsg
    ? {
        from: latestMsg.from,
        from_name: latestMsg.from_name,
        subject: thread.subject,
        body: latestMsg.body,
        received_at: latestMsg.received_at || latestMsg.date,
        cc: latestMsg.cc,
        gmail_message_id: latestMsg.gmail_message_id,
        gmail_thread_id: thread.threadId,
      }
    : null;

  return (
    <EmailComposeDialog
      email={emailFromThread}
      account={account}
      type="reply"
      onClose={onClose}
      onSent={onClose}
      {...rest}
    />
  );
}
