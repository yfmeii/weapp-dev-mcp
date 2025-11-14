# 微信小程序 MCP 服务器

基于 FastMCP 的服务器，通过 [`miniprogram-automator`](https://www.npmjs.com/package/miniprogram-automator) 自动化微信开发者工具。该服务器提供 MCP 工具，让 AI 助手能够导航、检查和操作小程序页面——类似于 `playwright-mcp`，但专为微信生态系统定制。

## 前置要求

- 已安装微信开发者工具，支持命令行访问（`cli` / `cli.bat`）
- 本地已安装 Node.js 18+ 和 `npm`
- 有可以在开发者工具中打开的小程序项目

## MCP 客户端集成

### 配置

要在 Claude Desktop 或其他 MCP 客户端中使用此服务器，请在配置文件中添加：


> ```json
> {
>   "mcpServers": {
>     "weapp-dev": {
>       "command": "npx",
>       "args": ["@yfme/weapp-dev-mcp"],
>       "env": {
>         "WEAPP_WS_ENDPOINT": "ws://localhost:9420"
>       }
>     }
>   }
> }
> ```

### 启动微信开发者工具

在使用 MCP 服务器之前，需要先启动微信开发者工具并开启 WebSocket 服务。

💡 在开始之前：
1. 打开微信开发者工具
2. 进入 **设置 → 安全设置 → 服务端口**
3. 开启 **"HTTP 调试"** 和 **"自动化测试"**

**使用命令行启动**

使用命令行启动微信开发者工具并自动开启 WebSocket 服务：

**macOS/Linux：**
```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project /path/to/your/project --auto-port 9420
```

**Windows：**
```cmd
"C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat" auto --project C:\path\to\your\project --auto-port 9420
```

其中：
- `--project` 参数指定小程序项目目录路径（请替换为实际的项目路径）
- `--auto-port` 参数指定 WebSocket 服务端口（默认 9420）


**⚠️ 警告**
由于沙箱机制，部分客户端不允许 MCP 访问项目目录以外的微信开发者工具的 cli，所以这里只介绍了使用 WebSocket 服务


### 环境变量配置

通过环境变量控制自动化工具如何连接到微信开发者工具：

| 变量 | 说明 |
| --- | --- |
| `WEAPP_WS_ENDPOINT` | **【推荐】** 已运行的开发者工具 WebSocket 端点。设置后，服务器使用 `connect` 模式而不是启动新实例。示例：`ws://localhost:9420` |
| `WECHAT_DEVTOOLS_CLI_PATH` | 微信开发者工具 CLI 路径（如果默认路径有效则可选）。 |
| `WEAPP_AUTOMATOR_MODE` | 强制使用 `launch` 或 `connect` 模式。除非提供了 `WEAPP_WS_ENDPOINT`，否则默认为 `launch`。 |
| `WEAPP_DEVTOOLS_PORT` | 启动开发者工具时的首选端口（回退到可用端口）。 |
| `WEAPP_DEVTOOLS_TIMEOUT` | 启动超时时间（毫秒，默认 30000）。 |
| `WEAPP_AUTO_ACCOUNT` | 传递给 `--auto-account` 用于自动登录。 |
| `WEAPP_DEVTOOLS_TICKET` | 启动时传递给 `--ticket`。 |
| `WEAPP_TRUST_PROJECT` | 设置为 `true` 以在启动时包含 `--trust-project`。 |
| `WEAPP_DEVTOOLS_ARGS` | 启动时的额外 CLI 参数（空格分隔）。 |
| `WEAPP_DEVTOOLS_CWD` | 传递给开发者工具进程的工作目录。 |
| `WEAPP_AUTOCLOSE` | 设置为 `true` 时，每次工具调用后关闭开发者工具会话。 |

> **注意：** 当启动开发者工具（`launch` 模式）时，必须通过 MCP 工具参数提供小程序项目目录：在执行操作前通过 `connection.projectPath` 提供（例如通过 `mp_ensureConnection`）。该值一旦建立，将在后续调用中持久化。

工具调用可以通过 `connection` 对象覆盖这些默认值中的大部分。

## 可用工具

### 应用工具（Application Tools）

- `mp_ensureConnection` – 确保自动化会话就绪；可选择强制重连或覆盖连接设置
- `mp_navigate` – 在小程序内导航，支持 `navigateTo`、`redirectTo`、`reLaunch`、`switchTab` 或 `navigateBack`
- `mp_screenshot` – 捕获屏幕截图并返回（或保存到磁盘）
- `mp_callWx` – 调用微信小程序 API 方法（如 `wx.showToast`）
- `mp_getLogs` – 获取小程序控制台日志，可选择获取后清除

### 页面工具（Page Tools）

- `page_getElement` – 通过选择器获取页面元素
- `page_waitElement` – 等待元素出现在页面上（⚠️ 不适用于自定义组件内部元素）
- `page_waitTimeout` – 等待指定的毫秒数
- `page_getData` – 获取当前页面的数据对象，可指定路径
- `page_setData` – 使用 `setData` 更新当前页面的数据
- `page_callMethod` – 调用当前页面实例上暴露的方法

### 元素工具（Element Tools）

- `element_tap` – 通过 CSS 选择器点击 WXML 元素
- `element_input` – 向元素输入文本（适用于 `input` 和 `textarea` 组件）
- `element_callMethod` – 调用自定义组件实例的方法（需要 ID 选择器）
- `element_getData` – 获取自定义组件实例的渲染数据（需要 ID 选择器）
- `element_setData` – 设置自定义组件实例的渲染数据（需要 ID 选择器）
- `element_getInnerElement` – 获取元素内的元素（相当于 `element.$(selector)`）
- `element_getInnerElements` – 获取元素内的元素数组（相当于 `element.$$(selector)`）
- `element_getSize` – 获取元素大小（宽度和高度）
- `element_getWxml` – 获取元素 WXML（内部或外部）

每个工具都接受可选的 `connection` 块来覆盖环境默认值（项目路径、CLI 路径、WebSocket 端点等）。


## 使用技巧

### 一般提示

- 连接前，在微信开发者工具中启用自动化（`设置 → 安全设置 → 服务端口`）
- 推荐首先调用 `mp_ensureConnection` 来验证连接并查看系统/页面详情
- 使用 `WEAPP_AUTOCLOSE=true` 适合无状态的一次性交互
- **导航时始终使用绝对路径**（以 `/` 开头）：`/pages/mine/mine`
- tabBar 页面使用 `switchTab`，普通页面使用 `navigateTo`

### 操作自定义组件

**🔴 重要：必须使用 ID 选择器（如 `#my-component`）来定位自定义组件**

操作自定义组件时，有两种方法：

#### 方法一：使用 `innerSelector` 参数（推荐）

适用于 `element_tap`、`element_input`、`element_getSize`、`element_getWxml` 等工具：

```json
{
  "selector": "#my-component",
  "innerSelector": ".inner-button"
}
```

- `selector`：自定义组件的 ID 选择器
- `innerSelector`：组件内部元素的选择器

#### 方法二：使用元素内查询工具

适用于 `element_getInnerElement` 和 `element_getInnerElements`：

```json
{
  "selector": "#my-component",
  "targetSelector": ".inner-button"
}
```

#### 限制说明

- `page_waitElement` **不适用于**自定义组件内部元素。请使用 `page_waitTimeout` 配合元素查询工具进行轮询检查。
- 自定义组件操作（如 `element_callMethod`、`element_getData`、`element_setData`）要求组件具有 `id` 属性。
