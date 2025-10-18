import type { FastAppHono } from "../types";

export const testFetcher = {
  get: async (
    app: FastAppHono,
    path: string,
    token: string | undefined
  ): Promise<{
    status: number;
    jsonResponse: any | undefined;
    textResponse: string;
    headers: Headers;
  }> => {
    const headers: HeadersInit = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "GET",
      headers,
    });

    const textResponse = await response.text();
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch (error) {
      // jsonResponse remains undefined if parsing fails
    }
    return {
      status: response.status,
      jsonResponse,
      textResponse,
      headers: response.headers,
    };
  },

  post: async (
    app: FastAppHono,
    path: string,
    token: string | undefined,
    body: any
  ): Promise<{
    status: number;
    jsonResponse: any | undefined;
    textResponse: string;
    headers: Headers;
  }> => {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const textResponse = await response.text();
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch (error) {
      // jsonResponse remains undefined if parsing fails
    }
    return {
      status: response.status,
      jsonResponse,
      textResponse,
      headers: response.headers,
    };
  },

  postFormData: async (
    app: FastAppHono,
    path: string,
    token: string | undefined,
    body: FormData
  ): Promise<{
    status: number;
    jsonResponse: any | undefined;
    textResponse: string;
    headers: Headers;
  }> => {
    const headers: HeadersInit = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "POST",
      headers,
      body,
    });
    const textResponse = await response.text();
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch (error) {
      // jsonResponse remains undefined if parsing fails
    }

    return {
      status: response.status,
      jsonResponse,
      textResponse,
      headers: response.headers,
    };
  },

  postWithPlainResponse: async (
    app: FastAppHono,
    path: string,
    token: string | undefined,
    body: any
  ): Promise<Response> => {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return response;
  },

  put: async (
    app: FastAppHono,
    path: string,
    token: string | undefined,
    body: any
  ): Promise<{
    status: number;
    jsonResponse: any | undefined;
    textResponse: string;
    headers: Headers;
  }> => {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    const textResponse = await response.text();
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch (error) {
      // jsonResponse remains undefined if parsing fails
    }
    return {
      status: response.status,
      jsonResponse,
      textResponse,
      headers: response.headers,
    };
  },

  delete: async (
    app: FastAppHono,
    path: string,
    token: string | undefined
  ): Promise<{
    status: number;
    jsonResponse: any | undefined;
    textResponse: string;
    headers: Headers;
  }> => {
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await app.request(path, {
      method: "DELETE",
      headers,
    });
    const textResponse = await response.text();
    let jsonResponse;
    try {
      jsonResponse = JSON.parse(textResponse);
    } catch (error) {
      // jsonResponse remains undefined if parsing fails
    }
    return {
      status: response.status,
      jsonResponse,
      textResponse,
      headers: response.headers,
    };
  },
};
