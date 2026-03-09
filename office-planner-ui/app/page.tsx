"use client";

import {
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

const initialBenches: Bench[] = [
  { id: "B1", capacity: 10, order: 1, floorId: "F1", layout: { x: 10, y: 20, w: 8, h: 5 } },
  { id: "B2", capacity: 10, order: 2, floorId: "F1", layout: { x: 22, y: 20, w: 8, h: 5 } },
  { id: "B3", capacity: 10, order: 3, floorId: "F1", layout: { x: 34, y: 20, w: 8, h: 5 } },
  { id: "B4", capacity: 8, order: 4, floorId: "F1", layout: { x: 46, y: 20, w: 8, h: 5 } },
];

const initialFloors: FloorPlan[] = [{ id: "F1", name: "Floor 1" }];

const initialTeams: Team[] = [
  { id: "Engineering", size: 12, targetDays: 3, preferredDays: ["Tue", "Wed", "Thu"], contiguousDaysRequired: false },
  { id: "Sales", size: 8, targetDays: 3, preferredDays: ["Tue", "Thu"], contiguousDaysRequired: false },
  { id: "Design", size: 6, targetDays: 2, preferredDays: ["Mon", "Wed"], contiguousDaysRequired: false },
  { id: "Finance", size: 5, targetDays: 2, preferredDays: ["Mon", "Fri"], contiguousDaysRequired: false },
];

const initialPreallocations: PreallocationDraft[] = [
  { benchId: "B1", days: ["Mon"], seats: 2, label: "HR" },
  { benchId: "B1", days: ["Tue"], seats: 1, label: "Assistant" },
  { benchId: "B2", days: ["Wed", "Thu", "Fri"], seats: 1, label: "Handicap" },
];

const initialProximityRequests: TeamProximityRequest[] = [
  { teamA: "Engineering", teamB: "Design", strength: 3 },
];

const AUTOSAVE_KEY = "office-planner-ui.autosave.v1";

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
    size: Number(team.size),
    targetDays: Number(team.targetDays),
    preferredDays: [...team.preferredDays],
    contiguousDaysRequired: !!team.contiguousDaysRequired,
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
    strength: Number(item.strength),
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
  const [layoutDrag, setLayoutDrag] = useState<DragState | null>(null);
  const [layoutView, setLayoutView] = useState<LayoutView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [layoutDayView, setLayoutDayView] = useState<LayoutDayView>("off");
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);
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
  const layoutCanvasRef = useRef<HTMLDivElement | null>(null);

  const benchesByOrder = useMemo(() => [...benches].sort((a, b) => a.order - b.order), [benches]);
  const activeScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === activeScenarioId) ?? scenarios[0] ?? null,
    [activeScenarioId, scenarios],
  );
  const selectedFloor = useMemo(
    () => floors.find((floor) => floor.id === selectedFloorId) ?? floors[0],
    [floors, selectedFloorId],
  );
  const benchesOnSelectedFloor = useMemo(
    () =>
      benchesByOrder.filter(
        (bench) => (bench.floorId ?? selectedFloor?.id ?? "F1") === (selectedFloor?.id ?? "F1"),
      ),
    [benchesByOrder, selectedFloor],
  );
  const selectedBenchOnFloor = useMemo(
    () => benchesOnSelectedFloor.find((bench) => bench.id === selectedBenchId) ?? null,
    [benchesOnSelectedFloor, selectedBenchId],
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
    setBenches(cloneBenches(scenario.benches));
    setTeams(cloneTeams(scenario.teams));
    setPreallocations(clonePreallocations(scenario.preallocations));
    setFloors(cloneFloors(scenario.floors));
    setSelectedFloorId(scenario.selectedFloorId || scenario.floors[0]?.id || "F1");
    setSolverMode(scenario.solverMode);
    setFlexDefault(scenario.flexDefault);
    setFlexOverrides({ ...scenario.flexOverrides });
    setBenchStabilityWeight(scenario.benchStabilityWeight);
    setProximityRequests(cloneProximity(scenario.proximityRequests));
    setLayoutView({ scale: 1, offsetX: 0, offsetY: 0 });
    setLayoutDayView("off");
    setSelectedBenchId(null);
    setSelectedTeamId(null);
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
    setManualError(null);
  }, [result]);

  useEffect(() => {
    if (!floors.some((floor) => floor.id === selectedFloorId) && floors.length > 0) {
      setSelectedFloorId(floors[0].id);
    }
  }, [floors, selectedFloorId]);

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
              floorId: selectedFloorId,
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
              floorId: selectedFloorId,
              layout: { ...baseLayout, w, h },
            };
          }
          const x = clamp(point.x - drag.pointerOffsetX, 0, 100 - baseLayout.w);
          const y = clamp(point.y - drag.pointerOffsetY, 0, 100 - baseLayout.h);
          return {
            ...bench,
            floorId: selectedFloorId,
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
  }, [getCanvasPercentPoint, layoutDrag, selectedFloorId]);

  useEffect(() => {
    const canvas = layoutCanvasRef.current;
    if (!canvas) {
      return;
    }
    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
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
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", handleWheel);
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
    const totalSeats = benches.reduce((acc, bench) => acc + bench.capacity, 0);
    const byDay: Record<Day, { teamSeats: number; flexSeats: number }> = {
      Mon: { teamSeats: 0, flexSeats: 0 },
      Tue: { teamSeats: 0, flexSeats: 0 },
      Wed: { teamSeats: 0, flexSeats: 0 },
      Thu: { teamSeats: 0, flexSeats: 0 },
      Fri: { teamSeats: 0, flexSeats: 0 },
    };

    for (const item of manualAllocations) {
      if (item.kind === "flex") {
        byDay[item.day].flexSeats += item.seats;
      } else {
        byDay[item.day].teamSeats += item.seats;
      }
    }

    const preallocByDay: Record<Day, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 };
    for (const item of preallocationItems) {
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
  }, [result, benches, manualAllocations, preallocationItems]);

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

  const teamContiguousStatus = useMemo(() => {
    if (!result) {
      return new Map<string, boolean>();
    }
    return new Map(
      result.primary.teamSchedules.map((schedule) => [schedule.teamId, areDaysContiguous(schedule.days)]),
    );
  }, [result]);

  const teamRequirementMap = useMemo(() => new Map(teams.map((team) => [team.id, team])), [teams]);
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

  function updateTeam(index: number, patch: Partial<Team>) {
    setTeams((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
  }

  function updatePreallocation(index: number, patch: Partial<PreallocationDraft>) {
    setPreallocations((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
  }

  function updateProximityRequest(index: number, patch: Partial<TeamProximityRequest>) {
    setProximityRequests((prev) => prev.map((item, idx) => (idx === index ? { ...item, ...patch } : item)));
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

  function ensureBenchLayout(benchId: string) {
    setBenches((prev) =>
      prev.map((bench, index) =>
        bench.id === benchId
          ? {
              ...bench,
              floorId: bench.floorId ?? selectedFloor?.id ?? "F1",
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
    return raw
      .map((item, index) => {
        const bench = item as Partial<Bench>;
        const id = String(bench.id ?? "").trim();
        if (!id) {
          return null;
        }
        const capacity = Math.max(0, Number(bench.capacity) || 0);
        const order = Number.isFinite(Number(bench.order)) ? Number(bench.order) : index + 1;
        const floorId = String(bench.floorId ?? "F1").trim() || "F1";
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

  function normalizeConfigTeams(raw: unknown): Team[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((item) => {
        const team = item as Partial<Team>;
        const id = String(team.id ?? "").trim();
        if (!id) {
          return null;
        }
        return {
          id,
          size: Math.max(0, Number(team.size) || 0),
          targetDays: Math.max(0, Math.min(5, Number(team.targetDays) || 0)),
          preferredDays: toDayArray(team.preferredDays),
          contiguousDaysRequired: typeof team.contiguousDaysRequired === "boolean" ? team.contiguousDaysRequired : false,
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

  function normalizeConfigProximity(raw: unknown): TeamProximityRequest[] {
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
        return {
          teamA,
          teamB,
          strength: Math.max(1, Math.min(5, Number(req.strength) || 1)),
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
        const teamsParsed = normalizeConfigTeams(scenario.teams);
        const preallocParsed = normalizeConfigPreallocations(scenario.preallocations);
        if (benchesParsed.length === 0 || teamsParsed.length === 0) {
          return null;
        }
        const floorsParsed = normalizeConfigFloors(scenario.floors, benchesParsed);
        const selectedFloorId = String(scenario.selectedFloorId ?? "").trim();
        const settings = (scenario.settings ?? {}) as NonNullable<ScenarioConfigEntry["settings"]>;
        const nextFlexOverrides: FlexOverrides = {};
        if (settings.flexOverrides) {
          for (const day of DAYS) {
            const rawValue = settings.flexOverrides[day];
            if (rawValue === undefined || rawValue === null || rawValue === "") {
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
          proximityRequests: normalizeConfigProximity(settings.proximityRequests),
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

      const parsed: Bench[] = rows.slice(1).map((row, index) => {
        const floorId = floorIdx >= 0 ? row[floorIdx] || "F1" : "F1";
        const x = xIdx >= 0 ? Number(row[xIdx]) : Number.NaN;
        const y = yIdx >= 0 ? Number(row[yIdx]) : Number.NaN;
        const w = wIdx >= 0 ? Number(row[wIdx]) : Number.NaN;
        const h = hIdx >= 0 ? Number(row[hIdx]) : Number.NaN;
        const rotation = rotationIdx >= 0 ? Number(row[rotationIdx]) : 0;
        const hasLayout = [x, y, w, h].every((value) => Number.isFinite(value));
        return {
          id: row[idIdx],
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
      if (idIdx < 0 || sizeIdx < 0 || targetIdx < 0 || prefIdx < 0) {
        setError(
          "Teams CSV must include id, size, target_days, preferred_days headers (optional: contiguous_days_required).",
        );
        setImportFeedback((prev) => ({ ...prev, teams: `Failed: ${file.name} (invalid headers)` }));
        return;
      }

      const parsed: Team[] = rows.slice(1).map((row) => ({
        id: row[idIdx],
        size: Number(row[sizeIdx]),
        targetDays: Number(row[targetIdx]),
        preferredDays: parsePreferredDays(row[prefIdx] ?? ""),
        contiguousDaysRequired: contiguousIdx >= 0 ? parseBoolean(row[contiguousIdx]) : false,
      }));

      setTeams(parsed.filter((team) => team.id));
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
    return {
      benches: benches.map((bench) => ({
        id: bench.id.trim(),
        capacity: Number(bench.capacity),
        order: Number(bench.order),
        floorId: (bench.floorId ?? "F1").trim(),
        layout: bench.layout
          ? {
              x: Number(bench.layout.x),
              y: Number(bench.layout.y),
              w: Number(bench.layout.w),
              h: Number(bench.layout.h),
              rotation: normalizeRotation(Number(bench.layout.rotation ?? 0)),
            }
          : undefined,
      })),
      teams: teams.map((team) => ({
        id: team.id.trim(),
        size: Number(team.size),
        targetDays: Number(team.targetDays),
        preferredDays: team.preferredDays,
        contiguousDaysRequired: !!team.contiguousDaysRequired,
      })),
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
          strength: Math.max(1, Math.min(5, Number(item.strength) || 1)),
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

  function moveAllocation(blockId: string, benchId: string, day: Day) {
    const moving = manualAllocations.find((item) => item.id === blockId);
    if (!moving) {
      return;
    }
    if (moving.benchId === benchId && moving.day === day) {
      return;
    }
    const capacity = cellCapacity[`${benchId}-${day}`] ?? 0;
    const targetUsed = manualAllocations
      .filter((item) => item.id !== blockId && item.benchId === benchId && item.day === day)
      .reduce((acc, item) => acc + item.seats, 0);
    if (targetUsed + moving.seats > capacity) {
      setManualError(
        `Cannot move ${formatBlockLabel(moving)} to ${benchId} ${day}. Capacity would be exceeded (${targetUsed + moving.seats}/${capacity}).`,
      );
      return;
    }

    setManualAllocations((prev) =>
      prev.map((item) => (item.id === blockId ? { ...item, benchId, day } : item)),
    );
    setManualError(null);
  }

  function exportBenchPlanCsv() {
    const rows: string[][] = [["bench", ...DAYS]];
    for (const bench of benchesByOrder) {
      rows.push([
        bench.id,
        ...DAYS.map((day) => {
          const prealloc = (preallocationMatrix[bench.id]?.[day] ?? []).map(formatBlockLabel);
          const plan = (allocationMatrix[bench.id]?.[day] ?? []).map(formatBlockLabel);
          return [...prealloc, ...plan].join(" | ");
        }),
      ]);
    }
    downloadCsv("bench_day_plan.csv", rows);
  }

  function exportTeamViewCsv() {
    const rows: string[][] = [["team", "day", "bench", "seats"]];
    const teamRows = manualAllocations
      .filter((item) => item.kind === "team")
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
      rows.push([item.teamId ?? "", item.day, item.benchId, String(item.seats)]);
    }

    downloadCsv("team_view_plan.csv", rows);
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
    const unmetTeams = diagnostics.teamDiagnostics.filter((row) => row.unmetDays > 0);
    const monFriIssues = diagnostics.teamDiagnostics.filter((row) => !row.monFriSatisfied);
    const fairnessWinners = teamDelta.filter((row) => row.delta > 0);
    const fairnessLosers = teamDelta.filter((row) => row.delta < 0);

    return {
      diagnostics,
      comparison,
      unmetTeams,
      monFriIssues,
      fairnessWinners,
      fairnessLosers,
    };
  }, [result, teamDelta]);

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

      <CollapsibleSection
        className="grid-two"
        title="Step 0: Import & Policy"
        description="Load data and choose solver/flex target policy."
        defaultOpen
      >
        <div>
          <h3>Import Data</h3>
          <p className="subtle">CSV imports replace one table. Config JSON restores a full session in one step.</p>
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
          <button onClick={exportSessionConfig}>Export full config (JSON)</button>
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
        </div>

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

      <CollapsibleSection title="Step 1: Benches" description="Define bench IDs, capacity, and floor." defaultOpen={false}>
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
            {benches.map((bench, index) => (
              <tr key={`bench-${index}`}>
                <td>
                  <input value={bench.id} onChange={(e) => updateBench(index, { id: e.target.value })} />
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
                  <select
                    value={bench.floorId ?? selectedFloor?.id ?? "F1"}
                    onChange={(e) => updateBench(index, { floorId: e.target.value })}
                  >
                    {floors.map((floor) => (
                      <option value={floor.id} key={`bench-floor-${bench.id}-${floor.id}`}>
                        {floor.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button onClick={() => setBenches((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() =>
            setBenches((prev) => [
              ...prev,
              {
                id: `B${prev.length + 1}`,
                capacity: 8,
                order: prev.length + 1,
                floorId: selectedFloor?.id ?? "F1",
                layout: defaultLayoutForIndex(prev.length),
              },
            ])
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
        <div className="layout-toolbar">
          <label>
            Active floor
            <select value={selectedFloor?.id ?? ""} onChange={(e) => setSelectedFloorId(e.target.value)}>
              {floors.map((floor) => (
                <option value={floor.id} key={`floor-${floor.id}`}>
                  {floor.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Floor name
            <input
              value={selectedFloor?.name ?? ""}
              onChange={(e) =>
                setFloors((prev) =>
                  prev.map((floor) => (floor.id === selectedFloor?.id ? { ...floor, name: e.target.value } : floor)),
                )
              }
            />
          </label>
          <button
            onClick={() => {
              const nextId = `F${floors.length + 1}`;
              setFloors((prev) => [...prev, { id: nextId, name: `Floor ${floors.length + 1}` }]);
              setSelectedFloorId(nextId);
            }}
          >
            Add floor
          </button>
          <button
            onClick={() => {
              if (floors.length <= 1 || !selectedFloor) {
                return;
              }
              const fallbackFloorId = floors.find((floor) => floor.id !== selectedFloor.id)?.id ?? floors[0].id;
              setFloors((prev) => prev.filter((floor) => floor.id !== selectedFloor.id));
              setBenches((prev) =>
                prev.map((bench) => (bench.floorId === selectedFloor.id ? { ...bench, floorId: fallbackFloorId } : bench)),
              );
              setSelectedFloorId(fallbackFloorId);
            }}
          >
            Remove floor
          </button>
        </div>
        <div className="layout-toolbar">
          <label>
            Floor image
            <input type="file" accept="image/*" onChange={handleFloorImageUpload} />
          </label>
          <label>
            Import layout profile (JSON)
            <input type="file" accept=".json,application/json" onChange={importLayoutProfile} />
          </label>
          <button onClick={exportLayoutProfile}>Export layout profile (JSON)</button>
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
          <div className="layout-rotation-controls">
            <span>{selectedBenchOnFloor ? `Rotate ${selectedBenchOnFloor.id}` : "Select a bench to rotate"}</span>
            <button
              onClick={() =>
                updateSelectedBenchRotation(Number(selectedBenchOnFloor?.layout?.rotation ?? 0) - 15)
              }
              disabled={!selectedBenchOnFloor}
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
              disabled={!selectedBenchOnFloor}
            />
            <button
              onClick={() =>
                updateSelectedBenchRotation(Number(selectedBenchOnFloor?.layout?.rotation ?? 0) + 15)
              }
              disabled={!selectedBenchOnFloor}
            >
              +15°
            </button>
            <button onClick={() => updateSelectedBenchRotation(0)} disabled={!selectedBenchOnFloor}>
              Reset
            </button>
          </div>
        </div>
        <p className="metric-row">
          Drag bench blocks to set position. Layout profile JSON can be re-imported after code updates and reused for future
          floors.
        </p>
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
                <div
                  key={`layout-${bench.id}`}
                  className={[
                    "bench-block",
                    isSelectedBench ? "is-selected" : "",
                    isDimmed ? "is-dimmed" : "",
                    isEmptyBench ? "is-empty" : "",
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
                  <span className="bench-id" style={{ fontSize: `${sizing.title}px` }}>
                    {bench.id}
                  </span>
                  <small className="bench-seat-value" style={{ fontSize: `${sizing.seat}px` }}>
                    {bench.capacity}
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
              );
            })}
          </div>
        </div>
        <p className="metric-row">
          Tips: Click a bench to focus it. Drag empty canvas to pan. Scroll to zoom. Drag the top circular handle to rotate
          (hold Shift to snap by 15 degrees), and drag the subtle bottom-right corner grip to resize.
          Use the rotation controls for angled walls.
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
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 3: Teams"
        description="Set team size, target days, contiguous requirement, and preferred days."
        defaultOpen={false}
      >
        <table>
          <thead>
            <tr>
              <th>Team</th>
              <th>Size</th>
              <th>Target days</th>
              <th>Contiguous required</th>
              <th>Preferred days</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {teams.map((team, index) => (
              <tr key={`team-${index}`}>
                <td>
                  <input value={team.id} onChange={(e) => updateTeam(index, { id: e.target.value })} />
                </td>
                <td>
                  <input type="number" value={team.size} onChange={(e) => updateTeam(index, { size: Number(e.target.value) })} />
                </td>
                <td>
                  <input
                    type="number"
                    min={0}
                    max={5}
                    value={team.targetDays}
                    onChange={(e) => updateTeam(index, { targetDays: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <label className="single-check">
                    <input
                      type="checkbox"
                      checked={team.contiguousDaysRequired}
                      onChange={(e) => updateTeam(index, { contiguousDaysRequired: e.target.checked })}
                    />
                    Yes
                  </label>
                </td>
                <td>
                  <div className="days-inline">
                    {DAYS.map((day) => (
                      <label key={`team-${index}-${day}`}>
                        <input
                          type="checkbox"
                          checked={team.preferredDays.includes(day)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              updateTeam(index, { preferredDays: [...team.preferredDays, day] });
                            } else {
                              updateTeam(index, { preferredDays: team.preferredDays.filter((item) => item !== day) });
                            }
                          }}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                </td>
                <td>
                  <button onClick={() => setTeams((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() =>
            setTeams((prev) => [
              ...prev,
              {
                id: `Team${prev.length + 1}`,
                size: 6,
                targetDays: 2,
                preferredDays: ["Tue", "Thu"],
                contiguousDaysRequired: false,
              },
            ])
          }
        >
          Add team
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 4: Team Proximity Requests"
        description="Optional: request teams to sit near each other when they attend on the same day."
        defaultOpen={false}
      >
        <table>
          <thead>
            <tr>
              <th>Team A</th>
              <th>Team B</th>
              <th>Strength (1-5)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {proximityRequests.map((item, index) => (
              <tr key={`prox-${index}`}>
                <td>
                  <select
                    value={item.teamA}
                    onChange={(event) => updateProximityRequest(index, { teamA: event.target.value })}
                  >
                    <option value="">Select team</option>
                    {teamOptions.map((teamId) => (
                      <option value={teamId} key={`prox-a-${index}-${teamId}`}>
                        {teamId}
                      </option>
                    ))}
                    {item.teamA && !teamOptions.includes(item.teamA) ? (
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
                    {teamOptions.map((teamId) => (
                      <option value={teamId} key={`prox-b-${index}-${teamId}`}>
                        {teamId}
                      </option>
                    ))}
                    {item.teamB && !teamOptions.includes(item.teamB) ? (
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
                  <button onClick={() => setProximityRequests((prev) => prev.filter((_, i) => i !== index))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          onClick={() =>
            setProximityRequests((prev) => [
              ...prev,
              {
                teamA: teamOptions[0] ?? "",
                teamB: teamOptions[1] ?? teamOptions[0] ?? "",
                strength: 3,
              },
            ])
          }
        >
          Add proximity request
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="Step 5: Pre-allocations"
        description="Reserve seats by bench/day before planning. Multiple days per row are supported."
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
            {preallocations.map((item, index) => (
              <tr key={`prealloc-${index}`}>
                <td>
                  <input value={item.benchId} onChange={(e) => updatePreallocation(index, { benchId: e.target.value })} />
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
          </tbody>
        </table>
        <button
          onClick={() =>
            setPreallocations((prev) => [
              ...prev,
              { benchId: benchesByOrder[0]?.id ?? "B1", days: ["Mon"], seats: 1, label: "Reserved" },
            ])
          }
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
          <CollapsibleSection
            className="grid-two"
            title="Share, Export & Manual Adjustments"
            description="Export current table state and drag chips to fine-tune."
            defaultOpen
          >
            <div>
              <h3>Share & Export</h3>
              <p className="subtle">Export current table state, including manual adjustments.</p>
              <div className="export-actions">
                <button onClick={exportBenchPlanCsv}>Export bench x day CSV</button>
                <button onClick={exportTeamViewCsv}>Export team view CSV</button>
                <button onClick={exportBenchPlanA4Pdf}>Export Bench x Day A4 PDF</button>
              </div>
            </div>
            <div>
              <h3>Manual Adjustments</h3>
              <p className="subtle">Drag allocation chips across cells to fine-tune the plan.</p>
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
            description={`Primary mode: ${result.primary.diagnostics.mode}`}
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
            <table>
              <thead>
                <tr>
                  <th>Bench (Seats)</th>
                  {DAYS.map((day) => (
                    <th key={day}>{day}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {benchesByOrder.map((bench) => (
                  <tr key={bench.id}>
                    <td>
                      <strong>{bench.id}</strong> ({bench.capacity})
                    </td>
                    {DAYS.map((day) => (
                      <td
                        key={`${bench.id}-${day}`}
                        className={activeDragId ? "drop-target" : undefined}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          const blockId = event.dataTransfer.getData("text/plain");
                          moveAllocation(blockId, bench.id, day);
                          setActiveDragId(null);
                        }}
                      >
                        <div className="chip-stack">
                          {(preallocationMatrix[bench.id]?.[day] ?? []).map((item) => (
                            <span key={item.id} className="alloc-chip alloc-chip-prealloc">
                              {formatBlockLabel(item)}
                            </span>
                          ))}
                          {(allocationMatrix[bench.id]?.[day] ?? []).map((item) => (
                            <span
                              key={item.id}
                              className={[
                                "alloc-chip",
                                item.kind === "flex" ? "alloc-chip-flex" : "",
                                item.kind === "team" && selectedTeamId
                                  ? item.teamId === selectedTeamId
                                    ? "alloc-chip-team-selected"
                                    : "alloc-chip-muted"
                                  : "",
                                item.kind !== "team" && selectedTeamId ? "alloc-chip-muted" : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              draggable={item.kind !== "prealloc"}
                              onDragStart={(event) => {
                                if (item.kind === "prealloc") {
                                  return;
                                }
                                event.dataTransfer.setData("text/plain", item.id);
                                setActiveDragId(item.id);
                              }}
                              onDragEnd={() => {
                                if (item.kind !== "prealloc") {
                                  setActiveDragId(null);
                                }
                              }}
                              onClick={() => {
                                if (item.kind !== "team" || !item.teamId) {
                                  return;
                                }
                                setSelectedTeamId((prev) => (prev === item.teamId ? null : item.teamId));
                              }}
                              style={
                                item.kind === "team"
                                  ? teamChipStyle(
                                      teamColorMap[item.teamId ?? ""] ??
                                        TEAM_BASE_COLORS[hashTeam(item.teamId ?? "team") % TEAM_BASE_COLORS.length],
                                    )
                                  : undefined
                              }
                            >
                              {formatBlockLabel(item)}
                            </span>
                          ))}
                          {(allocationMatrix[bench.id]?.[day] ?? []).length === 0 &&
                          (preallocationMatrix[bench.id]?.[day] ?? []).length === 0 ? (
                            <span className="empty-cell">-</span>
                          ) : null}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CollapsibleSection>

          <CollapsibleSection
            className="grid-two"
            title="Outcome Diagnostics"
            description="Fulfillment, fairness impact, and key KPI tables."
            defaultOpen={false}
          >
            <div>
              <h3>Team Outcomes</h3>
              <p className="subtle">Fulfillment, unmet demand, and Monday/Friday rule.</p>
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
                  </tr>
                </thead>
                <tbody>
                  {result.primary.diagnostics.teamDiagnostics.map((row) => (
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
                    </tr>
                  ))}
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
                  {teamDelta.map((row) => (
                    <tr key={row.teamId}>
                      <td>{row.teamId}</td>
                      <td>{row.primaryDays}</td>
                      <td>{row.comparisonDays}</td>
                      <td>{row.delta > 0 ? `+${row.delta}` : row.delta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="metric-row">Min fairness ratio: {result.primary.diagnostics.fairnessMinRatio.toFixed(2)}</p>
              <p className="metric-row">Contiguity penalty: {result.primary.diagnostics.contiguityPenalty}</p>
            </div>
          </CollapsibleSection>

          {explainability ? (
            <CollapsibleSection
              title="Explainability"
              description="Why this plan was selected and what tradeoffs were made."
              defaultOpen={false}
            >
              <p className="metric-row">
                Primary fairness min ratio: {explainability.diagnostics.fairnessMinRatio.toFixed(2)} | Comparison min ratio:{" "}
                {explainability.comparison.fairnessMinRatio.toFixed(2)}
              </p>
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
            className={`bench-print-sheet ${benchesByOrder.length >= 28 ? "is-many-rows" : benchesByOrder.length <= 12 ? "is-few-rows" : ""}`.trim()}
            aria-hidden="true"
          >
            <div className="bench-print-head">
              <h1>Bench x Day Plan - {activeScenario?.name?.trim() || "Scenario"}</h1>
              <p>{printGeneratedAt ? `Generated ${printGeneratedAt}` : ""}</p>
            </div>
            <table className="bench-print-table">
              <thead>
                <tr>
                  <th>Bench (Seats)</th>
                  {DAYS.map((day) => (
                    <th key={`print-${day}`}>{day}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {benchesByOrder.map((bench) => (
                  <tr key={`print-row-${bench.id}`}>
                    <th>
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
    </main>
  );
}
