export type PdfParserContext = {
  tenantId: string;
  userId?: string;
  teamId?: string;
  workspaceId?: string;
};

export type PdfParserOptions = {
  model?: string;
  extractImages?: boolean;
};

export interface PageContent {
  page: number;
  text: string;
}

export interface PdfParserResult {
  includesImages: boolean;
  model: string;
  pages?: PageContent[];
}
