import { readFileSync } from "node:fs";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

const read = (file: string): Record<string, any> =>
  parse(readFileSync(new URL(`../../contracts/${file}`, import.meta.url), "utf8")) as Record<string, any>;

export const openapi = read("openapi.yaml");
export const asyncapi = read("asyncapi.yaml");
export const tradingDebit = read("trading-debit.openapi.yaml");

// OpenAPI 3.1 schemas are JSON Schema 2020-12.
const openapiAjv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(openapiAjv);

// AsyncAPI 3.0 schemas default to a superset of JSON Schema draft-07.
const asyncapiAjv = new Ajv({ strict: false, allErrors: true });
addFormats.default(asyncapiAjv);

/** Errors of a body against the schema of an operation's response in contracts/openapi.yaml; empty = valid. */
export function responseErrors(path: string, method: string, status: number, body: unknown): string[] {
  const response = openapi["paths"][path]?.[method.toLowerCase()]?.responses?.[String(status)];
  if (!response) return [`${method} ${path} has no ${status} response in the contract`];
  const resolved = response.$ref ? openapi["components"].responses[String(response.$ref).split("/").pop()!] : response;
  const content = resolved.content?.["application/json"] ?? resolved.content?.["application/problem+json"];
  if (!content) return [];
  const validate = openapiAjv.compile({ components: openapi["components"], ...content.schema });
  return validate(body) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}

/** Errors of an event against a schema of contracts/asyncapi.yaml, for example "TenantCreatedEvent". */
export function eventErrors(schemaName: string, event: unknown): string[] {
  const validate = asyncapiAjv.compile({ components: asyncapi["components"], $ref: `#/components/schemas/${schemaName}` });
  return validate(event) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`);
}
