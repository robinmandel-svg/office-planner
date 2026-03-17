"use client";

import {
  Fragment,
  type CSSProperties,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import {
  DAYS,
  type Bench,
  type Day,
  type PlannerInput,
  type PlannerResponse,
  type Preallocation,
  type Team,
  type TeamProximityRequest,
} from "@/lib/types";

type FlexOverrides = Partial<Record<Day, number>>;
type AllocationKind = "team" | "flex" | "prealloc";

type PreallocationDraft = {
  benchId: string;
  days: Day[];
  seats: number;
  label?: string;
};

type FloorPlan = {
  id: string;
  name: string;
  imageDataUrl?: string;
};

type LayoutFile = {
  version: number;
  savedAt: string;
  floors: FloorPlan[];
  benches: Array<{
    id: string;
    floorId?: string;
    layout?: { x: number; y: number; w: number; h: number; rotation?: number };
  }>;
};

type SessionConfigFile = {
  version: number;
  savedAt: string;
  benches: Bench[];
  teams: Team[];
  preallocations: PreallocationDraft[];
  floors: FloorPlan[];
  activeScenarioId?: string;
  scenarios?: ScenarioConfigEntry[];
  settings?: {
    solverMode?: "fairness_first" | "efficiency_first";
    flexDefault?: number;
    flexOverrides?: FlexOverrides;
    benchStabilityWeight?: number;
    proximityRequests?: TeamProximityRequest[];
  };
};

type ScenarioConfigEntry = {
  id: string;
  name: string;
  benches: Bench[];
  teams: Team[];
  preallocations: PreallocationDraft[];
  floors: FloorPlan[];
  selectedFloorId?: string;
  settings?: {
    solverMode?: "fairness_first" | "efficiency_first";
    flexDefault?: number;
    flexOverrides?: FlexOverrides;
    benchStabilityWeight?: number;
    proximityRequests?: TeamProximityRequest[];
  };
};

type PlannerScenario = {
  id: string;
  name: string;
  benches: Bench[];
  teams: Team[];
  preallocations: PreallocationDraft[];
  floors: FloorPlan[];
  selectedFloorId: string;
  solverMode: "fairness_first" | "efficiency_first";
  flexDefault: number;
  flexOverrides: FlexOverrides;
  benchStabilityWeight: number;
  proximityRequests: TeamProximityRequest[];
};

type AutosaveFile = {
  version: number;
  savedAt: string;
  activeScenarioId: string;
  imageDataStripped?: boolean;
  scenarios: ScenarioConfigEntry[];
};

type DragState = {
  mode: "move" | "resize" | "rotate" | "pan";
  benchId?: string;
  pointerOffsetX: number;
  pointerOffsetY: number;
  startClientX?: number;
  startClientY?: number;
  initialOffsetX?: number;
  initialOffsetY?: number;
  initialRotation?: number;
  rotateCenterClientX?: number;
  rotateCenterClientY?: number;
  rotatePointerStartAngle?: number;
  viewScale: number;
  viewOffsetX: number;
  viewOffsetY: number;
};

type LayoutView = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

type LayoutDayView = Day | "off";

type AllocationBlock = {
  id: string;
  kind: AllocationKind;
  benchId: string;
  day: Day;
  seats: number;
  teamId?: string;
};

type ChipDragPreview = {
  label: string;
  className: string;
  style?: CSSProperties;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
};

type ProximityRequestStatus = {
  status: "met" | "unmet" | "na";
  unmetDays: Day[];
};

type ValidationIssue = {
  id: string;
  scope: "step0" | "step1" | "step2" | "step3" | "step4" | "step5" | "step6";
  level: "error" | "warning";
  message: string;
  fixCode?: string;
  fixLabel?: string;
};

const initialBenches: Bench[] = [
  { id: "F1-B1", capacity: 10, order: 1, floorId: "F1", layout: { x: 10, y: 20, w: 8, h: 5 } },
  { id: "F1-B2", capacity: 10, order: 2, floorId: "F1", layout: { x: 22, y: 20, w: 8, h: 5 } },
  { id: "F1-B3", capacity: 10, order: 3, floorId: "F1", layout: { x: 34, y: 20, w: 8, h: 5 } },
  { id: "F1-B4", capacity: 8, order: 4, floorId: "F1", layout: { x: 46, y: 20, w: 8, h: 5 } },
];

const initialFloors: FloorPlan[] = [{ id: "F1", name: "Floor 1" }];

const initialTeams: Team[] = [
  {
    id: "Engineering",
    floorId: "F1",
    size: 12,
    targetDays: 3,
    preferredDays: ["Tue", "Wed", "Thu"],
    contiguousDaysRequired: false,
    anchorBenchId: "F1-B1",
    anchorSeats: 2,
  },
  {
    id: "Sales",
    floorId: "F1",
    size: 8,
    targetDays: 3,
    preferredDays: ["Tue", "Thu"],
    contiguousDaysRequired: false,
    anchorBenchId: "",
    anchorSeats: 0,
  },
  {
    id: "Design",
    floorId: "F1",
    size: 6,
    targetDays: 2,
    preferredDays: ["Mon", "Wed"],
    contiguousDaysRequired: false,
    anchorBenchId: "",
    anchorSeats: 0,
  },
  {
    id: "Finance",
    floorId: "F1",
    size: 5,
    targetDays: 2,
    preferredDays: ["Mon", "Fri"],
    contiguousDaysRequired: false,
    anchorBenchId: "F1-B3",
    anchorSeats: 1,
  },
];

const initialPreallocations: PreallocationDraft[] = [
  { benchId: "F1-B1", days: ["Mon"], seats: 2, label: "HR" },
  { benchId: "F1-B1", days: ["Tue"], seats: 1, label: "Assistant" },
  { benchId: "F1-B2", days: ["Wed", "Thu", "Fri"], seats: 1, label: "Handicap" },
];

const initialProximityRequests: TeamProximityRequest[] = [
  { teamA: "Engineering", teamB: "Design", floorId: "F1", strength: 3, strict: false, days: [...DAYS] },
];

const AUTOSAVE_KEY = "office-planner-ui.autosave.v1";
const OUTPUT_SCOPE_ALL = "__ALL_FLOORS__";

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      row.push(field.trim());
      field = "";
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  return rows;
}

function dayFromString(value: string): Day | null {
  return DAYS.includes(value as Day) ? (value as Day) : null;
}

function normalizeFloorId(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : fallback;
}

function resolveTeamFloorId(
  team: Pick<Team, "floorId" | "anchorBenchId">,
  benchFloorById: Map<string, string>,
  fallbackFloorId: string,
): string {
  const explicitFloorId = normalizeFloorId(team.floorId, "");
  if (explicitFloorId) {
    return explicitFloorId;
  }
  const anchorBenchId = (team.anchorBenchId ?? "").trim();
  if (anchorBenchId.length > 0) {
    const anchorFloorId = benchFloorById.get(anchorBenchId);
    if (anchorFloorId) {
      return anchorFloorId;
    }
  }
  return fallbackFloorId;
}

function ensureFloorQualifiedBenchId(rawId: string, floorId: string): string {
  const normalizedFloorId = normalizeFloorId(floorId, "F1");
  const compactId = rawId.trim().replace(/\s+/g, "_");
  if (!compactId) {
    return `${normalizedFloorId}-B`;
  }
  const expectedPrefix = `${normalizedFloorId}-`;
  if (compactId.toUpperCase().startsWith(expectedPrefix.toUpperCase())) {
    return compactId;
  }
  return `${expectedPrefix}${compactId}`;
}

function uniqueBenchId(candidateId: string, usedIds: Set<string>): string {
  let nextId = candidateId;
  let suffix = 2;
  while (usedIds.has(nextId)) {
    nextId = `${candidateId}_${suffix}`;
    suffix += 1;
  }
  return nextId;
}

function parsePreferredDays(value: string): Day[] {
  return value
    .split(";")
    .map((part) => dayFromString(part.trim()))
    .filter((day): day is Day => day !== null);
}

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "y";
}

function isTextEntryElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toUpperCase();
  return target.isContentEditable || tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function defaultLayoutForIndex(index: number) {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return { x: 8 + col * 20, y: 18 + row * 14, w: 8, h: 5, rotation: 0 };
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return Math.round(wrapped);
}

function angleFromCenter(clientX: number, clientY: number, centerX: number, centerY: number): number {
  return (Math.atan2(clientY - centerY, clientX - centerX) * 180) / Math.PI;
}

function benchCenterPoint(bench: Bench, fallbackIndex: number): { x: number; y: number; floorId: string } {
  if (bench.layout) {
    return {
      x: bench.layout.x + bench.layout.w / 2,
      y: bench.layout.y + bench.layout.h / 2,
      floorId: bench.floorId ?? "F1",
    };
  }
  return {
    x: fallbackIndex * 10,
    y: 50,
    floorId: bench.floorId ?? "F1",
  };
}

function benchPointDistance(
  a: { x: number; y: number; floorId: string },
  b: { x: number; y: number; floorId: string },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const base = Math.sqrt(dx * dx + dy * dy);
  return a.floorId === b.floorId ? base : base + 250;
}

function proximityScoreFromDistance(distance: number): number {
  if (distance <= 0.1) {
    return 5;
  }
  if (distance <= 20) {
    return 4;
  }
  if (distance <= 40) {
    return 3;
  }
  if (distance <= 70) {
    return 2;
  }
  return 1;
}

function toDayArray(value: unknown): Day[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => dayFromString(String(item ?? "")))
    .filter((day): day is Day => day !== null);
}

function cloneBenches(source: Bench[]): Bench[] {
  return source.map((bench) => ({
    id: bench.id,
    capacity: Number(bench.capacity),
    order: Number(bench.order),
    floorId: bench.floorId,
    layout: bench.layout
      ? {
          x: Number(bench.layout.x),
          y: Number(bench.layout.y),
          w: Number(bench.layout.w),
          h: Number(bench.layout.h),
          rotation: normalizeRotation(Number(bench.layout.rotation ?? 0)),
        }
      : undefined,
  }));
}

function cloneTeams(source: Team[]): Team[] {
  return source.map((team) => ({
    id: team.id,
    floorId: team.floorId ? String(team.floorId) : undefined,
    size: Number(team.size),
    targetDays: Number(team.targetDays),
    preferredDays: [...team.preferredDays],
    contiguousDaysRequired: !!team.contiguousDaysRequired,
    anchorBenchId: team.anchorBenchId ? String(team.anchorBenchId) : "",
    anchorSeats: Math.max(0, Number(team.anchorSeats) || 0),
  }));
}

function clonePreallocations(source: PreallocationDraft[]): PreallocationDraft[] {
  return source.map((item) => ({
    benchId: item.benchId,
    days: [...item.days],
    seats: Number(item.seats),
    label: item.label ?? "",
  }));
}

function cloneFloors(source: FloorPlan[]): FloorPlan[] {
  return source.map((floor) => ({
    id: floor.id,
    name: floor.name,
    imageDataUrl: floor.imageDataUrl,
  }));
}

function cloneProximity(source: TeamProximityRequest[]): TeamProximityRequest[] {
  return source.map((item) => ({
    teamA: item.teamA,
    teamB: item.teamB,
    floorId: item.floorId ? String(item.floorId) : undefined,
    strength: Number(item.strength),
    strict: !!item.strict,
    days: toDayArray(item.days && item.days.length > 0 ? item.days : DAYS),
  }));
}

function scenarioToConfigEntry(scenario: PlannerScenario): ScenarioConfigEntry {
  return {
    id: scenario.id,
    name: scenario.name,
    benches: cloneBenches(scenario.benches),
    teams: cloneTeams(scenario.teams),
    preallocations: clonePreallocations(scenario.preallocations),
    floors: cloneFloors(scenario.floors),
    selectedFloorId: scenario.selectedFloorId,
    settings: {
      solverMode: scenario.solverMode,
      flexDefault: scenario.flexDefault,
      flexOverrides: { ...scenario.flexOverrides },
      benchStabilityWeight: scenario.benchStabilityWeight,
      proximityRequests: cloneProximity(scenario.proximityRequests),
    },
  };
}

function createInitialScenario(): PlannerScenario {
  return {
    id: "S1",
    name: "Scenario 1",
    benches: cloneBenches(initialBenches),
    teams: cloneTeams(initialTeams),
    preallocations: clonePreallocations(initialPreallocations),
    floors: cloneFloors(initialFloors),
    selectedFloorId: initialFloors[0].id,
    solverMode: "fairness_first",
    flexDefault: 10,
    flexOverrides: {},
    benchStabilityWeight: 6,
    proximityRequests: cloneProximity(initialProximityRequests),
  };
}

function downloadJson(filename: string, data: unknown): void {
  const text = JSON.stringify(data, null, 2);
  const blob = new Blob([text], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function areDaysContiguous(days: Day[]): boolean {
  if (days.length <= 1) {
    return true;
  }
  const indexes = [...days].map((day) => DAYS.indexOf(day)).sort((a, b) => a - b);
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] !== indexes[i - 1] + 1) {
      return false;
    }
  }
  return true;
}

function flattenPreallocations(drafts: PreallocationDraft[]): Preallocation[] {
  const rows: Preallocation[] = [];
  for (const draft of drafts) {
    for (const day of draft.days) {
      rows.push({
        benchId: draft.benchId,
        day,
        seats: draft.seats,
        label: draft.label,
      });
    }
  }
  return rows;
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n");
}

