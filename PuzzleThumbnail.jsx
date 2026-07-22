import React from "react";
import { OPPOSITE, TRACKS } from "./railbound-rules.js";

const PORTS = { N: [0.5, 0], E: [1, 0.5], S: [0.5, 1], W: [0, 0.5] };
const CAR_COLORS = ["#c45c3a", "#3a7cc4", "#8c5cbf", "#c4a43a", "#3ac4a4", "#c43a8c"];

function trackSegments(type, x, y, cell) {
  const track = TRACKS[type];
  if (!track) return [];
  const seen = new Set(), lines = [];
  for (const [from, to] of Object.entries(track)) {
    const key = [from, to].sort().join("");
    if (seen.has(key)) continue;
    seen.add(key);
    const a = PORTS[from], b = PORTS[to];
    const ax = x + a[0] * cell, ay = y + a[1] * cell;
    const bx = x + b[0] * cell, by = y + b[1] * cell;
    lines.push(OPPOSITE[from] === to
      ? <line key={key} x1={ax} y1={ay} x2={bx} y2={by} />
      : <path key={key} d={`M${ax},${ay} Q${x + cell / 2},${y + cell / 2} ${bx},${by}`} />);
  }
  return lines;
}

export default function PuzzleThumbnail({ puzzle, width = 188, height = 112 }) {
  const pad = 6;
  const cell = Math.min((width - pad * 2) / puzzle.width, (height - pad * 2) / puzzle.height);
  const boardW = cell * puzzle.width, boardH = cell * puzzle.height;
  const ox = (width - boardW) / 2, oy = (height - boardH) / 2;
  const blankSet = new Set((puzzle.blanks || []).map(([x, y]) => `${x},${y}`));
  const goalKey = Array.isArray(puzzle.goal) ? `${puzzle.goal[0]},${puzzle.goal[1]}` : null;
  const carMap = Object.fromEntries((puzzle.cars || []).map(car => [`${car.x},${car.y}`, car]));
  const tunnelMap = {};
  for (const tunnel of puzzle.tunnels || []) for (const point of tunnel.cells || []) tunnelMap[`${point.x},${point.y}`] = tunnel.color;

  return <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${puzzle.width} 乘 ${puzzle.height} 关卡缩略图`} style={{ display: "block", background: "#12100e" }}>
    <rect x={ox} y={oy} width={boardW} height={boardH} rx={3} fill="#17140f" />
    {Array.from({ length: puzzle.height }, (_, y) => Array.from({ length: puzzle.width }, (_, x) => {
      const key = `${x},${y}`, px = ox + x * cell, py = oy + y * cell;
      const isBlank = blankSet.has(key), car = carMap[key], tunnelColor = tunnelMap[key];
      return <g key={key}>
        <rect x={px + .5} y={py + .5} width={Math.max(0, cell - 1)} height={Math.max(0, cell - 1)}
          fill={key === goalKey ? "#142814" : tunnelColor ? "#21172c" : isBlank ? "#262117" : "#1b1814"}
          stroke={key === goalKey ? "#4a8a4a" : tunnelColor || (isBlank ? "#50442d" : "#2a2520")} strokeWidth={.7} />
        {puzzle.fixed?.[key] && <g fill="none" stroke="#a08a5a" strokeWidth={Math.max(1, cell * .09)} strokeLinecap="round">
          {trackSegments(puzzle.fixed[key], px, py, cell)}
        </g>}
        {key === goalKey && <circle cx={px + cell / 2} cy={py + cell / 2} r={Math.max(2, cell * .24)} fill="#3b9a4b" />}
        {tunnelColor && <circle cx={px + cell / 2} cy={py + cell / 2} r={Math.max(2, cell * .25)} fill="none" stroke={tunnelColor} strokeWidth={Math.max(1, cell * .12)} />}
        {car && <circle cx={px + cell / 2} cy={py + cell / 2} r={Math.max(2.5, cell * .29)}
          fill={car.role === "zero" || String(car.name) === "0" ? "#aeb6c2" : CAR_COLORS[(Number(car.name) - 1) % CAR_COLORS.length]} stroke="#fff" strokeWidth={.7} />}
      </g>;
    }))}
  </svg>;
}
