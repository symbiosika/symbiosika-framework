export interface SaveFileFunction {
  (
    file: File,
    bucket: string,
    organisationId: string,
    options?: {
      chatId?: string;
      workspaceId?: string;
    }
  ): Promise<{
    path: string;
    id: string;
    name: string;
    organisationId: string;
  }>;
}

export interface GeneralSaveFileFunction {
  (
    file: File,
    bucket: string,
    organisationId: string,
    storageType: "local" | "db"
  ): Promise<{
    path: string;
    id: string;
    name: string;
    organisationId: string;
  }>;
}

export interface GetFileFunction {
  (id: string, bucket: string, organisationId: string): Promise<File>;
}

export interface GeneralGetFileFunction {
  (
    id: string,
    bucket: string,
    organisationId: string,
    storageType: "local" | "db"
  ): Promise<File>;
}

export interface DeleteFileFunction {
  (id: string, bucket: string, organisationId: string): Promise<void>;
}

export interface GeneralDeleteFileFunction {
  (
    id: string,
    bucket: string,
    organisationId: string,
    storageType: "local" | "db"
  ): Promise<void>;
}
