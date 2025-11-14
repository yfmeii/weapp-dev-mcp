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
} from "./common.js";

const getPageDataParameters = connectionContainerSchema.extend({
  path: z.string().trim().min(1).optional(),
});

const setPageDataParameters = connectionContainerSchema.extend({
  data: z.record(z.unknown()),
});

const callPageMethodParameters = connectionContainerSchema.extend({
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const waitForElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
});

const waitForTimeoutParameters = connectionContainerSchema.extend({
  milliseconds: z.coerce.number().int().nonnegative(),
});

const getElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
});

export function createPageTools(manager: WeappAutomatorManager): AnyTool[] {
  return [
    createGetElementTool(manager),
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
    description: "通过选择器获取页面元素。",
    parameters: getElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );
          const summary = await summarizeElement(element);
          return toTextResult(formatJson(summary));
        }
      );
    },
  };
}

function createWaitForElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_waitElement",
    description: "等待指定选择器的元素出现在页面上。注意：此方法不适用于自定义组件内部元素，仅能等待页面级别的元素。如需等待自定义组件内部元素，请使用 page_waitTimeout 配合 element 相关工具进行轮询检查。",
    parameters: waitForElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = waitForElementParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await page.waitFor(args.selector);
          return toTextResult(`已等待元素选择器 "${args.selector}" 出现。`);
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
          await page.waitFor(args.milliseconds);
          return toTextResult(`已等待 ${args.milliseconds}ms。`);
        }
      );
    },
  };
}

function createGetPageDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "page_getData",
    description: "获取当前页面的数据对象，可选择指定路径。",
    parameters: getPageDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getPageDataParameters.parse(rawArgs ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const data = await page.data(args.path);
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
    description: "使用 setData 更新当前页面的数据。",
    parameters: setPageDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = setPageDataParameters.parse(rawArgs ?? {});
      const dataKeys = Object.keys(args.data ?? {});
      return manager.withPage<ContentResult>(
        context.log,
        { overrides: args.connection },
        async (page) => {
          await page.setData(args.data);
          return toTextResult(
            `已更新页面数据键: ${dataKeys.length ? dataKeys.join(", ") : "(无)"}。`
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
