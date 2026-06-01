export type WeappPrompt = {
  name: string;
  description: string;
  arguments?: {
    name: string;
    description?: string;
    required?: boolean;
    enum?: string[];
  }[];
  load: (args: Record<string, string | undefined>) => Promise<string>;
};

const connectionFlow = [
  "Use this MCP with a stable workflow.",
  "",
  "1. Call mp_ensureConnection first.",
  "2. If it succeeds, call mp_currentPage to confirm the active page.",
  "3. Only then call mp_screenshot, page_*, or element_* tools.",
  "4. If a tool says PROJECT_SELECTION_REQUIRED, call mp_listProjects or provide projectSelection to mp_ensureConnection.",
  "5. If a tool says NO_ACTIVE_SESSION, call mp_ensureConnection again instead of blindly retrying other tools.",
].join("\n");

export function createPrompts(): WeappPrompt[] {
  return [
    {
      name: "connect-and-inspect-home",
      description:
        "Connect to the mini program, confirm the current page, then inspect the home page UI.",
      arguments: [
        {
          name: "focus",
          description: "Optional UI area to inspect after connecting.",
          required: false,
        },
      ],
      load: async ({ focus }) => {
        const target = focus?.trim() ? ` Focus on: ${focus.trim()}.` : "";
        return [
          connectionFlow,
          "",
          "After connection succeeds:",
          "- Call mp_currentPage.",
          "- Call mp_screenshot.",
          "- If needed, use page_getElements/page_getElement or page_getElementsByXpath/page_getElementByXpath to inspect the UI tree.",
          `- Report the current page path and whether the requested home-page UI is visible.${target}`,
          "",
          "If connection fails twice, stop and report the exact MCP error instead of looping.",
        ].join("\n");
      },
    },
    {
      name: "recover-connection",
      description:
        "Recover a failed mini program connection using the MCP's expected retry order.",
      arguments: [
        {
          name: "lastError",
          description: "Exact error message returned by the MCP client.",
          required: false,
        },
      ],
      load: async ({ lastError }) => {
        const errorLine = lastError?.trim()
          ? `Last error: ${lastError.trim()}`
          : "Last error: unavailable";
        return [
          connectionFlow,
          "",
          errorLine,
          "",
          "Recovery order:",
          "- First call mp_ensureConnection with reconnect=true.",
          "- If the MCP asks for project selection, call mp_listProjects or retry mp_ensureConnection with projectSelection.",
          "- If the MCP reports connect mode failure, check whether WeChat DevTools automation is reachable at the configured wsEndpoint.",
          "- Do not spam mp_ensureConnection more than twice with the same arguments.",
        ].join("\n");
      },
    },
    {
      name: "connect-and-screenshot",
      description:
        "Connect first, then capture a screenshot from the active mini program page.",
      load: async () => {
        return [
          connectionFlow,
          "",
          "Workflow:",
          "- Call mp_ensureConnection.",
          "- Call mp_currentPage to confirm the active route.",
          "- Call mp_screenshot.",
          "- Report the saved screenshot path or the inline image result.",
        ].join("\n");
      },
    },
  ];
}
