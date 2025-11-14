import {
  UserError,
  type ContentResult,
  type Context,
  type SerializableValue,
  type Tool,
} from "fastmcp";
import { z } from "zod";

import { connectionOverridesSchema } from "../config.js";

export type ToolContext = Context<Record<string, unknown> | undefined>;
export type AnyTool = Tool<Record<string, unknown> | undefined>;

export const connectionContainerSchema = z.object({
  connection: connectionOverridesSchema.optional(),
});

export const connectionOnlyParameters = connectionContainerSchema;

export const ensureConnectionParameters = connectionContainerSchema
  .extend({
    reconnect: z.coerce.boolean().optional().default(false),
  });

export const querySchema = z.record(z.string()).optional();

export const stringListSchema = z
  .union([z.string(), z.array(z.string()), z.undefined()])
  .transform((value) => {
    if (!value) {
      return undefined;
    }
    const list = Array.isArray(value) ? value : value.split(/\s+/);
    const normalized = list.map((item) => item.trim()).filter(Boolean);
    return normalized.length ? normalized : undefined;
  });

export function buildUrl(
  path: string,
  query?: Record<string, string>
): string {
  if (!query || Object.keys(query).length === 0) {
    return path;
  }
  const searchParams = new URLSearchParams(query);
  const separator = path.includes("?") ? "&" : "?";
  const search = searchParams.toString();
  return search ? `${path}${separator}${search}` : path;
}

export function formatJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? String(value);
}

export function toTextResult(text: string): ContentResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
  };
}

export async function readNamedValues(
  names: string[] | undefined,
  reader: (name: string) => Promise<unknown>,
  kind: "attribute" | "property"
): Promise<Record<string, unknown> | undefined> {
  if (!names?.length) {
    return undefined;
  }

  const entries: [string, unknown][] = [];
  for (const name of names) {
    try {
      entries.push([name, await reader(name)]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push([name, `Failed to read ${kind}: ${message}`]);
    }
  }
  return Object.fromEntries(entries);
}

export async function resolveElement(
  page: unknown,
  selector: string,
  innerSelector?: string
): Promise<any> {
  if (!page || typeof (page as { $?: unknown }).$ !== "function") {
    throw new UserError("Page instance is not available to resolve elements.");
  }
  let element = await (page as { $: (s: string) => Promise<any> }).$(selector);
  if (!element) {
    throw new UserError(`Element not found for selector "${selector}".`);
  }
  if (innerSelector) {
    if (typeof element.$ !== "function") {
      throw new UserError(
        `Element for selector "${selector}" does not support nested queries.`
      );
    }
    const inner = await element.$(innerSelector);
    if (!inner) {
      throw new UserError(
        `Element not found for selector "${innerSelector}" within "${selector}".`
      );
    }
    element = inner;
  }
  return element;
}

export async function summarizeElement(
  element: any
): Promise<Record<string, SerializableValue>> {
  const tagName = typeof element?.tagName === "string" ? element.tagName : null;
  const [text, value, outerWxml] = await Promise.all([
    typeof element?.text === "function"
      ? element.text().catch(() => null)
      : null,
    typeof element?.value === "function"
      ? element.value().catch(() => null)
      : null,
    typeof element?.outerWxml === "function"
      ? element.outerWxml().catch(() => null)
      : null,
  ]);

  return {
    tagName: toSerializableValue(tagName),
    text: toSerializableValue(text),
    value: toSerializableValue(value),
    outerWxml: toSerializableValue(outerWxml),
  };
}

export async function waitOnPage(page: unknown, waitMs?: number): Promise<void> {
  if (!waitMs) {
    return;
  }
  if (page && typeof (page as { waitFor?: unknown }).waitFor === "function") {
    await (page as { waitFor: (value: number) => Promise<void> }).waitFor(waitMs);
  }
}

export function serializePageSummary(page: unknown): SerializableValue {
  if (!isPageLike(page)) {
    return toSerializableValue(page);
  }
  const summary: Record<string, SerializableValue> = {
    path: page.path,
  };
  if (page.query !== undefined) {
    summary.query = toSerializableValue(page.query);
  }
  return summary as SerializableValue;
}

export function toSerializableValue(value: unknown): SerializableValue {
  if (value === null || value === undefined) {
    return value as SerializableValue;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString() as SerializableValue;
  }
  if (value instanceof Date) {
    return value.toISOString() as SerializableValue;
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return value.toString("base64") as SerializableValue;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toSerializableValue(item)) as SerializableValue;
  }
  if (isPageLike(value)) {
    return serializePageSummary(value);
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => [key, toSerializableValue(val)]
    );
    return Object.fromEntries(entries) as SerializableValue;
  }
  return String(value) as SerializableValue;
}

function isPageLike(value: unknown): value is { path: string; query?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

export function createFunctionFromSource(
  source: string,
  context: string
): (...args: unknown[]) => unknown {
  try {
    const fn = new Function(`return (${source});`)();
    if (typeof fn !== "function") {
      throw new Error("Source did not evaluate to a function.");
    }
    return fn as (...args: unknown[]) => unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`${context} is invalid: ${message}`);
  }
}
