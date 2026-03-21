/**
 * EmailComposeReply — thin backward-compat wrapper around EmailComposeDialog.
 *
 * Used inside EmailThreadViewer for inline reply. Maps the legacy
 * `thread` / `account` / `onReplyMode` / `emailAccounts` interface to the
 * unified compose dialog with mode='reply'.
 */
import EmailComposeDialog from "./EmailComposeDialog";

export default function EmailComposeReply({
  thread,
  account,
  onClose,
  onReplyMode,
  emailAccounts = [],
  defaultBodyPrefix = '',
  replyType = 'reply',
  replyToMessage,
  ...rest
}) {
  // If a specific message to reply to is provided, use it; otherwise use latest
  const latestMsg = replyToMessage || thread?.messages?.[thread.messages.length - 1] || thread?.messages?.[0];
  const emailFromThread = latestMsg
    ? {
        from: latestMsg.from,
        from_name: latestMsg.from_name,
        to: latestMsg.to,
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
      type={replyType}
      onClose={onClose}
      onSent={onClose}
      defaultBodyPrefix={defaultBodyPrefix}
      {...rest}
    />
  );
}
