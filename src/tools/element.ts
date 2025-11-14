import { UserError } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  connectionContainerSchema,
  formatJson,
  resolveElement,
  toSerializableValue,
  toTextResult,
  waitOnPage,
} from "./common.js";

const tapElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  waitMs: z.coerce.number().int().nonnegative().optional(),
});

const inputTextParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  value: z.union([z.string(), z.coerce.number()]),
});

const callElementMethodParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  method: z.string().trim().min(1),
  args: z.array(z.unknown()).optional(),
});

const getElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
});

const setElementDataParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  data: z.record(z.unknown()),
});

const getInnerElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
});

const getInnerElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
});

const getElementSizeParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
});

const getElementWxmlParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  outer: z.boolean().optional().default(false),
});

export function createElementTools(
  manager: WeappAutomatorManager
): AnyTool[] {
  return [
    createTapElementTool(manager),
    createInputTextTool(manager),
    createCallElementMethodTool(manager),
    createGetElementDataTool(manager),
    createSetElementDataTool(manager),
    createGetInnerElementTool(manager),
    createGetInnerElementsTool(manager),
    createGetElementSizeTool(manager),
    createGetElementWxmlTool(manager),
  ];
}

function createTapElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_tap",
    description: "通过 CSS 选择器模拟点击 WXML 元素。如需点击自定义组件内部的元素，请使用 innerSelector 参数：selector 设为组件 ID 选择器(如 #my-component)，innerSelector 设为组件内部元素的选择器。",
    parameters: tapElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = tapElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          await element.tap();
          await waitOnPage(page, waitMs);

          return toTextResult(
            `已点击元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""}${waitMs ? ` 并等待 ${waitMs}ms` : ""}。`
          );
        }
      );
    },
  };
}

function createInputTextTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_input",
    description: "向指定元素输入文本。如需向自定义组件内部的元素输入，请使用 innerSelector 参数：selector 设为组件 ID 选择器(如 #my-component)，innerSelector 设为组件内部元素的选择器。",
    parameters: inputTextParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = inputTextParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          await element.input(args.value);
          return toTextResult(
            `已向元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 输入值 "${args.value}"。`
          );
        }
      );
    },
  };
}

function createCallElementMethodTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_callMethod",
    description: "调用组件实例指定方法，仅自定义组件可以使用。需要 automator 0.6.0 和基础库 2.9.0 及以上版本。使用 ID 选择器(如 #my-component)定位自定义组件。",
    parameters: callElementMethodParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = callElementMethodParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const callArgs = args.args ?? [];
          const result = await element.callMethod(args.method, ...callArgs);
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
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

function createGetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getData",
    description: "获取组件实例渲染数据，仅自定义组件可以使用。需要 automator 0.6.0 和基础库 2.9.0 及以上版本。使用 ID 选择器(如 #my-component)定位自定义组件。",
    parameters: getElementDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementDataParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const data = await element.data(args.path);
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              path: args.path ?? null,
              data: toSerializableValue(data),
            })
          );
        }
      );
    },
  };
}

function createSetElementDataTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_setData",
    description: "设置组件实例渲染数据，仅自定义组件可以使用。需要 automator 0.6.0 和基础库 2.9.0 及以上版本。使用 ID 选择器(如 #my-component)定位自定义组件。",
    parameters: setElementDataParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = setElementDataParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          await element.setData(args.data);
          const dataKeys = Object.keys(args.data ?? {});
          return toTextResult(
            `已更新组件数据键: ${dataKeys.length ? dataKeys.join(", ") : "(无)"}。`
          );
        }
      );
    },
  };
}

function createGetInnerElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getInnerElement",
    description: "在元素范围内获取元素，相当于 element.$(selector)。重要：操作自定义组件内部元素时，必须先通过 ID 选择器(如 #my-component)定位自定义组件，然后使用此工具获取组件内部的元素。",
    parameters: getInnerElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getInnerElementParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.$ !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持查询内部元素。`
            );
          }

          const innerElement = await element.$(args.targetSelector);
          if (!innerElement) {
            throw new UserError(
              `在元素 "${args.selector}" 内未找到选择器 "${args.targetSelector}" 对应的元素。`
            );
          }

          const tagName = innerElement.tagName || null;
          const text = typeof innerElement.text === "function"
            ? await innerElement.text().catch(() => null)
            : null;
          const outerWxml = typeof innerElement.outerWxml === "function"
            ? await innerElement.outerWxml().catch(() => null)
            : null;

          return toTextResult(
            formatJson({
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              tagName: toSerializableValue(tagName),
              text: toSerializableValue(text),
              outerWxml: toSerializableValue(outerWxml),
            })
          );
        }
      );
    },
  };
}

function createGetInnerElementsTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getInnerElements",
    description: "在元素范围内获取元素数组，相当于 element.$$(selector)。重要：操作自定义组件内部元素时，必须先通过 ID 选择器(如 #my-component)定位自定义组件，然后使用此工具获取组件内部的元素数组。",
    parameters: getInnerElementsParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getInnerElementsParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.$$ !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持查询内部元素数组。`
            );
          }

          const innerElements = await element.$$(args.targetSelector);
          if (!Array.isArray(innerElements)) {
            throw new UserError(
              `在元素 "${args.selector}" 内查询选择器 "${args.targetSelector}" 失败。`
            );
          }

          const elementsInfo = await Promise.all(
            innerElements.map(async (el, index) => {
              const tagName = el.tagName || null;
              const text = typeof el.text === "function"
                ? await el.text().catch(() => null)
                : null;
              return {
                index,
                tagName: toSerializableValue(tagName),
                text: toSerializableValue(text),
              };
            })
          );

          return toTextResult(
            formatJson({
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              count: innerElements.length,
              elements: elementsInfo,
            })
          );
        }
      );
    },
  };
}

function createGetElementSizeTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getSize",
    description: "获取元素大小(宽度和高度)。如需获取自定义组件内部元素的大小，请使用 innerSelector 参数：selector 设为组件 ID 选择器(如 #my-component)，innerSelector 设为组件内部元素的选择器。",
    parameters: getElementSizeParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementSizeParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.size !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取大小。`
            );
          }

          const size = await element.size();
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              width: toSerializableValue(size.width),
              height: toSerializableValue(size.height),
            })
          );
        }
      );
    },
  };
}

function createGetElementWxmlTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getWxml",
    description: "获取元素 WXML。默认获取内部 WXML(element.wxml())，设置 outer 为 true 可获取包含元素本身的 WXML(element.outerWxml())。如需获取自定义组件内部元素的 WXML，请使用 innerSelector 参数：selector 设为组件 ID 选择器(如 #my-component)，innerSelector 设为组件内部元素的选择器。",
    parameters: getElementWxmlParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementWxmlParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          const methodName = args.outer ? "outerWxml" : "wxml";
          if (typeof element[methodName] !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取 ${methodName}。`
            );
          }

          const wxml = await element[methodName]();
          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              type: args.outer ? "outerWxml" : "wxml",
              wxml: toSerializableValue(wxml),
            })
          );
        }
      );
    },
  };
}
