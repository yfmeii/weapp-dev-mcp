import { UserError } from "fastmcp";
import { z } from "zod";

import type { WeappAutomatorManager } from "../weappClient.js";
import {
  AnyTool,
  ToolContext,
  connectionContainerSchema,
  formatJson,
  resolveElement,
  summarizeElement,
  toSerializableValue,
  toTextResult,
  waitOnPage,
  parseSelectorWithIndex,
} from "./common.js";

const tapElementParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  waitMs: z.coerce.number().int().nonnegative().optional(),
  waitForInteractive: z.boolean().optional().default(true),
  x: z.coerce.number().optional(),
  y: z.coerce.number().optional(),
  /** 验证点击是否成功（页面路径变化或元素状态变化） */
  verify: z.boolean().optional().default(true),
  /** 验证超时时间（毫秒） */
  verifyTimeout: z.coerce.number().int().nonnegative().optional().default(3000),
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
  withWxml: z.boolean().optional().default(false),
});

const getInnerElementsParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  targetSelector: z.string().trim().min(1),
  withWxml: z.boolean().optional().default(false),
});

const getElementWxmlParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  outer: z.boolean().optional().default(false),
});

const getElementStylesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)),
});

const scrollToParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  x: z.coerce.number(),
  y: z.coerce.number(),
});

const getAttributesParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
  names: z.array(z.string().trim().min(1)),
});

const getBoundingClientRectParameters = connectionContainerSchema.extend({
  selector: z.string().trim().min(1),
  innerSelector: z.string().trim().min(1).optional(),
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
    createGetElementWxmlTool(manager),
    createGetElementStylesTool(manager),
    createScrollToTool(manager),
    createGetAttributesTool(manager),
    createGetBoundingClientRectTool(manager),
  ];
}

function createTapElementTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_tap",
    description: "通过 CSS 选择器模拟点击 WXML 元素。支持 [index=N] 语法选择第 N 个元素。支持 x/y 坐标偏移点击。增强稳定性：等待元素可交互状态，点击后自动验证页面路径是否变化。",
    parameters: tapElementParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = tapElementParameters.parse(rawArgs ?? {});
      const waitMs = args.waitMs;
      const verify = args.verify ?? true;
      const verifyTimeout = args.verifyTimeout ?? 3000;

      return manager.withMiniProgram(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const page = await miniProgram.currentPage();
          if (!page) {
            throw new UserError("当前没有活动页面");
          }

          let selector = args.selector;
          let indexHint: number | undefined;

          const parsed = parseSelectorWithIndex(selector);
          if (parsed) {
            selector = parsed.baseSelector;
            indexHint = parsed.index;
          }

          if (typeof page.$$ !== "function") {
            throw new UserError("当前页面不支持查询元素。");
          }

          let elements = await page.$$(selector);
          if (!Array.isArray(elements) || elements.length === 0) {
            throw new UserError(`未找到元素: "${selector}"`);
          }

          if (indexHint !== undefined) {
            if (indexHint < 0 || indexHint >= elements.length) {
              throw new UserError(`索引 ${indexHint} 超出范围 (0-${elements.length - 1})。`);
            }
            elements = [elements[indexHint]];
          }

          const element = elements[0];

          if (args.waitForInteractive) {
            try {
              await element.waitFor?.(500);
            } catch {
            }
          }

          const originalPath = page.path;
          let originalRect;
          try {
            originalRect = await element.boundingClientRect?.();
          } catch {
          }

          if (args.x !== undefined || args.y !== undefined) {
            if (typeof element.tap === "function") {
              await element.tap();
            }
          } else {
            await element.tap();
          }

          let verifyResult = "";
          if (verify) {
            const startTime = Date.now();
            while (Date.now() - startTime < verifyTimeout) {
              await new Promise(resolve => setTimeout(resolve, 200));
              try {
                const currentPage = await miniProgram.currentPage();
                const newPath = currentPage?.path;
                if (newPath && newPath !== originalPath) {
                  verifyResult = ` 验证成功：页面已从 "${originalPath}" 跳转到 "${newPath}"`;
                  break;
                }
              } catch (e) {
                context.log.warn(`验证过程出现异常: ${e}`);
              }
            }
            if (!verifyResult) {
              verifyResult = ` ⚠️ 点击后页面路径未变化 (${originalPath})，请确认是否需要 verify=false`;
            }
          }

          if (waitMs) {
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }

          return toTextResult(
            `已点击元素 "${args.selector}"${indexHint !== undefined ? `[index=${indexHint}]` : ""}${args.innerSelector ? ` -> "${args.innerSelector}"` : ""}${args.x !== undefined || args.y !== undefined ? ` (坐标偏移: ${args.x ?? 0}, ${args.y ?? 0})` : ""}${waitMs ? ` 并等待 ${waitMs}ms` : ""}${verify ? verifyResult : ""}。`
          );
        }
      );
    },
  };
}

function createInputTextTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_input",
    description: "向指定元素输入文本。",
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
    description: "调用组件实例指定方法，仅自定义组件可以使用。",
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
    description: "获取组件实例渲染数据，仅自定义组件可以使用。",
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
    description: "设置组件实例渲染数据，仅自定义组件可以使用。",
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
    description: "在元素范围内获取元素，相当于 element.$(selector)。设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。",
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

          const summary = await summarizeElement(innerElement, { withWxml: args.withWxml });

          return toTextResult(
            formatJson({
              parentSelector: args.selector,
              parentInnerSelector: args.innerSelector ?? null,
              targetSelector: args.targetSelector,
              ...summary,
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
    description: "在元素范围内获取元素数组，相当于 element.$$(selector)。设置 withWxml 为 true 可额外返回每个元素的完整 outerWxml。",
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
              const summary = await summarizeElement(el, { withWxml: args.withWxml });
              return {
                index,
                ...summary,
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

function createGetElementWxmlTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getWxml",
    description: "获取元素 WXML。默认获取内部 WXML(element.wxml())，设置 outer 为 true 可获取包含元素本身的 WXML(element.outerWxml())。",
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

function createGetElementStylesTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getStyles",
    description: "获取元素的样式值。names 为样式名数组（如 ['color', 'fontSize', 'backgroundColor']）。",
    parameters: getElementStylesParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getElementStylesParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.style !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取样式。`
            );
          }

          const styles: Record<string, unknown> = {};

          await Promise.all(
            args.names.map(async (name) => {
              try {
                styles[name] = await element.style(name);
              } catch {
                styles[name] = null;
              }
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              styles,
            })
          );
        }
      );
    },
  };
}

function createScrollToTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_scrollTo",
    description: "滚动 scroll-view 组件到指定位置。仅适用于 scroll-view 组件。",
    parameters: scrollToParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = scrollToParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.scrollTo !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持滚动操作，仅 scroll-view 组件可使用此功能。`
            );
          }

          await element.scrollTo(args.x, args.y);

          return toTextResult(
            `已将元素 "${args.selector}"${args.innerSelector ? ` -> "${args.innerSelector}"` : ""} 滚动到位置 (${args.x}, ${args.y})。`
          );
        }
      );
    },
  };
}

function createGetAttributesTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getAttributes",
    description: "获取元素的特性值。names 为特性名数组（如 ['class', 'id', 'data-index']）。",
    parameters: getAttributesParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getAttributesParameters.parse(rawArgs ?? {});
      return manager.withPage(
        context.log,
        { overrides: args.connection },
        async (page) => {
          const element = await resolveElement(
            page,
            args.selector,
            args.innerSelector
          );

          if (typeof element.attribute !== "function") {
            throw new UserError(
              `元素 "${args.selector}" 不支持获取特性。`
            );
          }

          const attributes: Record<string, unknown> = {};

          await Promise.all(
            args.names.map(async (name) => {
              try {
                attributes[name] = await element.attribute(name);
              } catch {
                attributes[name] = null;
              }
            })
          );

          return toTextResult(
            formatJson({
              selector: args.selector,
              innerSelector: args.innerSelector ?? null,
              attributes,
            })
          );
        }
      );
    },
  };
}

function createGetBoundingClientRectTool(manager: WeappAutomatorManager): AnyTool {
  return {
    name: "element_getBoundingClientRect",
    description: "获取元素相对于视口的边界矩形信息（left、top、width、height、right、bottom）。此方法返回的是考虑 CSS transform 变换后的实际渲染尺寸和位置。支持跨组件查询：若需获取自定义组件内部元素，可将 selector 设为组件选择器，innerSelector 设为内部元素选择器。注意：目前仅支持 ID 选择器、类选择器。",
    parameters: getBoundingClientRectParameters,
    execute: async (rawArgs, context: ToolContext) => {
      const args = getBoundingClientRectParameters.parse(rawArgs ?? {});
      const { selector, innerSelector } = args;

      return manager.withMiniProgram(
        context.log,
        { overrides: args.connection },
        async (miniProgram) => {
          const fullSelector = innerSelector ? `${selector} >>> ${innerSelector}` : selector;

          let result;
          try {
            result = await miniProgram.evaluate(
              (sel: string, innerSel?: string) => {
                return new Promise((resolve, reject) => {
                  // @ts-expect-error - wx 是小程序运行时全局对象
                  const query = wx.createSelectorQuery();

                  // 如果有 innerSelector，使用 >>> 拼接成穿透选择器，这比 selectComponent 更可靠
                  const full = innerSel ? `${sel} >>> ${innerSel}` : sel;

                  query.select(full).boundingClientRect();

                  query.exec((res: unknown[]) => {
                    if (res && res.length > 0 && res[0]) {
                      resolve(res[0]);
                    } else {
                      reject(new Error(`Element not found or not rendered: "${full}". (exec returned ${JSON.stringify(res)})`));
                    }
                  });
                });
              },
              selector,
              innerSelector
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new UserError(
              `获取元素 "${fullSelector}" 的边界矩形失败: ${message}`
            );
          }

          return toTextResult(
            formatJson({
              selector,
              innerSelector: innerSelector ?? null,
              boundingClientRect: toSerializableValue(result),
            })
          );
        }
      );
    },
  };
}
