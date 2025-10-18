export interface SyncItem {
  externalId: string;
  title: string;
  text: string;
  lastChange?: string;
  lastHash?: string;
  meta?: Record<string, any>;
  filters?: Record<string, string>;
}

export interface SyncItemStatus {
  externalId: string;
  status: "added" | "updated" | "deleted" | "unchanged";
}

export interface SyncResult {
  items: SyncItemStatus[];
  stats: {
    added: number;
    updated: number;
    deleted: number;
    unchanged: number;
  };
}
