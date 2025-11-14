import { createApplicationTools } from "./tools/application.js";
import { AnyTool } from "./tools/common.js";
import { createElementTools } from "./tools/element.js";
import { createPageTools } from "./tools/page.js";
import { WeappAutomatorManager } from "./weappClient.js";

export function createTools(manager: WeappAutomatorManager): AnyTool[] {
  return [
    ...createApplicationTools(manager),
    ...createPageTools(manager),
    ...createElementTools(manager),
  ];
}
