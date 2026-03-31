import { UserError, type SerializableValue } from "fastmcp";
import automator from "miniprogram-automator";

import {
  ConfigError,
  resolveConfig,
  type ConnectionOverrides,
  type WeappConnectionConfig,
} from "./config.js";

type ToolLogger = {
  debug: (message: string, data?: SerializableValue) => void;
  info: (message: string, data?: SerializableValue) => void;
  warn: (message: string, data?: SerializableValue) => void;
  error: (message: string, data?: SerializableValue) => void;
};

interface UseOptions {
  overrides?: ConnectionOverrides;
  reconnect?: boolean;
}

export interface ConsoleLogEntry {
  type: string;
  message: string;
  timestamp: number;
  data?: SerializableValue;
}

export class WeappAutomatorManager {
  private miniProgram?: MiniProgramInstance;
  private config?: WeappConnectionConfig;
  private consoleLogs: ConsoleLogEntry[] = [];
  private maxLogs = 1000; // 最多保存1000条日志

  getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  async withMiniProgram<T>(
    log: ToolLogger,
    options: UseOptions,
    handler: (
      miniProgram: MiniProgramInstance,
      config: WeappConnectionConfig
    ) => Promise<T>
  ): Promise<T> {
    const { overrides, reconnect } = options;
    let config: WeappConnectionConfig;
    try {
      config = resolveConfig(overrides, this.config);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new UserError(error.message);
      }
      throw error;
    }

    if (reconnect) {
      await this.close(log);
    }

    const canReuse =
      this.miniProgram && this.config && isSameConfig(this.config, config);
    if (!canReuse) {
      await this.close(log);
      log.info("Establishing WeChat DevTools automation session", {
        mode: config.mode,
        projectPath: config.projectPath,
        wsEndpoint: config.wsEndpoint,
        port: config.port,
      });
      try {
        this.miniProgram = await this.connect(config);
        this.config = config;
        this.attachLogging(this.miniProgram, log);
      } catch (error) {
        this.miniProgram = undefined;
        this.config = undefined;
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(
          `Failed to ${
            config.mode === "connect" ? "connect to" : "launch"
          } WeChat DevTools: ${message}`
        );
      }
    }

    const activeProgram = this.miniProgram!;
    try {
      return await handler(activeProgram, config);
    } finally {
      if (config.autoClose) {
        await this.close(log);
      }
    }
  }

  async withPage<T>(
    log: ToolLogger,
    options: UseOptions,
    handler: (
      page: PageInstance,
      miniProgram: MiniProgramInstance,
      config: WeappConnectionConfig
    ) => Promise<T>
  ): Promise<T> {
    return this.withMiniProgram(log, options, async (miniProgram, config) => {
      const page = await miniProgram.currentPage();
      if (!page) {
        throw new UserError(
          "Mini Program page stack is empty. Ensure the project window is open."
        );
      }
      return handler(page, miniProgram, config);
    });
  }

  async close(log?: ToolLogger): Promise<void> {
    if (!this.miniProgram) {
      return;
    }

    try {
      if (this.config?.mode === "launch") {
        await this.miniProgram.close();
      } else {
        this.miniProgram.disconnect();
      }
      log?.debug("Closed WeChat DevTools automation session");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.warn("Failed to close WeChat DevTools cleanly", { message });
    } finally {
      this.miniProgram.removeAllListeners();
      this.miniProgram = undefined;
      this.config = undefined;
    }
  }

  private async connect(
    config: WeappConnectionConfig
  ): Promise<MiniProgramInstance> {
    if (config.mode === "connect") {
      return automator.connect({ wsEndpoint: config.wsEndpoint! });
    }

    return automator.launch({
      cliPath: config.cliPath,
      projectPath: config.projectPath!,
      timeout: config.timeout,
      port: config.port,
      account: config.account,
      ticket: config.ticket,
      trustProject: config.trustProject,
      args: config.args,
      cwd: config.cwd,
    });
  }

  private attachLogging(miniProgram: MiniProgramInstance, log: ToolLogger) {
    miniProgram.on("console", (event: unknown) => {
      const serialized = toSerializable(event);
      const args = (event as any)?.args;
      const logEntry: ConsoleLogEntry = {
        type: typeof (event as any)?.type === "string" ? (event as any).type : "log",
        message: Array.isArray(args) ? args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ") : String(serialized),
        timestamp: Date.now(),
        data: serialized,
      };
      
      // 保存日志，限制数量
      this.consoleLogs.push(logEntry);
      if (this.consoleLogs.length > this.maxLogs) {
        this.consoleLogs.shift();
      }
      
      log.debug("Mini Program console event", {
        event: serialized,
      });
    });
    miniProgram.on("exception", (event: unknown) => {
      const serialized = toSerializable(event);
      const logEntry: ConsoleLogEntry = {
        type: "exception",
        message: typeof (event as any)?.message === "string" ? (event as any).message : String(serialized),
        timestamp: Date.now(),
        data: serialized,
      };
      
      // 保存异常日志
      this.consoleLogs.push(logEntry);
      if (this.consoleLogs.length > this.maxLogs) {
        this.consoleLogs.shift();
      }
      
      log.error("Mini Program exception", {
        event: serialized,
      });
    });
  }
}

type MiniProgramInstance = Awaited<ReturnType<typeof automator.launch>>;
type PageInstance = NonNullable<
  Awaited<ReturnType<MiniProgramInstance["currentPage"]>>
>;

function toSerializable(value: unknown): SerializableValue {
  if (value === null || value === undefined) {
    return value as SerializableValue;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toSerializable(item)) as SerializableValue;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => [key, toSerializable(val)]
    );
    return Object.fromEntries(entries) as SerializableValue;
  }
  return String(value) as SerializableValue;
}

function isSameConfig(
  a: WeappConnectionConfig,
  b: WeappConnectionConfig
): boolean {
  return (
    a.mode === b.mode &&
    a.cliPath === b.cliPath &&
    a.projectPath === b.projectPath &&
    a.wsEndpoint === b.wsEndpoint &&
    a.timeout === b.timeout &&
    a.port === b.port &&
    a.account === b.account &&
    a.ticket === b.ticket &&
    a.trustProject === b.trustProject &&
    a.cwd === b.cwd &&
    a.autoClose === b.autoClose &&
    areArgsEqual(a.args, b.args)
  );
}

function areArgsEqual(a?: string[], b?: string[]): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}
