# Built-in AI Knowledge Base

## Overview

The symbiosika-framework provides a built-in, organization-wide knowledge base that is tightly integrated with the AI chat functionality. Knowledge can be added as text, from documents, or from URLs, and is organized into **groups** and further refined with **filters**. This knowledge can then be leveraged in the AI chat endpoints, either directly or via prompt templates.

---

## Knowledge Groups & Filters

- **Knowledge Groups:**  
  Organize knowledge entries into groups (e.g., by team, project, or topic). Groups help you structure and control access to knowledge.
- **Filters:**  
  Add key-value filters (e.g., category, tag, team, workspace) to knowledge entries for even more granular selection and retrieval.

---

## Key Endpoints

### Manage Knowledge Groups

- **Create a group:**  
  `POST /api/v1/tenant/:tenantId/knowledge/groups`
  ```json
  {
    "tenantId": "string",
    "name": "string",
    "description": "string (optional)",
    "tenantWideAccess": true
  }
  ```
- **List all groups:**  
  `GET /api/v1/tenant/:tenantId/knowledge/groups`

- **Update/Delete a group:**  
  `PUT`/`DELETE /api/v1/tenant/:tenantId/knowledge/groups/:id`

### Add Knowledge (asynchronous — returns a Job)

> **Breaking change:** Reading/ingesting documents (PDF and others) now runs
> on the [background job system](./10_Using_Long_Running_Jobs.md) instead of
> blocking the request. Every ingestion endpoint below **returns the created
> Job immediately** — not the finished knowledge entry. Parsing a large PDF
> plus embedding every chunk can take minutes, so the request no longer waits.
>
> A UI polls the job and decides what to do with the result:
>
> - `GET /api/v1/tenant/:tenantId/jobs/:jobId` → full job incl. `result`
> - `GET /api/v1/tenant/:tenantId/jobs/:jobId/status` → `{ status, progress }`
>
> Statuses are `pending` → `running` → `completed` | `failed`. When
> `completed`, the handler's output is on `job.result`:
> `{ id, ok }` for RAG knowledge entries, `{ knowledgeText, blocks }` for
> imported wiki pages. On `failed`, `job.error.message` explains why (e.g. a
> missing source or an unreadable file). All jobs use the type
> `knowledge:ingest`.
>
> Uploaded files are stashed in DB storage, processed by the job, and the
> temporary file is deleted once the job has run.
>
> The framework registers the built-in ingestion handler and starts the job
> queue automatically. If a separate worker process drains the queue, set
> `disableJobQueue: true` in the server config on the web instance.
>
> **Push instead of poll (opt-in):** add `"notifyOnCompletion": true` to any of
> the ingestion requests below (a form field for the multipart uploads). When
> the job finishes, a `success`/`error` message is pushed into the user's
> notification queue (`GET /user/notifications`) carrying
> `meta: { jobId, jobType, status }`, so the UI can react without polling. See
> [Long Running Jobs](./10_Using_Long_Running_Jobs.md#notify-the-user-on-completion-opt-in).

The following endpoints all respond with a Job (`202`-style semantics, HTTP
`200` + the job body):

- **Add knowledge from text:**  
  `POST /api/v1/tenant/:tenantId/knowledge/from-text`
  ```json
  {
    "tenantId": "string",
    "title": "string",
    "text": "string",
    "filters": { "category": "Handbook" },
    "knowledgeGroupId": "string (optional)"
  }
  ```
- **Add knowledge from a file/document (PDF, txt, …):**  
  `POST /api/v1/tenant/:tenantId/knowledge/upload-and-extract`  
  (multipart/form-data, file upload + optional metadata like group, filters, etc.)

- **Extract knowledge from an existing stored source (db/local/url/text):**  
  `POST /api/v1/tenant/:tenantId/knowledge/extract-knowledge`

- **Add knowledge from a URL:**  
  `POST /api/v1/tenant/:tenantId/knowledge/from-url`
  ```json
  {
    "tenantId": "string",
    "url": "https://example.com/handbook.pdf",
    "filters": { "category": "Handbook" },
    "knowledgeGroupId": "string (optional)"
  }
  ```

- **Import a file / URL as an editable wiki page:**  
  `POST /api/v1/tenant/:tenantId/knowledge/texts/import` (multipart file) and  
  `POST /api/v1/tenant/:tenantId/knowledge/texts/import-url` also return a Job.

Typical client flow:

```text
POST .../knowledge/upload-and-extract        → { id: "<jobId>", type: "knowledge:ingest", status: "pending", ... }
GET  .../jobs/<jobId>/status  (poll)          → { status: "running" }
GET  .../jobs/<jobId>/status  (poll)          → { status: "completed" }
GET  .../jobs/<jobId>                         → { ..., result: { id: "<knowledgeEntryId>", ok: true } }
```

- **You can assign or update groups and filters for knowledge entries at any time.**

---

## Using Knowledge in Chat

Knowledge stored in the system can be leveraged in the AI chat endpoint in two main ways:

### 1. Directly Selecting Knowledge

When calling the chat endpoint (`/api/v1/tenant/:tenantId/ai/chat`), you can specify which knowledge to use by passing group IDs, entry IDs, or filters.

**Example:**
```http
POST /api/v1/tenant/0000-000-0000/ai/chat
Content-Type: application/json

{
  "input": "How does our onboarding process work?",
  "options": {
    "model": "openai:gpt-4"
  },
  "filterKnowledgeGroupIds": ["0000-000-0000"],
  "filterKnowledgeEntryIds": ["0000-000-0000"],
  "filter": { "category": ["Onboarding"] }
}
```
- `filterKnowledgeGroupIds`: Only use knowledge from these groups.
- `filterKnowledgeEntryIds`: Only use these specific knowledge entries.
- `filter`: Only use knowledge entries matching these key-value filters.

**Response Example:**
```json
{
  "chatId": "chat-xyz",
  "message": {
    "role": "assistant",
    "content": "Our onboarding process consists of the following steps: ..."
  },
  "messages": [
    // full chat history
  ],
  "meta": {
    "sources": [
      {
        "knowledgeEntryId": "0000-000-0000",
        "title": "Onboarding Handbook",
        "matchedText": "..."
      }
    ]
  }
}
```

### Source path (wiki breadcrumb) in retrieval results

For knowledge that originates from **wiki pages** (`knowledgeText`, organized in
a tree via `parentId`), retrieval responses include the page's **path** — the
slash-separated breadcrumb of ancestor titles, e.g.
`"Handbook/HR/Vacation Policy"`. This tells an AI agent *where* a chunk
lives, not just its bare title, which is valuable context for reasoning and
citation.

The path is present on:

- **Wiki page search** (`GET .../knowledge/texts/search`): each hit carries
  `path` (string) and `pathIds` (segment ids, root first).
- **Chunk context** (`GET .../knowledge/texts/:id/chunk-context`): the response
  carries the page's `path` / `pathIds`.
- **RAG similarity search** (`POST .../knowledge/similarity-search`): each chunk
  carries `knowledgeTextId`, `path` and `pathIds` when the underlying entry was
  mirrored from a wiki page; these are `null` / `[]` for plain (non-wiki) RAG
  documents.

The path is derived on the fly from the page's `parentId` chain — there is no
stored path column, so moving a page in the tree updates its path automatically.

### 2. Using Prompt Templates

Prompt templates can be configured to always include knowledge from specific groups or with certain filters. This allows you to create specialized chat behaviors (e.g., always answer with knowledge from the "Support FAQ" group).

**Example Template Configuration:**
```typescript
{
  name: "faq_support",
  label: "Support FAQ",
  category: "support",
  systemPrompt: "Use the knowledge from the 'Support-FAQ' group to answer user questions.",
  knowledgeGroupId: "group-support-faq"
}
```
When you use this template in a chat request:
```json
{
  "useTemplate": "support:faq_support",
  "input": "How do I reset my password?",
  "options": {
    "model": "openai:gpt-4"
  }
}
```
The system will automatically include the relevant knowledge for the assistant.

---

## Full Example: Adding and Using Knowledge

1. **Create a knowledge group:**
   ```http
   POST /api/v1/tenant/0000-000-0000/knowledge/groups
   Content-Type: application/json
   {
     "tenantId": "0000-000-0000",
     "name": "Onboarding",
     "description": "All onboarding related documents"
   }
   ```

2. **Add a knowledge entry to the group (returns a Job):**
   ```http
   POST /api/v1/tenant/0000-000-0000/knowledge/from-text
   Content-Type: application/json
   {
     "tenantId": "0000-000-0000",
     "title": "Onboarding Steps",
     "text": "Step 1: ... Step 2: ...",
     "filters": { "category": "Onboarding" },
     "knowledgeGroupId": "<ID from previous step>"
   }
   ```
   The response is a `knowledge:ingest` Job. Poll
   `GET /api/v1/tenant/0000-000-0000/jobs/<jobId>` until `status` is
   `completed`; the created entry id is on `job.result.id`.

3. **Use the knowledge in chat:**
   ```http
   POST /api/v1/tenant/0000-000-0000/ai/chat
   Content-Type: application/json
   {
     "input": "What are the onboarding steps?",
     "filterKnowledgeGroupIds": ["<ID from previous step>"]
   }
   ```

   The assistant will answer using the onboarding knowledge you provided.

---

## Summary

- The framework provides a built-in, structured knowledge base.
- Knowledge can be organized into groups and refined with filters.
- There are dedicated endpoints for adding, managing, and using knowledge (text, document, URL).
- In chat, you can target knowledge by group, filter, or template for precise, context-aware answers.

---

**Tip:**  
Combining groups, filters, and templates allows you to focus AI answers on exactly the knowledge you want.
