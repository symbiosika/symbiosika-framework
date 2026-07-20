-- Robust full-text indexing for base_knowledge_text.
--
-- Problem: the previous expression index ran the raw title + text through
-- to_tsvector. Postgres caps a single tsvector at 1048575 bytes, so inserting
-- a large, token-diverse document (e.g. an OCR'd product catalog) failed with
-- "string is too long for tsvector" — aborting the whole row write for every
-- ingestion path (file upload, URL import, API, sync jobs).
--
-- Fix: wrap to_tsvector in a function that bounds the indexed input and
-- degrades gracefully instead of erroring. The full text always stays in the
-- "text" column; only the *search index* sees a bounded input.
--   1. index the first 500k characters (comfortably under the 1MB tsvector
--      ceiling for realistic content),
--   2. if the resulting vector is still too large (extremely token-dense
--      content), retry with the first 100k characters,
--   3. as a last resort store an empty tsvector — the row is then not
--      FTS-indexed, but the write NEVER fails (the ILIKE fallback in
--      knowledge-text-search.ts still finds it).
--
-- Marked IMMUTABLE (required for use in an index expression): the two-arg
-- to_tsvector(regconfig, text) form is immutable, left() is immutable, and
-- the exception handling does not change that.
CREATE FUNCTION base_safe_tsvector(config regconfig, doc text)
RETURNS tsvector
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $fn$
BEGIN
  RETURN to_tsvector(config, left(doc, 500000));
EXCEPTION WHEN program_limit_exceeded THEN
  BEGIN
    RETURN to_tsvector(config, left(doc, 100000));
  EXCEPTION WHEN program_limit_exceeded THEN
    RETURN ''::tsvector;
  END;
END;
$fn$;--> statement-breakpoint
DROP INDEX "knowledge_text_fts_idx";--> statement-breakpoint
CREATE INDEX "knowledge_text_fts_idx" ON "base_knowledge_text" USING gin (base_safe_tsvector('simple', coalesce("title", '') || ' ' || coalesce("text", '')));
