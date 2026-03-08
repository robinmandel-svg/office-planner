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

type AssignmentMap = Record<string, Set<Day>>;

type CapacityContext = {
  totalSeats: number;
  benchesByOrder: Bench[];
  benchAvailability: Record<Day, Record<string, number>>;
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
  const benchAvailability: Record<Day, Record<string, number>> = {
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
    dayCapacity[day] = Math.max(0, usable - dayFlex[day]);
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
  mode: SolverMode,
): number {
  const used = DAYS.map((day) => dayCap[day] - remaining[day]);
  const balancePenalty = variance(used);
  if (mode === "efficiency_first") {
    return prefScore * 20 - balancePenalty;
  }
  return prefScore * 25 - balancePenalty * 1.5;
}

function cloneAssignments(assignments: AssignmentMap): AssignmentMap {
  const next: AssignmentMap = {};
  for (const [teamId, days] of Object.entries(assignments)) {
    next[teamId] = new Set(days);
  }
  return next;
}

function tryExactAssignment(input: PlannerInput, capacity: CapacityContext, mode: SolverMode): AssignmentMap | null {
  const teams = [...input.teams].sort((a, b) => {
    const scoreA = a.size * a.targetDays;
    const scoreB = b.size * b.targetDays;
    return scoreB - scoreA;
  });

  const dayCap = capacity.dayCapacity;
  const BEAM_WIDTH = 300;

  type BeamState = {
    remaining: DayMap<number>;
    assignments: AssignmentMap;
    prefScore: number;
    score: number;
  };

  let beam: BeamState[] = [
    {
      remaining: { ...dayCap },
      assignments: {},
      prefScore: 0,
      score: 0,
    },
  ];

  for (const team of teams) {
    const options = generateDayCombosExact(team);
    if (options.length === 0) {
      return null;
    }

    const nextBeam: BeamState[] = [];

    for (const state of beam) {
      for (const option of options) {
        let feasible = true;
        for (const day of option) {
          if (state.remaining[day] < team.size) {
            feasible = false;
            break;
          }
        }
        if (!feasible) {
          continue;
        }

        const remaining: DayMap<number> = { ...state.remaining };
        for (const day of option) {
          remaining[day] -= team.size;
        }

        const assignments = cloneAssignments(state.assignments);
        assignments[team.id] = new Set(option);

        const prefScore = state.prefScore + preferredHits(option, team);
        const score = scoreExactState(remaining, dayCap, prefScore, mode);
        nextBeam.push({ remaining, assignments, prefScore, score });
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
  dayCap: DayMap<number>,
  mode: SolverMode,
): Day | null {
  const hasMonFri = [...assigned].some(dayIsMonFri);
  const candidates: { day: Day; score: number }[] = [];

  for (const day of DAYS) {
    if (assigned.has(day)) {
      continue;
    }
    if (remaining[day] < team.size) {
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
): void {
  for (const team of teams) {
    const assigned = assignments[team.id];
    if (!assigned || [...assigned].some(dayIsMonFri)) {
      continue;
    }

    const preferredSwapDays: Day[] = [MON, FRI];

    for (const day of preferredSwapDays) {
      if (assigned.has(day)) {
        continue;
      }

      if (remaining[day] >= team.size && assigned.size < team.targetDays) {
        const candidateDays = new Set(assigned);
        candidateDays.add(day);
        if (contiguousCompatible(team, candidateDays)) {
          assigned.add(day);
          remaining[day] -= team.size;
          break;
        }
      }

      if (remaining[day] >= team.size) {
        const dropDay = [...assigned].find((d) => !dayIsMonFri(d));
        if (!dropDay) {
          continue;
        }
        const candidateDays = new Set(assigned);
        candidateDays.delete(dropDay);
        candidateDays.add(day);
        if (contiguousCompatible(team, candidateDays)) {
          assigned.delete(dropDay);
          remaining[dropDay] += team.size;
          assigned.add(day);
          remaining[day] -= team.size;
          break;
        }
      }
    }
  }
}

function relaxedAssignment(input: PlannerInput, capacity: CapacityContext, mode: SolverMode): AssignmentMap {
  const assignments = initAssignments(input.teams);
  const remaining: DayMap<number> = { ...capacity.dayCapacity };
  const maxTarget = Math.max(0, ...input.teams.map((team) => team.targetDays));

  for (let round = 1; round <= maxTarget; round += 1) {
    const teams = [...input.teams]
      .filter((team) => team.targetDays >= round)
      .sort((a, b) => {
        const aRatio = assignments[a.id].size / Math.max(1, a.targetDays);
        const bRatio = assignments[b.id].size / Math.max(1, b.targetDays);
        if (mode === "fairness_first" && aRatio !== bRatio) {
          return aRatio - bRatio;
        }
        if (mode === "efficiency_first" && a.size !== b.size) {
          return a.size - b.size;
        }
        return b.targetDays - a.targetDays;
      });

    for (const team of teams) {
      const assigned = assignments[team.id];
      if (assigned.size >= team.targetDays) {
        continue;
      }
      const chosenDay = chooseDayForTeam(team, assigned, remaining, capacity.dayCapacity, mode);
      if (!chosenDay) {
        continue;
      }
      assigned.add(chosenDay);
      remaining[chosenDay] -= team.size;
    }
  }

  enforceMonFri(input.teams, assignments, remaining);
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
): Record<string, Record<string, number>> {
  const map: Record<string, Record<string, number>> = {};
  for (const req of requests ?? []) {
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

function allocateBenches(
  input: PlannerInput,
  teams: Team[],
  assignments: AssignmentMap,
  capacity: CapacityContext,
): { allocations: BenchAllocation[]; flexAllocations: FlexAllocation[]; contiguityPenalty: number } {
  const allocations: BenchAllocation[] = [];
  const flexAllocations: FlexAllocation[] = [];
  let contiguityPenalty = 0;
  const byDay = teamsByDay(teams, assignments);
  const proximityMap = buildProximityMap(input.proximityRequests);
  const benchStabilityWeight = Math.max(0, Math.min(10, input.benchStabilityWeight ?? 5));
  const teamBenchCenters: Record<string, BenchPoint> = {};

  for (const day of DAYS) {
    const benchRemaining: Record<string, number> = { ...capacity.benchAvailability[day] };
    const teamList = byDay[day];
    const dayCenters: Record<string, BenchPoint> = {};

    for (const team of teamList) {
      let preferredCenter: BenchPoint | null = null;
      let preferenceWeight = 0;
      const partners = proximityMap[team.id] ?? {};
      const weightedCenters: Array<{ center: BenchPoint; weight: number }> = [];
      for (const [partnerId, weight] of Object.entries(partners)) {
        const partnerCenter = dayCenters[partnerId];
        if (partnerCenter === undefined) {
          continue;
        }
        weightedCenters.push({ center: partnerCenter, weight });
      }
      if (benchStabilityWeight > 0 && teamBenchCenters[team.id] !== undefined) {
        weightedCenters.push({ center: teamBenchCenters[team.id], weight: benchStabilityWeight });
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

      const segment = bestSpatialCluster(
        capacity.benchesByOrder,
        benchRemaining,
        team.size,
        preferredCenter,
        preferenceWeight * 2,
      );
      if (!segment) {
        continue;
      }

      let left = team.size;
      // Keep bench order from cluster search (nearest-to-anchor) to reduce accidental long-tail splits.
      const orderedBenches = [...segment.benchIds];
      for (const benchId of orderedBenches) {
        if (left <= 0) {
          break;
        }
        const bench = capacity.benchesByOrder.find((item) => item.id === benchId);
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
        allocations.push({ benchId: bench.id, day, teamId: team.id, seats });
      }

      if (left > 0) {
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
          allocations.push({ benchId: bench.id, day, teamId: team.id, seats });
        }
        contiguityPenalty += 10;
      }

      contiguityPenalty += Math.round(segment.spread / 4);
      const segmentCenter = segment.center;
      dayCenters[team.id] = segmentCenter;
      teamBenchCenters[team.id] =
        teamBenchCenters[team.id] === undefined
          ? segmentCenter
          : {
              x: (teamBenchCenters[team.id].x * 2 + segmentCenter.x) / 3,
              y: (teamBenchCenters[team.id].y * 2 + segmentCenter.y) / 3,
              floorId: segmentCenter.floorId,
            };
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

  return { allocations, flexAllocations, contiguityPenalty };
}

function buildTeamDiagnostics(teams: Team[], assignments: AssignmentMap): TeamDiagnostics[] {
  return teams.map((team) => {
    const days = assignments[team.id] ?? new Set<Day>();
    const assignedDays = days.size;
    const unmetDays = Math.max(0, team.targetDays - assignedDays);
    const fulfillmentRatio = team.targetDays > 0 ? assignedDays / team.targetDays : 1;
    return {
      teamId: team.id,
      targetDays: team.targetDays,
      assignedDays,
      unmetDays,
      fulfillmentRatio,
      preferredHits: preferredHits(days, team),
      monFriSatisfied: [...days].some(dayIsMonFri),
    };
  });
}

function buildDayDiagnostics(
  allocations: BenchAllocation[],
  capacity: CapacityContext,
): DayDiagnostics[] {
  const allocatedByDay = emptyDayMap(0);
  for (const item of allocations) {
    allocatedByDay[item.day] += item.seats;
  }

  return DAYS.map((day) => {
    const allocatedSeats = allocatedByDay[day];
    return {
      day,
      allocatedSeats,
      preallocatedSeats: capacity.dayPreallocated[day],
      flexSeats: capacity.dayFlex[day],
      totalSeats: capacity.totalSeats,
      occupancyPercent: capacity.totalSeats > 0 ? (allocatedSeats / capacity.totalSeats) * 100 : 0,
    };
  });
}

function toTeamSchedules(assignments: AssignmentMap): TeamSchedule[] {
  return Object.entries(assignments).map(([teamId, daySet]) => {
    const days = [...daySet].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    return { teamId, days };
  });
}

function makePlan(input: PlannerInput, mode: SolverMode): PlanResult {
  const capacity = buildCapacityContext(input);
  const assignmentResult = assignDays(input, capacity, mode);
  const { allocations, flexAllocations, contiguityPenalty } = allocateBenches(
    input,
    input.teams,
    assignmentResult.assignments,
    capacity,
  );

  const teamDiagnostics = buildTeamDiagnostics(input.teams, assignmentResult.assignments);
  const dayDiagnostics = buildDayDiagnostics(allocations, capacity);
  const fairnessMinRatio = teamDiagnostics.reduce((min, row) => Math.min(min, row.fulfillmentRatio), 1);
  const totalFulfilledDays = teamDiagnostics.reduce((acc, row) => acc + row.assignedDays, 0);

  return {
    allocations,
    flexAllocations,
    teamSchedules: toTeamSchedules(assignmentResult.assignments),
    diagnostics: {
      mode,
      exactFeasible: assignmentResult.exactFeasible,
      relaxedApplied: assignmentResult.relaxedApplied,
      fairnessMinRatio,
      totalFulfilledDays,
      contiguityPenalty,
      teamDiagnostics,
      dayDiagnostics,
    },
  };
}

export function plan(input: PlannerInput): PlannerResponse {
  const primaryMode = input.solverMode;
  const secondaryMode: SolverMode = primaryMode === "fairness_first" ? "efficiency_first" : "fairness_first";

  const primary = makePlan(input, primaryMode);
  const comparison = makePlan(input, secondaryMode);

  return { primary, comparison };
}
