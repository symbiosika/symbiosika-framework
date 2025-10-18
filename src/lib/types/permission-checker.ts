import type { SQL } from "drizzle-orm";

export interface CrudPermission {
  create: boolean;
  read: boolean;
  write: boolean;
  delete: boolean;
}

export interface RawParameters {
  userId: string;
  rawSearchParams: URLSearchParams;
  tableName: string;
  orderBy?: string;
  orderAsc?: boolean;
  limit?: number;
  single?: boolean;
  columns?: string[];
  expand?: string[];
  filter?: string;
  where?: Record<string, SQL<unknown>>;
}

export interface PermissionDefinition {
  simpleFilter?: string; // simple filter for the query like "id = '123'"
  customWhere?: (params: RawParameters) => SQL<unknown> | undefined; // custom where clause
  neededParameters?: {
    name: string;
    operator: string;
    valueType: string;
    isPrimaryId?: boolean; // if this is the primary id of the table then it comes from the request as "id" and needs to be renamed
  }[]; // URL Parameters that are needed for the query
  checkPermissionsFor?: {
    name: string;
    checker: (userId: string, value: string) => Promise<CrudPermission>;
    permission: "create" | "read" | "write" | "delete";
  }[];
  columns?: any;
  // custom SQL actions
  selector?: (userId: string, params: RawParameters) => Promise<any[]>; // custom selector function
  inserter?: (userId: string, body: any) => Promise<any>; // custom inserter function
  // custom actions to do some modifications with the data before the actual action
  preAction?: (userId: string, body: any) => Promise<any>; // custom pre-action function
  // postAction?: (userId: string, body: any) => Promise<any>; // custom post-action function
}

interface PermissionDefinitionPerMethod {
  [key: string]: PermissionDefinition | undefined;
  GET?: PermissionDefinition;
  POST?: PermissionDefinition;
  PUT?: PermissionDefinition;
  DELETE?: PermissionDefinition;
}

export interface PermissionDefinitionPerTable {
  [tablename: string]: PermissionDefinitionPerMethod;
}
