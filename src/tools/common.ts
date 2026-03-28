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
    projectSelection: z.string().optional(),
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
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (!query || Object.keys(query).length === 0) {
    return normalizedPath;
  }
  const searchParams = new URLSearchParams(query);
  const separator = normalizedPath.includes("?") ? "&" : "?";
  const search = searchParams.toString();
  return search ? `${normalizedPath}${separator}${search}` : normalizedPath;
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
  element: any,
  options?: { withWxml?: boolean }
): Promise<Record<string, SerializableValue>> {
  const tagName = typeof element?.tagName === "string" ? element.tagName : null;
  const withWxml = options?.withWxml ?? false;
  
  const [text, value, outerWxml, size, offset, scrollWidth, scrollHeight] = await Promise.all([
    typeof element?.text === "function"
      ? element.text().catch(() => null)
      : null,
    typeof element?.value === "function"
      ? element.value().catch(() => null)
      : null,
    withWxml && typeof element?.outerWxml === "function"
      ? element.outerWxml().catch(() => null)
      : null,
    typeof element?.size === "function"
      ? element.size().catch(() => null)
      : null,
    typeof element?.offset === "function"
      ? element.offset().catch(() => null)
      : null,
    typeof element?.scrollWidth === "function"
      ? element.scrollWidth().catch(() => null)
      : null,
    typeof element?.scrollHeight === "function"
      ? element.scrollHeight().catch(() => null)
      : null,
  ]);

  const result: Record<string, SerializableValue> = {
    tagName: toSerializableValue(tagName),
    text: toSerializableValue(text),
    value: toSerializableValue(value),
    size: toSerializableValue(size),
    offset: toSerializableValue(offset),
  };

  // 当 withWxml 为 true 时，返回完整的 outerWxml
  if (withWxml && outerWxml !== null) {
    result.outerWxml = toSerializableValue(outerWxml);
  }

  // scroll-view 专用属性，仅在有值时添加
  if (scrollWidth !== null) {
    result.scrollWidth = toSerializableValue(scrollWidth);
  }
  if (scrollHeight !== null) {
    result.scrollHeight = toSerializableValue(scrollHeight);
  }

  return result;
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

/**
 * 解析带索引的选择器语法，如 "view[index=2]" 或 "view[index=2] .child"
 * 返回 { baseSelector, index } 或 null
 */
export function parseSelectorWithIndex(selector: string): { baseSelector: string; index: number } | null {
  // 匹配 selector[index=N] 语法
  const match = selector.match(/^(.+?)\[index=(\d+)\]$/);
  if (match) {
    return {
      baseSelector: match[1],
      index: parseInt(match[2], 10),
    };
  }
  return null;
}

/**
 * 等待元素可交互的稳定点击
 * 增加多重检查确保元素真正可点击
 */
export async function waitForElementInteractive(
  element: any,
  options?: { timeout?: number; retryInterval?: number }
): Promise<void> {
  const timeout = options?.timeout ?? 5000;
  const retryInterval = options?.retryInterval ?? 100;
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    try {
      // 检查元素是否可见
      const visible = await element.isVisible?.();
      if (visible === true) {
        return;
      }
      // 如果 isVisible 不可用，尝试获取 boundingClientRect
      const rect = await element.boundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) {
        return;
      }
    } catch {
      // 忽略错误继续重试
    }
    await new Promise(resolve => setTimeout(resolve, retryInterval));
  }
  
  // 最后尝试一次，不管结果如何都继续
  try {
    await element.isVisible?.();
  } catch {
    // ignore
  }
}

/**
 * 验证点击操作是否成功
 * 通过比较点击前后的元素状态来判断
 */
export async function verifyTapAction(
  element: any,
  originalRect?: { x: number; y: number; width: number; height: number }
): Promise<boolean> {
  try {
    if (originalRect) {
      const newRect = await element.boundingClientRect?.();
      if (newRect) {
        return Math.abs((newRect as any).left - originalRect.x) < 1 && 
               Math.abs((newRect as any).top - originalRect.y) < 1;
      }
    }
    return true;
  } catch {
    return false;
  }
}
