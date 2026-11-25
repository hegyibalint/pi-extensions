import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let output = "";

  pi.on("before_agent_start", () => {
    output = "";
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    output = event.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  });

  pi.registerCommand("notification", {
    description: "Toggle macOS notifications: /notification on|off",
    getArgumentCompletions: (prefix) =>
      ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value !== "on" && value !== "off") {
        ctx.ui.notify(`Notifications are ${enabled ? "on" : "off"}. Usage: /notification on|off`, "info");
        return;
      }
      if (value === "on" && process.platform !== "darwin") {
        ctx.ui.notify("Notifications require macOS.", "error");
        return;
      }

      enabled = value === "on";
      ctx.ui.notify(`Notifications ${enabled ? "on" : "off"}.`, "info");
    },
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!enabled || event.aborted) return;

    const firstLine = output.split(/\r?\n/).find((line) => line.trim())?.trim() || "Ready for input";
    const characters = Array.from(firstLine);
    const body = characters.length > 160 ? characters.slice(0, 159).join("") + "…" : firstLine;
    const title = basename(ctx.cwd) || ctx.cwd;

    const result = await pi.exec("/usr/bin/osascript", [
      "-e",
      "on run argv\n  display notification (item 1 of argv) with title (item 2 of argv)\nend run",
      body,
      title,
    ], { timeout: 5000 });
    if (result.code !== 0) {
      ctx.ui.notify(`Notification failed: ${result.stderr.trim() || "osascript did not finish successfully"}`, "warning");
    }
  });
}
