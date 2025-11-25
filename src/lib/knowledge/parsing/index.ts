import type { FileSourceType } from "../../../lib/storage";
import log from "../../../lib/log";
import { getFileFromDb } from "../../../lib/storage/db";
import { getFileFromLocalDisc } from "../../../lib/storage/local";
import { parsePdfFileAsMardown } from "./pdf";
import { knowledgeText } from "../../../lib/db/db-schema";
import { getDb } from "../../../lib/db/db-connection";
import { eq } from "drizzle-orm";
import type { PageContent } from "./pdf/types";
import { applyPostProcessors } from "./pre-processors";

/**
 * Helper function to parse a file and return the text content and pages if available
 */
export const parseFile = async (
  file: File,
  context: {
    tenantId: string;
    userId?: string;
    teamId?: string;
    workspaceId?: string;
  },
  options?: {
    model?: string;
    extractImages?: boolean;
  }
): Promise<{
  text: string;
  pages?: PageContent[];
  includesImages: boolean;
}> => {
  log.debug(`Parse file: ${file.name} from type ${file.type}`);

  // PDF
  if (file.type === "application/pdf") {
    // try to parse the content
    const result = await parsePdfFileAsMardown(file, context, options);

    // Create a combined text from all pages if available
    let fullText = "";
    if (result.pages && result.pages.length > 0) {
      fullText = result.pages.map((page) => page.text).join("\n\n");
    }

    return {
      text: fullText,
      pages: result.pages,
      includesImages: result.includesImages,
    };
  }

  // TXT file
  if (file.type.startsWith("text/plain")) {
    return { text: await file.text(), includesImages: false };
  }

  // Image
  else if (file.type.startsWith("image")) {
    // the the image describe by ai

    // TO DE IMPLEMENTED!

    return { text: "NOT IMPLEMENTED!", includesImages: false };
  } else {
    throw new Error(`Unsupported file type for parsing: ${file.type}`);
  }
};

/**
 * Parse a variety of file types
 */
export const parseDocument = async (data: {
  sourceType: FileSourceType;
  tenantId: string;
  sourceId?: string;
  sourceFileBucket?: string;
  sourceUrl?: string;
  knowledgeGroupId?: string;
  userOwned?: boolean;
  teamId?: string;
  workspaceId?: string;
  model?: string;
  extractImages?: boolean;
  usePostProcessors?: string[];
}) => {
  // Get the file (from DB or local disc) or content from URL
  let content: string = "";
  let pages: PageContent[] | undefined;
  let title: string;
  let docIncludesImages = false;

  if (data.sourceType === "db" && data.sourceId && data.sourceFileBucket) {
    log.debug(
      `Get file from DB: ${data.sourceId} ${data.sourceFileBucket} for tenant ${data.tenantId}`
    );
    const file = await getFileFromDb(
      data.sourceId,
      data.sourceFileBucket,
      data.tenantId
    );
    const {
      text,
      pages: filePages,
      includesImages,
    } = await parseFile(
      file,
      {
        tenantId: data.tenantId,
        teamId: data.teamId,
        workspaceId: data.workspaceId,
      },
      {
        model: data.model,
        extractImages: data.extractImages,
      }
    );
    content = text;
    pages = filePages;
    title = file.name;
    docIncludesImages = includesImages;
  } else if (
    data.sourceType === "local" &&
    data.sourceId &&
    data.sourceFileBucket
  ) {
    log.debug(
      `Get file from local disc: ${data.sourceId} ${data.sourceFileBucket} for tenant ${data.tenantId}`
    );
    const file = await getFileFromLocalDisc(
      data.sourceId,
      data.sourceFileBucket,
      data.tenantId
    );
    const {
      text,
      pages: filePages,
      includesImages,
    } = await parseFile(
      file,
      {
        tenantId: data.tenantId,
        teamId: data.teamId,
        workspaceId: data.workspaceId,
      },
      {
        model: data.model,
        extractImages: data.extractImages,
      }
    );
    content = text;
    pages = filePages;
    title = file.name;
    docIncludesImages = includesImages;
  } else if (data.sourceType === "url" && data.sourceUrl) {
    log.debug(`Get file from URL: ${data.sourceUrl}`);
    content = "";
    title = "";
  } else if (data.sourceType === "text") {
    log.debug(`Get file from TEXT`);
    const dbResults = await getDb()
      .select()
      .from(knowledgeText)
      .where(eq(knowledgeText.id, data.sourceId!));
    if (dbResults.length === 0) {
      throw new Error(`Knowledge text not found: ${data.sourceId}`);
    }
    content = dbResults[0].text;
    title = dbResults[0].title;
  } else {
    log.error(
      `Can´t get file. Unsupported file source type '${data.sourceType}' or missing parameters.`
    );
    throw new Error(
      `Can´t get file. Unsupported file source type '${data.sourceType}' or missing parameters.`
    );
  }
  log.debug(`File parsed. Content length: ${content.length}`);

  // Apply post processors if requested
  if (data.usePostProcessors && data.usePostProcessors.length > 0) {
    content = await applyPostProcessors(
      content,
      data.tenantId,
      data.usePostProcessors
    );
    // set pages to undefined since we don't have pages after post processing
    pages = undefined;
    // Optionally, also update pages if needed (not implemented here)
  }

  return { content, pages, title, includesImages: docIncludesImages };
};
