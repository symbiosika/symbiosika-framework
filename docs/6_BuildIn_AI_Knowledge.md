# Built-in AI Knowledge Base

## Overview

The Fastapp Framework provides a built-in, organization-wide knowledge base that is tightly integrated with the AI chat functionality. Knowledge can be added as text, from documents, or from URLs, and is organized into **groups** and further refined with **filters**. This knowledge can then be leveraged in the AI chat endpoints, either directly or via prompt templates.

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
  `POST /api/v1/organisation/:organisationId/knowledge/groups`
  ```json
  {
    "organisationId": "string",
    "name": "string",
    "description": "string (optional)",
    "organisationWideAccess": true
  }
  ```
- **List all groups:**  
  `GET /api/v1/organisation/:organisationId/knowledge/groups`

- **Update/Delete a group:**  
  `PUT`/`DELETE /api/v1/organisation/:organisationId/knowledge/groups/:id`

### Add Knowledge

- **Add knowledge from text:**  
  `POST /api/v1/organisation/:organisationId/knowledge/from-text`
  ```json
  {
    "organisationId": "string",
    "title": "string",
    "text": "string",
    "filters": { "category": "Handbook" },
    "knowledgeGroupId": "string (optional)"
  }
  ```
- **Add knowledge from a file/document:**  
  `POST /api/v1/organisation/:organisationId/knowledge/upload-and-extract`  
  (multipart/form-data, file upload + optional metadata like group, filters, etc.)

- **Add knowledge from a URL:**  
  `POST /api/v1/organisation/:organisationId/knowledge/from-url`
  ```json
  {
    "organisationId": "string",
    "url": "https://example.com/handbook.pdf",
    "filters": { "category": "Handbook" },
    "knowledgeGroupId": "string (optional)"
  }
  ```

- **You can assign or update groups and filters for knowledge entries at any time.**

---

## Using Knowledge in Chat

Knowledge stored in the system can be leveraged in the AI chat endpoint in two main ways:

### 1. Directly Selecting Knowledge

When calling the chat endpoint (`/api/v1/organisation/:organisationId/ai/chat`), you can specify which knowledge to use by passing group IDs, entry IDs, or filters.

**Example:**
```http
POST /api/v1/organisation/0000-000-0000/ai/chat
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
   POST /api/v1/organisation/0000-000-0000/knowledge/groups
   Content-Type: application/json
   {
     "organisationId": "0000-000-0000",
     "name": "Onboarding",
     "description": "All onboarding related documents"
   }
   ```

2. **Add a knowledge entry to the group:**
   ```http
   POST /api/v1/organisation/0000-000-0000/knowledge/from-text
   Content-Type: application/json
   {
     "organisationId": "0000-000-0000",
     "title": "Onboarding Steps",
     "text": "Step 1: ... Step 2: ...",
     "filters": { "category": "Onboarding" },
     "knowledgeGroupId": "<ID from previous step>"
   }
   ```

3. **Use the knowledge in chat:**
   ```http
   POST /api/v1/organisation/0000-000-0000/ai/chat
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
