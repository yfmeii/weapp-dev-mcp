import { UserError, type SerializableValue } from "fastmcp";
import automator from "miniprogram-automator";
import net from "net";
import fs from "fs";
import path from "path";
import os from "os";

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
  private pendingProjects: { path: string; name: string }[] = [];
  
  private static readonly CONFIG_FILE = path.join(
    process.env.USERPROFILE || process.env.HOME || os.tmpdir(),
    ".weapp-dev-mcp-config.json"
  );

  /**
   * 设置待选择项目列表（用于交互式选择）
   */
  async setPendingProjects(projects: { path: string; name: string }[]): Promise<void> {
    this.pendingProjects = projects;
    await this.savePendingProjects(projects);
  }

  /**
   * 保存待选择项目到配置文件（持久化，支持跨进程）
   */
  private async savePendingProjects(projects: { path: string; name: string }[]): Promise<void> {
    const configDir = path.dirname(WeappAutomatorManager.CONFIG_FILE);
    await fs.promises.mkdir(configDir, { recursive: true });
    const tmpPath = WeappAutomatorManager.CONFIG_FILE + ".tmp";
    const content = JSON.stringify({ 
      lastProjectPath: this.config?.projectPath || null,
      pendingProjects: projects 
    }, null, 2);
    await fs.promises.writeFile(tmpPath, content, "utf-8");
    await fs.promises.rename(tmpPath, WeappAutomatorManager.CONFIG_FILE);
  }

  /**
   * 从配置文件加载待选择项目
   */
  private async loadPendingProjects(): Promise<{ path: string; name: string }[]> {
    try {
      const exists = await fs.promises.access(WeappAutomatorManager.CONFIG_FILE).then(() => true).catch(() => false);
      if (!exists) {
        return [];
      }
      const content = await fs.promises.readFile(WeappAutomatorManager.CONFIG_FILE, "utf-8");
      const config = JSON.parse(content);
      return config.pendingProjects || [];
    } catch (error) {
      console.warn("[config] Failed to load pending projects:", error);
      return [];
    }
  }

  /**
   * 获取待选择项目列表
   */
  getPendingProjects(): { path: string; name: string }[] {
    return [...this.pendingProjects];
  }

  async consumePendingProject(selection: string): Promise<{ path: string; name: string } | null> {
    // 先从配置文件加载（支持跨进程）
    if (this.pendingProjects.length === 0) {
      this.pendingProjects = await this.loadPendingProjects();
    }
    
    const trimmed = selection.trim();
    
    // 验证编号格式（必须是纯数字）
    const index = parseInt(trimmed, 10) - 1;
    const isValidIndex = /^\d+$/.test(trimmed) && index >= 0 && index < this.pendingProjects.length;
    
    if (isValidIndex) {
      const selected = this.pendingProjects[index];
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return selected;
    }
    
    // 尝试解析路径（直接匹配）
    const byPath = this.pendingProjects.find(p => p.path === trimmed || p.name === trimmed);
    if (byPath) {
      this.pendingProjects = [];
      await this.savePendingProjects([]);
      return byPath;
    }
    
    // 失败时清空状态，避免误导
    this.pendingProjects = [];
    await this.savePendingProjects([]);
    return null;
  }
  
  /**
   * 获取错误提示信息（用于无效选择时显示）
   */
  async getSelectionHint(): Promise<string> {
    // 先从配置文件加载（支持跨进程）
    if (this.pendingProjects.length === 0) {
      this.pendingProjects = await this.loadPendingProjects();
    }
    if (this.pendingProjects.length === 0) {
      return "没有待选择的项目。请先调用 mp_listProjects 查看可用项目。";
    }
    const options = this.pendingProjects
      .map((p, i) => `  ${i + 1}. ${p.name} (${p.path})`)
      .join("\n");
    return `可用选项：\n${options}\n\n请输入编号（1-${this.pendingProjects.length}）或完整路径`;
  }

  getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  clearConsoleLogs(): void {
    this.consoleLogs = [];
  }
  
  /**
   * 保存项目路径到配置文件
   */
  private async saveProjectPath(projectPath: string): Promise<void> {
    try {
      const configDir = path.dirname(WeappAutomatorManager.CONFIG_FILE);
      await fs.promises.mkdir(configDir, { recursive: true });
      const tmpPath = WeappAutomatorManager.CONFIG_FILE + ".tmp";
      await fs.promises.writeFile(tmpPath, JSON.stringify({ lastProjectPath: projectPath }, null, 2), "utf-8");
      await fs.promises.rename(tmpPath, WeappAutomatorManager.CONFIG_FILE);
    } catch (error) {
      console.warn("[config] Failed to save project path:", error);
    }
  }
  
  private async loadProjectPath(): Promise<string | null> {
    try {
      const exists = await fs.promises.access(WeappAutomatorManager.CONFIG_FILE).then(() => true).catch(() => false);
      if (!exists) {
        return null;
      }
      const content = await fs.promises.readFile(WeappAutomatorManager.CONFIG_FILE, "utf-8");
      const config = JSON.parse(content);
      return config.lastProjectPath || null;
    } catch (error) {
      console.warn("[config] Failed to load project path:", error);
      return null;
    }
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

    // 如果是 autoLaunch 模式但没有 projectPath，尝试获取默认项目
    if (config.autoLaunch && config.mode === "connect" && !config.projectPath) {
      // 1. 先尝试获取默认项目（mp_setDefaultProject 设置的）
      const defaultProject = await this.getDefaultProject();
      if (defaultProject) {
        log.info(`使用默认项目: ${defaultProject}`);
        config.projectPath = defaultProject;
      } else {
        // 2. 没有默认项目，列出最近项目让用户选择
        const projects = await this.listRecentProjects();
        
        // 关键：保存待选择项目，供后续 projectSelection 消费
        await this.setPendingProjects(projects);
        
        // 使用标准化的 Response Tags 格式返回
        const response = this.formatProjectSelectionResponse(projects, defaultProject);
        throw new UserError(response);
      }
    }

    if (reconnect) {
      await this.close(log);
    }

    const isAlive = await this.isConnectionAlive();
    const canReuse =
      this.miniProgram && this.config && isSameConfig(this.config, config) && isAlive;
    if (!canReuse) {
      await this.close(log);
      log.info("Establishing WeChat DevTools automation session", {
        mode: config.mode,
        projectPath: config.projectPath,
        wsEndpoint: config.wsEndpoint,
        port: config.port,
      });
      try {
        if (config.mode === "connect") {
          let needNewConnection = true;
          
          if (config.autoLaunch) {
            const isPortOpen = await this.isPortInUse(config.port ?? 9420);
            
            if (isPortOpen) {
              log.info("DevTools is already running, connecting directly...");
              
              const isAlive = await this.isConnectionAlive();
              const canReuse = this.miniProgram && this.config && isSameConfig(this.config, config) && isAlive;
              
              if (canReuse) {
                log.info("Reusing existing connection");
                needNewConnection = false;
              }
            } else {
              log.info("DevTools not detected, auto launching...");
              
              let projectPath = config.projectPath || process.cwd();
              const isValidProject = await this.isValidWeappProject(projectPath);
              
              if (!isValidProject) {
                projectPath = "";
                log.info("Current directory is not a valid weapp project, will open project selector...");
              }
              
              const resolvedConfig = {
                ...config,
                projectPath: projectPath || undefined,
              };
              await this.launchDevTools(resolvedConfig, log);
              
              const launchTimeout = config.launchTimeout ?? 45000;
              log.info(`Waiting ${launchTimeout}ms for DevTools to be ready...`);
              await new Promise(resolve => setTimeout(resolve, launchTimeout));
            }
          }
          
          if (needNewConnection) {
            const timeoutMs = config.connectTimeout ?? 45000;
            log.info(`Connecting with ${timeoutMs}ms timeout...`);
            this.miniProgram = await this.connectWithTimeout(config, timeoutMs);
          }
        } else {
          this.miniProgram = await this.connect(config);
        }
        this.config = config;
        if (!this.miniProgram) {
          throw new Error('MiniProgram not initialized');
        }
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

  /**
   * 带超时控制的 WebSocket 连接
   */
  private async connectWithTimeout(
    config: WeappConnectionConfig,
    timeoutMs: number = 15000
  ): Promise<MiniProgramInstance> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<MiniProgramInstance>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Connection timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = await Promise.race([
        automator.connect({ wsEndpoint: config.wsEndpoint! }),
        timeoutPromise
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (e) {
      if (timer) clearTimeout(timer);
      throw e;
    }
  }

  /**
   * 验证连接是否真的可用
   */
  private async isConnectionAlive(): Promise<boolean> {
    try {
      if (!this.miniProgram) return false;
      let timer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      });

      try {
        const page = await Promise.race([
          this.miniProgram.currentPage(),
          timeoutPromise
        ]);
        if (timer) clearTimeout(timer);
        return page !== null && page !== undefined;
      } catch (e) {
        if (timer) clearTimeout(timer);
        throw e;
      }
    } catch {
      return false;
    }
  }

  private async connect(
    config: WeappConnectionConfig
  ): Promise<MiniProgramInstance> {
    if (config.mode === "connect") {
      if (config.autoLaunch) {
        const log = {
          debug: (msg: string) => console.debug("[autoLaunch]", msg),
          info: (msg: string) => console.info("[autoLaunch]", msg),
          warn: (msg: string) => console.warn("[autoLaunch]", msg),
          error: (msg: string) => console.error("[autoLaunch]", msg),
        };

        // 先检测端口是否有服务，避免重复启动
        const isPortOpen = await this.isPortInUse(config.port ?? 9420);
        
        if (isPortOpen) {
          log.info("DevTools is already running, connecting directly...");
        } else {
          log.info("DevTools not detected, auto launching...");
          
          // 解析项目路径：如果配置有就用配置的，否则用 cwd
          let projectPath = config.projectPath || process.cwd();
          
          // 检查是否是有效的小程序项目目录
          const isValidProject = await this.isValidWeappProject(projectPath);
          
          if (!isValidProject) {
            // 如果不是有效项目目录，projectPath 设为 undefined
            // 这样 CLI 会打开项目选择器让用户选择
            projectPath = "";
            log.info("Current directory is not a valid weapp project, will open project selector...");
          }
          
          const resolvedConfig = {
            ...config,
            projectPath: projectPath || undefined,
          };
          await this.launchDevTools(resolvedConfig, log);
          
          const launchTimeout = config.launchTimeout ?? 30000;
          log.info(`Waiting ${launchTimeout}ms for DevTools to be ready...`);
          await new Promise(resolve => setTimeout(resolve, launchTimeout));
        }
        
        log.info(`Connecting to websocket: ${config.wsEndpoint}`);
      }
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

  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = new net.Server();
      
      server.once("error", () => {
        resolve(true);
      });
      
      server.once("listening", () => {
        server.close();
        resolve(false);
      });
      
      server.listen(port, "127.0.0.1");
    });
  }

  private async isValidWeappProject(projectPath: string): Promise<boolean> {
    const configPath = path.join(projectPath, "project.config.json");
    
    try {
      await fs.promises.access(configPath, fs.constants.F_OK);
      const content = await fs.promises.readFile(configPath, "utf-8");
      const config = JSON.parse(content);
      return !!(config.appid || config.projectname);
    } catch {
      return false;
    }
  }
  
  /**
   * 从 WeappLocalData/*.json 读取项目（PRD要求的新路径）
   * 支持 Windows 和 macOS 平台
   */
  private async listProjectsFromWeappLocalData(): Promise<{ path: string; name: string }[]> {
    const projects: { path: string; name: string }[] = [];
    
    // 定位 WeappLocalData 目录的父目录
    let userDataBasePath: string;
    
    if (process.platform === 'darwin') {
      // macOS 路径1: ~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/
      // macOS 路径2: ~/Library/Application Support/微信开发者工具/
      const macOSPath1 = path.join(
        os.homedir(),
        "Library",
        "Containers",
        "com.tencent.xinWeChat",
        "Data",
        "Library",
        "Application Support",
        "com.tencent.xinWeChat"
      );
      const macOSPath2 = path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "微信开发者工具"
      );
      
      // 优先使用路径1，不存在则尝试路径2
      try {
        await fs.promises.access(macOSPath1);
        userDataBasePath = macOSPath1;
      } catch {
        userDataBasePath = macOSPath2;
      }
      console.log(`[MpListProjects] macOS 平台，使用路径: ${userDataBasePath}`);
    } else {
      // Windows: C:\Users\{username}\AppData\Local\微信开发者工具\User Data
      userDataBasePath = path.join(
        os.homedir(),
        "AppData",
        "Local",
        "微信开发者工具",
        "User Data"
      );
      console.log(`[MpListProjects] Windows 平台，使用路径: ${userDataBasePath}`);
    }
    
    // 查找所有 hash 子目录（可能有多个）
    const weappLocalDataPaths: string[] = [];
    try {
      const entries = await fs.promises.readdir(userDataBasePath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)) {
          weappLocalDataPaths.push(path.join(userDataBasePath, entry.name, "WeappLocalData"));
        }
      }
    } catch (error) {
      console.warn(`[MpListProjects] 读取 User Data 目录失败: ${(error as Error).message}`);
    }
    
    // 遍历所有 WeappLocalData 目录收集项目
    for (const weappLocalDataPath of weappLocalDataPaths) {
      try {
        const files = await fs.promises.readdir(weappLocalDataPath);
        const localStorageFiles = files.filter(f => f.startsWith('localstorage_') && f.endsWith('.json'));
        
        for (const file of localStorageFiles) {
          try {
            const filePath = path.join(weappLocalDataPath, file);
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);
            
            // 遍历 JSON 对象，查找项目信息
            for (const [key, value] of Object.entries(data)) {
              // 跳过明显不是项目路径的键（如数字时间戳）
              if (/^\d+$/.test(key)) continue;
              
              const projectInfo = value as any;
              if (projectInfo && (projectInfo.projectPath || projectInfo.projectName)) {
                const projectPath = projectInfo.projectPath || key;
                const projectName = projectInfo.projectName || projectInfo.appName || path.basename(projectPath);
                
                // 验证项目有效性
                if (await this.isValidWeappProject(projectPath)) {
                  if (!projects.find(p => p.path === projectPath)) {
                    projects.push({ path: projectPath, name: projectName });
                  }
                }
              }
            }
          } catch (error) {
            console.warn(`[MpListProjects] 解析 localstorage 文件失败: ${file}, error: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        console.warn(`[MpListProjects] 读取 WeappLocalData 目录失败: ${weappLocalDataPath}, error: ${(error as Error).message}`);
      }
    }
    
    return projects;
  }

  /**
   * 获取微信开发者工具的最近项目列表
   * 优先从 WeappLocalData/*.json 读取（PRD要求）
   * Fallback 到原有扫描逻辑
   */
  async listRecentProjects(): Promise<{ path: string; name: string }[]> {
    // 1. 尝试从 WeappLocalData 读取
    const weappLocalDataProjects = await this.listProjectsFromWeappLocalData();
    if (weappLocalDataProjects.length > 0) {
      return weappLocalDataProjects.slice(0, 10);
    }
    
    // 2. Fallback 到原有逻辑
    const projects: { path: string; name: string }[] = [];
    const startTime = Date.now();
    const SCAN_TIMEOUT_MS = 5000;
    const MAX_DEPTH = 2;
    
    const isTimeout = () => Date.now() - startTime > SCAN_TIMEOUT_MS;
    
    const scanDir = async (dir: string, depth = 0): Promise<void> => {
      if (depth > MAX_DEPTH || isTimeout()) return;
      
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (isTimeout()) return;
          if (entry.isDirectory()) {
            const fullPath = path.join(dir, entry.name);
            const isValid = await this.isValidWeappProject(fullPath);
            if (isValid) {
              if (!projects.find(p => p.path === fullPath)) {
                projects.push({ path: fullPath, name: entry.name });
              }
            } else if (depth < MAX_DEPTH) {
              await scanDir(fullPath, depth + 1);
            }
          }
        }
      } catch {
        // 忽略权限错误
      }
    };
    
    // 微信开发者工具的用户数据目录
    const userDataPath = path.join(
      os.homedir(),
      "AppData",
      "Local",
      "微信开发者工具",
      "User Data"
    );
    
    let userDataDir = userDataPath;
    try {
      const exists = await fs.promises.access(userDataPath).then(() => true).catch(() => false);
      if (!exists) {
        // 尝试 fallback 方式
        userDataDir = userDataPath;
      } else {
        const entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && /^[a-f0-9]{32}$/i.test(entry.name)) {
            userDataDir = path.join(userDataPath, entry.name);
            break;
          }
        }
      }
    } catch {
      // 忽略错误
    }
    
    const possiblePaths = [
      path.join(userDataDir, "Default", "Local Storage", "weapp-devtools-state"),
      path.join(userDataDir, "weapp-devtools-state"),
      path.join(userDataDir, "Default", "Preferences"),
    ];
    
    for (const statePath of possiblePaths) {
      if (isTimeout()) break;
      try {
        const exists = await fs.promises.access(statePath).then(() => true).catch(() => false);
        if (exists) {
          const content = await fs.promises.readFile(statePath, "utf-8");
          const data = JSON.parse(content);
          
          if (data.recentProjects || data.recent || data.projects) {
            const recentList = data.recentProjects || data.recent || data.projects;
            if (Array.isArray(recentList)) {
              for (const item of recentList) {
                if (isTimeout()) break;
                const projectPath = item.path || item.projectPath || item;
                const projectName = item.name || item.projectName || path.basename(projectPath);
                
                if (projectPath) {
                  const isValid = await this.isValidWeappProject(projectPath);
                  if (isValid && !projects.find(p => p.path === projectPath)) {
                    projects.push({ path: projectPath, name: projectName });
                  }
                }
              }
            }
          }
        }
      } catch {
        // 继续尝试下一个路径
      }
    }
    
    if (projects.length === 0 && !isTimeout()) {
      const commonDirs = [
        path.join(os.homedir(), "Documents", "WeChatProjects"),
        path.join(os.homedir(), "Desktop"),
      ];
      
      for (const dir of commonDirs) {
        if (isTimeout()) break;
        try {
          await scanDir(dir, 0);
        } catch {
          // 忽略错误
        }
      }
    }
    
    return projects.slice(0, 10);
  }
  
  /**
   * 获取默认项目路径
   */
  async getDefaultProject(): Promise<string | null> {
    return this.loadProjectPath();
  }
  
  /**
   * 设置默认项目路径
   */
  async setDefaultProject(projectPath: string): Promise<boolean> {
    if (!(await this.isValidWeappProject(projectPath))) {
      return false;
    }
    await this.saveProjectPath(projectPath);
    return true;
  }

  /**
   * 格式化项目选择响应（标准化 Response Tags 格式）
   */
  private formatProjectSelectionResponse(
    projects: { path: string; name: string }[],
    defaultProject?: string | null
  ): string {
    // Case 1: 只有一个项目
    if (projects.length === 1) {
      return `[ONLY_ONE_PROJECT]
检测到您的小程序项目列表只有一个：

📁 ${projects[0].name}
   ${projects[0].path}

请选择操作：
A. 使用该项目
B. 重新选择其他项目
C. 输入新项目路径`;
    }

    // Case 2: 有默认项目配置
    if (defaultProject) {
      return `[DEFAULT_PROJECT_CONFIGURED]
您已配置默认项目：
📁 ${path.basename(defaultProject)}
   ${defaultProject}

请选择操作：
A. 使用默认项目（继续）
B. 重新选择项目（从列表选）
C. 输入新项目路径`;
    }

    // Case 3: 多个项目需要选择
    if (projects.length > 1) {
      const projectList = projects.map((p, i) => `${i + 1}|${p.name}|${p.path}`).join("\n");
      return `[SELECTION_REQUIRED]
请选择小程序项目：

${projectList}

请输入编号（如：1）或项目完整路径：`;
    }

    // Case 4: 空列表
    return `[PROJECT_LIST_EMPTY]
未检测到小程序项目。

可能的原因：
• 微信开发者工具尚未打开过任何项目
• 新安装的开发者工具

请选择操作：
A. 我已打开开发者工具（重新检测）
B. 帮我打开开发者工具
C. 直接输入项目路径`;
  }

  private async launchDevTools(config: WeappConnectionConfig, log: { info: (msg: string) => void; warn: (msg: string) => void }): Promise<void> {
    if (!config.cliPath) {
      log.warn("cliPath not configured, cannot auto launch DevTools");
      return;
    }
    if (!config.projectPath) {
      log.warn("projectPath not configured, cannot auto launch DevTools");
      return;
    }

    const { spawn } = await import("child_process");
    
    // Windows 上执行 bat 文件需要用 cmd /c
    const isWindows = process.platform === "win32";
    // auto 命令使用 --auto-port 指定自动化端口
    const batFileArgs = [
      "auto",
      "--project", config.projectPath,
      "--auto-port", String(config.port ?? 9420),
    ];
    
    if (config.account) {
      batFileArgs.push("--auto-account", config.account);
    }
    if (config.ticket) {
      batFileArgs.push("--ticket", config.ticket);
    }
    if (config.trustProject) {
      batFileArgs.push("--trust-project");
    }
    if (config.args) {
      batFileArgs.push(...config.args);
    }
    
    // Windows 上使用 cmd /c 执行 bat 文件
    const command = isWindows ? "cmd.exe" : config.cliPath;
    const commandArgs = isWindows ? ["/c", config.cliPath, ...batFileArgs] : [config.cliPath, ...batFileArgs];
    
    log.info(`Launching: ${isWindows ? `cmd.exe /c ${config.cliPath}` : config.cliPath} ${batFileArgs.join(" ")}`);
    
    const proc = spawn(command, commandArgs, {
      cwd: config.cwd,
      detached: true,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    });
    
    // 监听错误事件以便调试
    proc.on("error", (err) => {
      log.warn(`Failed to launch DevTools: ${err.message}`);
    });
    
    proc.unref();
    
    log.info(`DevTools launched with PID: ${proc.pid}`);
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
