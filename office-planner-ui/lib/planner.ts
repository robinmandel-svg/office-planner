import {
  DAYS,
  type Bench,
  type BenchAllocation,
  type Day,
  type DayDiagnostics,
  type FlexAllocation,
  type PlanResult,
  type PlannerInput,
  type PlannerResponse,
  type SolverMode,
  type Team,
  type TeamDiagnostics,
  type TeamProximityRequest,
  type TeamSchedule,
} from "./types";

type DayMap<T> = Record<Day, T>;
type BenchAvailabilityByDay = Record<Day, Record<string, number>>;

type AssignmentMap = Record<string, Set<Day>>;

type CapacityContext = {
  totalSeats: number;
  benchesByOrder: Bench[];
  benchAvailability: BenchAvailabilityByDay;
  dayCapacity: DayMap<number>;
  dayPreallocated: DayMap<number>;
  dayFlex: DayMap<number>;
};

type DayAssignmentResult = {
  assignments: AssignmentMap;
  exactFeasible: boolean;
  relaxedApplied: boolean;
};

const MON: Day = "Mon";
const FRI: Day = "Fri";
const MAX_MON_FRI_PAIR_PENALTY = 300;
const MAX_ALLOWED_SEAT_SHORTFALL = 10;

function emptyDayMap(value = 0): DayMap<number> {
  return { Mon: value, Tue: value, Wed: value, Thu: value, Fri: value };
}

