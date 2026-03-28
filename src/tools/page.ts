import { UserError, type ContentResult } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  connectionContainerSchema,
  formatJson,
  summarizeElement,
  toSerializableValue,
  toTextResult,
  resolveElement,
  parseSelectorWithIndex,
} from "./common.js";

const getPageDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
});

const setPageDataParameters = connectionContainerSchema.extend({
  data: z.record(z.unknown()),
  verify: z.boolean().optional().default(true),
});

const callPageMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const waitForElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  timeout: z.coerce.number().int().positive().optional().default(5000),
  retryInterval: z.coerce.number().int().positive().optional().default(200),
});

const waitForTimeoutParameters = connectionContainerSchema.extend({
  milliseconds: z.coerce.number().int().nonnegative(),
});

const getElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  withWxml: z.boolean().optional().default(false),
});

const getElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  withWxml: z.boolean().optional().default(false),
});

export function createPageTools(manager: WeappAutomatorManager): AnyTool[] {
  return [
    createGetElementTool(manager),
    createGetElementsTool(manager),
    createWaitForElementTool(manager),
    createWaitForTimeoutTool(manager),
    createGetPageDataTool(manager),
    createSetPageDataTool(manager),
    createCallPageMethodTool(manager),
  ];
}

function createGetElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElement",
    description: "通过选择器获取页面元素，相当于 page.$(selector)。返回每个元素的摘要信息（tagName、text、value、size、offset）；设置 withWxml 为 true 可额外返回元素的完整 outerWxml。支持 [index=N] 语法选择第 N 个元素。",
    parameters: getElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          let selector = args.selector;
          let indexHint: number | undefined;
          
          // 解析 [index=N] 语法
          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          // 先用 $$ 获取所有匹配元素
          let elements = await page.$$(selector);
          if (!Array.isArray(elements) || elements.length === 0) {
            throw new UserError(`元素未找到: "${selector}"`);
          }

          // 如果有索引提示，取对应元素
          if (indexHint !== undefined) {
            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }
            elements = [elements[indexHint]];
          }

          const element = elements[0];
          const summary = await summarizeElement(element, { withWxml: args.withWxml });
          return toTextResult(formatJson({
            selector: args.selector,
            index: indexHint,
            ...summary,
          }));
        }
      );
    },
  };
}

function createGetElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getElements",
    description: "通过选择器获取页面元素数组，相当于 page.$$(selector)。返回每个元素的摘要信息（tagName、text、value、size、offset）；设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。支持 [index=N] 语法选择第 N 个元素。",
    parameters: getElementsParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementsParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素数组。");
          }

          let selector = args.selector;
          let indexHint: number | undefined;
          
          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          let elements = await page.$$(selector);
          if (!Array.isArray(elements)) {
            throw new UserError(`查询选择器 "${selector}" 失败。`);
          }

          if (indexHint !== undefined) {
            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }
            elements = [elements[indexHint]];
          }

          const elementsInfo = await Promise.all(
            elements.map(async (el: any, index: number) => {
              const summary = await summarizeElement(el, { withWxml: args.withWxml });
              return {
                index: indexHint !== undefined ? indexHint : index,
                ...summary,
              };
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              count: elements.length,
              elements: elementsInfo,
            })
          );
        }
      );
    },
  };
}

function createWaitForElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElement",
    description: "等待指定选择器的元素出现在页面上。支持 [index=N] 语法选择第 N 个元素。增强版：增加了超时和重试间隔参数。",
    parameters: waitForElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = waitForElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const startTime = Date.now();
          const timeout = args.timeout;
          const retryInterval = args.retryInterval;
          
          while (Date.now() - startTime < timeout) {
            try {
              const element = await page.$(args.selector);
              if (element) {
                return toTextResult(`已等待元素选择器 "${args.selector}" 出现 (耗时 ${Date.now() - startTime}ms)。`);
              }
            } catch {
            }
            await new Promise(resolve => setTimeout(resolve, retryInterval));
          }
          
          throw new UserError(`等待元素 "${args.selector}" 超时 (${timeout}ms)。`);
        }
      );
    },
  };
}

function createWaitForTimeoutTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitTimeout",
    description: "等待指定的毫秒数。",
    parameters: waitForTimeoutParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = waitForTimeoutParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await new Promise(resolve => setTimeout(resolve, args.milliseconds));
          return toTextResult(`已等待 ${args.milliseconds}ms。`);
        }
      );
    },
  };
}

function createGetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getData",
    description: "获取当前页面的数据对象，可选择指定子数据路径（使用点号分隔，如 'user.name'）。",
    parameters: getPageDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getPageDataParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          let data = await page.data();
          if (args.path) {
            const keys = args.path.split('.');
            for (const key of keys) {
              if (data && typeof data === 'object' && key in data) {
                data = (data as Record<string, unknown>)[key];
              } else {
                data = undefined;
                break;
              }
            }
          }
          return toTextResult(
            formatJson({
              path: args.path ?? null,
              data: toSerializableValue(data),
            })
          );
        }
      );
    },
  };
}

function createSetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_setData",
    description: "使用 setData 更新当前页面的数据。增加 verify 选项，验证数据是否真正更新成功。",
    parameters: setPageDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = setPageDataParameters.parse(rawArgs ?? {});
      const dataKeys = Object.keys(args.data ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await page.setData(args.data);
          
          if (args.verify) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const verifyData = await page.data();
            let verificationPassed = true;
            for (const key of dataKeys) {
              const expectedValue = (args.data as Record<string, unknown>)[key];
              const actualValue = (verifyData as Record<string, unknown>)[key];
              if (JSON.stringify(expectedValue) !== JSON.stringify(actualValue)) {
                verificationPassed = false;
                context.log.warn(`验证失败: ${key}`, {
                  expected: String(expectedValue),
                  actual: String(actualValue),
                });
                break;
              }
            }
            
            if (!verificationPassed) {
              throw new UserError(`setData 验证失败: 数据未正确更新。已更新的键: ${dataKeys.join(", ")}`);
            }
          }
          
          return toTextResult(
            `已更新页面数据键: ${dataKeys.length ? dataKeys.join(", ") : "(无)"}${args.verify ? " (已验证)" : ""}。`
          );
        }
      );
    },
  };
}

function createCallPageMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_callMethod",
    description: "调用当前页面实例上暴露的方法。参数可以作为数组提供。",
    parameters: callPageMethodParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = callPageMethodParameters.parse(rawArgs ?? {});
      const callArgs = args.args ?? [];
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const result = await page.callMethod(args.method, ...callArgs);
          return toTextResult(
            formatJson({
              method: args.method,
              arguments: callArgs,
              result: toSerializableValue(result),
            })
          );
        }
      );
    },
  };
}
