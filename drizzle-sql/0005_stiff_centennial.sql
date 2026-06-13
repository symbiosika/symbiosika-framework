ALTER TABLE "base_knowledge_text" DROP CONSTRAINT "base_knowledge_text_parent_id_base_knowledge_text_id_fk";
--> statement-breakpoint
-- Migrate existing parentId values from id to documentId
UPDATE "base_knowledge_text" AS child
SET "parent_id" = parent."document_id"
FROM "base_knowledge_text" AS parent
WHERE child."parent_id" = parent."id"
  AND child."parent_id" IS NOT NULL;
