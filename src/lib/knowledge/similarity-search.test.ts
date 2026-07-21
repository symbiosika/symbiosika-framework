import { describe, it, expect, beforeAll } from "bun:test";
import { getNearestEmbeddings } from "./similarity-search";
import { extractKnowledgeFromExistingDbEntry } from "./add-knowledge";
import { createKnowledgeText } from "./knowledge-texts";
import { initTests, TEST_ORGANISATION_1 } from "../../test/init.test";
import { getDb } from "../db/db-connection";
import { knowledgeEntry, knowledgeChunks } from "../db/db-schema";

describe("Hybrid chunk search (fulltext leg, no embedding provider)", () => {
  beforeAll(async () => {
    await initTests();
  });

  it("degrades gracefully to fulltext when the embedding provider is unavailable", async () => {
    const previousProvider = process.env.EMBEDDING_PROVIDER;
    // an unknown provider makes generateEmbedding fail immediately, so the
    // semantic leg is unavailable and only the fulltext leg can match
    process.env.EMBEDDING_PROVIDER = "__not-configured__";
    try {
      const db = getDb();
      const [entry] = await db
        .insert(knowledgeEntry)
        .values({
          tenantId: TEST_ORGANISATION_1.id,
          name: `Hybrid FTS Test Entry ${crypto.randomUUID()}`,
        })
        .returning();
      await db.insert(knowledgeChunks).values({
        knowledgeEntryId: entry!.id,
        text: "Worker bees must visit over two million flowers to produce one pound of honey.",
        order: 0,
        embeddingModel: "test",
        dimensions: 1024,
        textEmbedding1024: new Array(1024).fill(0),
      });

      const results = await getNearestEmbeddings({
        tenantId: TEST_ORGANISATION_1.id,
        searchText: "honey flowers bees",
        n: 3,
        filterKnowledgeEntryIds: [entry!.id],
      });

      expect(results.length).toBe(1);
      expect(results[0]!.text).toContain("Worker bees");
    } finally {
      if (previousProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
      else process.env.EMBEDDING_PROVIDER = previousProvider;
    }
  });
});

const testTexts = [
  {
    title: "Space Exploration",
    text: "The Mars rover discovered ancient river beds on the red planet. Scientists believe this indicates the possibility of past life on Mars.",
  },
  {
    title: "Cooking",
    text: "Traditional Italian pasta is made with just flour and eggs. The secret to perfect carbonara lies in using high-quality guanciale and pecorino cheese.",
  },
  {
    title: "Marine Biology",
    text: "Octopuses have three hearts and blue blood. They are considered among the most intelligent invertebrates in the ocean.",
  },
  {
    title: "Classical Music",
    text: "Mozart wrote his first symphony at the age of eight. His final composition was the unfinished Requiem Mass in D minor.",
  },
  {
    title: "Ancient Egypt",
    text: "The Great Pyramid of Giza took 20 years to build using 2.3 million stone blocks. Hieroglyphics remained undeciphered until the discovery of the Rosetta Stone.",
  },
  {
    title: "Quantum Physics",
    text: "Quantum entanglement allows particles to instantly affect each other regardless of distance. Schrödinger's famous thought experiment illustrates the paradoxical nature of quantum superposition.",
  },
  {
    title: "Football History",
    text: "The first World Cup was held in Uruguay in 1930 with only 13 teams participating. The tournament has since grown to become the most-watched sporting event globally.",
  },
  {
    title: "Beekeeping",
    text: "A single bee colony can contain up to 60,000 bees during peak season. Worker bees must visit over two million flowers to produce one pound of honey.",
  },
  {
    title: "Volcanic Activity",
    text: "The largest volcanic eruption in recorded history was Mount Tambora in 1815. The explosion was so powerful it caused a global temperature drop and led to the 'Year Without Summer'.",
  },
  {
    title: "Medieval Architecture",
    text: "Gothic cathedrals used flying buttresses to support their massive stone walls. The construction of Notre-Dame de Paris took nearly 200 years to complete.",
  },
];

// describe("Similarity Search Test", () => {
//   beforeAll(async () => {
//     await initTests();
//   });

//   it("should find the most similar text through similarity search", async () => {
//     // 1. Add all test texts to the database and extract knowledge
//     const addedTexts = await Promise.all(
//       testTexts.map((text) =>
//         createKnowledgeText({
//           text: text.text,
//           title: text.title,
//           tenantId: TEST_ORGANISATION_1.id,
//         })
//       )
//     );

//     // 2. Extract knowledge for all texts
//     await Promise.all(
//       addedTexts.map((text) =>
//         extractKnowledgeFromExistingDbEntry({
//           tenantId: TEST_ORGANISATION_1.id,
//           sourceType: "text",
//           sourceId: text.id,
//         })
//       )
//     );

//     // 3. Perform similarity search with a query related to bees
//     const searchQuery =
//       "How do bees make honey and how many flowers do they need to visit?";

//     const results = await getNearestEmbeddings({
//       tenantId: TEST_ORGANISATION_1.id,
//       searchText: searchQuery,
//       n: 1,
//     });

//     // 4. Verify results
//     expect(results.length).toBe(1);
//     expect(results[0].text).toContain("Worker bees must visit");
//   }, 15000);
// });
