import { OPPOSITE } from "./railbound-rules.js";

export const DEFAULT_GRID_WIDTH = 6;
export const DEFAULT_GRID_HEIGHT = 6;

export function straightTrackForDirection(direction) {
  return direction === "N" || direction === "S" ? "|" : "-";
}

export function directionGlyphDirection(tool, direction) {
  return tool === "goal" || tool === "tunnel" ? OPPOSITE[direction] : direction;
}
