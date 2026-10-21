-- One reaction per person per message: the old table allowed a row per emoji,
-- so a person could react several times to the same message.
--
-- This runs before `prisma db push`, and it exists because Prisma refuses to add
-- a unique constraint that could match existing duplicates even after they are
-- gone — without this script the API container would warn, refuse, and never
-- boot. So the script collapses the old rows and creates the index Prisma
-- expects (`reactions_userId_messageId_key`), which leaves the push to do only
-- additive work.
--
-- Idempotent, and safe on a database where the table does not exist yet (a fresh
-- install gets the schema from `db push` directly). Which old row survives is
-- arbitrary but stable: it is the one that person's next tap replaces or removes
-- anyway.
DO $$
BEGIN
  IF to_regclass('public.reactions') IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM reactions r
  USING reactions kept
  WHERE kept."userId"    = r."userId"
    AND kept."messageId" = r."messageId"
    AND kept.id > r.id;

  DROP INDEX IF EXISTS "reactions_userId_messageId_emoji_key";

  CREATE UNIQUE INDEX IF NOT EXISTS "reactions_userId_messageId_key"
    ON reactions ("userId", "messageId");
END $$;
