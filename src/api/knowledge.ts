/**
 * @framework/knowledge — knowledge base similarity search.
 *
 * Embedding-based retrieval over the framework knowledge tables.
 *
 * Part of the curated framework public API. See ./README.md.
 */
export {
  getNearestEmbeddings,
  getFullSourceDocumentsForSimilaritySearch,
} from "../lib/knowledge/similarity-search";
export { createKnowledgeGroup } from "../lib/knowledge/knowledge-groups";
