#!/usr/bin/env node

import { FastMCP } from "fastmcp";

import { createTools } from "./tools.js";
import { WeappAutomatorManager } from "./weappClient.js";

const manager = new WeappAutomatorManager();

const server = new FastMCP({
  name: "weapp-dev-mcp",
  version: "0.1.0",
  instructions:
    "Controls WeChat Mini Program projects through WeChat DevTools using miniprogram-automator.",
});

server.addTools(createTools(manager));

server.on("disconnect", async () => {
  await manager.close();
});

await server.start({
  transportType: "stdio",
});
