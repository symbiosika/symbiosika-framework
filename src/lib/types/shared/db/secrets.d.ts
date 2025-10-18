/*
import type { secrets } from "../../../lib/db/schema/secrets";
type SecretsEntry = typeof secrets.$inferSelect;
type InsertSecretsEntry = typeof secrets.$inferInsert;
*/

export type SecretsEntry = {
  id: string;
  name: string;
  reference: string;
  referenceId: string;
  label: string;
  value: string;
  type: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertSecretsEntry = {
  name: string;
  reference: string;
  referenceId: string;
  label: string;
  value: string;
  type: string;
  id?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};
