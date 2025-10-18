# Built-in AI Chat

## Overview

The Fastapp Framework provides a powerful, extensible AI chat endpoint for organizations. This endpoint allows you to chat with AI models using general knowledge, prompt templates, and custom tools. You can also send and receive artifacts (such as files or images) as part of the conversation. All routes are protected by JWT authentication and permission checks.

---

## API Route Prefix

All chat API routes are prefixed with `/api/v1/` by default. For example, chatting is available at `/api/v1/organisation/:organisationId/ai/chat`.

---

## Chat Endpoints

The following endpoints are available for interacting with the AI chat system:

### 1. **POST `/api/v1/organisation/:organisationId/ai/chat`**

Start or continue a chat session with the AI. This endpoint supports plain chat, model selection, templates, tools, and artifacts.

**Params:**
- `organisationId` (string, URL param)

**Body:**
```json
{
  "chatId": "string (optional, for ongoing chat)",
  "input": "string (user message)",
  "enabledTools": ["toolName1", "toolName2"], // optional, see below
  "useTemplate": "category:name" | "templateId", // optional, see below
  "artifacts": [ ... ], // optional, see below
  "options": {
    "model": "provider:model", // e.g. "openai:gpt-4"
    "maxTokens": 1024,
    "temperature": 0.7
  }
}
```

**Response:**
```json
{
  "chatId": "string",
  "message": {
    "role": "assistant",
    "content": "AI response",
    "meta": {
      "model": "openai:gpt-4",
      "sources": [ ... ],
      "artifacts": [ ... ]
    }
  },
  "messages": [ ... ] // full chat history
}
```

#### Features

- **Plain Chat:**  
  Send a message with just the `input` field to chat with general AI knowledge.  
  You can select the model via `options.model` (e.g., `"openai:gpt-4"`).

- **Chat with Template:**  
  Use the `useTemplate` field to start a chat with a specific prompt template.  
  Templates can be referenced by `"category:name"` or by template ID.

- **Artifacts:**  
  Attach files, images, or other artifacts to your message using the `artifacts` field.  
  Artifacts can also be returned by the AI in the response.

- **Tools:**  
  Enable specific tools for the chat by listing their names in `enabledTools`.  
  Tools can perform web research, image generation, and more.

---

### 3. **GET `/api/v1/organisation/:organisationId/ai/chat/history`**

Get the chat history for the current user.

---

### 4. **GET `/api/v1/organisation/:organisationId/ai/chat/history/:id`**

Get the full message history for a specific chat session.

---

### 5. **POST `/api/v1/organisation/:organisationId/ai/chat/ensure-session`**

Create an empty chat session (returns a `chatId`).

---

### 6. **GET `/api/v1/organisation/:organisationId/ai/chat/live/:chatId`**

Get the live status of an ongoing chat generation (for streaming/UX).

---

## Permissions & Scopes

- All chat endpoints require a valid JWT and appropriate permissions.
- Chatting requires the `ai:chat` scope.
- Reading chat history requires `ai:chat-history:read`.
- Deleting chat sessions requires `ai:chat-history:write`.

---

## Configuration

- **Model Selection:**  
  Choose the AI model per request using `options.model` (e.g., `"openai:gpt-4"`).

- **Templates:**  
  Use static or custom templates to guide the AI's behavior.  
  Templates can be referenced by category/name or by ID.

- **Artifacts:**  
  Artifacts (files, images, etc.) can be sent to and received from the AI.  
  Artifacts are attached in the `artifacts` field and returned in the response's `meta.artifacts`.

- **Tools:**  
  Tools extend the AI's capabilities (e.g., web search, image generation).  
  Enable tools per chat by listing their names in `enabledTools`.

---

## Example Usage

### Plain Chat

```http
POST /api/v1/organisation/0000-000-0000/ai/chat

{
  "input": "What is the capital of France?",
  "options": {
    "model": "openai:gpt-4"
  }
}
```

### Chat with Template

```http
POST /api/v1/organisation/0000-000-0000/ai/chat

{
  "useTemplate": "system:task_redefine",
  "input": "Rewrite this task for clarity.",
  "options": {
    "model": "openai:gpt-4"
  }
}
```

### Chat with Artifacts

```http
POST /api/v1/organisation/0000-000-0000/ai/chat

{
  "input": "Analyze this document.",
  "artifacts": [
    {
      "type": "file",
      "fileId": "abc123"
    }
  ]
}
```

### Chat with Tools

```http
POST /api/v1/organisation/0000-000-0000/ai/chat

{
  "input": "Find the latest news about AI.",
  "enabledTools": ["web-research"]
}
```

---

## Extending the Chat Endpoint

### Adding Static Templates

As an app builder, you can add static templates to your app by providing them in the `staticTemplates` array when calling `defineServer`:

```typescript
const server = defineServer({
  // ...other config...
  staticTemplates: [
    {
      name: "task_redefine",
      label: "Task Redefine",
      description: "Redefine a task",
      category: "system",
      systemPrompt: "You are a helpful assistant.",
      userPrompt: null,
      langCode: "en",
      hidden: true,
      needsInitialCall: false,
      placeholders: [
        {
          name: "user_input",
          label: "Task Description",
          description: "The tasks description",
          requiredByUser: true,
        },
      ],
      llmOptions: null,
      enabledTools: ["web-research"],
    },
  ],
});
```

---

### Adding Tools to Your App

You can register custom tools to extend the AI's capabilities using `addBaseTool`.  
Each tool is defined as a factory function that receives a context and returns a tool object.

**Example: Registering a Custom Tool with Input Parameters**

```typescript
import { addBaseTool } from "./fastapp-framework/src/lib/ai/interaction/tools";

// Define your tool factory
function getMyCustomTool(context) {
  return {
    name: "my-custom-tool",
    tool: {
      description: "Returns the current server time, optionally in a given locale.",
      parameters: {
        type: "object",
        properties: {
          locale: {
            type: "string",
            description: "Optional locale for formatting the time (e.g. 'de-DE', 'en-US')"
          }
        },
        required: []
      },
      async execute({ input }) {
        // input.locale may be provided by the user
        const locale = input?.locale || "en-US";
        const now = new Date();
        return {
          result: `Current time: ${now.toLocaleString(locale)}`
        };
      }
    }
  };
}

// Register the tool
addBaseTool(
  "my-custom-tool",
  "My Custom Tool",
  "Returns the current server time, optionally in a given locale.",
  getMyCustomTool
);
```

- The tool factory receives a context object (`{ chatId, userId, organisationId }`).
- The returned object must have a `name` and a `tool` with an `execute` method.
- You can define a `parameters` schema (JSON Schema) to describe expected input fields for the tool.

**Usage in Chat:**

Enable your tool in a chat and provide parameters:

```json
{
  "input": "What time is it in German format?",
  "enabledTools": ["my-custom-tool"],
  "toolInputs": {
    "my-custom-tool": { "locale": "de-DE" }
  }
}
```

---

## Artifacts: Sending and Receiving

- **Sending Artifacts:**  
  Attach artifacts (files, images, etc.) in the `artifacts` field of your chat request.

- **Receiving Artifacts:**  
  The AI can return artifacts in the response's `meta.artifacts` field.

---