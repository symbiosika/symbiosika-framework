import { describe, test, expect, beforeAll } from "bun:test";
import { Hono } from "hono";
import defineWebhookRoutes from "./index";
import { testFetcher } from "../../../../test/fetcher.test";
import {
  initTests,
  TEST_ORGANISATION_1,
  TEST_ORG1_USER_1,
} from "../../../../test/init.test";
import type { FastAppHonoContextVariables } from "../../../../types";
import { createServer } from "http";

let app = new Hono<{ Variables: FastAppHonoContextVariables }>();
let TEST_USER_1_TOKEN: string;
let TEST_USER_2_TOKEN: string;

beforeAll(async () => {
  await initTests();
  defineWebhookRoutes(app, "/api");
  const { user1Token, user2Token } = await initTests();
  TEST_USER_1_TOKEN = user1Token;
  TEST_USER_2_TOKEN = user2Token;
});

describe("Webhook API Endpoints", () => {
  test("CRUD operations", async () => {
    let response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks`,
      TEST_USER_1_TOKEN,
      {
        name: "Test Webhook",
        type: "n8n",
        webhookUrl: "http://example.com",
        event: "chat-output",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        organisationWide: true,
      }
    );
    console.log(response.textResponse);
    expect(response.status).toBe(200);
    let data = response.jsonResponse;
    expect(data.name).toBe("Test Webhook");

    console.log("should get all user webhooks");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);

    console.log("should get all organisation webhooks");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/global`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(Array.isArray(data)).toBe(true);

    console.log("should create a specific webhook");
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks`,
      TEST_USER_1_TOKEN,
      {
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        name: "Specific Webhook",
        type: "n8n",
        webhookUrl: "http://example.com",
        event: "chat-output",
        organisationWide: true,
      }
    );
    let createdWebhook = response.jsonResponse;
    console.log(createdWebhook, response.textResponse);
    expect(response.status).toBe(200);

    console.log("should get a specific webhook");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/${createdWebhook.id}`,
      TEST_USER_1_TOKEN
    );
    console.log(response.textResponse);
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.name).toBe("Specific Webhook");

    console.log("should post a new webhook");
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks`,
      TEST_USER_1_TOKEN,
      {
        name: "Update Webhook",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        type: "n8n",
        webhookUrl: "http://example.com",
        event: "chat-output",
        organisationWide: true,
      }
    );
    createdWebhook = response.jsonResponse;

    console.log("should update a webhook");
    response = await testFetcher.put(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/${createdWebhook.id}`,
      TEST_USER_1_TOKEN,
      {
        name: "Updated Webhook",
        userId: TEST_ORG1_USER_1.id,
        organisationId: TEST_ORGANISATION_1.id,
        type: "n8n",
        webhookUrl: "http://example.com",
        event: "chat-output",
        organisationWide: false,
      }
    );
    expect(response.status).toBe(200);
    data = response.jsonResponse;
    expect(data.name).toBe("Updated Webhook");

    console.log("should delete a webhook");
    response = await testFetcher.delete(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/${createdWebhook.id}`,
      TEST_USER_1_TOKEN
    );
    expect(response.status).toBe(200);

    console.log("should fail to create a webhook with wrong body");
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks`,
      TEST_USER_2_TOKEN,
      {
        name: "Unauthorized Webhook",
        // userId: TEST_ORG2_USER_1.id,
        // organisationId: TEST_ORGANISATION_1.id,
        type: "n8n",
        webhookUrl: "http://example.com",
        event: "chat-output",
        organisationWide: true,
      }
    );
    console.log(response.textResponse);
    expect(response.status).toBe(400);

    console.log("should fail to get a non-existent webhook");
    response = await testFetcher.get(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/00000000-0000-0000-0000-000000000000`,
      TEST_USER_1_TOKEN
    );
    console.log(response.textResponse);
    expect(response.status).toBe(404);
  });

  test("n8n simulation", async () => {
    console.log("starting n8n simulation");
    console.log("starting mikro-server");

    let receivedWebhook = false;

    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/test-webhook") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          console.log("Received webhook payload:", body);
          res.writeHead(200);
          res.end("ok");
          receivedWebhook = true;
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(3000);

    // Register the webhook
    console.log("registering webhook");
    let response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/register/n8n`,
      TEST_USER_1_TOKEN,
      {
        name: "n8n Test Webhook",
        webhookUrl: "http://localhost:3000/test-webhook",
        event: "chatOutput",
        organisationId: TEST_ORGANISATION_1.id,
        organisationWide: true,
      }
    );
    expect(response.status).toBe(200);
    let wh = response.jsonResponse;
    expect(wh.success).toBe(true);

    // Check if the webhook is registered
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/check`,
      TEST_USER_1_TOKEN,
      {
        webhookId: wh.id,
      }
    );
    expect(response.status).toBe(200);
    let check = response.jsonResponse;
    expect(check.exists).toBe(true);

    // Trigger the webhook
    console.log("triggering webhook");
    response = await testFetcher.post(
      app,
      `/api/organisation/${TEST_ORGANISATION_1.id}/webhooks/${wh.id}/trigger`,
      TEST_USER_1_TOKEN,
      {
        test: "payload",
      }
    );
    console.log(response.textResponse);
    expect(response.status).toBe(200);
    expect(receivedWebhook).toBe(true);

    // Close the server
    server.close();
  });
});
