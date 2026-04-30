import { createNotificationsForUsers } from '@/components/notifications/createNotification';

const CONTEXT_PAGE = {
  agency: 'OrgDetails',
  project: 'ProjectDetails',
  agent: 'PersonDetails',
  team: 'TeamDetails',
};

function ctaForContext({ contextType, agencyId, projectId, agentId, teamId }) {
  const id =
    contextType === 'agency'  ? agencyId  :
    contextType === 'project' ? projectId :
    contextType === 'agent'   ? agentId   :
    contextType === 'team'    ? teamId    :
    null;
  if (!id || !CONTEXT_PAGE[contextType]) return { ctaUrl: null, ctaParams: null };
  return { ctaUrl: CONTEXT_PAGE[contextType], ctaParams: { id } };
}

function snippet(text, max = 100) {
  if (!text) return '';
  const t = String(text).trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Fire `note_mention` notifications for everyone tagged in a note.
 * No-op when there are no mentions or no resolvable context.
 */
export async function notifyNoteMentions({
  mentionedUserIds = [],
  noteId,
  noteContent,
  contextType,
  contextLabel,
  agencyId,
  projectId,
  agentId,
  teamId,
  authorName,
  authorUserId,
  isReply = false,
}) {
  const ids = [...new Set(mentionedUserIds.filter(Boolean))];
  if (!ids.length) return;
  const cta = ctaForContext({ contextType, agencyId, projectId, agentId, teamId });
  const where = contextLabel ? ` on ${contextLabel}` : '';
  const verb = isReply ? 'a comment' : 'a note';

  await createNotificationsForUsers(
    ids,
    {
      type: 'note_mention',
      title: `${authorName || 'Someone'} mentioned you in ${verb}${where}`,
      message: snippet(noteContent),
      projectId: projectId || null,
      entityType: 'note',
      entityId: noteId,
      ctaUrl: cta.ctaUrl,
      ctaParams: cta.ctaParams,
      sourceUserId: authorUserId,
      idempotencyKey: noteId ? `note_mention:${noteId}` : undefined,
    },
    authorUserId
  );
}

/**
 * Fire `note_reply` for the parent note's author when someone replies.
 * Skipped when the replier is the author or when the author was already @mentioned
 * in the same reply (avoids double-tap).
 */
export async function notifyNoteReply({
  parentAuthorUserId,
  parentNoteId,
  noteId,
  noteContent,
  contextType,
  contextLabel,
  agencyId,
  projectId,
  agentId,
  teamId,
  authorName,
  authorUserId,
  alreadyMentionedUserIds = [],
}) {
  if (!parentAuthorUserId) return;
  if (parentAuthorUserId === authorUserId) return;
  if (alreadyMentionedUserIds.includes(parentAuthorUserId)) return;

  const cta = ctaForContext({ contextType, agencyId, projectId, agentId, teamId });
  const where = contextLabel ? ` on ${contextLabel}` : '';

  await createNotificationsForUsers(
    [parentAuthorUserId],
    {
      type: 'note_reply',
      title: `${authorName || 'Someone'} replied to your note${where}`,
      message: snippet(noteContent),
      projectId: projectId || null,
      entityType: 'note',
      entityId: noteId,
      ctaUrl: cta.ctaUrl,
      ctaParams: cta.ctaParams,
      sourceUserId: authorUserId,
      idempotencyKey: noteId ? `note_reply:${noteId}:${parentAuthorUserId}` : undefined,
    },
    authorUserId
  );
}