function roundNearest(value: number): number {
  return Math.round(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dayIsMonFri(day: Day): boolean {
  return day === MON || day === FRI;
}

function includesMonFri(days: Day[]): boolean {
  return days.some(dayIsMonFri);
}

function hasMonFriPair(days: Iterable<Day>): boolean {
  let hasMon = false;
  let hasFri = false;
  for (const day of days) {
    if (day === MON) {
      hasMon = true;
    }
    if (day === FRI) {
      hasFri = true;
    }
  }
  return hasMon && hasFri;
}

function monFriPairPenaltyWeight(input: PlannerInput, mode: SolverMode): number {
  const modeDefault = mode === "fairness_first" ? 120 : 80;
  return clamp(Number(input.monFriPairPenaltyWeight ?? modeDefault), 0, MAX_MON_FRI_PAIR_PENALTY);
}

function allowedSeatShortfallPerTeamDay(input: PlannerInput): number {
  return clamp(Math.round(Number(input.allowedSeatShortfallPerTeamDay ?? 0)), 0, MAX_ALLOWED_SEAT_SHORTFALL);
}

function requiredSeatsForTeamDay(team: Team, input: PlannerInput): number {
  const shortfall = allowedSeatShortfallPerTeamDay(input);
  const minPresence = team.size > 0 ? 1 : 0;
  const baselineRequired = clamp(team.size - shortfall, minPresence, team.size);
  return Math.max(baselineRequired, teamAnchorSeats(team));
}

function requiredSeatsMap(teams: Team[], input: PlannerInput): Record<string, number> {
  const map: Record<string, number> = {};
  for (const team of teams) {
    map[team.id] = requiredSeatsForTeamDay(team, input);
  }
  return map;
}

function teamAnchorBenchId(team: Team): string | null {
  const anchorBenchId = (team.anchorBenchId ?? "").trim();
  return anchorBenchId.length > 0 ? anchorBenchId : null;
}

function teamFloorId(team: Team, benchFloorById: Map<string, string>, fallbackFloorId: string): string {
  const explicitFloorId = (team.floorId ?? "").trim();
  if (explicitFloorId.length > 0) {
    return explicitFloorId;
  }
  const anchorBenchId = teamAnchorBenchId(team);
  if (anchorBenchId) {
    const anchorFloorId = benchFloorById.get(anchorBenchId);
    if (anchorFloorId) {
      return anchorFloorId;
    }
  }
  return fallbackFloorId;
}

function teamAnchorSeats(team: Team): number {
  const anchorBenchId = teamAnchorBenchId(team);
  if (!anchorBenchId) {
    return 0;
  }
  const rawSeats = Number(team.anchorSeats ?? 0);
  if (!Number.isFinite(rawSeats) || rawSeats <= 0) {
    return 0;
  }
  return Math.min(team.size, Math.floor(rawSeats));
}

function cloneBenchAvailability(availability: BenchAvailabilityByDay): BenchAvailabilityByDay {
  return {
    Mon: { ...availability.Mon },
    Tue: { ...availability.Tue },
    Wed: { ...availability.Wed },
    Thu: { ...availability.Thu },
    Fri: { ...availability.Fri },
  };
}

function dayIndex(day: Day): number {
  return DAYS.indexOf(day);
}

function isContiguousDays(days: Iterable<Day>): boolean {
  const indexes = [...days].map(dayIndex).sort((a, b) => a - b);
  if (indexes.length <= 1) {
    return true;
  }
  for (let i = 1; i < indexes.length; i += 1) {
    if (indexes[i] !== indexes[i - 1] + 1) {
      return false;
    }
  }
  return true;
}

function hasContiguousWindowContaining(days: Iterable<Day>, windowLength: number): boolean {
  const indexes = [...days].map(dayIndex);
  if (indexes.length === 0) {
    return true;
  }
  if (windowLength <= 0 || indexes.length > windowLength) {
    return false;
  }
  for (let start = 0; start <= DAYS.length - windowLength; start += 1) {
    const end = start + windowLength - 1;
    if (indexes.every((idx) => idx >= start && idx <= end)) {
      return true;
    }
  }
  return false;
}

function contiguousCompatible(team: Team, days: Iterable<Day>): boolean {
  if (!team.contiguousDaysRequired) {
    return true;
  }
  return isContiguousDays(days) && hasContiguousWindowContaining(days, team.targetDays);
}

function preferredHits(days: Iterable<Day>, team: Team): number {
  const preferred = new Set(team.preferredDays);
  let hits = 0;
  for (const day of days) {
    if (preferred.has(day)) {
      hits += 1;
    }
  }
  return hits;
}

function buildCapacityContext(input: PlannerInput): CapacityContext {
  const benchesByOrder = [...input.benches].sort((a, b) => a.order - b.order);
  const totalSeats = benchesByOrder.reduce((acc, bench) => acc + bench.capacity, 0);

  const dayPreallocated = emptyDayMap(0);
  const benchAvailability: BenchAvailabilityByDay = {
    Mon: {},
    Tue: {},
    Wed: {},
    Thu: {},
    Fri: {},
  };

  for (const day of DAYS) {
    for (const bench of benchesByOrder) {
      benchAvailability[day][bench.id] = bench.capacity;
    }
  }

  for (const item of input.preallocations) {
    if (!benchAvailability[item.day] || benchAvailability[item.day][item.benchId] === undefined) {
      continue;
    }
    const cappedSeats = clamp(item.seats, 0, benchAvailability[item.day][item.benchId]);
    benchAvailability[item.day][item.benchId] -= cappedSeats;
    dayPreallocated[item.day] += cappedSeats;
  }

  const dayFlex = emptyDayMap(0);
  for (const day of DAYS) {
    const percent = input.flexPolicy.overrides?.[day] ?? input.flexPolicy.defaultPercent;
    dayFlex[day] = roundNearest((totalSeats * percent) / 100);
  }

  const dayCapacity = emptyDayMap(0);
  for (const day of DAYS) {
    const usable = benchesByOrder.reduce((acc, bench) => acc + benchAvailability[day][bench.id], 0);
    // Flex is a soft target: reserve after team seating/proximity, not before.
    dayCapacity[day] = Math.max(0, usable);
  }

  return { totalSeats, benchesByOrder, benchAvailability, dayCapacity, dayPreallocated, dayFlex };
}

function generateDayCombosExact(team: Team): Day[][] {
  const targetDays = team.targetDays;
  const combos: Day[][] = [];

  function backtrack(start: number, current: Day[]) {
    if (current.length === targetDays) {
      if (includesMonFri(current) && (!team.contiguousDaysRequired || isContiguousDays(current))) {
        combos.push([...current]);
      }
      return;
    }
    for (let i = start; i < DAYS.length; i += 1) {
      current.push(DAYS[i]);
      backtrack(i + 1, current);
      current.pop();
    }
  }

  if (targetDays <= 0) {
    return [[]];
  }

  backtrack(0, []);
  return combos;
}

function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return values.reduce((acc, value) => acc + (value - mean) ** 2, 0) / values.length;
}

function scoreExactState(
  remaining: DayMap<number>,
  dayCap: DayMap<number>,
  prefScore: number,
  monFriPairCount: number,
  monFriPairPenalty: number,
  mode: SolverMode,
): number {
  const used = DAYS.map((day) => dayCap[day] - remaining[day]);
  const balancePenalty = variance(used);
  const monFriPenalty = monFriPairCount * monFriPairPenalty;
  if (mode === "efficiency_first") {
    return prefScore * 20 - balancePenalty - monFriPenalty;
  }
  return prefScore * 25 - balancePenalty * 1.5 - monFriPenalty;
}

function cloneAssignments(assignments: AssignmentMap): AssignmentMap {
  const next: AssignmentMap = {};
  for (const [teamId, days] of Object.entries(assignments)) {
    next[teamId] = new Set(days);
  }
  return next;
}

function tryExactAssignment(input: PlannerInput, capacity: CapacityContext, mode: SolverMode): AssignmentMap | null {
  const requiredByTeam = requiredSeatsMap(input.teams, input);
  const teams = [...input.teams].sort((a, b) => {
    const anchorLoadA = teamAnchorSeats(a) * a.targetDays;
    const anchorLoadB = teamAnchorSeats(b) * b.targetDays;
    if (anchorLoadA !== anchorLoadB) {
      return anchorLoadB - anchorLoadA;
    }
    const scoreA = (requiredByTeam[a.id] ?? a.size) * a.targetDays;
    const scoreB = (requiredByTeam[b.id] ?? b.size) * b.targetDays;
    return scoreB - scoreA;
  });

  const dayCap = capacity.dayCapacity;
  const monFriPenalty = monFriPairPenaltyWeight(input, mode);
  const BEAM_WIDTH = 300;

  type BeamState = {
    remaining: DayMap<number>;
    anchorRemaining: BenchAvailabilityByDay;
    assignments: AssignmentMap;
    prefScore: number;
    monFriPairCount: number;
    score: number;
  };

  let beam: BeamState[] = [
    {
      remaining: { ...dayCap },
      anchorRemaining: cloneBenchAvailability(capacity.benchAvailability),
      assignments: {},
      prefScore: 0,
      monFriPairCount: 0,
      score: 0,
    },
  ];

  for (const team of teams) {
    const anchorBenchId = teamAnchorBenchId(team);
    const anchorSeats = teamAnchorSeats(team);
    const requiredSeats = requiredByTeam[team.id] ?? team.size;
    const options = generateDayCombosExact(team);
    if (options.length === 0) {
      return null;
    }

    const nextBeam: BeamState[] = [];

    for (const state of beam) {
      for (const option of options) {
        let feasible = true;
        for (const day of option) {
          if (state.remaining[day] < requiredSeats) {
            feasible = false;
            break;
          }
          if (
            anchorBenchId &&
            anchorSeats > 0 &&
            (state.anchorRemaining[day][anchorBenchId] ?? 0) < anchorSeats
          ) {
            feasible = false;
            break;
          }
        }
        if (!feasible) {
          continue;
        }

        const remaining: DayMap<number> = { ...state.remaining };
        for (const day of option) {
          remaining[day] -= requiredSeats;
        }

        const anchorRemaining =
          anchorBenchId && anchorSeats > 0 ? cloneBenchAvailability(state.anchorRemaining) : state.anchorRemaining;
        if (anchorBenchId && anchorSeats > 0) {
          for (const day of option) {
            anchorRemaining[day][anchorBenchId] -= anchorSeats;
          }
        }

        const assignments = cloneAssignments(state.assignments);
        assignments[team.id] = new Set(option);

        const prefScore = state.prefScore + preferredHits(option, team);
        const monFriPairCount = state.monFriPairCount + (hasMonFriPair(option) ? 1 : 0);
        const score = scoreExactState(remaining, dayCap, prefScore, monFriPairCount, monFriPenalty, mode);
        nextBeam.push({ remaining, anchorRemaining, assignments, prefScore, monFriPairCount, score });
      }
    }

    if (nextBeam.length === 0) {
      return null;
    }

    nextBeam.sort((a, b) => b.score - a.score);
    beam = nextBeam.slice(0, BEAM_WIDTH);
  }

  beam.sort((a, b) => b.score - a.score);
  return beam[0]?.assignments ?? null;
}

function initAssignments(teams: Team[]): AssignmentMap {
  const assignments: AssignmentMap = {};
  for (const team of teams) {
    assignments[team.id] = new Set<Day>();
  }
  return assignments;
}

function chooseDayForTeam(
  team: Team,
  assigned: Set<Day>,
  remaining: DayMap<number>,
  anchorRemaining: BenchAvailabilityByDay,
  dayCap: DayMap<number>,
  mode: SolverMode,
  monFriPairPenalty: number,
  requiredSeats: number,
): Day | null {
  const anchorBenchId = teamAnchorBenchId(team);
  const anchorSeats = teamAnchorSeats(team);
  const hasMonFri = [...assigned].some(dayIsMonFri);
  const candidates: { day: Day; score: number }[] = [];

  for (const day of DAYS) {
    if (assigned.has(day)) {
      continue;
    }
    if (remaining[day] < requiredSeats) {
      continue;
    }
    if (anchorBenchId && anchorSeats > 0 && (anchorRemaining[day][anchorBenchId] ?? 0) < anchorSeats) {
      continue;
    }
    const candidateDays = new Set(assigned);
    candidateDays.add(day);
    if (!contiguousCompatible(team, candidateDays)) {
      continue;
    }

    let score = 0;
    if (team.preferredDays.includes(day)) {
      score += 20;
    }
    if (!hasMonFri && dayIsMonFri(day)) {
      score += 35;
    }
    if (hasMonFri && dayIsMonFri(day)) {
      score -= monFriPairPenalty;
    }

    const usedPct = dayCap[day] > 0 ? (dayCap[day] - remaining[day]) / dayCap[day] : 1;
    if (mode === "fairness_first") {
      score += (1 - usedPct) * 16;
    } else {
      score += (1 - usedPct) * 8;
      score += (20 - team.size) * 0.5;
    }

    if (team.contiguousDaysRequired) {
      const indexes = [...candidateDays].map(dayIndex).sort((a, b) => a - b);
      const spread = indexes[indexes.length - 1] - indexes[0] + 1;
      score += Math.max(0, team.targetDays - spread) * 4;
    }

    candidates.push({ day, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.day ?? null;
}

function enforceMonFri(
  teams: Team[],
  assignments: AssignmentMap,
  remaining: DayMap<number>,
  anchorRemaining: BenchAvailabilityByDay,
  requiredByTeam: Record<string, number>,
): void {
  for (const team of teams) {
    const anchorBenchId = teamAnchorBenchId(team);
    const anchorSeats = teamAnchorSeats(team);
    const requiredSeats = requiredByTeam[team.id] ?? team.size;
    const assigned = assignments[team.id];
    if (!assigned || [...assigned].some(dayIsMonFri)) {
      continue;
    }

    const preferredSwapDays: Day[] = [MON, FRI];

    for (const day of preferredSwapDays) {
      if (assigned.has(day)) {
        continue;
      }

      if (remaining[day] >= requiredSeats && assigned.size < team.targetDays) {
        if (anchorBenchId && anchorSeats > 0 && (anchorRemaining[day][anchorBenchId] ?? 0) < anchorSeats) {
          continue;
        }
        const candidateDays = new Set(assigned);
        candidateDays.add(day);
        if (contiguousCompatible(team, candidateDays)) {
          assigned.add(day);
          remaining[day] -= requiredSeats;
          if (anchorBenchId && anchorSeats > 0) {
            anchorRemaining[day][anchorBenchId] -= anchorSeats;
          }
          break;
        }
      }

      if (remaining[day] >= requiredSeats) {
        if (anchorBenchId && anchorSeats > 0 && (anchorRemaining[day][anchorBenchId] ?? 0) < anchorSeats) {
          continue;
        }
        const dropDay = [...assigned].find((d) => !dayIsMonFri(d));
        if (!dropDay) {
          continue;
        }
        const candidateDays = new Set(assigned);
        candidateDays.delete(dropDay);
        candidateDays.add(day);
        if (contiguousCompatible(team, candidateDays)) {
          assigned.delete(dropDay);
          remaining[dropDay] += requiredSeats;
          assigned.add(day);
          remaining[day] -= requiredSeats;
          if (anchorBenchId && anchorSeats > 0) {
            anchorRemaining[dropDay][anchorBenchId] += anchorSeats;
            anchorRemaining[day][anchorBenchId] -= anchorSeats;
          }
          break;
        }
      }
    }
  }
}

function relaxedAssignment(input: PlannerInput, capacity: CapacityContext, mode: SolverMode): AssignmentMap {
  const requiredByTeam = requiredSeatsMap(input.teams, input);
  const assignments = initAssignments(input.teams);
  const remaining: DayMap<number> = { ...capacity.dayCapacity };
  const anchorRemaining = cloneBenchAvailability(capacity.benchAvailability);
  const monFriPenalty = monFriPairPenaltyWeight(input, mode);
  const maxTarget = Math.max(0, ...input.teams.map((team) => team.targetDays));

  for (let round = 1; round <= maxTarget; round += 1) {
    const teams = [...input.teams]
      .filter((team) => team.targetDays >= round)
      .sort((a, b) => {
        const anchorSeatsA = teamAnchorSeats(a);
        const anchorSeatsB = teamAnchorSeats(b);
        if (anchorSeatsA !== anchorSeatsB) {
          return anchorSeatsB - anchorSeatsA;
        }
        const aRatio = assignments[a.id].size / Math.max(1, a.targetDays);
        const bRatio = assignments[b.id].size / Math.max(1, b.targetDays);
        if (mode === "fairness_first" && aRatio !== bRatio) {
          return aRatio - bRatio;
        }
        if (mode === "efficiency_first" && a.size !== b.size) {
          return (requiredByTeam[a.id] ?? a.size) - (requiredByTeam[b.id] ?? b.size);
        }
        return b.targetDays - a.targetDays;
      });

    for (const team of teams) {
      const assigned = assignments[team.id];
      if (assigned.size >= team.targetDays) {
        continue;
      }
      const requiredSeats = requiredByTeam[team.id] ?? team.size;
      const chosenDay = chooseDayForTeam(
        team,
        assigned,
        remaining,
        anchorRemaining,
        capacity.dayCapacity,
        mode,
        monFriPenalty,
        requiredSeats,
      );
      if (!chosenDay) {
        continue;
      }
      assigned.add(chosenDay);
      remaining[chosenDay] -= requiredSeats;
      const anchorBenchId = teamAnchorBenchId(team);
      const anchorSeats = teamAnchorSeats(team);
      if (anchorBenchId && anchorSeats > 0) {
        anchorRemaining[chosenDay][anchorBenchId] -= anchorSeats;
      }
    }
  }

  enforceMonFri(input.teams, assignments, remaining, anchorRemaining, requiredByTeam);
  return assignments;
}

function assignDays(input: PlannerInput, capacity: CapacityContext, mode: SolverMode): DayAssignmentResult {
  const exact = tryExactAssignment(input, capacity, mode);
  if (exact) {
    return { assignments: exact, exactFeasible: true, relaxedApplied: false };
  }

  const relaxed = relaxedAssignment(input, capacity, mode);
  return { assignments: relaxed, exactFeasible: false, relaxedApplied: true };
}

function teamsByDay(teams: Team[], assignments: AssignmentMap): Record<Day, Team[]> {
  const byDay: Record<Day, Team[]> = { Mon: [], Tue: [], Wed: [], Thu: [], Fri: [] };
  const teamMap = new Map(teams.map((team) => [team.id, team]));

  for (const [teamId, days] of Object.entries(assignments)) {
    const team = teamMap.get(teamId);
    if (!team) {
      continue;
    }
    for (const day of days) {
      byDay[day].push(team);
    }
  }

  for (const day of DAYS) {
    byDay[day].sort((a, b) => b.size - a.size);
  }

  return byDay;
}

type BenchPoint = {
  x: number;
  y: number;
  floorId: string;
};

function benchPoint(bench: Bench, fallbackIndex: number): BenchPoint {
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

function benchDistance(a: BenchPoint, b: BenchPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const base = Math.sqrt(dx * dx + dy * dy);
  if (a.floorId !== b.floorId) {
    return base + 250;
  }
  return base;
}

function bestSpatialCluster(
  benchesByOrder: Bench[],
  benchRemaining: Record<string, number>,
  seatsNeeded: number,
  preferredPoint: BenchPoint | null,
  proximityWeight: number,
): { benchIds: string[]; waste: number; spread: number; center: BenchPoint } | null {
  let best: { benchIds: string[]; waste: number; spread: number; center: BenchPoint } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const pointsByBench: Record<string, BenchPoint> = {};
  benchesByOrder.forEach((bench, index) => {
    pointsByBench[bench.id] = benchPoint(bench, index);
  });

  for (const anchorBench of benchesByOrder) {
    if ((benchRemaining[anchorBench.id] ?? 0) <= 0) {
      continue;
    }
    const anchorPoint = pointsByBench[anchorBench.id];
    const candidateBenches = benchesByOrder
      .filter((bench) => (benchRemaining[bench.id] ?? 0) > 0)
      .map((bench) => ({
        bench,
        distance: benchDistance(anchorPoint, pointsByBench[bench.id]),
      }))
      .sort((a, b) => a.distance - b.distance);

    let seats = 0;
    const selected: string[] = [];
    let spread = 0;
    for (const candidate of candidateBenches) {
      selected.push(candidate.bench.id);
      seats += benchRemaining[candidate.bench.id];
      spread = Math.max(spread, candidate.distance);
      if (seats >= seatsNeeded) {
        break;
      }
    }
    if (seats < seatsNeeded) {
      continue;
    }

    const waste = seats - seatsNeeded;
    const centroid = selected.reduce(
      (acc, benchId) => {
        const point = pointsByBench[benchId];
        acc.x += point.x;
        acc.y += point.y;
        return acc;
      },
      { x: 0, y: 0 },
    );
    const center: BenchPoint = {
      x: centroid.x / selected.length,
      y: centroid.y / selected.length,
      floorId: anchorPoint.floorId,
    };

    // Favor compact team placement first; proximity/stability is secondary.
    const splitPenalty = Math.max(0, selected.length - 1) * 14;
    const spreadPenalty = spread * 20;
    const wastePenalty = waste * 1.5;
    const preferencePenalty =
      preferredPoint === null ? 0 : benchDistance(center, preferredPoint) * proximityWeight;
    const score = spreadPenalty + splitPenalty + wastePenalty + preferencePenalty;
    const candidate = { benchIds: selected, waste, spread, center };
    if (!best || score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function buildProximityMap(
  requests: TeamProximityRequest[] | undefined,
  day: Day,
): Record<string, Record<string, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const req of requests ?? []) {
    const reqDays = req.days && req.days.length > 0 ? req.days : DAYS;
    if (!reqDays.includes(day)) {
      continue;
    }
    if (!req.teamA || !req.teamB || req.teamA === req.teamB) {
      continue;
    }
    if (!map[req.teamA]) {
      map[req.teamA] = {};
    }
    if (!map[req.teamB]) {
      map[req.teamB] = {};
    }
    const weight = Math.max(1, Math.min(5, req.strength));
    map[req.teamA][req.teamB] = Math.max(map[req.teamA][req.teamB] ?? 0, weight);
    map[req.teamB][req.teamA] = Math.max(map[req.teamB][req.teamA] ?? 0, weight);
  }
  return map;
}

function buildStrictGroupsForDay(
  teamsInDay: Team[],
  requests: TeamProximityRequest[] | undefined,
  day: Day,
): string[][] {
  const teamIds = teamsInDay.map((team) => team.id);
  const present = new Set(teamIds);
  const adjacency: Record<string, Set<string>> = {};
  for (const teamId of teamIds) {
    adjacency[teamId] = new Set();
  }

  for (const req of requests ?? []) {
    if (!req.strict || !present.has(req.teamA) || !present.has(req.teamB)) {
      continue;
    }
    const reqDays = req.days && req.days.length > 0 ? req.days : DAYS;
    if (!reqDays.includes(day)) {
      continue;
    }
    adjacency[req.teamA].add(req.teamB);
    adjacency[req.teamB].add(req.teamA);
  }

  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const teamId of teamIds) {
    if (visited.has(teamId)) {
      continue;
    }
    const stack = [teamId];
    const component: string[] = [];
    visited.add(teamId);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const neighbor of adjacency[current]) {
        if (visited.has(neighbor)) {
          continue;
        }
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    if (component.length > 1) {
      groups.push(component);
    }
  }

  return groups;
}

function allocateBenches(
  input: PlannerInput,
  teams: Team[],
  assignments: AssignmentMap,
  capacity: CapacityContext,
): {
  allocations: BenchAllocation[];
  flexAllocations: FlexAllocation[];
  contiguityPenalty: number;
  strictProximityRelaxations: string[];
} {
  const allocations: BenchAllocation[] = [];
  const flexAllocations: FlexAllocation[] = [];
  let contiguityPenalty = 0;
  const strictProximityRelaxations: string[] = [];
  const byDay = teamsByDay(teams, assignments);
  const requiredByTeam = requiredSeatsMap(teams, input);
  const benchStabilityWeight = Math.max(0, Math.min(10, input.benchStabilityWeight ?? 5));
  const teamAllocatedByDay: Record<Day, Record<string, number>> = {
    Mon: {},
    Tue: {},
    Wed: {},
    Thu: {},
    Fri: {},
  };
  const teamBenchCenters: Record<string, BenchPoint> = {};
  const benchById = new Map(capacity.benchesByOrder.map((bench) => [bench.id, bench]));
  const benchPointById: Record<string, BenchPoint> = {};
  const teamById = new Map(teams.map((team) => [team.id, team]));
  capacity.benchesByOrder.forEach((bench, index) => {
    benchPointById[bench.id] = benchPoint(bench, index);
  });

  function addTeamAllocation(day: Day, teamId: string, benchId: string, seats: number): void {
    if (seats <= 0) {
      return;
    }
    teamAllocatedByDay[day][teamId] = (teamAllocatedByDay[day][teamId] ?? 0) + seats;
    const existing = allocations.find((item) => item.day === day && item.teamId === teamId && item.benchId === benchId);
    if (existing) {
      existing.seats += seats;
      return;
    }
    allocations.push({ benchId, day, teamId, seats });
  }

  for (const day of DAYS) {
    const benchRemaining: Record<string, number> = { ...capacity.benchAvailability[day] };
    const teamList = byDay[day];
    const strictGroups = buildStrictGroupsForDay(teamList, input.proximityRequests, day);
    const proximityMap = buildProximityMap(input.proximityRequests, day);
    const dayCenters: Record<string, BenchPoint> = {};
    const anchorReservedByTeam: Record<string, { benchId: string; seats: number }> = {};

    // Reserve anchored seats first so non-anchored placements cannot consume mandatory anchor desks.
    for (const team of teamList) {
      const anchorBenchId = teamAnchorBenchId(team);
      const anchorSeats = teamAnchorSeats(team);
      if (!anchorBenchId || anchorSeats <= 0) {
        continue;
      }
      const available = benchRemaining[anchorBenchId] ?? 0;
      if (available < anchorSeats) {
        // Guardrail: keep anchored-seat requirements hard even if input drift creates an impossible state.
        contiguityPenalty += 1000;
        continue;
      }
      benchRemaining[anchorBenchId] -= anchorSeats;
      anchorReservedByTeam[team.id] = { benchId: anchorBenchId, seats: anchorSeats };
    }

    const groupedTeamIds = new Set(strictGroups.reduce((acc, group) => [...acc, ...group], [] as string[]));
    const units: Array<{ teamIds: string[]; strict: boolean; totalSize: number }> = [];
    for (const group of strictGroups) {
      const totalSize = group.reduce((acc, teamId) => acc + (requiredByTeam[teamId] ?? teamById.get(teamId)?.size ?? 0), 0);
      units.push({ teamIds: group, strict: true, totalSize });
    }
    for (const team of teamList) {
      if (groupedTeamIds.has(team.id)) {
        continue;
      }
      units.push({ teamIds: [team.id], strict: false, totalSize: requiredByTeam[team.id] ?? team.size });
    }
    units.sort((a, b) => b.totalSize - a.totalSize);

    function allocateUnit(unitTeams: Team[], forceSinglePlacement: boolean): boolean {
      const startAllocLen = allocations.length;
      const startPenalty = contiguityPenalty;
      const benchSnapshot = forceSinglePlacement ? { ...benchRemaining } : null;
      const dayCentersSnapshot = forceSinglePlacement ? { ...dayCenters } : null;
      const teamBenchCentersSnapshot = forceSinglePlacement ? { ...teamBenchCenters } : null;
      const teamAllocatedDaySnapshot = forceSinglePlacement ? { ...teamAllocatedByDay[day] } : null;

      function rollbackAndFail(): boolean {
        if (!forceSinglePlacement || !benchSnapshot || !dayCentersSnapshot || !teamBenchCentersSnapshot) {
          return false;
        }
        allocations.length = startAllocLen;
        contiguityPenalty = startPenalty;
        for (const [benchId, seats] of Object.entries(benchSnapshot)) {
          benchRemaining[benchId] = seats;
        }
        for (const key of Object.keys(dayCenters)) {
          delete dayCenters[key];
        }
        Object.assign(dayCenters, dayCentersSnapshot);
        for (const key of Object.keys(teamBenchCenters)) {
          delete teamBenchCenters[key];
        }
        Object.assign(teamBenchCenters, teamBenchCentersSnapshot);
        teamAllocatedByDay[day] = { ...(teamAllocatedDaySnapshot ?? {}) };
        return false;
      }

      const teamSeatByBench: Record<string, Record<string, number>> = {};
      const teamLeft: Record<string, number> = {};
      for (const team of unitTeams) {
        teamSeatByBench[team.id] = {};
        const anchorBenchId = teamAnchorBenchId(team);
        const anchorSeats = teamAnchorSeats(team);
        const requiredSeats = requiredByTeam[team.id] ?? team.size;
        const reservedAnchorSeats = anchorBenchId ? anchorReservedByTeam[team.id]?.seats ?? 0 : 0;
        if (anchorBenchId && anchorSeats > 0 && reservedAnchorSeats < anchorSeats) {
          return rollbackAndFail();
        }

        let left = requiredSeats;
        if (anchorBenchId && reservedAnchorSeats > 0) {
          addTeamAllocation(day, team.id, anchorBenchId, reservedAnchorSeats);
          teamSeatByBench[team.id][anchorBenchId] = reservedAnchorSeats;
          left -= reservedAnchorSeats;
        }

        // If the team is anchored, keep as many of its remaining seats on that bench as possible.
        if (anchorBenchId && left > 0) {
          const anchorAvailable = benchRemaining[anchorBenchId] ?? 0;
          if (anchorAvailable > 0) {
            const extraAnchorSeats = Math.min(anchorAvailable, left);
            if (extraAnchorSeats > 0) {
              benchRemaining[anchorBenchId] -= extraAnchorSeats;
              left -= extraAnchorSeats;
              addTeamAllocation(day, team.id, anchorBenchId, extraAnchorSeats);
              teamSeatByBench[team.id][anchorBenchId] =
                (teamSeatByBench[team.id][anchorBenchId] ?? 0) + extraAnchorSeats;
            }
          }
        }
        teamLeft[team.id] = left;
      }

      function sumLeft(): number {
        return Object.values(teamLeft).reduce((acc, value) => acc + value, 0);
      }

      function allocateSeatChunk(benchId: string, seats: number): void {
        let leftSeats = seats;
        while (leftSeats > 0) {
          const nextTeamId = unitTeams
            .map((team) => team.id)
            .filter((teamId) => (teamLeft[teamId] ?? 0) > 0)
            .sort((a, b) => (teamLeft[b] ?? 0) - (teamLeft[a] ?? 0))[0];
          if (!nextTeamId) {
            break;
          }
          const take = Math.min(leftSeats, teamLeft[nextTeamId]);
          teamLeft[nextTeamId] -= take;
          leftSeats -= take;
          addTeamAllocation(day, nextTeamId, benchId, take);
          teamSeatByBench[nextTeamId][benchId] = (teamSeatByBench[nextTeamId][benchId] ?? 0) + take;
        }
      }

      let preferredCenter: BenchPoint | null = null;
      let preferenceWeight = 0;
      const weightedCenters: Array<{ center: BenchPoint; weight: number }> = [];
      for (const team of unitTeams) {
        const partners = proximityMap[team.id] ?? {};
        for (const [partnerId, weight] of Object.entries(partners)) {
          const partnerCenter = dayCenters[partnerId];
          if (!partnerCenter) {
            continue;
          }
          weightedCenters.push({ center: partnerCenter, weight });
        }
        if (benchStabilityWeight > 0 && teamBenchCenters[team.id] !== undefined) {
          weightedCenters.push({ center: teamBenchCenters[team.id], weight: benchStabilityWeight });
        }
        const anchorBenchId = teamAnchorBenchId(team);
        if (anchorBenchId && benchPointById[anchorBenchId]) {
          weightedCenters.push({ center: benchPointById[anchorBenchId], weight: 18 });
        }
      }
      if (weightedCenters.length > 0) {
        const totalWeight = weightedCenters.reduce((acc, item) => acc + item.weight, 0);
        const accum = weightedCenters.reduce(
          (acc, item) => {
            acc.x += item.center.x * item.weight;
            acc.y += item.center.y * item.weight;
            return acc;
          },
          { x: 0, y: 0 },
        );
        preferredCenter = {
          x: accum.x / totalWeight,
          y: accum.y / totalWeight,
          floorId: weightedCenters[0].center.floorId,
        };
        preferenceWeight = Math.max(1, Math.round(totalWeight));
      }

      let left = sumLeft();
      if (left > 0) {
        const segment = bestSpatialCluster(
          capacity.benchesByOrder,
          benchRemaining,
          left,
          preferredCenter,
          preferenceWeight * 2,
        );
        if (!segment && forceSinglePlacement) {
          return rollbackAndFail();
        }
        if (segment) {
          const orderedBenches = [...segment.benchIds];
          for (const benchId of orderedBenches) {
            if (left <= 0) {
              break;
            }
            const bench = benchById.get(benchId);
            if (!bench) {
              continue;
            }
            const available = benchRemaining[bench.id];
            if (available <= 0) {
              continue;
            }
            const seats = Math.min(available, left);
            benchRemaining[bench.id] -= seats;
            left -= seats;
            allocateSeatChunk(bench.id, seats);
          }
          contiguityPenalty += Math.round(segment.spread / 4);
        }
      }

      left = sumLeft();
      if (left > 0) {
        if (forceSinglePlacement) {
          return rollbackAndFail();
        }
        // Fallback to non-contiguous fill when a contiguous segment under-delivers due fragmentation.
        for (const bench of capacity.benchesByOrder) {
          if (left <= 0) {
            break;
          }
          const available = benchRemaining[bench.id];
          if (available <= 0) {
            continue;
          }
          const seats = Math.min(available, left);
          benchRemaining[bench.id] -= seats;
          left -= seats;
          allocateSeatChunk(bench.id, seats);
        }
        contiguityPenalty += 10;
      }

      const aggregateByBench: Record<string, number> = {};
      for (const team of unitTeams) {
        for (const [benchId, seats] of Object.entries(teamSeatByBench[team.id])) {
          aggregateByBench[benchId] = (aggregateByBench[benchId] ?? 0) + seats;
        }
      }
      const seatEntries = Object.entries(aggregateByBench).filter(([, seats]) => seats > 0);
      if (seatEntries.length === 0) {
        return true;
      }
      const totalUnitSeats = seatEntries.reduce((acc, [, seats]) => acc + seats, 0);
      const accum = seatEntries.reduce(
        (acc, [benchId, seats]) => {
          const point = benchPointById[benchId];
          if (!point) {
            return acc;
          }
          acc.x += point.x * seats;
          acc.y += point.y * seats;
          return acc;
        },
        { x: 0, y: 0 },
      );
      const firstPoint = benchPointById[seatEntries[0][0]];
      const center: BenchPoint = {
        x: accum.x / totalUnitSeats,
        y: accum.y / totalUnitSeats,
        floorId: firstPoint?.floorId ?? (teamBenchCenters[unitTeams[0].id]?.floorId ?? "F1"),
      };
      for (const team of unitTeams) {
        dayCenters[team.id] = center;
        teamBenchCenters[team.id] =
          teamBenchCenters[team.id] === undefined
            ? center
            : {
                x: (teamBenchCenters[team.id].x * 2 + center.x) / 3,
                y: (teamBenchCenters[team.id].y * 2 + center.y) / 3,
                floorId: center.floorId,
              };
      }
      return true;
    }

    for (const unit of units) {
      const unitTeams = unit.teamIds.map((teamId) => teamById.get(teamId)).filter((team): team is Team => !!team);
      if (unitTeams.length === 0) {
        continue;
      }
      const strictAsOne = unit.strict && unitTeams.length > 1;
      const ok = allocateUnit(unitTeams, strictAsOne);
      if (ok || !strictAsOne) {
        continue;
      }
      strictProximityRelaxations.push(`${day}: ${unitTeams.map((team) => team.id).join(" + ")}`);
      for (const team of unitTeams) {
        allocateUnit([team], false);
      }
    }

    // Use leftover seats to reduce partial attendance before assigning flex seats.
    // Distribute extras fairly (round-robin by highest shortfall ratio) so multiple teams benefit.
    const extraNeedByTeam: Record<string, number> = {};
    for (const team of teamList) {
      const allocatedSeats = teamAllocatedByDay[day][team.id] ?? 0;
      extraNeedByTeam[team.id] = Math.max(0, team.size - allocatedSeats);
    }

    function totalExtraNeed(): number {
      return teamList.reduce((acc, team) => acc + (extraNeedByTeam[team.id] ?? 0), 0);
    }

    function bestBenchForTeamExtra(team: Team): string | null {
      const anchorBenchId = teamAnchorBenchId(team);
      if (anchorBenchId && (benchRemaining[anchorBenchId] ?? 0) > 0) {
        return anchorBenchId;
      }
      const preferredCenter =
        dayCenters[team.id] ??
        teamBenchCenters[team.id] ??
        (anchorBenchId ? benchPointById[anchorBenchId] : undefined) ??
        null;
      let bestBenchId: string | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const bench of capacity.benchesByOrder) {
        const available = benchRemaining[bench.id] ?? 0;
        if (available <= 0) {
          continue;
        }
        const point = benchPointById[bench.id];
        const distancePenalty = preferredCenter ? benchDistance(point, preferredCenter) : 0;
        const score = distancePenalty + bench.order * 0.0001;
        if (score < bestScore) {
          bestScore = score;
          bestBenchId = bench.id;
        }
      }
      return bestBenchId;
    }

    while (totalExtraNeed() > 0) {
      const teamsWithNeed = teamList
        .filter((team) => (extraNeedByTeam[team.id] ?? 0) > 0)
        .sort((a, b) => {
          const shortfallRatioA = (extraNeedByTeam[a.id] ?? 0) / Math.max(1, a.size);
          const shortfallRatioB = (extraNeedByTeam[b.id] ?? 0) / Math.max(1, b.size);
          if (shortfallRatioA !== shortfallRatioB) {
            return shortfallRatioB - shortfallRatioA;
          }
          return (extraNeedByTeam[b.id] ?? 0) - (extraNeedByTeam[a.id] ?? 0);
        });
      if (teamsWithNeed.length === 0) {
        break;
      }
      let progressed = false;
      for (const team of teamsWithNeed) {
        const needed = extraNeedByTeam[team.id] ?? 0;
        if (needed <= 0) {
          continue;
        }
        const benchId = bestBenchForTeamExtra(team);
        if (!benchId) {
          continue;
        }
        const available = benchRemaining[benchId] ?? 0;
        if (available <= 0) {
          continue;
        }
        const seats = Math.min(1, needed, available);
        if (seats <= 0) {
          continue;
        }
        benchRemaining[benchId] -= seats;
        extraNeedByTeam[team.id] -= seats;
        addTeamAllocation(day, team.id, benchId, seats);
        progressed = true;
      }
      if (!progressed) {
        break;
      }
    }

    let flexLeft = capacity.dayFlex[day];
    for (let idx = capacity.benchesByOrder.length - 1; idx >= 0 && flexLeft > 0; idx -= 1) {
      const bench = capacity.benchesByOrder[idx];
      const available = benchRemaining[bench.id];
      if (available <= 0) {
        continue;
      }
      const seats = Math.min(available, flexLeft);
      flexLeft -= seats;
      benchRemaining[bench.id] -= seats;
      flexAllocations.push({ benchId: bench.id, day, seats });
    }
  }

  return { allocations, flexAllocations, contiguityPenalty, strictProximityRelaxations };
}

function teamSeatByDayMap(allocations: BenchAllocation[]): Record<string, DayMap<number>> {
  const map: Record<string, DayMap<number>> = {};
  for (const allocation of allocations) {
    if (!map[allocation.teamId]) {
      map[allocation.teamId] = emptyDayMap(0);
    }
    map[allocation.teamId][allocation.day] += allocation.seats;
  }
  return map;
}

function buildTeamDiagnostics(
  teams: Team[],
  assignments: AssignmentMap,
  allocations: BenchAllocation[],
  input: PlannerInput,
): TeamDiagnostics[] {
  const teamSeatsByDay = teamSeatByDayMap(allocations);
  return teams.map((team) => {
    const days = assignments[team.id] ?? new Set<Day>();
    const scheduledDays = days.size;
    const requiredSeatsPerDay = requiredSeatsForTeamDay(team, input);
    const qualifiedDays: Day[] = [];
    let seatShortfallTotal = 0;
    for (const day of days) {
      const allocatedSeats = teamSeatsByDay[team.id]?.[day] ?? 0;
      if (allocatedSeats >= requiredSeatsPerDay) {
        qualifiedDays.push(day);
      }
      seatShortfallTotal += Math.max(0, team.size - allocatedSeats);
    }
    const assignedDays = qualifiedDays.length;
    const unmetDays = Math.max(0, team.targetDays - assignedDays);
    const fulfillmentRatio = team.targetDays > 0 ? assignedDays / team.targetDays : 1;
    const monFriPairAssigned = hasMonFriPair(qualifiedDays);
    return {
      teamId: team.id,
      targetDays: team.targetDays,
      scheduledDays,
      assignedDays,
      unmetDays,
      fulfillmentRatio,
      preferredHits: preferredHits(qualifiedDays, team),
      monFriSatisfied: qualifiedDays.some(dayIsMonFri),
      monFriPairAssigned,
      requiredSeatsPerDay,
      seatShortfallTotal,
    };
  });
}

function buildDayDiagnostics(
  allocations: BenchAllocation[],
  flexAllocations: FlexAllocation[],
  capacity: CapacityContext,
): DayDiagnostics[] {
  const allocatedByDay = emptyDayMap(0);
  for (const item of allocations) {
    allocatedByDay[item.day] += item.seats;
  }
  const flexByDay = emptyDayMap(0);
  for (const item of flexAllocations) {
    flexByDay[item.day] += item.seats;
  }

  return DAYS.map((day) => {
    const allocatedSeats = allocatedByDay[day];
    return {
      day,
      allocatedSeats,
      preallocatedSeats: capacity.dayPreallocated[day],
      flexSeats: flexByDay[day],
      totalSeats: capacity.totalSeats,
      occupancyPercent: capacity.totalSeats > 0 ? (allocatedSeats / capacity.totalSeats) * 100 : 0,
    };
  });
}

function toTeamSchedules(
  teams: Team[],
  assignments: AssignmentMap,
  allocations: BenchAllocation[],
  input: PlannerInput,
): TeamSchedule[] {
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const teamSeatsByDay = teamSeatByDayMap(allocations);
  return Object.entries(assignments).map(([teamId, daySet]) => {
    const team = teamById.get(teamId);
    const requiredSeats = team ? requiredSeatsForTeamDay(team, input) : 1;
    const days = [...daySet]
      .filter((day) => (teamSeatsByDay[teamId]?.[day] ?? 0) >= requiredSeats)
      .sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    return { teamId, days };
  });
}

function makePlan(input: PlannerInput, mode: SolverMode): PlanResult {
  const capacity = buildCapacityContext(input);
  const assignmentResult = assignDays(input, capacity, mode);
  const { allocations, flexAllocations, contiguityPenalty, strictProximityRelaxations } = allocateBenches(
    input,
    input.teams,
    assignmentResult.assignments,
    capacity,
  );

  const teamDiagnostics = buildTeamDiagnostics(input.teams, assignmentResult.assignments, allocations, input);
  const dayDiagnostics = buildDayDiagnostics(allocations, flexAllocations, capacity);
  const fairnessMinRatio = teamDiagnostics.reduce((min, row) => Math.min(min, row.fulfillmentRatio), 1);
  const totalFulfilledDays = teamDiagnostics.reduce((acc, row) => acc + row.assignedDays, 0);
  const monFriPairAssignedTeams = teamDiagnostics.filter((row) => row.monFriPairAssigned).length;

  return {
    allocations,
    flexAllocations,
    teamSchedules: toTeamSchedules(input.teams, assignmentResult.assignments, allocations, input),
    diagnostics: {
      mode,
      exactFeasible: assignmentResult.exactFeasible,
      relaxedApplied: assignmentResult.relaxedApplied,
      fairnessMinRatio,
      totalFulfilledDays,
      contiguityPenalty,
      monFriPairAssignedTeams,
      strictProximityRelaxations,
      teamDiagnostics,
      dayDiagnostics,
    },
  };
}

function mergePlanResults(mode: SolverMode, plans: PlanResult[]): PlanResult {
  const allocations = plans.flatMap((planPart) => planPart.allocations);
  const flexAllocations = plans.flatMap((planPart) => planPart.flexAllocations);
  const teamSchedules = plans
    .flatMap((planPart) => planPart.teamSchedules)
    .sort((a, b) => a.teamId.localeCompare(b.teamId));
  const teamDiagnostics = plans
    .flatMap((planPart) => planPart.diagnostics.teamDiagnostics)
    .sort((a, b) => a.teamId.localeCompare(b.teamId));

  const totalsByDay: Record<
    Day,
    {
      allocatedSeats: number;
      preallocatedSeats: number;
      flexSeats: number;
      totalSeats: number;
    }
  > = {
    Mon: { allocatedSeats: 0, preallocatedSeats: 0, flexSeats: 0, totalSeats: 0 },
    Tue: { allocatedSeats: 0, preallocatedSeats: 0, flexSeats: 0, totalSeats: 0 },
    Wed: { allocatedSeats: 0, preallocatedSeats: 0, flexSeats: 0, totalSeats: 0 },
    Thu: { allocatedSeats: 0, preallocatedSeats: 0, flexSeats: 0, totalSeats: 0 },
    Fri: { allocatedSeats: 0, preallocatedSeats: 0, flexSeats: 0, totalSeats: 0 },
  };

  for (const planPart of plans) {
    for (const row of planPart.diagnostics.dayDiagnostics) {
      totalsByDay[row.day].allocatedSeats += row.allocatedSeats;
      totalsByDay[row.day].preallocatedSeats += row.preallocatedSeats;
      totalsByDay[row.day].flexSeats += row.flexSeats;
      totalsByDay[row.day].totalSeats += row.totalSeats;
    }
  }

  const dayDiagnostics: DayDiagnostics[] = DAYS.map((day) => {
    const totals = totalsByDay[day];
    return {
      day,
      allocatedSeats: totals.allocatedSeats,
      preallocatedSeats: totals.preallocatedSeats,
      flexSeats: totals.flexSeats,
      totalSeats: totals.totalSeats,
      occupancyPercent: totals.totalSeats > 0 ? (totals.allocatedSeats / totals.totalSeats) * 100 : 0,
    };
  });

  const fairnessMinRatio =
    teamDiagnostics.length > 0
      ? teamDiagnostics.reduce((min, row) => Math.min(min, row.fulfillmentRatio), 1)
      : 1;
  const totalFulfilledDays = teamDiagnostics.reduce((acc, row) => acc + row.assignedDays, 0);
  const monFriPairAssignedTeams = teamDiagnostics.filter((row) => row.monFriPairAssigned).length;

  return {
    allocations,
    flexAllocations,
    teamSchedules,
    diagnostics: {
      mode,
      exactFeasible: plans.every((planPart) => planPart.diagnostics.exactFeasible),
      relaxedApplied: plans.some((planPart) => planPart.diagnostics.relaxedApplied),
      fairnessMinRatio,
      totalFulfilledDays,
      contiguityPenalty: plans.reduce((acc, planPart) => acc + planPart.diagnostics.contiguityPenalty, 0),
      monFriPairAssignedTeams,
      strictProximityRelaxations: plans.flatMap((planPart) => planPart.diagnostics.strictProximityRelaxations),
      teamDiagnostics,
      dayDiagnostics,
    },
  };
}

export function plan(input: PlannerInput): PlannerResponse {
  const primaryMode = input.solverMode;
  const secondaryMode: SolverMode = primaryMode === "fairness_first" ? "efficiency_first" : "fairness_first";

  const benchFloorById = new Map<string, string>();
  for (const bench of input.benches) {
    benchFloorById.set(bench.id, (bench.floorId ?? "F1").trim() || "F1");
  }

  const benchFloorIds = [...new Set(input.benches.map((bench) => (bench.floorId ?? "F1").trim() || "F1"))];
  const fallbackFloorId = benchFloorIds[0] ?? "F1";
  const teamFloorById = new Map<string, string>();
  for (const team of input.teams) {
    teamFloorById.set(team.id, teamFloorId(team, benchFloorById, fallbackFloorId));
  }

  const allFloorIds = [...new Set([...benchFloorIds, ...teamFloorById.values()])];
  const proximityByFloor: Record<string, TeamProximityRequest[]> = {};
  for (const request of input.proximityRequests ?? []) {
    const floorA = teamFloorById.get(request.teamA);
    const floorB = teamFloorById.get(request.teamB);
    if (floorA && floorB && floorA !== floorB) {
      continue;
    }
    const explicitFloorId = (request.floorId ?? "").trim();
    const inferredFloorId = explicitFloorId || floorA || floorB || fallbackFloorId;
    if (floorA && floorA !== inferredFloorId) {
      continue;
    }
    if (floorB && floorB !== inferredFloorId) {
      continue;
    }
    if (!proximityByFloor[inferredFloorId]) {
      proximityByFloor[inferredFloorId] = [];
    }
    proximityByFloor[inferredFloorId].push({ ...request, floorId: inferredFloorId });
  }

  const floorInputs: PlannerInput[] = allFloorIds.map((floorId) => {
    const floorBenches = input.benches.filter((bench) => ((bench.floorId ?? "F1").trim() || "F1") === floorId);
    const floorBenchIds = new Set(floorBenches.map((bench) => bench.id));
    const floorTeams = input.teams
      .filter((team) => teamFloorById.get(team.id) === floorId)
      .map((team) => ({ ...team, floorId }));
    const floorPreallocations = input.preallocations.filter((item) => floorBenchIds.has(item.benchId));
    const floorProximity = proximityByFloor[floorId] ?? [];

    return {
      benches: floorBenches,
      preallocations: floorPreallocations,
      teams: floorTeams,
      flexPolicy: input.flexPolicy,
      solverMode: input.solverMode,
      proximityRequests: floorProximity,
      benchStabilityWeight: input.benchStabilityWeight,
      monFriPairPenaltyWeight: input.monFriPairPenaltyWeight,
      allowedSeatShortfallPerTeamDay: input.allowedSeatShortfallPerTeamDay,
    };
  });

  const primaryByFloor = floorInputs.map((floorInput) => makePlan(floorInput, primaryMode));
  const comparisonByFloor = floorInputs.map((floorInput) => makePlan(floorInput, secondaryMode));
  const primary = mergePlanResults(primaryMode, primaryByFloor);
  const comparison = mergePlanResults(secondaryMode, comparisonByFloor);

  return { primary, comparison };
}
