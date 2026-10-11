export function disclosureId(...parts: string[]) { return `work-${parts.map(part => encodeURIComponent(part)).join("--")}`; }
export function contextLevel(tokens: number, percent: number): "ok" | "warn" | "high" | "critical" {
  if (percent >= 90 || tokens >= 500_000) return "critical";
  if (percent >= 70 || tokens >= 270_000) return "high";
  if (percent >= 50 || tokens >= 150_000) return "warn";
  return "ok";
}
export function elapsedLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  return `${seconds}s`;
}
export function tokenLabel(value: number) { return value >= 1_000_000 ? `${value / 1_000_000}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value); }
