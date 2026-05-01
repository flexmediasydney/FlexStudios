/**
 * LockConfirmDialog — Wave 11.6.3 P3 #11
 *
 * The PRE-lock confirmation dialog (the "are you sure?" prompt that appears
 * BEFORE the operator commits to the lock action). This is distinct from
 * `LockProgressDialog`, which renders the live progress bar AFTER the lock
 * fires and Dropbox starts moving files.
 *
 * Why it exists:
 *   The previous inline confirm in ShortlistingSwimlane was unclear about how
 *   the swimlane's three columns map to Dropbox folders on lock. Joseph's
 *   feedback — operator "can't see how many cards will stay in source" — was
 *   correct: the old text only mentioned approved + rejected counts, with no
 *   word about the AI-PROPOSED column (the cards the operator never decided
 *   on). Per the lock fn (`buildMoveSpecs`, line 110: "undecided → leave
 *   alone"), groups still in the proposed column are NOT moved — they stay in
 *   `Photos/Raws/Shortlist Proposed/` until the operator triages them in a
 *   later round or manually moves them in Dropbox.
 *
 * Math contract (matching the swimlane's `columnItems` derivation, which in
 * turn matches the lock fn's `computeApprovedRejectedSets`):
 *
 *   approvedCount   → number of composition_groups in the swimlane's
 *                     `approved` column. They MOVE to Photos/Raws/Final
 *                     Shortlist/.
 *   rejectedCount   → number of composition_groups in the `rejected` column.
 *                     They MOVE to Photos/Raws/Rejected/.
 *   undecidedCount  → number of composition_groups in the `proposed` column —
 *                     i.e. AI-proposed groups the operator never resolved.
 *                     They STAY in Photos/Raws/Shortlist Proposed/.
 *
 * The destination folder names mirror the constants resolved in the
 * `shortlist-lock` edge fn (`Photos/Raws/Final Shortlist/`,
 * `Photos/Raws/Rejected/`, source `Photos/Raws/Shortlist Proposed/`). If the
 * lock fn ever migrates to a different convention, update both sides.
 *
 * Layout:
 *   3-column grid (one cell per bucket). Each cell carries an icon, the count,
 *   the bucket label, the action verb (Moves to / Stays in) and the
 *   destination folder. This matches the visual rhythm of the existing
 *   LockProgressDialog post-lock counts so the operator gets a "before/after"
 *   sense of the action.
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  CheckCircle2,
  XCircle,
  HelpCircle,
  Loader2,
  ArrowRight,
  Pause,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Folder constants — kept in sync with `shortlist-lock` edge fn:
//   Photos/Raws/Shortlist Proposed/ — source
//   Photos/Raws/Final Shortlist/    — approved destination
//   Photos/Raws/Rejected/           — rejected destination
const FOLDER_APPROVED = "Photos/Raws/Final Shortlist/";
const FOLDER_REJECTED = "Photos/Raws/Rejected/";
const FOLDER_SOURCE = "Photos/Raws/Shortlist Proposed/";

function CountCell({ icon: Icon, iconClass, count, label, verb, folder, verbIcon: VerbIcon }) {
  return (
    <div className="rounded-md border bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("h-4 w-4", iconClass)} aria-hidden="true" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-none">
        {count}
      </div>
      <div className="flex items-start gap-1 text-[10px] text-muted-foreground">
        <VerbIcon className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div>{verb}</div>
          <code className="text-[10px] font-mono text-foreground break-all">
            {folder}
          </code>
        </div>
      </div>
    </div>
  );
}

export default function LockConfirmDialog({
  open,
  onOpenChange,
  approvedCount = 0,
  rejectedCount = 0,
  undecidedCount = 0,
  isLocking = false,
  onConfirm,
}) {
  const total = approvedCount + rejectedCount + undecidedCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Lock &amp; reorganize shortlist?</DialogTitle>
          <DialogDescription>
            {total > 0 ? (
              <>
                Locking will move {approvedCount + rejectedCount} of {total}{" "}
                composition{total === 1 ? "" : "s"} into their final Dropbox
                folder
                {approvedCount + rejectedCount === 1 ? "" : "s"}.{" "}
                {undecidedCount > 0 ? (
                  <>
                    {undecidedCount} undecided composition
                    {undecidedCount === 1 ? "" : "s"} will stay in source — you
                    can triage {undecidedCount === 1 ? "it" : "them"} in a
                    later round.
                  </>
                ) : (
                  <>Every proposed composition has been triaged.</>
                )}
              </>
            ) : (
              <>This round has no compositions to lock.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-2">
          <CountCell
            icon={CheckCircle2}
            iconClass="text-emerald-600 dark:text-emerald-400"
            count={approvedCount}
            label="Approved"
            verb="Moves to"
            verbIcon={ArrowRight}
            folder={FOLDER_APPROVED}
          />
          <CountCell
            icon={XCircle}
            iconClass="text-red-600 dark:text-red-400"
            count={rejectedCount}
            label="Rejected"
            verb="Moves to"
            verbIcon={ArrowRight}
            folder={FOLDER_REJECTED}
          />
          <CountCell
            icon={HelpCircle}
            iconClass="text-amber-600 dark:text-amber-400"
            count={undecidedCount}
            label="Undecided"
            verb="Stays in"
            verbIcon={Pause}
            folder={FOLDER_SOURCE}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          Round status becomes <strong>locked</strong>. This cannot be undone
          from the app — files can be manually moved back in Dropbox if
          required.
        </p>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isLocking}
          >
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isLocking || approvedCount === 0}
            title={
              approvedCount === 0
                ? "Add at least one composition to Approved before locking"
                : undefined
            }
          >
            {isLocking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Lock &amp; Reorganize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
