-- Till-created customers, and claiming them on signup (roadmap Step 4).
--
-- Run as `postgres`. Idempotent: safe to re-run.
--
-- ── The problem ────────────────────────────────────────────────────────────
-- `users.id` IS the Firebase uid, and uniqueness is scoped
-- `UNIQUE (store_id, phone)` / `UNIQUE (store_id, email)`. So a row the till
-- invents for a walk-in has no natural primary key — and when that same person
-- later signs up online with the same phone, their signup COLLIDES with the row
-- we invented for them.
--
-- ── The shape ──────────────────────────────────────────────────────────────
-- A till-created row gets an id of `pos_<uuid>` (the text PK already permits
-- it) and `claimed_at IS NULL`. On signup with a matching phone, that row is
-- ADOPTED: its id becomes the Firebase uid and `claimed_at` is stamped. Their
-- in-store purchase history is theirs the moment they create an account, which
-- is the actual point of the feature rather than a side effect.
--
-- ★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND THAT IS AUTOMATIC. Customer RLS is
-- `auth.uid() = users.id`; a `pos_…` id matches no Firebase uid, so these rows
-- are invisible to every session without a single new policy. Do not add one.
--
-- ── ★★ WHY THIS MIGRATION EXISTS AT ALL: SIX FOREIGN KEYS ──────────────────
-- The design note said "rewrite the id, or update both tables in the same
-- transaction". Neither works against the live schema, and the reason is worth
-- writing down because it is invisible until you try it.
--
-- SIX tables reference users.id — orders, customer_addresses, product_reviews,
-- blog_comments, blogs.submitted_by, user_group_members — and every one is
-- NOT DEFERRABLE with ON UPDATE NO ACTION. So the FK is checked at the end of
-- each STATEMENT, and both orderings fail:
--
--   update users first    → children now reference an id that is gone
--   update children first → they reference an id that does not exist yet
--
-- ★ AND THE ALTERNATIVE IS WORSE. "Insert the new row, repoint the children,
-- delete the pos_ row" avoids a schema change — but five of those six FKs are
-- ON DELETE CASCADE. Miss one table in the repoint and the DELETE does not
-- fail: it silently CASCADE-DELETES that customer's ORDERS. A seventh FK added
-- next year would reintroduce that silently, because nothing would tell the
-- person adding it that a hand-written list exists.
--
-- So the database keeps the list instead. With ON UPDATE CASCADE, adopting a
-- row is ONE statement and a future FK either cascades correctly or fails
-- LOUDLY with a constraint violation. Loud beats silent when the silent version
-- deletes orders.

BEGIN;

-- NULL = this row has never had an account behind it.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

COMMENT ON COLUMN public.users.claimed_at IS
  'When a till-created (pos_*) row was adopted by a real signup. NULL = never had an account: such a row cannot log in, because customer RLS matches auth.uid() against users.id and a pos_ id matches no Firebase uid.';

-- Adoption changes a primary key, so every reference has to follow it.
-- ON UPDATE CASCADE only — ON DELETE is deliberately left exactly as it was,
-- because that is a different question and this migration has no business
-- answering it.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_customer_id_fkey,
  ADD CONSTRAINT orders_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.customer_addresses
  DROP CONSTRAINT IF EXISTS customer_addresses_user_id_fkey,
  ADD CONSTRAINT customer_addresses_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.product_reviews
  DROP CONSTRAINT IF EXISTS product_reviews_customer_id_fkey,
  ADD CONSTRAINT product_reviews_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.blog_comments
  DROP CONSTRAINT IF EXISTS blog_comments_customer_id_fkey,
  ADD CONSTRAINT blog_comments_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE public.user_group_members
  DROP CONSTRAINT IF EXISTS user_group_members_customer_id_fkey,
  ADD CONSTRAINT user_group_members_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE CASCADE;

-- ⚠ SET NULL, not CASCADE, on delete — a blog outlives its author here. Kept.
ALTER TABLE public.blogs
  DROP CONSTRAINT IF EXISTS blogs_submitted_by_fkey,
  ADD CONSTRAINT blogs_submitted_by_fkey
    FOREIGN KEY (submitted_by) REFERENCES public.users(id)
    ON UPDATE CASCADE ON DELETE SET NULL;

-- The claim looks a row up by (store_id, phone) among UNCLAIMED rows only.
-- Partial, because claimed rows are the overwhelming majority and indexing
-- them would be paying for nothing.
CREATE INDEX IF NOT EXISTS users_unclaimed_phone_idx
  ON public.users (store_id, phone)
  WHERE claimed_at IS NULL;

-- ── Guard ──────────────────────────────────────────────────────────────────
-- FAIL the migration if any FK to users.id still lacks ON UPDATE CASCADE. The
-- whole design rests on the database maintaining that list, so a table missed
-- here — or added later without it — must stop this rather than surface as a
-- claim that half-works.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO missing
    FROM pg_constraint
   WHERE confrelid = 'public.users'::regclass
     AND contype = 'f'
     AND confupdtype <> 'c';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'FK(s) to users.id without ON UPDATE CASCADE: %. Customer claim would orphan or silently cascade-delete these.',
      missing;
  END IF;
END $$;

COMMIT;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- None. Every existing row came from a real signup and is therefore claimed by
-- definition — but `claimed_at` stays NULL for them rather than being invented,
-- because a made-up timestamp is worse than an absent one. Nothing reads
-- `claimed_at` to decide whether someone may log in; the id shape does that.
-- The claim only ever looks at rows whose id starts with `pos_`.

-- ── Rollback ────────────────────────────────────────────────────────────────
-- Restores ON UPDATE NO ACTION. Do NOT run while any pos_* row exists — it
-- would leave them unclaimable.
--
-- BEGIN;
-- DROP INDEX IF EXISTS public.users_unclaimed_phone_idx;
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_customer_id_fkey,
--   ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id)
--   REFERENCES public.users(id) ON DELETE CASCADE;
-- -- …and the same for customer_addresses, product_reviews, blog_comments,
-- -- user_group_members (ON DELETE CASCADE) and blogs (ON DELETE SET NULL).
-- ALTER TABLE public.users DROP COLUMN IF EXISTS claimed_at;
-- COMMIT;
