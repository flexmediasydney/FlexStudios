-- 272_drone_custom_pins_created_by_fk.sql
-- QC6 #22: drone_custom_pins.created_by + updated_by were declared as bare
-- uuid columns with no foreign-key constraint to auth.users. When a user
-- account is deleted the column retains a dangling uuid pointing at a
-- non-existent row, which (a) breaks the audit-trail join in the Pin Editor's
-- "Edited by" field (renders blank), and (b) prevents downstream cleanup
-- jobs from confidently marking the pin as orphaned vs deliberately
-- attributed to an inactive account.
--
-- Fix: add ON DELETE SET NULL FK constraints on both columns. Auth.users
-- deletes are rare (and intentional) so SET NULL preserves the pin row +
-- its content; the audit trail just becomes "(deleted user)" client-side
-- which is the right surface for a deleted account.
--
-- We use NOT VALID + VALIDATE so the constraint addition takes a brief
-- ACCESS EXCLUSIVE lock for the catalog write but skips the full table
-- scan up front. drone_custom_pins is small (low thousands of rows even
-- in prod) so VALIDATE is fast.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.drone_custom_pins'::regclass
      AND conname  = 'drone_custom_pins_created_by_fkey'
  ) THEN
    ALTER TABLE public.drone_custom_pins
      ADD CONSTRAINT drone_custom_pins_created_by_fkey
      FOREIGN KEY (created_by)
      REFERENCES auth.users(id)
      ON DELETE SET NULL
      NOT VALID;
    ALTER TABLE public.drone_custom_pins
      VALIDATE CONSTRAINT drone_custom_pins_created_by_fkey;
  END IF;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.drone_custom_pins'::regclass
      AND conname  = 'drone_custom_pins_updated_by_fkey'
  ) THEN
    ALTER TABLE public.drone_custom_pins
      ADD CONSTRAINT drone_custom_pins_updated_by_fkey
      FOREIGN KEY (updated_by)
      REFERENCES auth.users(id)
      ON DELETE SET NULL
      NOT VALID;
    ALTER TABLE public.drone_custom_pins
      VALIDATE CONSTRAINT drone_custom_pins_updated_by_fkey;
  END IF;
END
$$ LANGUAGE plpgsql;
