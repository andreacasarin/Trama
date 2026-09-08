import type { IconName } from "obsidian";

export const TRAMA_ICONS = {
  trama: "network",
  filo: "route",
  voce: "message-circle",
} as const satisfies Record<"trama" | "filo" | "voce", IconName>;