function downloadCsv(filename: string, rows: string[][]): void {
  const text = toCsv(rows);
  const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

const TEAM_BASE_COLORS = [
  "#1F77B4",
  "#FF7F0E",
  "#2CA02C",
  "#D62728",
  "#9467BD",
  "#8C564B",
  "#E377C2",
  "#17BECF",
  "#BCBD22",
  "#393B79",
  "#637939",
  "#8C6D31",
  "#843C39",
  "#7B4173",
  "#3182BD",
  "#31A354",
  "#756BB1",
  "#E6550D",
  "#636363",
  "#E41A1C",
  "#377EB8",
  "#4DAF4A",
  "#984EA3",
  "#FF7F00",
  "#A65628",
  "#F781BF",
  "#999999",
  "#66C2A5",
  "#FC8D62",
  "#8DA0CB",
  "#E78AC3",
  "#A6D854",
] as const;

function hashTeam(teamId: string): number {
  let hash = 0;
  for (let i = 0; i < teamId.length; i += 1) {
    hash = (hash << 5) - hash + teamId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((x) => x + x).join("") : value;
  const n = Number.parseInt(normalized, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [
    Math.round(a[0] * (1 - t) + b[0] * t),
    Math.round(a[1] * (1 - t) + b[1] * t),
    Math.round(a[2] * (1 - t) + b[2] * t),
  ];
}

function rgbCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const [bright, dark] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (bright + 0.05) / (dark + 0.05);
}

function rgbToLab(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear);
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const xn = 0.95047;
  const yn = 1;
  const zn = 1.08883;
  const fx = x / xn > 0.008856 ? (x / xn) ** (1 / 3) : 7.787 * (x / xn) + 16 / 116;
  const fy = y / yn > 0.008856 ? (y / yn) ** (1 / 3) : 7.787 * (y / yn) + 16 / 116;
  const fz = z / zn > 0.008856 ? (z / zn) ** (1 / 3) : 7.787 * (z / zn) + 16 / 116;
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE76(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function evaluatePaletteSeparation(palette: readonly string[], teamCount: number, minDeltaE = 20) {
  const colors = Array.from({ length: teamCount }, (_, index) => palette[index % palette.length]);
  const labs = colors.map((hex) => rgbToLab(hexToRgb(hex)));
  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < labs.length; i += 1) {
    for (let j = i + 1; j < labs.length; j += 1) {
      const distance = deltaE76(labs[i], labs[j]);
      if (distance < minDistance) {
        minDistance = distance;
      }
    }
  }
  const hasEnoughDistinctSlots = teamCount <= palette.length;
  return {
    ok: hasEnoughDistinctSlots && minDistance >= minDeltaE,
    teamCount,
    paletteSize: palette.length,
    minDistance: Number.isFinite(minDistance) ? minDistance : 0,
    target: minDeltaE,
  };
}

function teamChipStyle(baseHexColor: string): CSSProperties {
  const base = hexToRgb(baseHexColor);
  const background = mixRgb(base, [255, 255, 255], 0.72);
  const darkText: [number, number, number] = [16, 42, 74];
  const lightText: [number, number, number] = [255, 255, 255];
  const textColor = contrastRatio(background, darkText) >= contrastRatio(background, lightText) ? darkText : lightText;
  return {
    backgroundColor: rgbCss(background),
    borderColor: baseHexColor,
    color: rgbCss(textColor),
  };
}

type CollapsibleSectionProps = {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
};

function CollapsibleSection({ title, description, defaultOpen = true, children, className }: CollapsibleSectionProps) {
  return (
    <details className="panel collapsible" open={defaultOpen}>
      <summary className="collapsible-summary">
        <div className="section-head">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
      </summary>
      <div className={`collapsible-body ${className ?? ""}`.trim()}>{children}</div>
    </details>
  );
}

export default function Page() {
  const [scenarios, setScenarios] = useState<PlannerScenario[]>(() => [createInitialScenario()]);
  const [activeScenarioId, setActiveScenarioId] = useState<string>("S1");
  const [autosaveStatus, setAutosaveStatus] = useState<string>("Draft not saved yet.");
  const [autosaveReady, setAutosaveReady] = useState<boolean>(false);
  const [benches, setBenches] = useState<Bench[]>(initialBenches);
  const [teams, setTeams] = useState<Team[]>(initialTeams);
  const [preallocations, setPreallocations] = useState<PreallocationDraft[]>(initialPreallocations);
  const [proximityRequests, setProximityRequests] = useState<TeamProximityRequest[]>(initialProximityRequests);
  const [floors, setFloors] = useState<FloorPlan[]>(initialFloors);
  const [selectedFloorId, setSelectedFloorId] = useState<string>(initialFloors[0].id);
  const [resultFloorScopeId, setResultFloorScopeId] = useState<string>(initialFloors[0].id);
  const [layoutDrag, setLayoutDrag] = useState<DragState | null>(null);
  const [layoutView, setLayoutView] = useState<LayoutView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [layoutDayView, setLayoutDayView] = useState<LayoutDayView>("off");
  const [showHeatmap, setShowHeatmap] = useState<boolean>(false);
  const [selectedBenchId, setSelectedBenchId] = useState<string | null>(null);
  const [flexDefault, setFlexDefault] = useState<number>(10);
  const [benchStabilityWeight, setBenchStabilityWeight] = useState<number>(6);
  const [flexOverrides, setFlexOverrides] = useState<FlexOverrides>({});
  const [solverMode, setSolverMode] = useState<"fairness_first" | "efficiency_first">("fairness_first");
  const [result, setResult] = useState<PlannerResponse | null>(null);
  const [manualAllocations, setManualAllocations] = useState<AllocationBlock[]>([]);
  const [baselineAllocations, setBaselineAllocations] = useState<AllocationBlock[]>([]);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [selectedAllocationId, setSelectedAllocationId] = useState<string | null>(null);
  const [importFeedback, setImportFeedback] = useState<{ benches: string; teams: string; preallocations: string; config: string }>({
    benches: "",
    teams: "",
    preallocations: "",
    config: "",
  });
  const [manualError, setManualError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState<string>("");
  const [chipDragPreview, setChipDragPreview] = useState<ChipDragPreview | null>(null);
  const layoutCanvasRef = useRef<HTMLDivElement | null>(null);
  const transparentDragImageRef = useRef<HTMLImageElement | null>(null);

  const benchesByOrder = useMemo(() => [...benches].sort((a, b) => a.order - b.order), [benches]);
  const benchFloorById = useMemo(() => {
    const map = new Map<string, string>();
    benches.forEach((bench) => {
      map.set(bench.id, normalizeFloorId(bench.floorId, "F1"));
    });
    return map;
  }, [benches]);
  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0] ?? null,
    [activeScenarioId, scenarios],
  );
  const selectedFloor = useMemo(
    () => floors.find((floor) => floor.id === selectedFloorId) ?? floors[0],
    [floors, selectedFloorId],
  );
  const selectedFloorKey = selectedFloor?.id ?? selectedFloorId ?? floors[0]?.id ?? "F1";
  const floorNameById = useMemo(() => {
    const map = new Map<string, string>();
    floors.forEach((floor) => {
      map.set(floor.id, floor.name);
    });
    return map;
  }, [floors]);
  const allKnownFloorIds = useMemo(() => {
    const ids = new Set<string>(floors.map((floor) => floor.id));
    benches.forEach((bench) => {
      ids.add(normalizeFloorId(bench.floorId, "F1"));
    });
    teams.forEach((team) => {
      ids.add(normalizeFloorId(team.floorId, "F1"));
    });
    return [...ids].filter((floorId) => floorId.length > 0).sort((a, b) => a.localeCompare(b));
  }, [benches, floors, teams]);
  const normalizedResultFloorScopeId = useMemo(() => {
    if (resultFloorScopeId === OUTPUT_SCOPE_ALL) {
      return OUTPUT_SCOPE_ALL;
    }
    if (allKnownFloorIds.includes(resultFloorScopeId)) {
      return resultFloorScopeId;
    }
    return selectedFloorKey;
  }, [allKnownFloorIds, resultFloorScopeId, selectedFloorKey]);
  const resultScopeFloorIds = useMemo(
    () =>
      normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL
        ? new Set(allKnownFloorIds)
        : new Set([normalizedResultFloorScopeId]),
    [allKnownFloorIds, normalizedResultFloorScopeId],
  );
  const resultScopeLabel =
    normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL
      ? "All floors"
      : floorNameById.get(normalizedResultFloorScopeId) ?? normalizedResultFloorScopeId;
  const resultScopeFileSuffix =
    normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? "all_floors" : normalizedResultFloorScopeId.toLowerCase();
  const benchesOnSelectedFloor = useMemo(
    () => benchesByOrder.filter((bench) => normalizeFloorId(bench.floorId, selectedFloorKey) === selectedFloorKey),
    [benchesByOrder, selectedFloorKey],
  );
  const benchesInResultScope = useMemo(
    () =>
      benchesByOrder.filter((bench) => resultScopeFloorIds.has(normalizeFloorId(bench.floorId, selectedFloorKey))),
    [benchesByOrder, resultScopeFloorIds, selectedFloorKey],
  );
  const benchIdsInResultScope = useMemo(() => new Set(benchesInResultScope.map((bench) => bench.id)), [benchesInResultScope]);
  const benchesOnSelectedFloorWithIndex = useMemo(
    () =>
      benches
        .map((bench, index) => ({ bench, index }))
        .filter(({ bench }) => normalizeFloorId(bench.floorId, selectedFloorKey) === selectedFloorKey),
    [benches, selectedFloorKey],
  );
  const selectedBenchOnFloor = useMemo(
    () => benchesOnSelectedFloor.find((bench) => bench.id === selectedBenchId) ?? null,
    [benchesOnSelectedFloor, selectedBenchId],
  );
  const teamFloorById = useMemo(() => {
    const map = new Map<string, string>();
    teams.forEach((team) => {
      map.set(team.id, resolveTeamFloorId(team, benchFloorById, selectedFloorKey));
    });
    return map;
  }, [benchFloorById, selectedFloorKey, teams]);
  const teamsInResultScope = useMemo(
    () =>
      teams.filter((team) =>
        resultScopeFloorIds.has(resolveTeamFloorId(team, benchFloorById, floors[0]?.id ?? selectedFloorKey)),
      ),
    [benchFloorById, floors, resultScopeFloorIds, selectedFloorKey, teams],
  );
  const teamIdsInResultScope = useMemo(
    () => new Set(teamsInResultScope.map((team) => team.id)),
    [teamsInResultScope],
  );
  const teamsOnSelectedFloorWithIndex = useMemo(
    () =>
      teams
        .map((team, index) => ({ team, index }))
        .filter(({ team }) => resolveTeamFloorId(team, benchFloorById, selectedFloorKey) === selectedFloorKey),
    [benchFloorById, selectedFloorKey, teams],
  );
  const teamOptionsOnSelectedFloor = useMemo(
    () =>
      teamsOnSelectedFloorWithIndex
        .map(({ team }) => team.id.trim())
        .filter((teamId, index, all) => teamId.length > 0 && all.indexOf(teamId) === index)
        .sort((a, b) => a.localeCompare(b)),
    [teamsOnSelectedFloorWithIndex],
  );
  const proximityRequestsOnSelectedFloorWithIndex = useMemo(
    () =>
      proximityRequests
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => {
          const requestFloorId =
            normalizeFloorId(item.floorId, "") ||
            teamFloorById.get(item.teamA) ||
            teamFloorById.get(item.teamB) ||
            selectedFloorKey;
          return requestFloorId === selectedFloorKey;
        }),
    [proximityRequests, selectedFloorKey, teamFloorById],
  );
  const teamOptions = useMemo(
    () =>
      teams
        .map((team) => team.id.trim())
        .filter((teamId, index, all) => teamId.length > 0 && all.indexOf(teamId) === index)
        .sort((a, b) => a.localeCompare(b)),
    [teams],
  );
  const teamColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    teamOptions.forEach((teamId, index) => {
      map[teamId] = TEAM_BASE_COLORS[index % TEAM_BASE_COLORS.length];
    });
    return map;
  }, [teamOptions]);
  const paletteAudit = useMemo(
    () => evaluatePaletteSeparation(TEAM_BASE_COLORS, Math.max(30, teamOptions.length), 20),
    [teamOptions.length],
  );
  const preallocationItems = useMemo(() => flattenPreallocations(preallocations), [preallocations]);
  const benchIdsOnSelectedFloor = useMemo(() => new Set(benchesOnSelectedFloor.map((bench) => bench.id)), [benchesOnSelectedFloor]);
  const preallocationsOnSelectedFloorWithIndex = useMemo(
    () =>
      preallocations
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => benchIdsOnSelectedFloor.has(item.benchId)),
    [benchIdsOnSelectedFloor, preallocations],
  );
  const canRemoveSelectedFloor = useMemo(() => {
    if (!selectedFloor || floors.length <= 1) {
      return false;
    }
    if (benchesOnSelectedFloorWithIndex.length > 0) {
      return false;
    }
    if (teamsOnSelectedFloorWithIndex.length > 0) {
      return false;
    }
    if (proximityRequestsOnSelectedFloorWithIndex.length > 0) {
      return false;
    }
    if (preallocationsOnSelectedFloorWithIndex.length > 0) {
      return false;
    }
    return true;
  }, [
    benchesOnSelectedFloorWithIndex.length,
    floors.length,
    preallocationsOnSelectedFloorWithIndex.length,
    proximityRequestsOnSelectedFloorWithIndex.length,
    selectedFloor,
    teamsOnSelectedFloorWithIndex.length,
  ]);
  const floorConstraintRows = useMemo(() => {
    const floorIds = [...new Set([...floors.map((floor) => floor.id), ...benches.map((bench) => normalizeFloorId(bench.floorId, "F1"))])]
      .filter((floorId) => floorId.length > 0)
      .sort((a, b) => a.localeCompare(b));

    return floorIds.map((floorId) => {
      const benchesInFloor = benchesByOrder.filter((bench) => normalizeFloorId(bench.floorId, "F1") === floorId);
      const benchIdSet = new Set(benchesInFloor.map((bench) => bench.id));
      const capacitySeats = benchesInFloor.reduce((acc, bench) => acc + bench.capacity, 0);
      const preallocatedSeatDays = preallocationItems
        .filter((item) => benchIdSet.has(item.benchId))
        .reduce((acc, item) => acc + item.seats, 0);
      const teamsInFloor = teams.filter((team) => resolveTeamFloorId(team, benchFloorById, floorId) === floorId);
      const teamHeadcount = teamsInFloor.reduce((acc, team) => acc + team.size, 0);
      const demandSeatDays = teamsInFloor.reduce((acc, team) => acc + team.size * team.targetDays, 0);
      const anchoredTeams = teamsInFloor.filter((team) => (team.anchorBenchId ?? "").trim().length > 0).length;
      const proximityRows = proximityRequests.filter((request) => {
        const requestFloorId =
          normalizeFloorId(request.floorId, "") || teamFloorById.get(request.teamA) || teamFloorById.get(request.teamB) || floorId;
        return requestFloorId === floorId;
      });
      const strictProximityRows = proximityRows.filter((request) => !!request.strict).length;
      const seatDaysCapacity = capacitySeats * DAYS.length;
      const netSeatDays = Math.max(0, seatDaysCapacity - preallocatedSeatDays);
      const demandRatio = netSeatDays > 0 ? (demandSeatDays / netSeatDays) * 100 : null;
      const floorName = floors.find((floor) => floor.id === floorId)?.name ?? floorId;
      return {
        floorId,
        floorName,
        benchCount: benchesInFloor.length,
        capacitySeats,
        preallocatedSeatDays,
        teamCount: teamsInFloor.length,
        teamHeadcount,
        demandSeatDays,
        anchoredTeams,
        proximityCount: proximityRows.length,
        strictProximityRows,
        demandRatio,
      };
    });
  }, [benchFloorById, benches, benchesByOrder, floors, preallocationItems, proximityRequests, teamFloorById, teams]);
  const selectedFloorConstraints =
    floorConstraintRows.find((row) => row.floorId === selectedFloorKey) ?? floorConstraintRows[0] ?? null;

  function generateScenarioId(): string {
    return `S${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  const buildScenarioFromCurrent = useCallback(
    (id: string, name: string): PlannerScenario => ({
      id,
      name,
      benches: cloneBenches(benches),
      teams: cloneTeams(teams),
      preallocations: clonePreallocations(preallocations),
      floors: cloneFloors(floors),
      selectedFloorId: selectedFloorId || floors[0]?.id || "F1",
      solverMode,
      flexDefault: Number(flexDefault),
      flexOverrides: { ...flexOverrides },
      benchStabilityWeight: Number(benchStabilityWeight),
      proximityRequests: cloneProximity(proximityRequests),
    }),
    [
      benches,
      benchStabilityWeight,
      flexDefault,
      flexOverrides,
      floors,
      preallocations,
      proximityRequests,
      selectedFloorId,
      solverMode,
      teams,
    ],
  );

  function applyScenario(scenario: PlannerScenario): void {
    const nextSelectedFloorId = scenario.selectedFloorId || scenario.floors[0]?.id || "F1";
    setBenches(cloneBenches(scenario.benches));
    setTeams(cloneTeams(scenario.teams));
    setPreallocations(clonePreallocations(scenario.preallocations));
    setFloors(cloneFloors(scenario.floors));
    setSelectedFloorId(nextSelectedFloorId);
    setResultFloorScopeId(nextSelectedFloorId);
    setSolverMode(scenario.solverMode);
    setFlexDefault(scenario.flexDefault);
    setFlexOverrides({ ...scenario.flexOverrides });
    setBenchStabilityWeight(scenario.benchStabilityWeight);
    setProximityRequests(cloneProximity(scenario.proximityRequests));
    setLayoutView({ scale: 1, offsetX: 0, offsetY: 0 });
    setLayoutDayView("off");
    setSelectedBenchId(null);
    setSelectedTeamId(null);
    setSelectedAllocationId(null);
    setManualError(null);
    setResult(null);
    setManualAllocations([]);
    setBaselineAllocations([]);
    setError(null);
  }

  const getCanvasPercentPoint = useCallback(
    (
      clientX: number,
      clientY: number,
      view: { scale: number; offsetX: number; offsetY: number } = layoutView,
    ) => {
      const canvas = layoutCanvasRef.current;
      if (!canvas) {
        return null;
      }
      const rect = canvas.getBoundingClientRect();
      const localX = (clientX - rect.left - view.offsetX) / view.scale;
      const localY = (clientY - rect.top - view.offsetY) / view.scale;
      const x = (localX / rect.width) * 100;
      const y = (localY / rect.height) * 100;
      return { x, y, rect };
    },
    [layoutView],
  );

  useEffect(() => {
    if (!result) {
      setManualAllocations([]);
      setBaselineAllocations([]);
      setSelectedTeamId(null);
      setSelectedAllocationId(null);
      return;
    }
    const teamBlocks: AllocationBlock[] = result.primary.allocations.map((item, index) => ({
      id: `team-${index}`,
      kind: "team",
      benchId: item.benchId,
      day: item.day,
      seats: item.seats,
      teamId: item.teamId,
    }));
    const flexBlocks: AllocationBlock[] = result.primary.flexAllocations.map((item, index) => ({
      id: `flex-${index}`,
      kind: "flex",
      benchId: item.benchId,
      day: item.day,
      seats: item.seats,
    }));
    const allBlocks = [...teamBlocks, ...flexBlocks];
    setManualAllocations(allBlocks);
    setBaselineAllocations(allBlocks);
    setSelectedTeamId(null);
    setSelectedAllocationId(null);
    setManualError(null);
  }, [result]);

  useEffect(() => {
    if (!selectedAllocationId) {
      return;
    }
    if (!manualAllocations.some((item) => item.id === selectedAllocationId)) {
      setSelectedAllocationId(null);
    }
  }, [manualAllocations, selectedAllocationId]);

  useEffect(() => {
    if (!selectedAllocationId) {
      return;
    }
    if (normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL) {
      return;
    }
    const selected = manualAllocations.find((item) => item.id === selectedAllocationId);
    if (!selected) {
      return;
    }
    const selectedBenchFloorId = normalizeFloorId(benchFloorById.get(selected.benchId), "F1");
    if (selectedBenchFloorId !== selectedFloorKey) {
      setSelectedAllocationId(null);
    }
  }, [benchFloorById, manualAllocations, normalizedResultFloorScopeId, selectedAllocationId, selectedFloorKey]);

  useEffect(() => {
    if (!selectedTeamId) {
      return;
    }
    if (normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL) {
      return;
    }
    const selectedTeamFloorId = teamFloorById.get(selectedTeamId);
    if (!selectedTeamFloorId || selectedTeamFloorId !== selectedFloorKey) {
      setSelectedTeamId(null);
    }
  }, [normalizedResultFloorScopeId, selectedFloorKey, selectedTeamId, teamFloorById]);

  useEffect(() => {
    if (!floors.some((floor) => floor.id === selectedFloorId) && floors.length > 0) {
      setSelectedFloorId(floors[0].id);
    }
  }, [floors, selectedFloorId]);

  useEffect(() => {
    if (resultFloorScopeId === OUTPUT_SCOPE_ALL) {
      return;
    }
    if (allKnownFloorIds.includes(resultFloorScopeId)) {
      return;
    }
    setResultFloorScopeId(selectedFloorKey);
  }, [allKnownFloorIds, resultFloorScopeId, selectedFloorKey]);

  useEffect(() => {
    if (normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL) {
      return;
    }
    if (normalizedResultFloorScopeId === selectedFloorKey) {
      return;
    }
    setResultFloorScopeId(selectedFloorKey);
  }, [normalizedResultFloorScopeId, selectedFloorKey]);

  useEffect(() => {
    if (floors.length === 0) {
      return;
    }
    const floorSet = new Set(floors.map((floor) => floor.id));
    const fallbackFloorId = floors[0].id;
    setTeams((prev) => {
      let changed = false;
      const next = prev.map((team) => {
        const resolvedFloorId = resolveTeamFloorId(team, benchFloorById, fallbackFloorId);
        const normalizedFloorId = floorSet.has(resolvedFloorId) ? resolvedFloorId : fallbackFloorId;
        if (team.floorId === normalizedFloorId) {
          return team;
        }
        changed = true;
        return { ...team, floorId: normalizedFloorId };
      });
      return changed ? next : prev;
    });
    setProximityRequests((prev) => {
      let changed = false;
      const next = prev.map((request) => {
        const resolvedFloorId =
          normalizeFloorId(request.floorId, "") ||
          teamFloorById.get(request.teamA) ||
          teamFloorById.get(request.teamB) ||
          fallbackFloorId;
        const normalizedFloorId = floorSet.has(resolvedFloorId) ? resolvedFloorId : fallbackFloorId;
        if (request.floorId === normalizedFloorId) {
          return request;
        }
        changed = true;
        return { ...request, floorId: normalizedFloorId };
      });
      return changed ? next : prev;
    });
  }, [benchFloorById, floors, teamFloorById]);

  useEffect(() => {
    if (selectedBenchId && !benches.some((bench) => bench.id === selectedBenchId)) {
      setSelectedBenchId(null);
    }
  }, [benches, selectedBenchId]);

  useEffect(() => {
    if (!selectedBenchId || !selectedFloor) {
      return;
    }
    const selectedBench = benches.find((bench) => bench.id === selectedBenchId);
    const selectedBenchFloor = selectedBench?.floorId ?? selectedFloor.id;
    if (selectedBenchFloor !== selectedFloor.id) {
      setSelectedBenchId(null);
    }
  }, [benches, selectedBenchId, selectedFloor]);

  useEffect(() => {
    if (scenarios.length === 0) {
      return;
    }
    if (!scenarios.some((scenario) => scenario.id === activeScenarioId)) {
      setActiveScenarioId(scenarios[0].id);
    }
  }, [activeScenarioId, scenarios]);

  useEffect(() => {
    if (!activeScenarioId) {
      return;
    }
    setScenarios((prev) =>
      prev.map((scenario) =>
        scenario.id === activeScenarioId ? buildScenarioFromCurrent(scenario.id, scenario.name) : scenario,
      ),
    );
  }, [activeScenarioId, buildScenarioFromCurrent]);

  // We intentionally hydrate from autosave once on mount.
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (typeof window === "undefined") {
      setAutosaveReady(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) {
        setAutosaveStatus("No local draft yet.");
        setAutosaveReady(true);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<AutosaveFile>;
      const loadedScenarios = normalizeScenarioEntries(parsed.scenarios);
      if (loadedScenarios.length === 0) {
        setAutosaveStatus("Draft found but invalid.");
        setAutosaveReady(true);
        return;
      }
      const activeId =
        typeof parsed.activeScenarioId === "string" && loadedScenarios.some((scenario) => scenario.id === parsed.activeScenarioId)
          ? parsed.activeScenarioId
          : loadedScenarios[0].id;
      const active = loadedScenarios.find((scenario) => scenario.id === activeId) ?? loadedScenarios[0];
      setScenarios(loadedScenarios);
      setActiveScenarioId(active.id);
      applyScenario(active);
      const strippedSuffix = parsed.imageDataStripped ? " (images excluded)" : "";
      setAutosaveStatus(`Draft loaded${strippedSuffix}.`);
    } catch {
      setAutosaveStatus("Draft load failed.");
    } finally {
      setAutosaveReady(true);
    }
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    if (!autosaveReady || typeof window === "undefined" || scenarios.length === 0) {
      return;
    }
    const payload: AutosaveFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      activeScenarioId,
      scenarios: scenarios.map(scenarioToConfigEntry),
    };
    try {
      window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
      setAutosaveStatus(`Draft saved at ${new Date().toLocaleTimeString()}.`);
      return;
    } catch {
      try {
        const stripped: AutosaveFile = {
          ...payload,
          imageDataStripped: true,
          scenarios: payload.scenarios.map((scenario) => ({
            ...scenario,
            floors: scenario.floors.map((floor) => ({ ...floor, imageDataUrl: undefined })),
          })),
        };
        window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(stripped));
        setAutosaveStatus(`Draft saved without floor images at ${new Date().toLocaleTimeString()}.`);
      } catch {
        setAutosaveStatus("Draft autosave failed (storage limit).");
      }
    }
  }, [activeScenarioId, autosaveReady, scenarios]);

  useEffect(() => {
    if (!layoutDrag) {
      return;
    }
    const drag = layoutDrag;
    function handleMouseMove(event: MouseEvent) {
      if (drag.mode === "pan") {
        const deltaX = event.clientX - drag.pointerOffsetX;
        const deltaY = event.clientY - drag.pointerOffsetY;
        setLayoutView((prev) => ({
          ...prev,
          offsetX: (drag.initialOffsetX ?? prev.offsetX) + deltaX,
          offsetY: (drag.initialOffsetY ?? prev.offsetY) + deltaY,
        }));
        return;
      }

      if (
        drag.mode === "rotate" &&
        drag.benchId &&
        drag.rotateCenterClientX !== undefined &&
        drag.rotateCenterClientY !== undefined &&
        drag.rotatePointerStartAngle !== undefined
      ) {
        const pointerAngle = angleFromCenter(
          event.clientX,
          event.clientY,
          drag.rotateCenterClientX,
          drag.rotateCenterClientY,
        );
        const rawDelta = pointerAngle - drag.rotatePointerStartAngle;
        const delta = ((((rawDelta + 180) % 360) + 360) % 360) - 180;
        const freeRotation = normalizeRotation((drag.initialRotation ?? 0) + delta);
        const nextRotation = event.shiftKey
          ? normalizeRotation(Math.round(freeRotation / 15) * 15)
          : freeRotation;
        setBenches((prev) =>
          prev.map((bench, index) => {
            if (bench.id !== drag.benchId) {
              return bench;
            }
            const baseLayout = bench.layout ?? defaultLayoutForIndex(index);
            return {
              ...bench,
              layout: { ...baseLayout, rotation: nextRotation },
            };
          }),
        );
        return;
      }

      const point = getCanvasPercentPoint(event.clientX, event.clientY, {
        scale: drag.viewScale,
        offsetX: drag.viewOffsetX,
        offsetY: drag.viewOffsetY,
      });
      if (!point || !drag.benchId) {
        return;
      }
      if (drag.mode === "move" && drag.startClientX !== undefined && drag.startClientY !== undefined) {
        const jitterX = event.clientX - drag.startClientX;
        const jitterY = event.clientY - drag.startClientY;
        if (Math.hypot(jitterX, jitterY) < 3) {
          return;
        }
      }
      setBenches((prev) =>
        prev.map((bench, index) => {
          if (bench.id !== drag.benchId) {
            return bench;
          }
          const baseLayout = bench.layout ?? defaultLayoutForIndex(index);
          if (drag.mode === "resize") {
            const minW = 2;
            const minH = 1.5;
            const w = clamp(point.x - baseLayout.x, minW, 100 - baseLayout.x);
            const h = clamp(point.y - baseLayout.y, minH, 100 - baseLayout.y);
            return {
              ...bench,
              layout: { ...baseLayout, w, h },
            };
          }
          const x = clamp(point.x - drag.pointerOffsetX, 0, 100 - baseLayout.w);
          const y = clamp(point.y - drag.pointerOffsetY, 0, 100 - baseLayout.h);
          return {
            ...bench,
            layout: { ...baseLayout, x, y },
          };
        }),
      );
    }

    function handleMouseUp() {
      setLayoutDrag(null);
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [getCanvasPercentPoint, layoutDrag]);

  useEffect(() => {
    const canvas = layoutCanvasRef.current;
    if (!canvas) {
      return;
    }
    const canvasElement = canvas;
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvasElement.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const factor = event.deltaY > 0 ? 0.92 : 1.08;
      setLayoutView((prev) => {
        const nextScale = clamp(prev.scale * factor, 0.5, 4);
        const logicalX = (pointerX - prev.offsetX) / prev.scale;
        const logicalY = (pointerY - prev.offsetY) / prev.scale;
        return {
          scale: nextScale,
          offsetX: pointerX - logicalX * nextScale,
          offsetY: pointerY - logicalY * nextScale,
        };
      });
    }
    canvasElement.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvasElement.removeEventListener("wheel", handleWheel);
    };
  }, []);

  useEffect(() => {
    const img = new window.Image();
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    transparentDragImageRef.current = img;
    return () => {
      transparentDragImageRef.current = null;
    };
  }, []);

  const allocationMatrix = useMemo(() => {
    if (!manualAllocations.length && !result) {
      return {} as Record<string, Record<Day, AllocationBlock[]>>;
    }
    const matrix: Record<string, Record<Day, AllocationBlock[]>> = {};
    for (const bench of benchesByOrder) {
      matrix[bench.id] = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
    }

    for (const item of manualAllocations) {
      if (!matrix[item.benchId]) {
        matrix[item.benchId] = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
      }
      matrix[item.benchId][item.day].push(item);
    }

    return matrix;
  }, [result, manualAllocations, benchesByOrder]);

  const preallocationMatrix = useMemo(() => {
    const matrix: Record<string, Record<Day, AllocationBlock[]>> = {};
    for (const bench of benchesByOrder) {
      matrix[bench.id] = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
    }
    preallocationItems.forEach((item, index) => {
      if (!matrix[item.benchId]) {
        matrix[item.benchId] = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
      }
      matrix[item.benchId][item.day].push({
        id: `prealloc-${index}`,
        kind: "prealloc",
        benchId: item.benchId,
        day: item.day,
        seats: item.seats,
        teamId: item.label,
      });
    });
    return matrix;
  }, [benchesByOrder, preallocationItems]);

  const cellCapacity = useMemo(() => {
    const capacityMap: Record<string, number> = {};
    const benchCap = new Map(benches.map((bench) => [bench.id, bench.capacity]));
    for (const day of DAYS) {
      for (const bench of benches) {
        capacityMap[`${bench.id}-${day}`] = bench.capacity;
      }
    }
    for (const item of preallocationItems) {
      const key = `${item.benchId}-${item.day}`;
      const current = capacityMap[key] ?? (benchCap.get(item.benchId) ?? 0);
      capacityMap[key] = Math.max(0, current - item.seats);
    }
    return capacityMap;
  }, [benches, preallocationItems]);

  const manualUsageWarnings = useMemo(() => {
    const usedByCell: Record<string, number> = {};
    for (const item of manualAllocations) {
      const key = `${item.benchId}-${item.day}`;
      usedByCell[key] = (usedByCell[key] ?? 0) + item.seats;
    }
    return Object.entries(usedByCell)
      .filter(([key, used]) => used > (cellCapacity[key] ?? 0))
      .map(([key, used]) => {
        const [benchId, day] = key.split("-");
        return `${benchId} ${day}: ${used}/${cellCapacity[key] ?? 0}`;
      });
  }, [manualAllocations, cellCapacity]);

  const availableSeatsByCell = useMemo(() => {
    const usedByCell: Record<string, number> = {};
    for (const item of manualAllocations) {
      const key = `${item.benchId}-${item.day}`;
      usedByCell[key] = (usedByCell[key] ?? 0) + item.seats;
    }
    const available: Record<string, number> = {};
    for (const [key, capacity] of Object.entries(cellCapacity)) {
      available[key] = Math.max(0, capacity - (usedByCell[key] ?? 0));
    }
    return available;
  }, [cellCapacity, manualAllocations]);

  const movedBlocksCount = useMemo(() => {
    if (!baselineAllocations.length || !manualAllocations.length) {
      return 0;
    }
    const baseline = new Map(baselineAllocations.map((item) => [item.id, item]));
    let moved = 0;
    for (const current of manualAllocations) {
      const original = baseline.get(current.id);
      if (!original) {
        continue;
      }
      if (original.benchId !== current.benchId || original.day !== current.day) {
        moved += 1;
      }
    }
    return moved;
  }, [baselineAllocations, manualAllocations]);

  const manualDayDiagnostics = useMemo(() => {
    if (!result) {
      return [];
    }
    const totalSeats = benchesInResultScope.reduce((acc, bench) => acc + bench.capacity, 0);
    const byDay: Record<Day, { teamSeats: number; flexSeats: number }> = {
      Mon: { teamSeats: 0, flexSeats: 0 },
      Tue: { teamSeats: 0, flexSeats: 0 },
      Wed: { teamSeats: 0, flexSeats: 0 },
      Thu: { teamSeats: 0, flexSeats: 0 },
      Fri: { teamSeats: 0, flexSeats: 0 },
    };

    for (const item of manualAllocations) {
      if (!benchIdsInResultScope.has(item.benchId)) {
        continue;
      }
      if (item.kind === "flex") {
        byDay[item.day].flexSeats += item.seats;
      } else {
        byDay[item.day].teamSeats += item.seats;
      }
    }

    const preallocByDay: Record<Day, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
    for (const item of preallocationItems) {
      if (!benchIdsInResultScope.has(item.benchId)) {
        continue;
      }
      preallocByDay[item.day] += item.seats;
    }

    return DAYS.map((day) => ({
      day,
      allocatedSeats: byDay[day].teamSeats,
      preallocatedSeats: preallocByDay[day],
      flexSeats: byDay[day].flexSeats,
      totalSeats,
      occupancyPercent: totalSeats > 0 ? (byDay[day].teamSeats / totalSeats) * 100 : 0,
    }));
  }, [benchIdsInResultScope, benchesInResultScope, manualAllocations, preallocationItems, result]);

  const teamDelta = useMemo(() => {
    if (!result) {
      return [] as { teamId: string; primaryDays: number; comparisonDays: number; delta: number }[];
    }
    const comp = new Map(result.comparison.diagnostics.teamDiagnostics.map((row) => [row.teamId, row]));
    return result.primary.diagnostics.teamDiagnostics.map((row) => {
      const other = comp.get(row.teamId);
      const comparisonDays = other?.assignedDays ?? 0;
      return {
        teamId: row.teamId,
        primaryDays: row.assignedDays,
        comparisonDays,
        delta: row.assignedDays - comparisonDays,
      };
    });
  }, [result]);
  const teamDeltaInResultScope = useMemo(
    () => teamDelta.filter((row) => teamIdsInResultScope.has(row.teamId)),
    [teamDelta, teamIdsInResultScope],
  );
  const primaryTeamDiagnosticsInResultScope = useMemo(
    () =>
      result
        ? result.primary.diagnostics.teamDiagnostics.filter((row) => teamIdsInResultScope.has(row.teamId))
        : [],
    [result, teamIdsInResultScope],
  );
  const comparisonTeamDiagnosticsInResultScope = useMemo(
    () =>
      result
        ? result.comparison.diagnostics.teamDiagnostics.filter((row) => teamIdsInResultScope.has(row.teamId))
        : [],
    [result, teamIdsInResultScope],
  );
  const scopedPrimaryFairnessMin = useMemo(
    () =>
      primaryTeamDiagnosticsInResultScope.length > 0
        ? Math.min(...primaryTeamDiagnosticsInResultScope.map((row) => row.fulfillmentRatio))
        : 0,
    [primaryTeamDiagnosticsInResultScope],
  );
  const teamContiguousStatus = useMemo(() => {
    if (!result) {
      return new Map<string, boolean>();
    }
    return new Map(
      result.primary.teamSchedules.map((schedule) => [schedule.teamId, areDaysContiguous(schedule.days)]),
    );
  }, [result]);
  const scopedContiguityPenalty = useMemo(
    () =>
      teamsInResultScope.reduce((acc, team) => {
        if (!team.contiguousDaysRequired) {
          return acc;
        }
        return teamContiguousStatus.get(team.id) ? acc : acc + 1;
      }, 0),
    [teamContiguousStatus, teamsInResultScope],
  );

  const teamRequirementMap = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
  const assignedDaysByTeam = useMemo(() => {
    const map = new Map<string, Set<Day>>();
    for (const item of manualAllocations) {
      if (item.kind !== "team" || !item.teamId) {
        continue;
      }
      const days = map.get(item.teamId) ?? new Set<Day>();
      days.add(item.day);
      map.set(item.teamId, days);
    }
    return map;
  }, [manualAllocations]);
  const proximityRequestStatuses = useMemo(() => {
    const defaultStatus: ProximityRequestStatus = { status: "na", unmetDays: [] };
    if (!result) {
      return proximityRequests.map(() => defaultStatus);
    }

    const benchPointById = new Map<string, { x: number; y: number; floorId: string }>();
    benchesByOrder.forEach((bench, index) => {
      benchPointById.set(bench.id, benchCenterPoint(bench, index));
    });

    const teamBenchesByDay: Record<Day, Map<string, Set<string>>> = {
      Mon: new Map(),
      Tue: new Map(),
      Wed: new Map(),
      Thu: new Map(),
      Fri: new Map(),
    };
    for (const item of manualAllocations) {
      if (item.kind !== "team" || !item.teamId) {
        continue;
      }
      const byTeam = teamBenchesByDay[item.day];
      const benchSet = byTeam.get(item.teamId) ?? new Set<string>();
      benchSet.add(item.benchId);
      byTeam.set(item.teamId, benchSet);
    }

    return proximityRequests.map((request) => {
      const enforcedDays = toDayArray(request.days && request.days.length > 0 ? request.days : DAYS);
      const floorA = teamFloorById.get(request.teamA);
      const floorB = teamFloorById.get(request.teamB);
      const requestFloorId = normalizeFloorId(request.floorId, "") || floorA || floorB || selectedFloorKey;
      if (!floorA || !floorB || floorA !== floorB || floorA !== requestFloorId) {
        return { status: "unmet", unmetDays: enforcedDays } as ProximityRequestStatus;
      }
      const unmetDays: Day[] = [];
      let checkedDays = 0;
      for (const day of enforcedDays) {
        const aBenchesRaw = teamBenchesByDay[day].get(request.teamA);
        const bBenchesRaw = teamBenchesByDay[day].get(request.teamB);
        const aBenches = new Set(
          [...(aBenchesRaw ?? [])].filter((benchId) => normalizeFloorId(benchFloorById.get(benchId), requestFloorId) === requestFloorId),
        );
        const bBenches = new Set(
          [...(bBenchesRaw ?? [])].filter((benchId) => normalizeFloorId(benchFloorById.get(benchId), requestFloorId) === requestFloorId),
        );
        if (!aBenches || !bBenches || aBenches.size === 0 || bBenches.size === 0) {
          continue;
        }
        checkedDays += 1;

        let minDistance = Number.POSITIVE_INFINITY;
        for (const aBenchId of aBenches) {
          for (const bBenchId of bBenches) {
            if (aBenchId === bBenchId) {
              minDistance = 0;
              continue;
            }
            const pointA = benchPointById.get(aBenchId);
            const pointB = benchPointById.get(bBenchId);
            if (!pointA || !pointB) {
              continue;
            }
            minDistance = Math.min(minDistance, benchPointDistance(pointA, pointB));
          }
        }
        const dayScore =
          minDistance === Number.POSITIVE_INFINITY ? 1 : proximityScoreFromDistance(minDistance);
        const requiredScore = request.strict ? 4 : Math.max(1, Math.min(5, Number(request.strength) || 1));
        if (dayScore < requiredScore) {
          unmetDays.push(day);
        }
      }

      if (checkedDays === 0) {
        return { status: "na", unmetDays } as ProximityRequestStatus;
      }
      return {
        status: unmetDays.length > 0 ? "unmet" : "met",
        unmetDays,
      } as ProximityRequestStatus;
    });
  }, [benchesByOrder, manualAllocations, proximityRequests, result, teamFloorById, selectedFloorKey, benchFloorById]);

  const validationIssues = useMemo(() => {
    const issues: ValidationIssue[] = [];
    const benchIds = benches.map((bench) => bench.id.trim()).filter((id) => id.length > 0);
    const benchIdSet = new Set(benchIds);
    const floorIdSet = new Set(floors.map((floor) => floor.id));
    const teamIds = teams.map((team) => team.id.trim()).filter((id) => id.length > 0);
    const teamIdSet = new Set(teamIds);

    const benchEmptyIdCount = benches.filter((bench) => !bench.id.trim()).length;
    const benchInvalidCapacityCount = benches.filter((bench) => Number(bench.capacity) <= 0).length;
    const benchMissingLayoutCount = benches.filter((bench) => !bench.layout).length;
    const benchDuplicateCount = benchIds.length - new Set(benchIds).size;
    const benchFloorUnqualifiedCount = benches.filter((bench) => {
      const floorId = normalizeFloorId(bench.floorId, "F1");
      return !bench.id.trim().toUpperCase().startsWith(`${floorId.toUpperCase()}-`);
    }).length;
    if (benches.length === 0) {
      issues.push({
        id: "bench-none",
        scope: "step1",
        level: "error",
        message: "No benches defined.",
        fixCode: "add_default_bench",
        fixLabel: "Add default bench",
      });
    }
    if (benchEmptyIdCount > 0) {
      issues.push({
        id: "bench-empty-id",
        scope: "step1",
        level: "error",
        message: `${benchEmptyIdCount} bench row(s) have empty IDs.`,
        fixCode: "normalize_benches",
        fixLabel: "Auto-fix bench IDs",
      });
    }
    if (benchDuplicateCount > 0) {
      issues.push({
        id: "bench-duplicate-id",
        scope: "step1",
        level: "error",
        message: `${benchDuplicateCount} duplicate bench ID(s).`,
        fixCode: "normalize_benches",
        fixLabel: "Make bench IDs unique",
      });
    }
    if (benchFloorUnqualifiedCount > 0) {
      issues.push({
        id: "bench-floor-prefix",
        scope: "step1",
        level: "warning",
        message: `${benchFloorUnqualifiedCount} bench ID(s) do not include floor prefix (e.g. F1-B1).`,
        fixCode: "normalize_benches",
        fixLabel: "Apply floor-qualified IDs",
      });
    }
    if (benchInvalidCapacityCount > 0) {
      issues.push({
        id: "bench-capacity",
        scope: "step1",
        level: "error",
        message: `${benchInvalidCapacityCount} bench row(s) have capacity <= 0.`,
        fixCode: "normalize_benches",
        fixLabel: "Set invalid capacities to 1",
      });
    }
    if (benchMissingLayoutCount > 0) {
      issues.push({
        id: "bench-missing-layout",
        scope: "step2",
        level: "warning",
        message: `${benchMissingLayoutCount} bench row(s) have no layout box yet.`,
        fixCode: "add_default_layouts",
        fixLabel: "Create default layout boxes",
      });
    }
    if (floors.every((floor) => !floor.imageDataUrl)) {
      issues.push({
        id: "layout-no-image",
        scope: "step2",
        level: "warning",
        message: "No floor image uploaded yet.",
      });
    }

    const teamEmptyIdCount = teams.filter((team) => !team.id.trim()).length;
    const teamInvalidSizeCount = teams.filter((team) => Number(team.size) <= 0).length;
    const teamInvalidTargetCount = teams.filter((team) => Number(team.targetDays) < 0 || Number(team.targetDays) > 5).length;
    const teamDuplicateCount = teamIds.length - new Set(teamIds).size;
    const teamInvalidFloorCount = teams.filter(
      (team) => !floorIdSet.has(resolveTeamFloorId(team, benchFloorById, selectedFloorKey)),
    ).length;
    const teamInvalidAnchorCount = teams.filter((team) => {
      const anchorBenchId = (team.anchorBenchId ?? "").trim();
      if (anchorBenchId.length === 0 || !benchIdSet.has(anchorBenchId)) {
        return anchorBenchId.length > 0;
      }
      const teamFloorId = resolveTeamFloorId(team, benchFloorById, selectedFloorKey);
      return benchFloorById.get(anchorBenchId) !== teamFloorId;
    }).length;
    const teamInvalidAnchorSeatsCount = teams.filter((team) => {
      const anchorBenchId = (team.anchorBenchId ?? "").trim();
      const anchorSeats = Number(team.anchorSeats ?? 0);
      if (!anchorBenchId) {
        return anchorSeats > 0;
      }
      return anchorSeats < 1 || anchorSeats > Number(team.size);
    }).length;
    if (teams.length === 0) {
      issues.push({
        id: "team-none",
        scope: "step3",
        level: "error",
        message: "No teams defined.",
      });
    }
    if (teamEmptyIdCount > 0) {
      issues.push({
        id: "team-empty-id",
        scope: "step3",
        level: "error",
        message: `${teamEmptyIdCount} team row(s) have empty IDs.`,
        fixCode: "normalize_teams",
        fixLabel: "Auto-fix team rows",
      });
    }
    if (teamDuplicateCount > 0) {
      issues.push({
        id: "team-duplicate-id",
        scope: "step3",
        level: "error",
        message: `${teamDuplicateCount} duplicate team ID(s).`,
        fixCode: "normalize_teams",
        fixLabel: "Make team IDs unique",
      });
    }
    if (
      teamInvalidSizeCount > 0 ||
      teamInvalidTargetCount > 0 ||
      teamInvalidFloorCount > 0 ||
      teamInvalidAnchorCount > 0 ||
      teamInvalidAnchorSeatsCount > 0
    ) {
      issues.push({
        id: "team-invalid-values",
        scope: "step3",
        level: "error",
        message:
          `${teamInvalidSizeCount} invalid size, ${teamInvalidTargetCount} invalid target, ${teamInvalidFloorCount} invalid floor, ` +
          `${teamInvalidAnchorCount} invalid anchors, ${teamInvalidAnchorSeatsCount} invalid anchor seats.`,
        fixCode: "normalize_teams",
        fixLabel: "Normalize team values",
      });
    }

    const proximityInvalidTeamCount = proximityRequests.filter(
      (request) => {
        const teamA = request.teamA.trim();
        const teamB = request.teamB.trim();
        const floorA = teamFloorById.get(teamA);
        const floorB = teamFloorById.get(teamB);
        const requestFloorId = normalizeFloorId(request.floorId, "");
        return (
          !teamA ||
          !teamB ||
          teamA === teamB ||
          !teamIdSet.has(teamA) ||
          !teamIdSet.has(teamB) ||
          !floorA ||
          !floorB ||
          floorA !== floorB ||
          (requestFloorId.length > 0 && requestFloorId !== floorA)
        );
      },
    ).length;
    const proximityInvalidDaysCount = proximityRequests.filter(
      (request) => toDayArray(request.days).length === 0,
    ).length;
    if (proximityInvalidTeamCount > 0) {
      issues.push({
        id: "prox-invalid-team",
        scope: "step4",
        level: "error",
        message: `${proximityInvalidTeamCount} proximity request(s) have invalid teams.`,
        fixCode: "remove_invalid_proximity",
        fixLabel: "Remove invalid requests",
      });
    }
    if (proximityInvalidDaysCount > 0) {
      issues.push({
        id: "prox-empty-days",
        scope: "step4",
        level: "warning",
        message: `${proximityInvalidDaysCount} proximity request(s) have no enforced days.`,
        fixCode: "fill_proximity_days",
        fixLabel: "Set all weekdays",
      });
    }

    const preallocUnknownBenchCount = preallocations.filter((item) => !benchIdSet.has(item.benchId.trim())).length;
    const preallocNoDaysCount = preallocations.filter((item) => toDayArray(item.days).length === 0).length;
    const preallocInvalidSeatsCount = preallocations.filter((item) => Number(item.seats) < 0).length;
    if (preallocUnknownBenchCount > 0 || preallocNoDaysCount > 0 || preallocInvalidSeatsCount > 0) {
      issues.push({
        id: "prealloc-invalid",
        scope: "step5",
        level: "warning",
        message:
          `${preallocUnknownBenchCount} unknown bench, ${preallocNoDaysCount} empty days, ` +
          `${preallocInvalidSeatsCount} negative seats in pre-allocations.`,
        fixCode: "normalize_preallocations",
        fixLabel: "Normalize pre-allocations",
      });
    }

    const policyFlexInvalid = Number(flexDefault) < 0 || Number(flexDefault) > 100;
    const policyBenchStabilityInvalid = Number(benchStabilityWeight) < 0 || Number(benchStabilityWeight) > 10;
    if (policyFlexInvalid || policyBenchStabilityInvalid) {
      issues.push({
        id: "policy-invalid",
        scope: "step0",
        level: "error",
        message: "Policy has out-of-range values (flex must be 0-100, stability 0-10).",
        fixCode: "normalize_policy",
        fixLabel: "Normalize policy",
      });
    }

    const strictUnmetCount = proximityRequestStatuses.filter((status) => status.status === "unmet").length;
    if (strictUnmetCount > 0) {
      issues.push({
        id: "strict-unmet",
        scope: "step6",
        level: "warning",
        message: `${strictUnmetCount} proximity request(s) currently unmet in the plan.`,
        fixCode: "disable_unmet_strict",
        fixLabel: "Disable strict on unmet",
      });
    }

    if (manualUsageWarnings.length > 0) {
      issues.push({
        id: "manual-over-capacity",
        scope: "step6",
        level: "error",
        message: `${manualUsageWarnings.length} manual cell(s) exceed capacity.`,
        fixCode: "reset_manual_moves",
        fixLabel: "Reset manual moves",
      });
    }

    if (!result) {
      issues.push({
        id: "plan-not-generated",
        scope: "step6",
        level: "warning",
        message: "Plan not generated yet.",
      });
    }

    return issues;
  }, [
    benchStabilityWeight,
    benches,
    flexDefault,
    floors,
    manualUsageWarnings,
    preallocations,
    proximityRequestStatuses,
    proximityRequests,
    result,
    teams,
    selectedFloorKey,
    benchFloorById,
    teamFloorById,
  ]);

  const validationByScope = useMemo(() => {
    const grouped: Record<ValidationIssue["scope"], ValidationIssue[]> = {
      step0: [],
      step1: [],
      step2: [],
      step3: [],
      step4: [],
      step5: [],
      step6: [],
    };
    validationIssues.forEach((issue) => {
      grouped[issue.scope].push(issue);
    });
    return grouped;
  }, [validationIssues]);

  const stepHealth = useMemo(() => {
    const step2Done =
      floors.length > 0 &&
      benches.length > 0 &&
      benches.every((bench) => !!bench.layout && Number(bench.layout.w) > 0 && Number(bench.layout.h) > 0);
    return [
      { id: "step0", label: "0 Data & Policy", done: validationByScope.step0.filter((i) => i.level === "error").length === 0 },
      { id: "step1", label: "1 Benches", done: benches.length > 0 && validationByScope.step1.filter((i) => i.level === "error").length === 0 },
      { id: "step2", label: "2 Layout", done: step2Done },
      { id: "step3", label: "3 Teams", done: teams.length > 0 && validationByScope.step3.filter((i) => i.level === "error").length === 0 },
      { id: "step4", label: "4 Proximity", done: validationByScope.step4.filter((i) => i.level === "error").length === 0 },
      { id: "step5", label: "5 Prealloc", done: validationByScope.step5.filter((i) => i.level === "error").length === 0 },
      { id: "step6", label: "6 Generate", done: !!result && validationByScope.step6.filter((i) => i.level === "error").length === 0 },
    ];
  }, [benches, floors.length, result, teams.length, validationByScope]);

  const planHealth = useMemo(() => {
    const errorCount = validationIssues.filter((issue) => issue.level === "error").length + (error ? 1 : 0);
    const warningCount = validationIssues.filter((issue) => issue.level === "warning").length;
    const completion = stepHealth.filter((item) => item.done).length;
    const level = errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";
    const title =
      errorCount > 0
        ? "Data issues detected"
        : !result
          ? "Ready to generate"
          : warningCount > 0
            ? "Plan generated with warnings"
            : "Plan healthy";
    return { errorCount, warningCount, completion, total: stepHealth.length, level, title };
  }, [error, result, stepHealth, validationIssues]);
  const useFloorDropdown = floors.length > 5;
  const workspaceStatus = useMemo(() => {
    const overCapacityFloors = floorConstraintRows.filter((row) => row.demandRatio !== null && row.demandRatio > 100).length;
    const unmetProximityRequests = proximityRequestStatuses.filter((status) => status.status === "unmet").length;
    const strictRelaxations = result?.primary.diagnostics.strictProximityRelaxations.length ?? 0;
    return {
      overCapacityFloors,
      unmetProximityRequests,
      strictRelaxations,
      generated: !!result,
    };
  }, [floorConstraintRows, proximityRequestStatuses, result]);
  const actionableValidationIssues = useMemo(
    () => validationIssues.filter((issue) => issue.id !== "plan-not-generated"),
    [validationIssues],
  );
  const isLayoutPlanViewActive = !!result && layoutDayView !== "off";
  const layoutDaySummary = useMemo(() => {
    const summary = new Map<
      string,
      {
        usedSeats: number;
        teamSeats: number;
        flexSeats: number;
        preallocatedSeats: number;
        topTeamId: string | null;
      }
    >();
    if (!isLayoutPlanViewActive) {
      for (const bench of benchesByOrder) {
        summary.set(bench.id, {
          usedSeats: 0,
          teamSeats: 0,
          flexSeats: 0,
          preallocatedSeats: 0,
          topTeamId: null,
        });
      }
      return summary;
    }
    const day = layoutDayView as Day;
    for (const bench of benchesByOrder) {
      const teamById = new Map<string, number>();
      const prealloc = preallocationMatrix[bench.id]?.[day] ?? [];
      const plan = allocationMatrix[bench.id]?.[day] ?? [];
      const allItems = [...prealloc, ...plan];
      let usedSeats = 0;
      let teamSeats = 0;
      let flexSeats = 0;
      let preallocatedSeats = 0;

      for (const item of allItems) {
        usedSeats += item.seats;
        if (item.kind === "team") {
          teamSeats += item.seats;
          if (item.teamId) {
            teamById.set(item.teamId, (teamById.get(item.teamId) ?? 0) + item.seats);
          }
        } else if (item.kind === "flex") {
          flexSeats += item.seats;
        } else {
          preallocatedSeats += item.seats;
        }
      }

      let topTeamId: string | null = null;
      let topTeamSeats = -1;
      for (const [teamId, seats] of teamById.entries()) {
        if (seats > topTeamSeats) {
          topTeamId = teamId;
          topTeamSeats = seats;
        }
      }

      summary.set(bench.id, {
        usedSeats,
        teamSeats,
        flexSeats,
        preallocatedSeats,
        topTeamId,
      });
    }
    return summary;
  }, [allocationMatrix, benchesByOrder, isLayoutPlanViewActive, layoutDayView, preallocationMatrix]);
  const selectedBenchDaySummary = useMemo(() => {
    if (!selectedBenchId) {
      return null;
    }
    const bench = benches.find((item) => item.id === selectedBenchId);
    if (!bench) {
      return null;
    }
    return {
      bench,
      summary: layoutDaySummary.get(selectedBenchId) ?? {
        usedSeats: 0,
        teamSeats: 0,
        flexSeats: 0,
        preallocatedSeats: 0,
        topTeamId: null,
      },
    };
  }, [benches, layoutDaySummary, selectedBenchId]);

  function updateBench(index: number, patch: Partial<Bench>) {
    setBenches((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
  }

  function normalizeBenchIdAtIndex(index: number, rawBenchId: string) {
    const target = benches[index];
    if (!target) {
      return;
    }
    const floorId = normalizeFloorId(target.floorId, selectedFloorKey);
    const fallbackId = `B${index + 1}`;
    const candidate = ensureFloorQualifiedBenchId(rawBenchId.trim() || fallbackId, floorId);
    const usedIds = new Set(benches.filter((_, rowIndex) => rowIndex !== index).map((bench) => bench.id));
    const normalizedId = uniqueBenchId(candidate, usedIds);
    const previousId = target.id;

    setBenches((prev) => prev.map((bench, rowIndex) => (rowIndex === index ? { ...bench, id: normalizedId } : bench)));
    if (previousId === normalizedId) {
      return;
    }
    setTeams((prev) =>
      prev.map((team) => ((team.anchorBenchId ?? "").trim() === previousId ? { ...team, anchorBenchId: normalizedId } : team)),
    );
    setPreallocations((prev) =>
      prev.map((item) => (item.benchId === previousId ? { ...item, benchId: normalizedId } : item)),
    );
    setManualAllocations((prev) =>
      prev.map((item) => (item.benchId === previousId ? { ...item, benchId: normalizedId } : item)),
    );
    setBaselineAllocations((prev) =>
      prev.map((item) => (item.benchId === previousId ? { ...item, benchId: normalizedId } : item)),
    );
    setSelectedBenchId((prev) => (prev === previousId ? normalizedId : prev));
  }

  function updateTeam(index: number, patch: Partial<Team>) {
    setTeams((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) {
          return item;
        }
        const next = { ...item, ...patch };
        const size = Math.max(0, Number(next.size) || 0);
        const floorId = resolveTeamFloorId(next, benchFloorById, selectedFloorKey);
        const anchorBenchId = (next.anchorBenchId ?? "").trim();
        const anchorOnSameFloor = anchorBenchId.length > 0 && benchFloorById.get(anchorBenchId) === floorId;
        const normalizedAnchorBenchId = anchorOnSameFloor ? anchorBenchId : "";
        const hasAnchorBench = normalizedAnchorBenchId.length > 0;
        const normalizedAnchorSeats = hasAnchorBench ? Math.max(0, Number(next.anchorSeats) || 0) : 0;
        return {
          ...next,
          floorId,
          anchorBenchId: normalizedAnchorBenchId,
          size,
          anchorSeats: Math.min(size, normalizedAnchorSeats),
        };
      }),
    );
  }

  function updatePreallocation(index: number, patch: Partial<PreallocationDraft>) {
    setPreallocations((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
  }

  function updateProximityRequest(index: number, patch: Partial<TeamProximityRequest>) {
    setProximityRequests((prev) =>
      prev.map((item, idx) => {
        if (idx !== index) {
          return item;
        }
        const next = { ...item, ...patch };
        const normalizedDays = toDayArray(next.days && next.days.length > 0 ? next.days : [DAYS[0]]);
        return {
          ...next,
          floorId: normalizeFloorId(next.floorId, selectedFloorKey),
          strength: Math.max(1, Math.min(5, Number(next.strength) || 1)),
          strict: !!next.strict,
          days: normalizedDays,
        };
      }),
    );
  }

  function applyValidationFix(fixCode: string) {
    if (fixCode === "add_default_bench") {
      const fallbackFloorId = selectedFloor?.id ?? selectedFloorKey;
      setBenches((prev) =>
        prev.length > 0
          ? prev
          : [
              {
                id: ensureFloorQualifiedBenchId("B1", fallbackFloorId),
                capacity: 8,
                order: 1,
                floorId: fallbackFloorId,
                layout: defaultLayoutForIndex(0),
              },
            ],
      );
      return;
    }

    if (fixCode === "normalize_benches") {
      const fallbackFloorId = floors[0]?.id ?? selectedFloorKey;
      const used = new Set<string>();
      const idRemap = new Map<string, string>();
      const normalizedBenches = benches.map((bench, index) => {
        const floorId = normalizeFloorId(bench.floorId, fallbackFloorId);
        const fallback = `B${index + 1}`;
        const base = ensureFloorQualifiedBenchId(bench.id.trim() || fallback, floorId);
        const id = uniqueBenchId(base, used);
        used.add(id);
        idRemap.set(bench.id, id);
        return {
          ...bench,
          id,
          floorId,
          capacity: Math.max(1, Number(bench.capacity) || 1),
          order: Number.isFinite(Number(bench.order)) ? Number(bench.order) : index + 1,
        };
      });
      setBenches(normalizedBenches);
      setTeams((prev) =>
        prev.map((team) => {
          const currentAnchor = (team.anchorBenchId ?? "").trim();
          if (!currentAnchor || !idRemap.has(currentAnchor)) {
            return team;
          }
          return { ...team, anchorBenchId: idRemap.get(currentAnchor) ?? currentAnchor };
        }),
      );
      setPreallocations((prev) =>
        prev.map((item) => (idRemap.has(item.benchId) ? { ...item, benchId: idRemap.get(item.benchId) ?? item.benchId } : item)),
      );
      setManualAllocations((prev) =>
        prev.map((item) => (idRemap.has(item.benchId) ? { ...item, benchId: idRemap.get(item.benchId) ?? item.benchId } : item)),
      );
      setBaselineAllocations((prev) =>
        prev.map((item) => (idRemap.has(item.benchId) ? { ...item, benchId: idRemap.get(item.benchId) ?? item.benchId } : item)),
      );
      setSelectedBenchId((prev) => (prev && idRemap.has(prev) ? idRemap.get(prev) ?? prev : prev));
      return;
    }

    if (fixCode === "add_default_layouts") {
      setBenches((prev) =>
        prev.map((bench, index) => ({
          ...bench,
          layout: bench.layout ?? defaultLayoutForIndex(index),
        })),
      );
      return;
    }

    if (fixCode === "normalize_teams") {
      const validBenchIds = new Set(benches.map((bench) => bench.id.trim()).filter((id) => id.length > 0));
      const fallbackFloorId = floors[0]?.id ?? selectedFloorKey;
      setTeams((prev) => {
        const used = new Set<string>();
        return prev.map((team, index) => {
          const fallback = `Team${index + 1}`;
          const base = team.id.trim() || fallback;
          let id = base;
          let suffix = 2;
          while (used.has(id)) {
            id = `${base}_${suffix}`;
            suffix += 1;
          }
          used.add(id);
          const size = Math.max(1, Number(team.size) || 1);
          const targetDays = clamp(Number(team.targetDays) || 0, 0, 5);
          const floorId = resolveTeamFloorId(team, benchFloorById, fallbackFloorId);
          const anchorBenchId = (team.anchorBenchId ?? "").trim();
          const hasValidAnchor =
            anchorBenchId.length > 0 &&
            validBenchIds.has(anchorBenchId) &&
            benchFloorById.get(anchorBenchId) === floorId;
          const normalizedAnchorSeats = hasValidAnchor ? Math.max(1, Number(team.anchorSeats) || 1) : 0;
          return {
            ...team,
            id,
            floorId,
            size,
            targetDays,
            preferredDays: toDayArray(team.preferredDays),
            anchorBenchId: hasValidAnchor ? anchorBenchId : "",
            anchorSeats: Math.min(size, normalizedAnchorSeats),
          };
        });
      });
      return;
    }

    if (fixCode === "remove_invalid_proximity") {
      const validTeamIds = new Set(teams.map((team) => team.id.trim()).filter((id) => id.length > 0));
      setProximityRequests((prev) =>
        prev.filter((request) => {
          const teamA = request.teamA.trim();
          const teamB = request.teamB.trim();
          const floorA = teamFloorById.get(teamA);
          const floorB = teamFloorById.get(teamB);
          return (
            teamA &&
            teamB &&
            teamA !== teamB &&
            validTeamIds.has(teamA) &&
            validTeamIds.has(teamB) &&
            !!floorA &&
            !!floorB &&
            floorA === floorB
          );
        }),
      );
      return;
    }

    if (fixCode === "fill_proximity_days") {
      setProximityRequests((prev) =>
        prev.map((request) => ({
          ...request,
          days: toDayArray(request.days).length > 0 ? toDayArray(request.days) : [...DAYS],
        })),
      );
      return;
    }

    if (fixCode === "normalize_preallocations") {
      const validBenchIds = new Set(benches.map((bench) => bench.id.trim()).filter((id) => id.length > 0));
      setPreallocations((prev) =>
        prev
          .filter((item) => validBenchIds.has(item.benchId.trim()))
          .map((item) => ({
            ...item,
            benchId: item.benchId.trim(),
            seats: Math.max(0, Number(item.seats) || 0),
            days: toDayArray(item.days).length > 0 ? toDayArray(item.days) : [DAYS[0]],
          })),
      );
      return;
    }

    if (fixCode === "normalize_policy") {
      setFlexDefault((prev) => clamp(Number(prev) || 0, 0, 100));
      setBenchStabilityWeight((prev) => clamp(Number(prev) || 0, 0, 10));
      return;
    }

    if (fixCode === "disable_unmet_strict") {
      setProximityRequests((prev) =>
        prev.map((request, index) =>
          proximityRequestStatuses[index]?.status === "unmet" ? { ...request, strict: false } : request,
        ),
      );
      return;
    }

    if (fixCode === "reset_manual_moves") {
      setManualAllocations(baselineAllocations);
      setManualError(null);
    }
  }

  function updateSelectedBenchRotation(value: number) {
    if (!selectedBenchOnFloor) {
      return;
    }
    setBenches((prev) =>
      prev.map((bench, index) => {
        if (bench.id !== selectedBenchOnFloor.id) {
          return bench;
        }
        const baseLayout = bench.layout ?? defaultLayoutForIndex(index);
        return {
          ...bench,
          layout: {
            ...baseLayout,
            rotation: normalizeRotation(value),
          },
        };
      }),
    );
  }

  function switchScenario(nextScenarioId: string) {
    const scenario = scenarios.find((item) => item.id === nextScenarioId);
    if (!scenario) {
      return;
    }
    setActiveScenarioId(scenario.id);
    applyScenario(scenario);
  }

  function createScenario() {
    const id = generateScenarioId();
    const scenario = {
      ...createInitialScenario(),
      id,
      name: `Scenario ${scenarios.length + 1}`,
    };
    setScenarios((prev) => [...prev, scenario]);
    setActiveScenarioId(id);
    applyScenario(scenario);
  }

  function duplicateScenario() {
    if (!activeScenario) {
      return;
    }
    const id = generateScenarioId();
    const copy = {
      ...buildScenarioFromCurrent(id, `${activeScenario.name} Copy`),
    };
    setScenarios((prev) => [...prev, copy]);
    setActiveScenarioId(id);
    applyScenario(copy);
  }

  function renameActiveScenario(name: string) {
    if (!activeScenarioId) {
      return;
    }
    setScenarios((prev) =>
      prev.map((scenario) =>
        scenario.id === activeScenarioId
          ? {
              ...scenario,
              name: name.length > 0 ? name : "Scenario",
            }
          : scenario,
      ),
    );
  }

  function deleteActiveScenario() {
    if (!activeScenario || scenarios.length <= 1) {
      return;
    }
    const currentIndex = scenarios.findIndex((scenario) => scenario.id === activeScenario.id);
    const fallback = scenarios[currentIndex > 0 ? currentIndex - 1 : 1] ?? scenarios[0];
    setScenarios((prev) => prev.filter((scenario) => scenario.id !== activeScenario.id));
    setActiveScenarioId(fallback.id);
    applyScenario(fallback);
  }

  function heatColorByRatio(ratio: number): string {
    if (ratio < 0.35) {
      return "#19a974";
    }
    if (ratio < 0.6) {
      return "#5dbb63";
    }
    if (ratio < 0.8) {
      return "#e0a100";
    }
    if (ratio < 0.95) {
      return "#e36c0a";
    }
    return "#c1373d";
  }

  function benchTextSizing(layout: { w: number; h: number }) {
    const sizeFactor = Math.sqrt(Math.max(1, layout.w * layout.h));
    const title = clamp(sizeFactor * 1.0, 8, 14);
    const seat = clamp(sizeFactor * 1.9, 11, 26);
    return {
      title,
      seat,
    };
  }

  function benchLabelMode(layout: { w: number; h: number }, benchId: string): "inline" | "vertical" | "callout" {
    const inlineCapacity = Math.max(4, Math.round(layout.w * 1.6));
    const verticalCapacity = Math.max(4, Math.round(layout.h * 2.2));
    if (benchId.length <= inlineCapacity) {
      return "inline";
    }
    if (benchId.length <= verticalCapacity) {
      return "vertical";
    }
    return "callout";
  }

  function updateSelectedBenchLayout(patch: Partial<{ x: number; y: number; w: number; h: number; rotation: number }>) {
    if (!selectedBenchOnFloor) {
      return;
    }
    setBenches((prev) =>
      prev.map((bench, index) => {
        if (bench.id !== selectedBenchOnFloor.id) {
          return bench;
        }
        const baseLayout = bench.layout ?? defaultLayoutForIndex(index);
        const proposed = {
          x: patch.x ?? baseLayout.x,
          y: patch.y ?? baseLayout.y,
          w: patch.w ?? baseLayout.w,
          h: patch.h ?? baseLayout.h,
          rotation: patch.rotation ?? Number(baseLayout.rotation ?? 0),
        };
        const w = clamp(Number(proposed.w), 2, 100);
        const h = clamp(Number(proposed.h), 1.5, 100);
        const x = clamp(Number(proposed.x), 0, 100 - w);
        const y = clamp(Number(proposed.y), 0, 100 - h);
        return {
          ...bench,
          layout: {
            x,
            y,
            w,
            h,
            rotation: normalizeRotation(Number(proposed.rotation)),
          },
        };
      }),
    );
  }

  function ensureBenchLayout(benchId: string) {
    setBenches((prev) =>
      prev.map((bench, index) =>
        bench.id === benchId
          ? {
              ...bench,
              layout: bench.layout ?? defaultLayoutForIndex(index),
            }
          : bench,
      ),
    );
  }

  function startLayoutDrag(event: ReactMouseEvent<HTMLDivElement>, bench: Bench) {
    if (!bench.layout) {
      return;
    }
    const point = getCanvasPercentPoint(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    event.preventDefault();
    setLayoutDrag({
      mode: "move",
      benchId: bench.id,
      pointerOffsetX: point.x - bench.layout.x,
      pointerOffsetY: point.y - bench.layout.y,
      startClientX: event.clientX,
      startClientY: event.clientY,
      viewScale: layoutView.scale,
      viewOffsetX: layoutView.offsetX,
      viewOffsetY: layoutView.offsetY,
    });
  }

  function startLayoutRotate(event: ReactMouseEvent<HTMLElement>, bench: Bench) {
    if (!bench.layout) {
      return;
    }
    const canvas = layoutCanvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const centerLocalX = ((bench.layout.x + bench.layout.w / 2) / 100) * rect.width;
    const centerLocalY = ((bench.layout.y + bench.layout.h / 2) / 100) * rect.height;
    const centerClientX = rect.left + layoutView.offsetX + centerLocalX * layoutView.scale;
    const centerClientY = rect.top + layoutView.offsetY + centerLocalY * layoutView.scale;
    const startAngle = angleFromCenter(event.clientX, event.clientY, centerClientX, centerClientY);
    event.preventDefault();
    event.stopPropagation();
    setLayoutDrag({
      mode: "rotate",
      benchId: bench.id,
      pointerOffsetX: 0,
      pointerOffsetY: 0,
      initialRotation: normalizeRotation(Number(bench.layout.rotation ?? 0)),
      rotateCenterClientX: centerClientX,
      rotateCenterClientY: centerClientY,
      rotatePointerStartAngle: startAngle,
      viewScale: layoutView.scale,
      viewOffsetX: layoutView.offsetX,
      viewOffsetY: layoutView.offsetY,
    });
  }

  function startLayoutResize(event: ReactMouseEvent<HTMLElement>, bench: Bench) {
    if (!bench.layout) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setLayoutDrag({
      mode: "resize",
      benchId: bench.id,
      pointerOffsetX: 0,
      pointerOffsetY: 0,
      viewScale: layoutView.scale,
      viewOffsetX: layoutView.offsetX,
      viewOffsetY: layoutView.offsetY,
    });
  }

  function startLayoutPan(event: ReactMouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest(".bench-block")) {
      return;
    }
    setSelectedBenchId(null);
    event.preventDefault();
    setLayoutDrag({
      mode: "pan",
      pointerOffsetX: event.clientX,
      pointerOffsetY: event.clientY,
      initialOffsetX: layoutView.offsetX,
      initialOffsetY: layoutView.offsetY,
      viewScale: layoutView.scale,
      viewOffsetX: layoutView.offsetX,
      viewOffsetY: layoutView.offsetY,
    });
  }

  function resetLayoutView() {
    setLayoutView({ scale: 1, offsetX: 0, offsetY: 0 });
  }

  function addFloor() {
    let nextCounter = 1;
    const used = new Set(floors.map((floor) => floor.id));
    while (used.has(`F${nextCounter}`)) {
      nextCounter += 1;
    }
    const nextId = `F${nextCounter}`;
    setFloors((prev) => [...prev, { id: nextId, name: `Floor ${nextCounter}` }]);
    setSelectedFloorId(nextId);
  }

  function renameSelectedFloor(name: string) {
    if (!selectedFloor) {
      return;
    }
    setFloors((prev) => prev.map((floor) => (floor.id === selectedFloor.id ? { ...floor, name } : floor)));
  }

  function removeSelectedFloor() {
    if (floors.length <= 1 || !selectedFloor) {
      return;
    }
    if (!canRemoveSelectedFloor) {
      setError("Floor cannot be removed while it still contains benches, teams, proximity requests, or pre-allocations.");
      return;
    }
    const fallbackFloorId = floors.find((floor) => floor.id !== selectedFloor.id)?.id ?? floors[0].id;
    setFloors((prev) => prev.filter((floor) => floor.id !== selectedFloor.id));
    setSelectedFloorId(fallbackFloorId);
  }

  function selectWorkspaceFloor(floorId: string) {
    setSelectedFloorId(floorId);
    setResultFloorScopeId(floorId);
  }

  function selectAllFloorsForResults() {
    setResultFloorScopeId(OUTPUT_SCOPE_ALL);
  }

  async function handleFloorImageUpload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    try {
      const file = input.files?.[0];
      if (!file || !selectedFloor) {
        return;
      }
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onerror = () => reject(new Error("Unable to read image file."));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(file);
      });
      setFloors((prev) =>
        prev.map((floor) => (floor.id === selectedFloor.id ? { ...floor, imageDataUrl: dataUrl } : floor)),
      );
    } catch {
      setError("Unable to import floor image.");
    } finally {
      input.value = "";
    }
  }

  function normalizeConfigBenches(raw: unknown): Bench[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const used = new Set<string>();
    return raw
      .map((item, index) => {
        const bench = item as Partial<Bench>;
        const floorId = normalizeFloorId(String(bench.floorId ?? "F1"), "F1");
        const fallbackId = `B${index + 1}`;
        const baseId = ensureFloorQualifiedBenchId(String(bench.id ?? "").trim() || fallbackId, floorId);
        const id = uniqueBenchId(baseId, used);
        used.add(id);
        const capacity = Math.max(0, Number(bench.capacity) || 0);
        const order = Number.isFinite(Number(bench.order)) ? Number(bench.order) : index + 1;
        const lx = Number(bench.layout?.x);
        const ly = Number(bench.layout?.y);
        const lw = Number(bench.layout?.w);
        const lh = Number(bench.layout?.h);
        const lr = Number(bench.layout?.rotation ?? 0);
        const hasLayout = [lx, ly, lw, lh].every((value) => Number.isFinite(value));
        const layout = hasLayout
          ? {
              w: clamp(lw, 1, 100),
              h: clamp(lh, 1, 100),
              x: 0,
              y: 0,
              rotation: normalizeRotation(lr),
            }
          : defaultLayoutForIndex(index);
        layout.x = clamp(hasLayout ? lx : layout.x, 0, 100 - layout.w);
        layout.y = clamp(hasLayout ? ly : layout.y, 0, 100 - layout.h);
        return {
          id,
          capacity,
          order,
          floorId,
          layout,
        };
      })
      .filter((bench): bench is Bench => bench !== null);
  }

  function normalizeConfigFloors(raw: unknown, benchesFromConfig: Bench[]): FloorPlan[] {
    const floors = Array.isArray(raw)
      ? raw
          .map((item) => {
            const floor = item as Partial<FloorPlan>;
            const id = String(floor.id ?? "").trim();
            if (!id) {
              return null;
            }
            return {
              id,
              name: String(floor.name ?? id).trim() || id,
              imageDataUrl: floor.imageDataUrl ? String(floor.imageDataUrl) : undefined,
            };
          })
          .filter((floor): floor is FloorPlan => floor !== null)
      : [];

    const floorIdsFromBenches = [...new Set(benchesFromConfig.map((bench) => bench.floorId ?? "F1"))];
    const merged = [...floors];
    for (const floorId of floorIdsFromBenches) {
      if (!merged.some((floor) => floor.id === floorId)) {
        merged.push({ id: floorId, name: floorId });
      }
    }
    if (merged.length === 0) {
      merged.push({ id: "F1", name: "Floor 1" });
    }
    return merged;
  }

  function normalizeConfigTeams(raw: unknown, benchesFromConfig: Bench[], fallbackFloorId: string): Team[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const benchFloorMap = new Map<string, string>();
    benchesFromConfig.forEach((bench) => {
      benchFloorMap.set(bench.id, normalizeFloorId(bench.floorId, fallbackFloorId));
    });
    return raw
      .map((item) => {
        const team = item as Partial<Team>;
        const id = String(team.id ?? "").trim();
        if (!id) {
          return null;
        }
        const floorId = resolveTeamFloorId(team, benchFloorMap, fallbackFloorId);
        return {
          id,
          floorId,
          size: Math.max(0, Number(team.size) || 0),
          targetDays: Math.max(0, Math.min(5, Number(team.targetDays) || 0)),
          preferredDays: toDayArray(team.preferredDays),
          contiguousDaysRequired: typeof team.contiguousDaysRequired === "boolean" ? team.contiguousDaysRequired : false,
          anchorBenchId: String(team.anchorBenchId ?? "").trim(),
          anchorSeats: Math.max(0, Number(team.anchorSeats) || 0),
        };
      })
      .filter((team): team is Team => team !== null);
  }

  function normalizeConfigPreallocations(raw: unknown): PreallocationDraft[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => {
        const prealloc = item as Partial<PreallocationDraft> & { day?: Day };
        const benchId = String(prealloc.benchId ?? "").trim();
        if (!benchId) {
          return null;
        }
        const seats = Math.max(0, Number(prealloc.seats) || 0);
        const dayValues = prealloc.days ? toDayArray(prealloc.days) : [];
        const singleDay = dayFromString(String(prealloc.day ?? ""));
        const days = [...new Set([...dayValues, ...(singleDay ? [singleDay] : [])])];
        if (days.length === 0) {
          return null;
        }
        return {
          benchId,
          days,
          seats,
          label: prealloc.label ? String(prealloc.label) : "",
        };
      })
      .filter((item): item is PreallocationDraft => item !== null);
  }

  function normalizeConfigProximity(
    raw: unknown,
    teamFloorById: Map<string, string>,
    fallbackFloorId: string,
  ): TeamProximityRequest[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => {
        const req = item as Partial<TeamProximityRequest>;
        const teamA = String(req.teamA ?? "").trim();
        const teamB = String(req.teamB ?? "").trim();
        if (!teamA || !teamB || teamA === teamB) {
          return null;
        }
        const parsedDays = toDayArray(req.days);
        const floorId =
          normalizeFloorId(req.floorId, "") || teamFloorById.get(teamA) || teamFloorById.get(teamB) || fallbackFloorId;
        return {
          teamA,
          teamB,
          floorId,
          strength: Math.max(1, Math.min(5, Number(req.strength) || 1)),
          strict: !!req.strict,
          days: parsedDays.length > 0 ? parsedDays : [...DAYS],
        };
      })
      .filter((item): item is TeamProximityRequest => item !== null);
  }

  function normalizeScenarioEntries(raw: unknown): PlannerScenario[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item, index) => {
        const scenario = item as Partial<ScenarioConfigEntry>;
        const benchesParsed = normalizeConfigBenches(scenario.benches);
        if (benchesParsed.length === 0) {
          return null;
        }
        const inferredDefaultFloorId = benchesParsed[0]?.floorId ?? "F1";
        const teamsParsed = normalizeConfigTeams(scenario.teams, benchesParsed, inferredDefaultFloorId);
        const preallocParsed = normalizeConfigPreallocations(scenario.preallocations);
        if (teamsParsed.length === 0) {
          return null;
        }
        const floorsParsed = normalizeConfigFloors(scenario.floors, benchesParsed);
        const selectedFloorId = String(scenario.selectedFloorId ?? "").trim();
        const settings = (scenario.settings ?? {}) as NonNullable<ScenarioConfigEntry["settings"]>;
        const teamFloorById = new Map<string, string>();
        teamsParsed.forEach((team) => {
          teamFloorById.set(team.id, normalizeFloorId(team.floorId, floorsParsed[0]?.id ?? "F1"));
        });
        const nextFlexOverrides: FlexOverrides = {};
        if (settings.flexOverrides) {
          for (const day of DAYS) {
            const rawValue = settings.flexOverrides[day];
            if (rawValue === undefined || rawValue === null) {
              continue;
            }
            const value = Number(rawValue);
            if (Number.isFinite(value)) {
              nextFlexOverrides[day] = clamp(value, 0, 100);
            }
          }
        }
        return {
          id: String(scenario.id ?? "").trim() || `S${index + 1}`,
          name: String(scenario.name ?? "").trim() || `Scenario ${index + 1}`,
          benches: benchesParsed,
          teams: teamsParsed,
          preallocations: preallocParsed,
          floors: floorsParsed,
          selectedFloorId: floorsParsed.some((floor) => floor.id === selectedFloorId)
            ? selectedFloorId
            : floorsParsed[0]?.id ?? "F1",
          solverMode: settings.solverMode === "efficiency_first" ? "efficiency_first" : "fairness_first",
          flexDefault: clamp(Number(settings.flexDefault ?? 10), 0, 100),
          flexOverrides: nextFlexOverrides,
          benchStabilityWeight: clamp(Number(settings.benchStabilityWeight ?? 6), 0, 10),
          proximityRequests: normalizeConfigProximity(
            settings.proximityRequests,
            teamFloorById,
            floorsParsed[0]?.id ?? "F1",
          ),
        };
      })
      .filter((scenario): scenario is PlannerScenario => scenario !== null);
  }

  function exportSessionConfig() {
    const synchronizedScenarios = scenarios.map((scenario) =>
      scenario.id === activeScenarioId ? buildScenarioFromCurrent(scenario.id, scenario.name) : scenario,
    );
    const serializedScenarios = synchronizedScenarios.map(scenarioToConfigEntry);
    const payload: SessionConfigFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      benches: cloneBenches(benches),
      teams: cloneTeams(teams),
      preallocations: clonePreallocations(preallocations),
      floors: cloneFloors(floors),
      activeScenarioId,
      scenarios: serializedScenarios,
      settings: {
        solverMode,
        flexDefault: Number(flexDefault),
        flexOverrides: { ...flexOverrides },
        benchStabilityWeight: Number(benchStabilityWeight),
        proximityRequests: cloneProximity(proximityRequests),
      },
    };
    downloadJson("office-planner-config.json", payload);
  }

  async function importSessionConfig(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    let selectedName = "config";
    try {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      selectedName = file.name;
      setImportFeedback((prev) => ({ ...prev, config: `Selected: ${file.name}` }));
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<SessionConfigFile>;

      let nextScenarios = normalizeScenarioEntries(parsed.scenarios);
      if (nextScenarios.length === 0) {
        const fallbackScenarioEntries: ScenarioConfigEntry[] =
          Array.isArray(parsed.benches) && Array.isArray(parsed.teams) && Array.isArray(parsed.preallocations)
            ? [
                {
                  id: "S1",
                  name: "Imported scenario",
                  benches: parsed.benches,
                  teams: parsed.teams,
                  preallocations: parsed.preallocations,
                  floors: parsed.floors ?? [],
                  selectedFloorId: parsed.floors?.[0]?.id,
                  settings: parsed.settings,
                },
              ]
            : [];
        nextScenarios = normalizeScenarioEntries(fallbackScenarioEntries);
      }

      if (nextScenarios.length === 0) {
        setError("Invalid config JSON. Expected valid scenario data.");
        setImportFeedback((prev) => ({ ...prev, config: `Failed: ${file.name} (invalid schema)` }));
        return;
      }

      const preferredId =
        typeof parsed.activeScenarioId === "string" &&
        nextScenarios.some((scenario) => scenario.id === parsed.activeScenarioId)
          ? parsed.activeScenarioId
          : nextScenarios[0].id;
      const nextActive = nextScenarios.find((scenario) => scenario.id === preferredId) ?? nextScenarios[0];

      setScenarios(nextScenarios);
      setActiveScenarioId(nextActive.id);
      applyScenario(nextActive);
      setError(null);
      setImportFeedback((prev) => ({
        ...prev,
        config: `Imported: ${file.name} at ${new Date().toLocaleTimeString()}`,
      }));
    } catch {
      setError("Unable to import config JSON.");
      setImportFeedback((prev) => ({ ...prev, config: `Failed: ${selectedName} (parse error)` }));
    } finally {
      input.value = "";
    }
  }

  function exportLayoutProfile() {
    const payload: LayoutFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      floors,
      benches: benches.map((bench) => ({
        id: bench.id,
        floorId: bench.floorId ?? "F1",
        layout: bench.layout,
      })),
    };
    downloadJson("office-layout-profile.json", payload);
  }

  async function importLayoutProfile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    try {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      const text = await file.text();
      const parsed = JSON.parse(text) as LayoutFile;
      if (!Array.isArray(parsed.floors) || !Array.isArray(parsed.benches)) {
        setError("Invalid layout profile file.");
        return;
      }

      setFloors(parsed.floors);
      setBenches((prev) =>
        prev.map((bench, index) => {
          const match = parsed.benches.find((item) => item.id === bench.id);
          const layoutCandidate = match?.layout ?? bench.layout ?? defaultLayoutForIndex(index);
          const normalizedLayout = layoutCandidate
            ? {
                ...layoutCandidate,
                rotation: normalizeRotation(Number(layoutCandidate.rotation ?? 0)),
              }
            : undefined;
          return {
            ...bench,
            floorId: match?.floorId ?? bench.floorId ?? parsed.floors[0]?.id ?? "F1",
            layout: normalizedLayout,
          };
        }),
      );
      if (parsed.floors.length > 0) {
        setSelectedFloorId(parsed.floors[0].id);
      }
      setError(null);
    } catch {
      setError("Unable to import layout profile.");
    } finally {
      input.value = "";
    }
  }

  async function handleBenchCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    try {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      setImportFeedback((prev) => ({ ...prev, benches: `Selected: ${file.name}` }));
      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        setError("Benches CSV is empty.");
        setImportFeedback((prev) => ({ ...prev, benches: `Failed: ${file.name} (empty)` }));
        return;
      }
      const headers = rows[0].map((h) => h.toLowerCase());
      const idIdx = headers.indexOf("id");
      const capIdx = headers.indexOf("capacity");
      const orderIdx = headers.indexOf("order");
      const floorIdx = headers.indexOf("floor_id");
      const xIdx = headers.indexOf("x");
      const yIdx = headers.indexOf("y");
      const wIdx = headers.indexOf("w");
      const hIdx = headers.indexOf("h");
      const rotationIdx = headers.indexOf("rotation");
      if (idIdx < 0 || capIdx < 0 || orderIdx < 0) {
        setError("Benches CSV must include id, capacity, order headers.");
        setImportFeedback((prev) => ({ ...prev, benches: `Failed: ${file.name} (invalid headers)` }));
        return;
      }

      const usedIds = new Set<string>();
      const parsed: Bench[] = rows.slice(1).map((row, index) => {
        const floorId = normalizeFloorId(floorIdx >= 0 ? row[floorIdx] : "", "F1");
        const x = xIdx >= 0 ? Number(row[xIdx]) : Number.NaN;
        const y = yIdx >= 0 ? Number(row[yIdx]) : Number.NaN;
        const w = wIdx >= 0 ? Number(row[wIdx]) : Number.NaN;
        const h = hIdx >= 0 ? Number(row[hIdx]) : Number.NaN;
        const rotation = rotationIdx >= 0 ? Number(row[rotationIdx]) : 0;
        const hasLayout = [x, y, w, h].every((value) => Number.isFinite(value));
        const rowId = ensureFloorQualifiedBenchId(row[idIdx] || `B${index + 1}`, floorId);
        const id = uniqueBenchId(rowId, usedIds);
        usedIds.add(id);
        return {
          id,
          capacity: Number(row[capIdx]),
          order: Number(row[orderIdx]),
          floorId,
          layout: hasLayout ? { x, y, w, h, rotation: normalizeRotation(rotation) } : defaultLayoutForIndex(index),
        };
      });

      setBenches(parsed.filter((bench) => bench.id));
      setFloors((prev) => {
        const fromFile = [...new Set(parsed.map((bench) => bench.floorId ?? "F1"))].map((id) => ({
          id,
          name: prev.find((floor) => floor.id === id)?.name ?? id,
          imageDataUrl: prev.find((floor) => floor.id === id)?.imageDataUrl,
        }));
        const merged = [...prev];
        for (const floor of fromFile) {
          if (!merged.some((existing) => existing.id === floor.id)) {
            merged.push(floor);
          }
        }
        return merged;
      });
      setError(null);
      setImportFeedback((prev) => ({
        ...prev,
        benches: `Imported: ${file.name} at ${new Date().toLocaleTimeString()}`,
      }));
    } finally {
      input.value = "";
    }
  }

  async function handleTeamCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    try {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      setImportFeedback((prev) => ({ ...prev, teams: `Selected: ${file.name}` }));
      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        setError("Teams CSV is empty.");
        setImportFeedback((prev) => ({ ...prev, teams: `Failed: ${file.name} (empty)` }));
        return;
      }

      const headers = rows[0].map((h) => h.toLowerCase());
      const idIdx = headers.indexOf("id");
      const sizeIdx = headers.indexOf("size");
      const targetIdx = headers.indexOf("target_days");
      const prefIdx = headers.indexOf("preferred_days");
      const contiguousIdx = headers.indexOf("contiguous_days_required");
      const anchorBenchIdx = headers.indexOf("anchor_bench_id");
      const anchorSeatsIdx = headers.indexOf("anchor_seats");
      const floorIdx = headers.indexOf("floor_id");
      if (idIdx < 0 || sizeIdx < 0 || targetIdx < 0 || prefIdx < 0) {
        setError(
          "Teams CSV must include id, size, target_days, preferred_days headers (optional: floor_id, contiguous_days_required, anchor_bench_id, anchor_seats).",
        );
        setImportFeedback((prev) => ({ ...prev, teams: `Failed: ${file.name} (invalid headers)` }));
        return;
      }

      const parsed: Team[] = rows.slice(1).map((row) => ({
        id: row[idIdx],
        floorId: normalizeFloorId(floorIdx >= 0 ? row[floorIdx] : "", selectedFloorKey),
        size: Number(row[sizeIdx]),
        targetDays: Number(row[targetIdx]),
        preferredDays: parsePreferredDays(row[prefIdx] ?? ""),
        contiguousDaysRequired: contiguousIdx >= 0 ? parseBoolean(row[contiguousIdx]) : false,
        anchorBenchId: anchorBenchIdx >= 0 ? String(row[anchorBenchIdx] ?? "").trim() : "",
        anchorSeats: anchorSeatsIdx >= 0 ? Math.max(0, Number(row[anchorSeatsIdx]) || 0) : 0,
      }));

      const normalizedTeams = parsed.filter((team) => team.id);
      setTeams(normalizedTeams);
      setFloors((prev) => {
        const next = [...prev];
        const teamFloorIds = [...new Set(normalizedTeams.map((team) => normalizeFloorId(team.floorId, selectedFloorKey)))];
        teamFloorIds.forEach((floorId) => {
          if (!next.some((floor) => floor.id === floorId)) {
            next.push({ id: floorId, name: floorId });
          }
        });
        return next;
      });
      setError(null);
      setImportFeedback((prev) => ({
        ...prev,
        teams: `Imported: ${file.name} at ${new Date().toLocaleTimeString()}`,
      }));
    } finally {
      input.value = "";
    }
  }

  async function handlePreallocationCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    try {
      const file = input.files?.[0];
      if (!file) {
        return;
      }
      setImportFeedback((prev) => ({ ...prev, preallocations: `Selected: ${file.name}` }));

      const rows = parseCsv(await file.text());
      if (rows.length < 2) {
        setError("Preallocations CSV is empty.");
        setImportFeedback((prev) => ({ ...prev, preallocations: `Failed: ${file.name} (empty)` }));
        return;
      }

      const headers = rows[0].map((h) => h.toLowerCase());
      const benchIdx = headers.indexOf("bench_id");
      const dayIdx = headers.indexOf("day") >= 0 ? headers.indexOf("day") : headers.indexOf("days");
      const seatsIdx = headers.indexOf("seats");
      const labelIdx = headers.indexOf("label");
      if (benchIdx < 0 || dayIdx < 0 || seatsIdx < 0) {
        setError("Preallocations CSV must include bench_id, day (or days), seats headers.");
        setImportFeedback((prev) => ({ ...prev, preallocations: `Failed: ${file.name} (invalid headers)` }));
        return;
      }

      const parsed: PreallocationDraft[] = rows
        .slice(1)
        .map((row) => {
          const days = parsePreferredDays(row[dayIdx] ?? "");
          if (days.length === 0) {
            return null;
          }
          return {
            benchId: row[benchIdx],
            days,
            seats: Number(row[seatsIdx]),
            label: labelIdx >= 0 ? row[labelIdx] : "",
          };
        })
        .filter((item): item is PreallocationDraft => item !== null);

      setPreallocations(parsed);
      setError(null);
      setImportFeedback((prev) => ({
        ...prev,
        preallocations: `Imported: ${file.name} at ${new Date().toLocaleTimeString()}`,
      }));
    } finally {
      input.value = "";
    }
  }

  function buildPayload(): PlannerInput {
    const payloadFallbackFloorId = floors[0]?.id ?? "F1";
    const normalizedBenches = benches.map((bench) => ({
      id: bench.id.trim(),
      capacity: Number(bench.capacity),
      order: Number(bench.order),
      floorId: normalizeFloorId(bench.floorId, payloadFallbackFloorId),
      layout: bench.layout
        ? {
            x: Number(bench.layout.x),
            y: Number(bench.layout.y),
            w: Number(bench.layout.w),
            h: Number(bench.layout.h),
            rotation: normalizeRotation(Number(bench.layout.rotation ?? 0)),
          }
        : undefined,
    }));
    const benchFloorByPayloadId = new Map<string, string>();
    normalizedBenches.forEach((bench) => {
      benchFloorByPayloadId.set(bench.id, normalizeFloorId(bench.floorId, payloadFallbackFloorId));
    });
    const normalizedTeams = teams.map((team) => ({
      id: team.id.trim(),
      floorId: resolveTeamFloorId(team, benchFloorByPayloadId, payloadFallbackFloorId),
      size: Number(team.size),
      targetDays: Number(team.targetDays),
      preferredDays: team.preferredDays,
      contiguousDaysRequired: !!team.contiguousDaysRequired,
      anchorBenchId: (team.anchorBenchId ?? "").trim(),
      anchorSeats: Math.max(0, Number(team.anchorSeats) || 0),
    }));
    const teamFloorByPayloadId = new Map<string, string>();
    normalizedTeams.forEach((team) => {
      teamFloorByPayloadId.set(team.id, normalizeFloorId(team.floorId, payloadFallbackFloorId));
    });

    return {
      benches: normalizedBenches,
      teams: normalizedTeams,
      preallocations: preallocationItems.map((item) => ({
        benchId: item.benchId.trim(),
        day: item.day,
        seats: Number(item.seats),
        label: item.label,
      })),
      flexPolicy: {
        defaultPercent: Number(flexDefault),
        overrides: flexOverrides,
        rounding: "nearest",
      },
      solverMode,
      proximityRequests: proximityRequests
        .filter((item) => item.teamA.trim() && item.teamB.trim() && item.teamA.trim() !== item.teamB.trim())
        .map((item) => ({
          teamA: item.teamA.trim(),
          teamB: item.teamB.trim(),
          floorId:
            normalizeFloorId(item.floorId, "") ||
            teamFloorByPayloadId.get(item.teamA.trim()) ||
            teamFloorByPayloadId.get(item.teamB.trim()) ||
            payloadFallbackFloorId,
          strength: Math.max(1, Math.min(5, Number(item.strength) || 1)),
          strict: !!item.strict,
          days: toDayArray(item.days && item.days.length > 0 ? item.days : DAYS),
        })),
      benchStabilityWeight: Math.max(0, Math.min(10, Number(benchStabilityWeight) || 0)),
    };
  }

  async function runPlanner() {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });

      const json = await response.json();
      if (!response.ok) {
        setError((json.errors ?? ["Planner failed"]).join(" "));
        setResult(null);
      } else {
        setResult(json as PlannerResponse);
      }
    } catch {
      setError("Unable to call planner API.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function formatBlockLabel(item: AllocationBlock): string {
    if (item.kind === "flex") {
      return `FLEX (${item.seats})`;
    }
    if (item.kind === "prealloc") {
      return `${item.teamId || "Prealloc"} (${item.seats})`;
    }
    return `${item.teamId ?? "Team"} (${item.seats})`;
  }

  function moveAllocation(blockId: string, benchId: string, day: Day, swapWithBlockId?: string) {
    const moving = manualAllocations.find((item) => item.id === blockId);
    if (!moving) {
      return;
    }
    const targetFloorId = normalizeFloorId(benchFloorById.get(benchId), selectedFloorKey);
    if (moving.kind === "team" && moving.teamId) {
      const teamFloorId = teamFloorById.get(moving.teamId) ?? selectedFloorKey;
      if (teamFloorId !== targetFloorId) {
        setManualError(
          `Cannot move ${formatBlockLabel(moving)} to ${benchId} ${day}. Team ${moving.teamId} is assigned to floor ${teamFloorId}.`,
        );
        return;
      }
    }

    setSelectedAllocationId(blockId);
    if (moving.benchId === benchId && moving.day === day) {
      return;
    }
    const targetKey = `${benchId}-${day}`;
    const sourceKey = `${moving.benchId}-${moving.day}`;
    const targetCapacity = cellCapacity[targetKey] ?? 0;
    const sourceCapacity = cellCapacity[sourceKey] ?? 0;
    const targetBlocks = manualAllocations.filter((item) => item.id !== blockId && item.benchId === benchId && item.day === day);
    const targetUsed = targetBlocks
      .reduce((acc, item) => acc + item.seats, 0);
    if (targetUsed + moving.seats <= targetCapacity) {
      setManualAllocations((prev) =>
        prev.map((item) => (item.id === blockId ? { ...item, benchId, day } : item)),
      );
      setManualError(null);
      return;
    }

    const sourceUsedWithoutMoving = manualAllocations
      .filter((item) => item.id !== blockId && item.benchId === moving.benchId && item.day === moving.day)
      .reduce((acc, item) => acc + item.seats, 0);
    const orderedCandidates = (() => {
      const candidates = targetBlocks.filter((item) => (swapWithBlockId ? item.id === swapWithBlockId : true));
      return [...candidates].sort((a, b) => {
        const kindPenaltyA = a.kind === moving.kind ? 0 : 1;
        const kindPenaltyB = b.kind === moving.kind ? 0 : 1;
        if (kindPenaltyA !== kindPenaltyB) {
          return kindPenaltyA - kindPenaltyB;
        }
        return Math.abs(a.seats - moving.seats) - Math.abs(b.seats - moving.seats);
      });
    })();

    const swapCandidate = orderedCandidates.find((candidate) => {
      const nextTargetUsed = targetUsed - candidate.seats + moving.seats;
      const nextSourceUsed = sourceUsedWithoutMoving + candidate.seats;
      return nextTargetUsed <= targetCapacity && nextSourceUsed <= sourceCapacity;
    });

    if (!swapCandidate) {
      const targetProjected = targetUsed + moving.seats;
      setManualError(
        `Cannot move ${formatBlockLabel(moving)} to ${benchId} ${day}. Capacity would be exceeded (${targetProjected}/${targetCapacity}). Try dropping on a specific chip to swap.`,
      );
      return;
    }

    setManualAllocations((prev) =>
      prev.map((item) => {
        if (item.id === blockId) {
          return { ...item, benchId, day };
        }
        if (item.id === swapCandidate.id) {
          return { ...item, benchId: moving.benchId, day: moving.day };
        }
        return item;
      }),
    );
    setManualError(null);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (isTextEntryElement(event.target)) {
        return;
      }
      if (event.key === "Escape") {
        if (activeDragId || chipDragPreview || layoutDrag) {
          event.preventDefault();
          setActiveDragId(null);
          setChipDragPreview(null);
          setLayoutDrag(null);
          return;
        }
        if (selectedAllocationId) {
          event.preventDefault();
          setSelectedAllocationId(null);
        }
        return;
      }
      if (!selectedAllocationId) {
        return;
      }

      const selected = manualAllocations.find((item) => item.id === selectedAllocationId);
      if (!selected || selected.kind === "prealloc") {
        return;
      }
      const benchesForKeyboard =
        normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? benchesInResultScope : benchesOnSelectedFloor;
      const selectedBenchFloorId = normalizeFloorId(benchFloorById.get(selected.benchId), selectedFloorKey);
      if (normalizedResultFloorScopeId !== OUTPUT_SCOPE_ALL && selectedBenchFloorId !== selectedFloorKey) {
        return;
      }
      const dayIndexCurrent = DAYS.indexOf(selected.day);
      const benchIndexCurrent = benchesForKeyboard.findIndex((bench) => bench.id === selected.benchId);
      if (dayIndexCurrent < 0 || benchIndexCurrent < 0) {
        return;
      }

      let nextDayIndex = dayIndexCurrent;
      let nextBenchIndex = benchIndexCurrent;
      switch (event.key) {
        case "ArrowLeft":
          nextDayIndex = dayIndexCurrent - 1;
          break;
        case "ArrowRight":
          nextDayIndex = dayIndexCurrent + 1;
          break;
        case "ArrowUp":
          nextBenchIndex = benchIndexCurrent - 1;
          break;
        case "ArrowDown":
          nextBenchIndex = benchIndexCurrent + 1;
          break;
        default:
          return;
      }
      if (
        nextDayIndex < 0 ||
        nextDayIndex >= DAYS.length ||
        nextBenchIndex < 0 ||
        nextBenchIndex >= benchesForKeyboard.length
      ) {
        return;
      }
      event.preventDefault();
      moveAllocation(selected.id, benchesForKeyboard[nextBenchIndex].id, DAYS[nextDayIndex]);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    activeDragId,
    benchFloorById,
    benchesInResultScope,
    benchesOnSelectedFloor,
    chipDragPreview,
    layoutDrag,
    manualAllocations,
    normalizedResultFloorScopeId,
    selectedAllocationId,
    selectedFloorKey,
  ]);

  function exportBenchPlanCsv() {
    const includeFloorColumn = normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL;
    const rows: string[][] = [includeFloorColumn ? ["floor", "bench", ...DAYS] : ["bench", ...DAYS]];
    for (const bench of benchesInResultScope) {
      const floorId = normalizeFloorId(bench.floorId, selectedFloorKey);
      rows.push([
        ...(includeFloorColumn ? [floorNameById.get(floorId) ?? floorId] : []),
        bench.id,
        ...DAYS.map((day) => {
          const prealloc = (preallocationMatrix[bench.id]?.[day] ?? []).map(formatBlockLabel);
          const plan = (allocationMatrix[bench.id]?.[day] ?? []).map(formatBlockLabel);
          return [...prealloc, ...plan].join(" | ");
        }),
      ]);
    }
    downloadCsv(`bench_day_plan_${resultScopeFileSuffix}.csv`, rows);
  }

  function exportTeamViewCsv() {
    const includeFloorColumn = normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL;
    const rows: string[][] = [includeFloorColumn ? ["floor", "team", "day", "bench", "seats"] : ["team", "day", "bench", "seats"]];
    const teamRows = manualAllocations
      .filter(
        (item) =>
          item.kind === "team" &&
          !!item.teamId &&
          teamIdsInResultScope.has(item.teamId ?? ""),
      )
      .sort((a, b) => {
        if ((a.teamId ?? "") !== (b.teamId ?? "")) {
          return (a.teamId ?? "").localeCompare(b.teamId ?? "");
        }
        if (a.day !== b.day) {
          return DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
        }
        return a.benchId.localeCompare(b.benchId);
      });

    for (const item of teamRows) {
      const floorId = normalizeFloorId(teamFloorById.get(item.teamId ?? ""), selectedFloorKey);
      rows.push([
        ...(includeFloorColumn ? [floorNameById.get(floorId) ?? floorId] : []),
        item.teamId ?? "",
        item.day,
        item.benchId,
        String(item.seats),
      ]);
    }

    downloadCsv(`team_view_plan_${resultScopeFileSuffix}.csv`, rows);
  }

  function exportBenchPlanA4Pdf() {
    if (!result) {
      return;
    }
    setError(null);
    setPrintGeneratedAt(new Date().toLocaleString());
    document.body.classList.add("bench-print-mode");
    let cleanupTimeout = 0;
    const cleanup = () => {
      window.clearTimeout(cleanupTimeout);
      document.body.classList.remove("bench-print-mode");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    cleanupTimeout = window.setTimeout(cleanup, 15000);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        window.print();
      });
    });
  }

  const explainability = useMemo(() => {
    if (!result) {
      return null;
    }
    const diagnostics = result.primary.diagnostics;
    const comparison = result.comparison.diagnostics;
    const teamRows = primaryTeamDiagnosticsInResultScope;
    const comparisonRows = comparisonTeamDiagnosticsInResultScope;
    const unmetTeams = teamRows.filter((row) => row.unmetDays > 0);
    const monFriIssues = teamRows.filter((row) => !row.monFriSatisfied);
    const fairnessWinners = teamDeltaInResultScope.filter((row) => row.delta > 0);
    const fairnessLosers = teamDeltaInResultScope.filter((row) => row.delta < 0);
    const scopedPrimaryMinRatio =
      teamRows.length > 0 ? Math.min(...teamRows.map((row) => row.fulfillmentRatio)) : diagnostics.fairnessMinRatio;
    const scopedComparisonMinRatio =
      comparisonRows.length > 0 ? Math.min(...comparisonRows.map((row) => row.fulfillmentRatio)) : comparison.fairnessMinRatio;
    const scopedContiguityPenalty = teamsInResultScope.reduce((acc, team) => {
      if (!team.contiguousDaysRequired) {
        return acc;
      }
      return teamContiguousStatus.get(team.id) ? acc : acc + 1;
    }, 0);

    return {
      diagnostics,
      comparison,
      unmetTeams,
      monFriIssues,
      fairnessWinners,
      fairnessLosers,
      scopedPrimaryMinRatio,
      scopedComparisonMinRatio,
      scopedContiguityPenalty,
    };
  }, [
    comparisonTeamDiagnosticsInResultScope,
    primaryTeamDiagnosticsInResultScope,
    result,
    teamContiguousStatus,
    teamDeltaInResultScope,
    teamsInResultScope,
  ]);

  return (
    <main className="page">
      <section className="hero">
        <p className="kicker">Office Allocation Planner</p>
        <h1>Build weekly bench-by-day plans with fairness-first scheduling</h1>
        <p>
          Configure benches, teams, pre-allocations, and flex targets. The planner enforces capacity and full-team attendance
          days, then compares fairness-first vs efficiency-first outcomes.
        </p>
      </section>

      <section className={`workspace-bar is-${planHealth.level}`}>
        <div className="workspace-bar-row">
          <div className="workspace-summary">
            <strong>{planHealth.title}</strong>
            <span>
              Active floor: <strong>{selectedFloor?.name ?? selectedFloorKey}</strong>
            </span>
            <span>
              Output scope: <strong>{resultScopeLabel}</strong>
            </span>
            <span>
              Steps: {planHealth.completion}/{planHealth.total}
            </span>
          </div>
          <div className="workspace-status">
            <span className={`workspace-chip ${planHealth.errorCount > 0 ? "is-error" : "is-ok"}`}>
              Errors {planHealth.errorCount}
            </span>
            <span className={`workspace-chip ${planHealth.warningCount > 0 ? "is-warning" : "is-ok"}`}>
              Warnings {planHealth.warningCount}
            </span>
            <span className={`workspace-chip ${workspaceStatus.overCapacityFloors > 0 ? "is-warning" : "is-ok"}`}>
              Floor pressure {workspaceStatus.overCapacityFloors}
            </span>
            <span className={`workspace-chip ${workspaceStatus.generated ? "is-ok" : "is-muted"}`}>
              {workspaceStatus.generated ? "Plan generated" : "Plan not generated"}
            </span>
            {normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? (
              <span className="workspace-chip is-info">All floors selected for outputs</span>
            ) : null}
          </div>
        </div>
        <div className="workspace-floor-switch">
          <span className="workspace-floor-label">Floor scope</span>
          {useFloorDropdown ? (
            <div className="workspace-floor-switch-controls">
              <select value={selectedFloorKey} onChange={(event) => selectWorkspaceFloor(event.target.value)}>
                {floors.map((floor) => (
                  <option key={`workspace-switch-${floor.id}`} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`workspace-floor-result-tab ${normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? "is-active" : ""}`}
                onClick={selectAllFloorsForResults}
              >
                All floors (results)
              </button>
            </div>
          ) : (
            <div className="workspace-floor-switch-controls">
              <div className="workspace-floor-tabs">
                {floors.map((floor) => (
                  <button
                    type="button"
                    key={`workspace-tab-${floor.id}`}
                    className={floor.id === selectedFloorKey ? "is-active" : ""}
                    onClick={() => selectWorkspaceFloor(floor.id)}
                  >
                    {floor.name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`workspace-floor-result-tab ${normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? "is-active" : ""}`}
                onClick={selectAllFloorsForResults}
              >
                All floors (results)
              </button>
            </div>
          )}
        </div>
      </section>

      {(actionableValidationIssues.length > 0 || error) ? (
        <section className="panel validation-panel">
          <div className="validation-head">
            <h2>Validation & Quick Fixes</h2>
            <p className="subtle">Resolve issues before generating or sharing. One-click fixes apply safe defaults.</p>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <ul className="validation-list">
            {actionableValidationIssues.map((issue) => (
                <li key={issue.id} className={`validation-item is-${issue.level}`}>
                  <span className={`validation-dot is-${issue.level}`} />
                  <span className="validation-message">{issue.message}</span>
                  {issue.fixCode && issue.fixLabel ? (
                    <button type="button" onClick={() => applyValidationFix(issue.fixCode!)}>
                      {issue.fixLabel}
                    </button>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <section className="panel scenario-panel">
        <div className="scenario-head">
          <h2>Scenarios</h2>
          <p className="subtle">Create alternatives, duplicate quickly, and keep drafts auto-saved in your browser.</p>
        </div>
        <div className="scenario-grid">
          <label>
            Active scenario
            <select value={activeScenario?.id ?? ""} onChange={(event) => switchScenario(event.target.value)}>
              {scenarios.map((scenario) => (
                <option key={`scenario-${scenario.id}`} value={scenario.id}>
                  {scenario.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Scenario name
            <input
              value={activeScenario?.name ?? ""}
              onChange={(event) => renameActiveScenario(event.target.value)}
              placeholder="Scenario name"
            />
          </label>
          <div className="scenario-actions">
            <button onClick={createScenario}>New scenario</button>
            <button onClick={duplicateScenario} disabled={!activeScenario}>
              Duplicate
            </button>
            <button onClick={deleteActiveScenario} disabled={scenarios.length <= 1}>
              Delete
            </button>
          </div>
        </div>
        <p className="metric-row">{autosaveStatus}</p>
      </section>

      <section className="panel floor-scope-panel">
        <div className="scenario-head">
          <h2>Floor Workspace</h2>
          <p className="subtle">
            Top-level floor scope for benches, teams, proximity, pre-allocations, and manual Bench x Day adjustments.
          </p>
        </div>
        <div className="floor-scope-grid">
          <div className="floor-admin-card">
            <h3>Floor Management</h3>
            <label>
              Floor name
              <input value={selectedFloor?.name ?? ""} onChange={(event) => renameSelectedFloor(event.target.value)} />
            </label>
            <div className="floor-admin-actions">
              <button type="button" onClick={addFloor}>
                Add floor
              </button>
              <button type="button" onClick={removeSelectedFloor} disabled={!canRemoveSelectedFloor}>
                Remove floor
              </button>
            </div>
            <p className="subtle">
              You can remove a floor only when it has no benches, teams, pre-allocations, or proximity requests.
            </p>
          </div>
          <div className="floor-summary-card">
            <p className="metric-row">Use the sticky floor tabs above to switch workspace scope.</p>
            <p className="metric-row">
              {selectedFloorConstraints
                ? `${selectedFloorConstraints.floorName}: ${selectedFloorConstraints.benchCount} benches, ${selectedFloorConstraints.capacitySeats} seats, ${selectedFloorConstraints.teamCount} teams, ${selectedFloorConstraints.teamHeadcount} people`
                : "No floor selected."}
            </p>
          </div>
        </div>
        <table className="floor-constraints-table">
          <thead>
            <tr>
              <th>Floor</th>
              <th>Benches</th>
              <th>Seats</th>
              <th>Teams</th>
              <th>Headcount</th>
              <th>Anchored teams</th>
              <th>Demand (seat-days)</th>
              <th>Prealloc (seat-days)</th>
              <th>Strict proximity</th>
              <th>Demand vs net cap</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {floorConstraintRows.map((row) => (
              <tr
                key={`floor-constraint-${row.floorId}`}
                className={row.floorId === selectedFloorKey ? "is-active-floor-row" : ""}
              >
                <td>{row.floorName}</td>
                <td>{row.benchCount}</td>
                <td>{row.capacitySeats}</td>
                <td>{row.teamCount}</td>
                <td>{row.teamHeadcount}</td>
                <td>{row.anchoredTeams}</td>
                <td>{row.demandSeatDays}</td>
                <td>{row.preallocatedSeatDays}</td>
                <td>{row.strictProximityRows}</td>
                <td>{row.demandRatio === null ? "n/a" : `${row.demandRatio.toFixed(1)}%`}</td>
                <td>
                  <button type="button" onClick={() => setSelectedFloorId(row.floorId)}>
                    Focus
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <CollapsibleSection
        className="grid-two"
        title="Data Exchange"
        description="One place for all imports and exports."
        defaultOpen={false}
      >
        <div>
          <h3>Import Data</h3>
          <p className="subtle">CSV imports replace one table. JSON imports restore full sessions or bench layouts.</p>
          <div className="template-links">
            <a href="/templates/benches.csv" download>
              benches.csv
            </a>
            <a href="/templates/teams.csv" download>
              teams.csv
            </a>
            <a href="/templates/preallocations.csv" download>
              preallocations.csv
            </a>
          </div>
          <label>
            Session config JSON
            <input type="file" accept=".json,application/json" onChange={importSessionConfig} />
          </label>
          {importFeedback.config ? <p className="file-note">{importFeedback.config}</p> : null}
          <label>
            Benches CSV
            <input type="file" accept=".csv" onChange={handleBenchCsv} />
          </label>
          {importFeedback.benches ? <p className="file-note">{importFeedback.benches}</p> : null}
          <label>
            Teams CSV
            <input type="file" accept=".csv" onChange={handleTeamCsv} />
          </label>
          {importFeedback.teams ? <p className="file-note">{importFeedback.teams}</p> : null}
          <label>
            Preallocations CSV
            <input type="file" accept=".csv" onChange={handlePreallocationCsv} />
          </label>
          {importFeedback.preallocations ? <p className="file-note">{importFeedback.preallocations}</p> : null}
          <label>
            Layout profile JSON
            <input type="file" accept=".json,application/json" onChange={importLayoutProfile} />
          </label>
        </div>

        <div>
          <h3>Export Data</h3>
          <p className="subtle">
            Exported files use output scope <strong>{resultScopeLabel}</strong>.
          </p>
          <div className="export-actions">
            <button onClick={exportSessionConfig}>Export full config (JSON)</button>
            <button onClick={exportLayoutProfile}>Export layout profile (JSON)</button>
            <button onClick={exportBenchPlanCsv} disabled={!result}>
              Export bench x day CSV
            </button>
            <button onClick={exportTeamViewCsv} disabled={!result}>
              Export team view CSV
            </button>
            <button onClick={exportBenchPlanA4Pdf} disabled={!result}>
              Export Bench x Day A4 PDF
            </button>
          </div>
          {!result ? <p className="metric-row">Generate a plan to enable schedule exports (CSV/PDF).</p> : null}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 0: Policy"
        description="Choose solver priority and flex target policy."
        defaultOpen
      >
        <div>
          <h3>Policy</h3>
          <p className="subtle">Fairness can be switched at run time.</p>
          <label>
            Solver mode
            <select value={solverMode} onChange={(e) => setSolverMode(e.target.value as "fairness_first" | "efficiency_first")}>
              <option value="fairness_first">Fairness-first</option>
              <option value="efficiency_first">Efficiency-first</option>
            </select>
          </label>
          <label>
            Flex target default % of total seats
            <input type="number" value={flexDefault} min={0} max={100} onChange={(e) => setFlexDefault(Number(e.target.value))} />
          </label>
          <div className="flex-grid">
            {DAYS.map((day) => (
              <label key={day}>
                {day} override %
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={flexOverrides[day] ?? ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    setFlexOverrides((prev) => ({ ...prev, [day]: value === "" ? undefined : Number(value) }));
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            Bench stability weight (0-10)
            <input
              type="number"
              min={0}
              max={10}
              value={benchStabilityWeight}
              onChange={(e) => setBenchStabilityWeight(Number(e.target.value))}
            />
          </label>
          <p className={paletteAudit.ok ? "metric-row" : "warning"}>
            Palette check (~30 teams): {paletteAudit.ok ? "OK" : "Needs adjustment"} | min distance{" "}
            {paletteAudit.minDistance.toFixed(1)} (target {paletteAudit.target}, palette slots {paletteAudit.paletteSize})
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 1: Benches"
        description={`Define benches for ${selectedFloor?.name ?? selectedFloorKey}. Benches are floor-scoped and cannot be moved between floors.`}
        defaultOpen={false}
      >
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Capacity</th>
              <th>Order</th>
              <th>Floor</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {benchesOnSelectedFloorWithIndex.map(({ bench, index }) => (
              <tr key={`bench-${index}`}>
                <td>
                  <input
                    value={bench.id}
                    onChange={(e) => updateBench(index, { id: e.target.value })}
                    onBlur={(e) => normalizeBenchIdAtIndex(index, e.target.value)}
                    placeholder={`${selectedFloorKey}-B#`}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={bench.capacity}
                    onChange={(e) => updateBench(index, { capacity: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input type="number" value={bench.order} onChange={(e) => updateBench(index, { order: Number(e.target.value) })} />
                </td>
                <td>
                  <span>{selectedFloor?.name ?? normalizeFloorId(bench.floorId, selectedFloorKey)}</span>
                </td>
                <td>
                  <button onClick={() => setBenches((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
            ))}
            {benchesOnSelectedFloorWithIndex.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <span className="subtle">No benches on this floor yet.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <button
          onClick={() =>
            setBenches((prev) => {
              const used = new Set(prev.map((bench) => bench.id));
              let counter = 1;
              let candidate = `${selectedFloorKey}-B${counter}`;
              while (used.has(candidate)) {
                counter += 1;
                candidate = `${selectedFloorKey}-B${counter}`;
              }
              return [
                ...prev,
                {
                  id: candidate,
                  capacity: 8,
                  order: prev.length + 1,
                  floorId: selectedFloorKey,
                  layout: defaultLayoutForIndex(prev.length),
                },
              ];
            })
          }
        >
          Add bench
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 2: Floor Layout Editor"
        description="Place benches on the floor image, then rotate/resize for angled walls."
        defaultOpen={false}
      >
        <div className="layout-editor-controls">
          <div className="layout-control-card">
            <h3>Floor Image</h3>
            <div className="layout-toolbar">
              <div className="layout-floor-badge">Active floor: {selectedFloor?.name ?? selectedFloorKey}</div>
              <label>
                Floor image
                <input type="file" accept="image/*" onChange={handleFloorImageUpload} />
              </label>
            </div>
            <p className="subtle">Floor creation and naming are managed from the Floor Workspace panel.</p>
          </div>

          <div className="layout-control-card">
            <h3>View</h3>
            <div className="layout-toolbar">
              <div className="layout-view-controls">
                <button onClick={() => setLayoutView((prev) => ({ ...prev, scale: clamp(prev.scale * 0.9, 0.5, 4) }))}>-</button>
                <span>{Math.round(layoutView.scale * 100)}%</span>
                <button onClick={() => setLayoutView((prev) => ({ ...prev, scale: clamp(prev.scale * 1.1, 0.5, 4) }))}>+</button>
                <button onClick={resetLayoutView}>Reset view</button>
              </div>
              <label>
                Plan day view
                <select value={layoutDayView} onChange={(event) => setLayoutDayView(event.target.value as LayoutDayView)}>
                  <option value="off">Off (blank benches)</option>
                  {DAYS.map((day) => (
                    <option value={day} key={`layout-day-${day}`}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
              <label className="single-check heatmap-toggle">
                <input
                  type="checkbox"
                  checked={showHeatmap}
                  onChange={(event) => setShowHeatmap(event.target.checked)}
                  disabled={!isLayoutPlanViewActive}
                />
                Heatmap
              </label>
            </div>
          </div>
        </div>

        <div className="layout-editor-main">
          <div>
            <div
              className={`layout-canvas ${layoutDrag?.mode === "pan" ? "is-panning" : ""}`}
              ref={layoutCanvasRef}
              onMouseDown={startLayoutPan}
            >
              <div
                className="layout-scene"
                style={{
                  transform: `translate(${layoutView.offsetX}px, ${layoutView.offsetY}px) scale(${layoutView.scale})`,
                }}
              >
                {selectedFloor?.imageDataUrl ? (
                  <Image
                    src={selectedFloor.imageDataUrl}
                    alt={`${selectedFloor.name} layout`}
                    className="layout-image"
                    fill
                    sizes="100vw"
                    unoptimized
                  />
                ) : (
                  <div className="layout-placeholder">No floor image yet. Upload one to start bench positioning.</div>
                )}
                {benchesOnSelectedFloor.map((bench, index) => {
                  const layout = bench.layout ?? defaultLayoutForIndex(index);
                  const sizing = benchTextSizing(layout);
                  const labelMode = benchLabelMode(layout, bench.id);
                  const daySummary = layoutDaySummary.get(bench.id);
                  const isSelectedBench = selectedBenchId === bench.id;
                  const isDimmed = selectedBenchId !== null && !isSelectedBench;
                  const dominantTeamColor = isLayoutPlanViewActive && daySummary?.topTeamId
                    ? teamColorMap[daySummary.topTeamId] ??
                      TEAM_BASE_COLORS[hashTeam(daySummary.topTeamId) % TEAM_BASE_COLORS.length]
                    : "#0057b8";
                  const isEmptyBench = isLayoutPlanViewActive && (daySummary?.usedSeats ?? 0) === 0;
                  const occupancyRatio = bench.capacity > 0 ? (daySummary?.usedSeats ?? 0) / bench.capacity : 0;
                  const layerColor = showHeatmap && isLayoutPlanViewActive ? heatColorByRatio(occupancyRatio) : dominantTeamColor;
                  const dominantRgb = hexToRgb(layerColor);
                  const benchBgRgb: [number, number, number] = isEmptyBench
                    ? [230, 236, 242]
                    : mixRgb(dominantRgb, [255, 255, 255], isLayoutPlanViewActive ? 0.18 : 0.4);
                  const benchBg = rgbCss(benchBgRgb);
                  const benchBorder = isEmptyBench
                    ? "#8b9bad"
                    : rgbCss(mixRgb(hexToRgb(dominantTeamColor), [0, 0, 0], 0.15));
                  const darkText: [number, number, number] = [16, 42, 74];
                  const lightText: [number, number, number] = [255, 255, 255];
                  const benchText: [number, number, number] = isEmptyBench
                    ? [45, 65, 90]
                    : contrastRatio(benchBgRgb, darkText) >= contrastRatio(benchBgRgb, lightText)
                      ? darkText
                      : lightText;
                  const calloutLeft = clamp(layout.x + layout.w / 2, 3, 97);
                  const calloutTop = clamp(layout.y - 1, 2, 98);
                  const hoverTitle = (() => {
                    if (!isLayoutPlanViewActive) {
                      return `${bench.id} (${bench.capacity} seats)`;
                    }
                    const day = layoutDayView as Day;
                    const teamRows = (allocationMatrix[bench.id]?.[day] ?? []).filter((item) => item.kind === "team");
                    const teamTotals = new Map<string, number>();
                    teamRows.forEach((item) => {
                      if (!item.teamId) {
                        return;
                      }
                      teamTotals.set(item.teamId, (teamTotals.get(item.teamId) ?? 0) + item.seats);
                    });
                    const lines = [
                      `${bench.id} - ${day}`,
                      `Used: ${daySummary?.usedSeats ?? 0}/${bench.capacity}`,
                    ];
                    if (teamTotals.size === 0) {
                      lines.push("Teams: none");
                    } else {
                      lines.push(
                        ...Array.from(teamTotals.entries())
                          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                          .map(([teamId, seats]) => `${teamId}: ${seats}`),
                      );
                    }
                    if ((daySummary?.preallocatedSeats ?? 0) > 0) {
                      lines.push(`Preallocated: ${daySummary?.preallocatedSeats ?? 0}`);
                    }
                    if ((daySummary?.flexSeats ?? 0) > 0) {
                      lines.push(`Flex: ${daySummary?.flexSeats ?? 0}`);
                    }
                    return lines.join("\n");
                  })();
                  return (
                    <Fragment key={`layout-${bench.id}`}>
                      <div
                        className={[
                          "bench-block",
                          isSelectedBench ? "is-selected" : "",
                          isDimmed ? "is-dimmed" : "",
                          isEmptyBench ? "is-empty" : "",
                          labelMode === "vertical" ? "has-vertical-id" : "",
                          labelMode === "callout" ? "has-callout-id" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{
                          left: `${layout.x}%`,
                          top: `${layout.y}%`,
                          width: `${layout.w}%`,
                          height: `${layout.h}%`,
                          zIndex: isSelectedBench ? 40 : 2,
                          backgroundColor: benchBg,
                          borderColor: benchBorder,
                          borderStyle: isEmptyBench ? "dashed" : "solid",
                          color: rgbCss(benchText),
                          transform: `rotate(${normalizeRotation(Number(layout.rotation ?? 0))}deg)`,
                        }}
                        onMouseDown={(event) => {
                          if (!bench.layout) {
                            ensureBenchLayout(bench.id);
                          }
                          startLayoutDrag(event, { ...bench, layout });
                        }}
                        onClick={() => setSelectedBenchId((prev) => (prev === bench.id ? null : bench.id))}
                        title={hoverTitle}
                      >
                        {labelMode !== "callout" ? (
                          <span
                            className={`bench-id ${labelMode === "vertical" ? "is-vertical" : ""}`}
                            style={{ fontSize: `${sizing.title}px` }}
                          >
                            {bench.id}
                          </span>
                        ) : null}
                        <small className="bench-seat-value" style={{ fontSize: `${sizing.seat}px` }}>
                          <span className="bench-seat-pill">{bench.capacity}</span>
                        </small>
                        {isSelectedBench ? (
                          <>
                            <button
                              type="button"
                              className="bench-rotate-handle"
                              onMouseDown={(event) => startLayoutRotate(event, { ...bench, layout })}
                              onClick={(event) => event.stopPropagation()}
                              title={`Rotate ${bench.id}`}
                              aria-label={`Rotate ${bench.id}`}
                            />
                            <button
                              type="button"
                              className="bench-resize-handle"
                              onMouseDown={(event) => startLayoutResize(event, { ...bench, layout })}
                              onClick={(event) => event.stopPropagation()}
                              title={`Resize ${bench.id}`}
                              aria-label={`Resize ${bench.id}`}
                            />
                          </>
                        ) : null}
                      </div>
                      {labelMode === "callout" ? (
                        <button
                          type="button"
                          className={`bench-id-callout ${isSelectedBench ? "is-selected" : ""} ${isDimmed ? "is-dimmed" : ""}`.trim()}
                          style={{
                            left: `${calloutLeft}%`,
                            top: `${calloutTop}%`,
                            zIndex: isSelectedBench ? 52 : 8,
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                          onClick={() => setSelectedBenchId((prev) => (prev === bench.id ? null : bench.id))}
                          title={hoverTitle}
                        >
                          {bench.id}
                        </button>
                      ) : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>
            <p className="metric-row">
              Tips: Click a bench to focus it. Drag empty canvas to pan. Scroll to zoom. Drag the top circular handle to rotate
              (hold Shift to snap by 15 degrees), and drag the subtle bottom-right corner grip to resize.
              {isLayoutPlanViewActive
                ? ` Day overlay reflects ${layoutDayView} allocations from the current plan.`
                : " Plan overlay is OFF. Switch to a day to preview allocations on benches."}
            </p>
            {isLayoutPlanViewActive && showHeatmap ? (
              <div className="heatmap-legend">
                <span>Heatmap</span>
                <div className="heatmap-scale">
                  <i style={{ backgroundColor: "#19a974" }} />
                  <i style={{ backgroundColor: "#5dbb63" }} />
                  <i style={{ backgroundColor: "#e0a100" }} />
                  <i style={{ backgroundColor: "#e36c0a" }} />
                  <i style={{ backgroundColor: "#c1373d" }} />
                </div>
                <small>Low occupancy</small>
                <small>High occupancy</small>
              </div>
            ) : null}
            {isLayoutPlanViewActive && selectedBenchDaySummary ? (
              <p className="metric-row">
                {selectedBenchDaySummary.bench.id} {layoutDayView}: {selectedBenchDaySummary.summary.usedSeats}/
                {selectedBenchDaySummary.bench.capacity} used | team {selectedBenchDaySummary.summary.teamSeats} | prealloc{" "}
                {selectedBenchDaySummary.summary.preallocatedSeats} | flex {selectedBenchDaySummary.summary.flexSeats}
                {selectedBenchDaySummary.summary.topTeamId ? ` | top team ${selectedBenchDaySummary.summary.topTeamId}` : ""}
              </p>
            ) : null}
          </div>

          <aside className="layout-inspector">
            <h3>Bench Inspector</h3>
            {selectedBenchOnFloor ? (
              <>
                <p className="metric-row">
                  <strong>{selectedBenchOnFloor.id}</strong> | {selectedBenchOnFloor.capacity} seats
                </p>
                <div className="layout-inspector-grid">
                  <label>
                    X (%)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedBenchOnFloor.layout ? Number(selectedBenchOnFloor.layout.x.toFixed(1)) : 0}
                      onChange={(event) => updateSelectedBenchLayout({ x: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Y (%)
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      value={selectedBenchOnFloor.layout ? Number(selectedBenchOnFloor.layout.y.toFixed(1)) : 0}
                      onChange={(event) => updateSelectedBenchLayout({ y: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Width (%)
                    <input
                      type="number"
                      min={2}
                      max={100}
                      step={0.1}
                      value={selectedBenchOnFloor.layout ? Number(selectedBenchOnFloor.layout.w.toFixed(1)) : 0}
                      onChange={(event) => updateSelectedBenchLayout({ w: Number(event.target.value) })}
                    />
                  </label>
                  <label>
                    Height (%)
                    <input
                      type="number"
                      min={1.5}
                      max={100}
                      step={0.1}
                      value={selectedBenchOnFloor.layout ? Number(selectedBenchOnFloor.layout.h.toFixed(1)) : 0}
                      onChange={(event) => updateSelectedBenchLayout({ h: Number(event.target.value) })}
                    />
                  </label>
                </div>
                <div className="layout-rotation-controls">
                  <span>Rotation</span>
                  <button
                    onClick={() => updateSelectedBenchRotation(Number(selectedBenchOnFloor?.layout?.rotation ?? 0) - 15)}
                  >
                    -15°
                  </button>
                  <input
                    type="number"
                    min={-180}
                    max={180}
                    step={1}
                    value={selectedBenchOnFloor ? Math.round(Number(selectedBenchOnFloor.layout?.rotation ?? 0)) : 0}
                    onChange={(event) => updateSelectedBenchRotation(Number(event.target.value))}
                  />
                  <button
                    onClick={() => updateSelectedBenchRotation(Number(selectedBenchOnFloor?.layout?.rotation ?? 0) + 15)}
                  >
                    +15°
                  </button>
                  <button onClick={() => updateSelectedBenchRotation(0)}>Reset</button>
                </div>
              </>
            ) : (
              <p className="subtle">Select a bench on the canvas to edit position, size, and rotation.</p>
            )}
          </aside>
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 3: Teams"
        description={`Set teams for ${selectedFloor?.name ?? selectedFloorKey}. Teams are now floor-scoped and cannot be allocated across floors.`}
        defaultOpen={false}
      >
        <table className="teams-input-table">
          <thead>
            <tr>
              <th>Team</th>
              <th className="col-size">Size</th>
              <th>Target days</th>
              <th>Contiguous required</th>
              <th>Anchor bench</th>
              <th>Anchor seats</th>
              <th>Preferred days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {teamsOnSelectedFloorWithIndex.map(({ team, index: teamIndex }) => (
              <tr key={`team-${teamIndex}`}>
                <td>
                  <input value={team.id} onChange={(e) => updateTeam(teamIndex, { id: e.target.value })} />
                </td>
                <td className="col-size">
                  <input
                    className="input-size"
                    type="number"
                    value={team.size}
                    onChange={(e) => updateTeam(teamIndex, { size: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={team.targetDays}
                    onChange={(e) => updateTeam(teamIndex, { targetDays: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <label className="single-check">
                    <input
                      type="checkbox"
                      checked={team.contiguousDaysRequired}
                      onChange={(e) => updateTeam(teamIndex, { contiguousDaysRequired: e.target.checked })}
                    />
                    Yes
                  </label>
                </td>
                <td>
                  <select
                    value={team.anchorBenchId ?? ""}
                    onChange={(e) => {
                      const nextAnchorBenchId = e.target.value;
                      if (!nextAnchorBenchId) {
                        updateTeam(teamIndex, { anchorBenchId: "", anchorSeats: 0 });
                        return;
                      }
                      const currentAnchorSeats = Math.max(0, Number(team.anchorSeats) || 0);
                      updateTeam(teamIndex, {
                        anchorBenchId: nextAnchorBenchId,
                        anchorSeats: currentAnchorSeats > 0 ? currentAnchorSeats : 1,
                      });
                    }}
                  >
                    <option value="">None</option>
                    {benchesOnSelectedFloor.map((bench) => (
                      <option key={`team-anchor-${teamIndex}-${bench.id}`} value={bench.id}>
                        {bench.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={team.anchorBenchId ? 1 : 0}
                    max={team.size}
                    value={team.anchorSeats ?? 0}
                    disabled={!team.anchorBenchId}
                    onChange={(e) => updateTeam(teamIndex, { anchorSeats: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </td>
                <td>
                  <div className="days-inline">
                    {DAYS.map((day) => (
                      (() => {
                        const requested = team.preferredDays.includes(day);
                        const assigned = (assignedDaysByTeam.get(team.id) ?? new Set<Day>()).has(day);
                        const dayStatusClass = result
                          ? requested
                            ? assigned
                              ? "team-day-match"
                              : "team-day-request-only"
                            : assigned
                              ? "team-day-assigned-only"
                              : "team-day-none"
                          : "";
                        return (
                      <label key={`team-${teamIndex}-${day}`} className={dayStatusClass}>
                        <input
                          type="checkbox"
                          checked={requested}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updateTeam(teamIndex, { preferredDays: [...team.preferredDays, day] });
                            } else {
                              updateTeam(teamIndex, { preferredDays: team.preferredDays.filter((item) => item !== day) });
                            }
                          }}
                        />
                        {day}
                      </label>
                        );
                      })()
                    ))}
                  </div>
                </td>
                <td>
                  <button onClick={() => setTeams((prev) => prev.filter((_, i) => i !== teamIndex))}>Delete</button>
                </td>
              </tr>
            ))}
            {teamsOnSelectedFloorWithIndex.length === 0 ? (
              <tr>
                <td colSpan={8}>
                  <span className="subtle">No teams on this floor yet.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <button
          onClick={() =>
            setTeams((prev) => [
              ...prev,
              {
                id: `Team${prev.filter((team) => resolveTeamFloorId(team, benchFloorById, selectedFloorKey) === selectedFloorKey).length + 1}`,
                floorId: selectedFloorKey,
                size: 6,
                targetDays: 2,
                preferredDays: ["Tue", "Thu"],
                contiguousDaysRequired: false,
                anchorBenchId: "",
                anchorSeats: 0,
              },
            ])
          }
        >
          Add team
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 4: Team Proximity Requests"
        description={`Optional floor-scoped proximity for ${selectedFloor?.name ?? selectedFloorKey}. Strict mode treats pairs as one placement group. Red dot = request currently unmet.`}
        defaultOpen={false}
      >
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Team A</th>
              <th>Team B</th>
              <th>Strength (1-5)</th>
              <th>Strict as one group</th>
              <th>Enforced days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {proximityRequestsOnSelectedFloorWithIndex.map(({ item, index }) => {
              const status = proximityRequestStatuses[index] ?? { status: "na", unmetDays: [] as Day[] };
              const statusTitle =
                status.status === "unmet"
                  ? `Unmet on ${status.unmetDays.join(", ")}`
                  : status.status === "met"
                    ? "Request met on active overlap days"
                    : "Not evaluated yet (or teams do not overlap on selected days)";
              return (
              <tr key={`prox-${index}`}>
                <td>
                  <span
                    className={`prox-status-dot prox-status-${status.status}`}
                    title={statusTitle}
                    aria-label={statusTitle}
                  />
                </td>
                <td>
                  <select
                    value={item.teamA}
                    onChange={(event) => updateProximityRequest(index, { teamA: event.target.value })}
                  >
                    <option value="">Select team</option>
                    {teamOptionsOnSelectedFloor.map((teamId) => (
                      <option value={teamId} key={`prox-a-${index}-${teamId}`}>
                        {teamId}
                      </option>
                    ))}
                    {item.teamA && !teamOptionsOnSelectedFloor.includes(item.teamA) ? (
                      <option value={item.teamA}>{item.teamA} (missing)</option>
                    ) : null}
                  </select>
                </td>
                <td>
                  <select
                    value={item.teamB}
                    onChange={(event) => updateProximityRequest(index, { teamB: event.target.value })}
                  >
                    <option value="">Select team</option>
                    {teamOptionsOnSelectedFloor.map((teamId) => (
                      <option value={teamId} key={`prox-b-${index}-${teamId}`}>
                        {teamId}
                      </option>
                    ))}
                    {item.teamB && !teamOptionsOnSelectedFloor.includes(item.teamB) ? (
                      <option value={item.teamB}>{item.teamB} (missing)</option>
                    ) : null}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={item.strength}
                    onChange={(event) => updateProximityRequest(index, { strength: Number(event.target.value) })}
                  />
                </td>
                <td>
                  <label className="single-check">
                    <input
                      type="checkbox"
                      checked={!!item.strict}
                      onChange={(event) => updateProximityRequest(index, { strict: event.target.checked })}
                    />
                    Yes
                  </label>
                </td>
                <td>
                  <div className="days-inline">
                    {DAYS.map((day) => (
                      <label key={`prox-${index}-${day}`}>
                        <input
                          type="checkbox"
                          checked={(item.days ?? []).includes(day)}
                          onChange={(event) => {
                            const currentDays = toDayArray(item.days && item.days.length > 0 ? item.days : DAYS);
                            const nextDays = event.target.checked
                              ? [...currentDays, day]
                              : currentDays.filter((value) => value !== day);
                            updateProximityRequest(index, { days: toDayArray(nextDays) });
                          }}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <button onClick={() => setProximityRequests((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
              );
            })}
            {proximityRequestsOnSelectedFloorWithIndex.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <span className="subtle">No proximity requests on this floor yet.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <button
          onClick={() =>
            setProximityRequests((prev) => [
              ...prev,
              {
                teamA: teamOptionsOnSelectedFloor[0] ?? "",
                teamB: teamOptionsOnSelectedFloor[1] ?? teamOptionsOnSelectedFloor[0] ?? "",
                floorId: selectedFloorKey,
                strength: 3,
                strict: false,
                days: [...DAYS],
              },
            ])
          }
          disabled={teamOptionsOnSelectedFloor.length === 0}
        >
          Add proximity request
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 5: Pre-allocations"
        description={`Reserve seats on ${selectedFloor?.name ?? selectedFloorKey} before planning. Multiple days per row are supported.`}
        defaultOpen={false}
      >
        <table>
          <thead>
            <tr>
              <th>Bench</th>
              <th>Days</th>
              <th>Seats</th>
              <th>Label</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {preallocationsOnSelectedFloorWithIndex.map(({ item, index }) => (
              <tr key={`prealloc-${index}`}>
                <td>
                  <select value={item.benchId} onChange={(e) => updatePreallocation(index, { benchId: e.target.value })}>
                    {benchesOnSelectedFloor.map((bench) => (
                      <option key={`prealloc-bench-${index}-${bench.id}`} value={bench.id}>
                        {bench.id}
                      </option>
                    ))}
                    {!benchIdsOnSelectedFloor.has(item.benchId) ? <option value={item.benchId}>{item.benchId} (missing)</option> : null}
                  </select>
                </td>
                <td>
                  <div className="days-inline">
                    {DAYS.map((day) => (
                      <label key={`prealloc-${index}-${day}`}>
                        <input
                          type="checkbox"
                          checked={item.days.includes(day)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updatePreallocation(index, { days: [...item.days, day] });
                            } else {
                              updatePreallocation(index, { days: item.days.filter((value) => value !== day) });
                            }
                          }}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    value={item.seats}
                    onChange={(e) => updatePreallocation(index, { seats: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input value={item.label ?? ""} onChange={(e) => updatePreallocation(index, { label: e.target.value })} />
                </td>
                <td>
                  <button onClick={() => setPreallocations((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
            ))}
            {preallocationsOnSelectedFloorWithIndex.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <span className="subtle">No pre-allocations on this floor yet.</span>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        <button
          onClick={() =>
            setPreallocations((prev) => [
              ...prev,
              {
                benchId: benchesOnSelectedFloor[0]?.id ?? ensureFloorQualifiedBenchId("B1", selectedFloorKey),
                days: ["Mon"],
                seats: 1,
                label: "Reserved",
              },
            ])
          }
          disabled={benchesOnSelectedFloor.length === 0}
        >
          Add pre-allocation
        </button>
      </CollapsibleSection>

      <section className="panel run-panel">
        <p className="subtle run-step">Step 6: Generate the plan once setup is complete.</p>
        <button className="cta" onClick={runPlanner} disabled={loading}>
          {loading ? "Generating plan..." : "Generate plan"}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </section>

      {result ? (
        <>
          <section className="panel result-scope-panel">
            <label>
              Result scope
              <select value={normalizedResultFloorScopeId} onChange={(event) => setResultFloorScopeId(event.target.value)}>
                <option value={OUTPUT_SCOPE_ALL}>All floors</option>
                {allKnownFloorIds.map((floorId) => (
                  <option key={`result-scope-${floorId}`} value={floorId}>
                    {floorNameById.get(floorId) ?? floorId}
                  </option>
                ))}
              </select>
            </label>
            <p className="metric-row">Bench table, diagnostics, daily usage, CSV exports, and PDF use this scope.</p>
          </section>

          <CollapsibleSection
            title="Manual Adjustments"
            description="Drag chips across cells to fine-tune the generated plan."
            defaultOpen
          >
            <div>
              <p className="subtle">Drag allocation chips across cells to fine-tune the plan.</p>
              <p className="subtle">If a cell is full, drop on a specific chip to swap allocations.</p>
              <p className="subtle">Click a chip then use Arrow keys to move it. Press Esc to cancel drag or clear selection.</p>
              <p className="metric-row">Moved chips: {movedBlocksCount}</p>
              <button onClick={() => setManualAllocations(baselineAllocations)}>Reset manual moves</button>
              {manualError ? <p className="error">{manualError}</p> : null}
              {manualUsageWarnings.length ? (
                <p className="warning">Capacity warnings: {manualUsageWarnings.join(" | ")}</p>
              ) : (
                <p className="metric-row">No capacity violations in manual layout.</p>
              )}
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Bench x Day Plan"
            description={`Primary mode: ${result.primary.diagnostics.mode} | Scope: ${resultScopeLabel}`}
            defaultOpen
          >
            <p className="metric-row highlight-status">
              {selectedTeamId ? (
                <>
                  Highlighting team: <strong>{selectedTeamId}</strong> (click the same team chip again to clear)
                </>
              ) : (
                "No active highlight. Click a team chip to highlight all of that team."
              )}
            </p>
            <p className="metric-row fixed-status">FIXED chips are pre-allocated seats and cannot be moved.</p>
            <p className="metric-row">Bench stability preference weight: {benchStabilityWeight}/10.</p>
            {result.primary.diagnostics.relaxedApplied ? (
              <p className="warning">Exact targets were infeasible. Auto-relax was applied and unmet demand is shown below.</p>
            ) : null}
            {result.primary.diagnostics.strictProximityRelaxations.length > 0 ? (
              <p className="warning">
                Strict proximity auto-relaxed for: {result.primary.diagnostics.strictProximityRelaxations.join(" | ")}.
              </p>
            ) : null}
            {benchesInResultScope.length === 0 ? (
              <p className="warning">No benches found in this output scope.</p>
            ) : null}
            <div className="plan-table-wrap is-compact">
              <table className="plan-table">
                <thead>
                  <tr>
                    <th>{normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? "Floor / Bench (Seats)" : "Bench (Seats)"}</th>
                    {DAYS.map((day) => (
                      <th key={day}>{day}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {benchesInResultScope.map((bench) => {
                    const floorId = normalizeFloorId(bench.floorId, selectedFloorKey);
                    const floorLabel = floorNameById.get(floorId) ?? floorId;
                    return (
                    <tr key={bench.id}>
                      <td>
                        {normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? <span className="subtle">{floorLabel} / </span> : null}
                        <strong>{bench.id}</strong> ({bench.capacity})
                      </td>
                      {DAYS.map((day) => {
                        const cellKey = `${bench.id}-${day}`;
                        const availableSeats = availableSeatsByCell[cellKey] ?? 0;
                        const dayAllocations = allocationMatrix[bench.id]?.[day] ?? [];
                        const dayPreallocations = preallocationMatrix[bench.id]?.[day] ?? [];
                        return (
                          <td
                            key={cellKey}
                            className={activeDragId ? "drop-target" : undefined}
                            onDragOver={(event) => {
                              event.preventDefault();
                              if (!activeDragId) {
                                return;
                              }
                              setChipDragPreview((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      x: event.clientX - prev.offsetX,
                                      y: event.clientY - prev.offsetY,
                                    }
                                  : prev,
                              );
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const blockId = event.dataTransfer.getData("text/plain");
                              const target = event.target as HTMLElement;
                              const swapChip = target.closest<HTMLElement>("[data-swap-block-id]");
                              const swapWithBlockId = swapChip?.dataset.swapBlockId;
                              moveAllocation(blockId, bench.id, day, swapWithBlockId);
                              setChipDragPreview(null);
                              setActiveDragId(null);
                              setSelectedAllocationId(blockId || null);
                            }}
                          >
                            <div className="chip-stack">
                              {dayPreallocations.map((item) => (
                                <span key={item.id} className="alloc-chip alloc-chip-prealloc">
                                  {formatBlockLabel(item)}
                                </span>
                              ))}
                              {dayAllocations.map((item) => (
                                (() => {
                                  const className = [
                                    "alloc-chip",
                                    item.kind === "flex" ? "alloc-chip-flex" : "",
                                    item.id === selectedAllocationId ? "alloc-chip-selected" : "",
                                    item.kind === "team" && selectedTeamId
                                      ? item.teamId === selectedTeamId
                                        ? "alloc-chip-team-selected"
                                        : "alloc-chip-muted"
                                      : "",
                                    item.kind !== "team" && selectedTeamId ? "alloc-chip-muted" : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ");
                                  const style =
                                    item.kind === "team"
                                      ? teamChipStyle(
                                          teamColorMap[item.teamId ?? ""] ??
                                            TEAM_BASE_COLORS[hashTeam(item.teamId ?? "team") % TEAM_BASE_COLORS.length],
                                        )
                                      : undefined;
                                  return (
                                    <span
                                      key={item.id}
                                      className={className}
                                      draggable={item.kind !== "prealloc"}
                                      data-swap-block-id={item.id}
                                      onDragStart={(event) => {
                                        if (item.kind === "prealloc") {
                                          return;
                                        }
                                        const chipRect = event.currentTarget.getBoundingClientRect();
                                        const pointerOffsetX = Math.max(
                                          0,
                                          Math.min(chipRect.width - 1, event.clientX - chipRect.left),
                                        );
                                        const pointerOffsetY = Math.max(
                                          0,
                                          Math.min(chipRect.height - 1, event.clientY - chipRect.top),
                                        );
                                        event.dataTransfer.effectAllowed = "move";
                                        event.dataTransfer.setData("text/plain", item.id);
                                        const transparent = transparentDragImageRef.current;
                                        if (transparent) {
                                          event.dataTransfer.setDragImage(transparent, 0, 0);
                                        }
                                        setChipDragPreview({
                                          label: formatBlockLabel(item),
                                          className,
                                          style,
                                          x: event.clientX - pointerOffsetX,
                                          y: event.clientY - pointerOffsetY,
                                          offsetX: pointerOffsetX,
                                          offsetY: pointerOffsetY,
                                        });
                                        setSelectedAllocationId(item.id);
                                        setActiveDragId(item.id);
                                      }}
                                      onDragEnd={() => {
                                        if (item.kind !== "prealloc") {
                                          setChipDragPreview(null);
                                          setActiveDragId(null);
                                        }
                                      }}
                                      onDrag={(event) => {
                                        if (event.clientX <= 0 && event.clientY <= 0) {
                                          return;
                                        }
                                        setChipDragPreview((prev) =>
                                          prev
                                            ? {
                                                ...prev,
                                                x: event.clientX - prev.offsetX,
                                                y: event.clientY - prev.offsetY,
                                              }
                                            : prev,
                                        );
                                      }}
                                      onClick={() => {
                                        setSelectedAllocationId(item.id);
                                        if (item.kind !== "team" || !item.teamId) {
                                          return;
                                        }
                                        const teamId = item.teamId;
                                        setSelectedTeamId((prev) => (prev === teamId ? null : teamId));
                                      }}
                                      style={style}
                                    >
                                      {formatBlockLabel(item)}
                                    </span>
                                  );
                                })()
                              ))}
                              {availableSeats > 0 ? (
                                <span className="alloc-chip alloc-chip-flex alloc-chip-seat-availability">
                                  FLEX ({availableSeats})
                                </span>
                              ) : null}
                              {dayAllocations.length === 0 && dayPreallocations.length === 0 && availableSeats <= 0 ? (
                                <span className="empty-cell">-</span>
                              ) : null}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CollapsibleSection>

          <CollapsibleSection
            title="Outcome Diagnostics"
            description="Fulfillment, fairness impact, and key KPI tables."
            defaultOpen={false}
          >
            <div>
              <h3>Team Outcomes</h3>
              <p className="subtle">Fulfillment, unmet demand, and Monday/Friday rule.</p>
              <p className="subtle">Scope: {resultScopeLabel}</p>
              <p className="subtle">
                Day colors: <span className="team-day-chip team-day-match">requested + assigned</span>{" "}
                <span className="team-day-chip team-day-request-only">requested only</span>{" "}
                <span className="team-day-chip team-day-assigned-only">assigned only</span>{" "}
                <span className="team-day-chip team-day-none">none</span>
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Target</th>
                    <th>Assigned</th>
                    <th>Unmet</th>
                    <th>Ratio</th>
                    <th>Pref hits</th>
                    <th>Contiguous req</th>
                    <th>Contiguous met</th>
                    <th>Mon/Fri</th>
                    <th>Days (Req vs Assigned)</th>
                  </tr>
                </thead>
                <tbody>
                  {primaryTeamDiagnosticsInResultScope.map((row) => {
                    const requestedDays = new Set(teamRequirementMap.get(row.teamId)?.preferredDays ?? []);
                    const assignedDays = assignedDaysByTeam.get(row.teamId) ?? new Set<Day>();
                    return (
                    <tr key={row.teamId}>
                      <td>{row.teamId}</td>
                      <td>{row.targetDays}</td>
                      <td>{row.assignedDays}</td>
                      <td>{row.unmetDays}</td>
                      <td>{row.fulfillmentRatio.toFixed(2)}</td>
                      <td>{row.preferredHits}</td>
                      <td>{teamRequirementMap.get(row.teamId)?.contiguousDaysRequired ? "Yes" : "No"}</td>
                      <td>{teamContiguousStatus.get(row.teamId) ? "Yes" : "No"}</td>
                      <td>{row.monFriSatisfied ? "Yes" : "No"}</td>
                      <td>
                        <div className="team-day-row">
                          {DAYS.map((day) => {
                            const requested = requestedDays.has(day);
                            const assigned = assignedDays.has(day);
                            const statusClass = requested
                              ? assigned
                                ? "team-day-match"
                                : "team-day-request-only"
                              : assigned
                                ? "team-day-assigned-only"
                                : "team-day-none";
                            return (
                              <span key={`${row.teamId}-${day}`} className={`team-day-chip ${statusClass}`}>
                                {day}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                    );
                  })}
                  {primaryTeamDiagnosticsInResultScope.length === 0 ? (
                    <tr>
                      <td colSpan={10}>
                        <span className="subtle">No teams in this scope.</span>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div>
              <h3>Fairness Impact</h3>
              <p className="subtle">
                Compare <strong>{result.primary.diagnostics.mode}</strong> against <strong>{result.comparison.diagnostics.mode}</strong>.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Primary days</th>
                    <th>Comparison days</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {teamDeltaInResultScope.map((row) => (
                    <tr key={row.teamId}>
                      <td>{row.teamId}</td>
                      <td>{row.primaryDays}</td>
                      <td>{row.comparisonDays}</td>
                      <td>{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                    </tr>
                  ))}
                  {teamDeltaInResultScope.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <span className="subtle">No teams in this scope.</span>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <p className="metric-row">Min fairness ratio: {scopedPrimaryFairnessMin.toFixed(2)}</p>
              <p className="metric-row">Contiguity penalty: {scopedContiguityPenalty}</p>
            </div>
          </CollapsibleSection>

          {explainability ? (
            <CollapsibleSection
              title="Explainability"
              description="Why this plan was selected and what tradeoffs were made."
              defaultOpen={false}
            >
              <p className="metric-row">Scope: {resultScopeLabel}</p>
              <p className="metric-row">
                Primary fairness min ratio: {explainability.scopedPrimaryMinRatio.toFixed(2)} | Comparison min ratio:{" "}
                {explainability.scopedComparisonMinRatio.toFixed(2)}
              </p>
              <p className="metric-row">Contiguity penalty: {explainability.scopedContiguityPenalty}</p>
              {explainability.diagnostics.relaxedApplied ? (
                <p className="warning">
                  Auto-relax was applied because exact full-day targets were infeasible with current capacity and pre-allocations.
                </p>
              ) : (
                <p className="metric-row">Exact target constraints were feasible in this run.</p>
              )}
              <p className="metric-row">
                Fairness impact: {explainability.fairnessWinners.length} teams gain days and {explainability.fairnessLosers.length} teams lose
                days versus {explainability.comparison.mode}.
              </p>
              {explainability.unmetTeams.length ? (
                <p className="warning">
                  Unmet demand:{" "}
                  {explainability.unmetTeams.map((team) => `${team.teamId} (-${team.unmetDays} day${team.unmetDays > 1 ? "s" : ""})`).join(" | ")}
                </p>
              ) : (
                <p className="metric-row">All team exact day targets were met.</p>
              )}
              {explainability.monFriIssues.length ? (
                <p className="warning">
                  Monday/Friday rule unmet: {explainability.monFriIssues.map((team) => team.teamId).join(", ")}
                </p>
              ) : (
                <p className="metric-row">Every team has at least one Monday/Friday presence.</p>
              )}
              <p className="metric-row">Manual override impact: {movedBlocksCount} moved chip(s).</p>
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection
            title="Daily Usage"
            description="Allocated seats, preallocated seats, and flex seats allocated from leftover capacity."
            defaultOpen={false}
          >
            <p className="metric-row">Scope: {resultScopeLabel}</p>
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Allocated</th>
                  <th>Preallocated</th>
                  <th>Flex allocated</th>
                  <th>Total seats</th>
                  <th>Occupancy %</th>
                </tr>
              </thead>
              <tbody>
                {manualDayDiagnostics.map((row) => (
                  <tr key={row.day}>
                    <td>{row.day}</td>
                    <td>{row.allocatedSeats}</td>
                    <td>{row.preallocatedSeats}</td>
                    <td>{row.flexSeats}</td>
                    <td>{row.totalSeats}</td>
                    <td>{row.occupancyPercent.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>

          <section
            className={`bench-print-sheet ${benchesInResultScope.length >= 28 ? "is-many-rows" : benchesInResultScope.length <= 12 ? "is-few-rows" : ""}`.trim()}
            aria-hidden="true"
          >
            <div className="bench-print-head">
              <h1>
                Bench x Day Plan - {activeScenario?.name?.trim() || "Scenario"} ({resultScopeLabel})
              </h1>
              <p>{printGeneratedAt ? `Generated ${printGeneratedAt}` : ""}</p>
            </div>
            <table className="bench-print-table">
              <thead>
                <tr>
                  <th>{normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL ? "Floor / Bench (Seats)" : "Bench (Seats)"}</th>
                  {DAYS.map((day) => (
                    <th key={`print-${day}`}>{day}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {benchesInResultScope.map((bench) => (
                  <tr key={`print-row-${bench.id}`}>
                    <th>
                      {normalizedResultFloorScopeId === OUTPUT_SCOPE_ALL
                        ? `${floorNameById.get(normalizeFloorId(bench.floorId, selectedFloorKey)) ?? normalizeFloorId(bench.floorId, selectedFloorKey)} / `
                        : ""}
                      {bench.id} ({bench.capacity})
                    </th>
                    {DAYS.map((day) => {
                      const prealloc = preallocationMatrix[bench.id]?.[day] ?? [];
                      const plan = allocationMatrix[bench.id]?.[day] ?? [];
                      const entries = [...prealloc, ...plan];
                      return (
                        <td key={`print-cell-${bench.id}-${day}`}>
                          {entries.length ? (
                            <div className="bench-print-cell-list">
                              {entries.map((item, index) => {
                                const className = [
                                  "bench-print-chip",
                                  item.kind === "flex" ? "is-flex" : "",
                                  item.kind === "prealloc" ? "is-prealloc" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ");
                                const style =
                                  item.kind === "team" && item.teamId
                                    ? teamChipStyle(
                                        teamColorMap[item.teamId] ??
                                          TEAM_BASE_COLORS[hashTeam(item.teamId) % TEAM_BASE_COLORS.length],
                                      )
                                    : undefined;
                                return (
                                  <span key={`print-entry-${bench.id}-${day}-${index}`} className={className} style={style}>
                                    {formatBlockLabel(item)}
                                  </span>
                                );
                              })}
                            </div>
                          ) : (
                            <span className="bench-print-empty">-</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
      {chipDragPreview ? (
        <span
          className={`${chipDragPreview.className} chip-drag-preview`.trim()}
          style={{
            ...(chipDragPreview.style ?? {}),
            left: chipDragPreview.x,
            top: chipDragPreview.y,
          }}
        >
          {chipDragPreview.label}
        </span>
      ) : null}
    </main>
  );
}
