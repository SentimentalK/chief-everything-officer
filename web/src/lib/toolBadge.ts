export function getToolBadgeClass(tool: string): string {
  if (tool.startsWith("resource_")) {
    return "bg-cyan-950/60 text-cyan-300 border-cyan-800/50";
  }
  switch (tool) {
    case "policy_read":
      return "bg-purple-950/60 text-purple-300 border-purple-800/50";
    case "apply_change_set":
      return "bg-amber-950/60 text-amber-300 border-amber-800/50";
    case "workspace_status":
      return "bg-sky-950/60 text-sky-300 border-sky-800/50";
    case "search_text":
      return "bg-emerald-950/60 text-emerald-300 border-emerald-800/50";
    default:
      return "bg-neutral-900 text-neutral-300 border-neutral-800";
  }
}
