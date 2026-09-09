import type { IconName } from "obsidian";

export const TRAMA_ICONS = {
  trama: "network",
  filo: "route",
  voce: "message-circle",
  lente: "search",
} as const satisfies Record<"trama" | "filo" | "voce" | "lente", IconName>;
