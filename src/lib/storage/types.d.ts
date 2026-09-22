/** The storage backends the framework carries. */
export type StorageType = "local" | "db" | "s3";

export interface SaveFileFunction {
  (
    file: File,
    bucket: string,
    tenantId: string,
    options?: {
      chatId?: string;
      workspaceId?: string;
    }
  ): Promise<{
    path: string;
    id: string;
    name: string;
    tenantId: string;
  }>;
}

export interface GeneralSaveFileFunction {
  (
    file: File,
    bucket: string,
    tenantId: string,
    storageType: StorageType
  ): Promise<{
    path: string;
    id: string;
    name: string;
    tenantId: string;
  }>;
}

export interface GetFileFunction {
  (id: string, bucket: string, tenantId: string): Promise<File>;
}

export interface GeneralGetFileFunction {
  (
    id: string,
    bucket: string,
    tenantId: string,
    storageType: StorageType
  ): Promise<File>;
}

export interface DeleteFileFunction {
  (id: string, bucket: string, tenantId: string): Promise<void>;
}

export interface GeneralDeleteFileFunction {
  (
    id: string,
    bucket: string,
    tenantId: string,
    storageType: StorageType
  ): Promise<void>;
}
