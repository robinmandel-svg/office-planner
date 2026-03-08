export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;

export type Day = (typeof DAYS)[number];
export type SolverMode = "fairness_first" | "efficiency_first";

export type Bench = {
  id: string;
  capacity: number;
  order: number;
  floorId?: string;
  layout?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

export type Preallocation = {
  benchId: string;
  day: Day;
  seats: number;
  label?: string;
};

export type Team = {
  id: string;
  size: number;
  targetDays: number;
  preferredDays: Day[];
  contiguousDaysRequired: boolean;
};

export type FlexPolicy = {
  defaultPercent: number;
  overrides?: Partial<Record<Day, number>>;
  rounding: "nearest";
};

export type TeamProximityRequest = {
  teamA: string;
  teamB: string;
  strength: number;
};

export type PlannerInput = {
  benches: Bench[];
  preallocations: Preallocation[];
  teams: Team[];
  flexPolicy: FlexPolicy;
  solverMode: SolverMode;
  proximityRequests?: TeamProximityRequest[];
  benchStabilityWeight?: number;
};

export type TeamSchedule = {
  teamId: string;
  days: Day[];
};

export type BenchAllocation = {
  benchId: string;
  day: Day;
  teamId: string;
  seats: number;
};

export type FlexAllocation = {
  benchId: string;
  day: Day;
  seats: number;
};

export type TeamDiagnostics = {
  teamId: string;
  targetDays: number;
  assignedDays: number;
  unmetDays: number;
  fulfillmentRatio: number;
  preferredHits: number;
  monFriSatisfied: boolean;
};

export type DayDiagnostics = {
  day: Day;
  allocatedSeats: number;
  preallocatedSeats: number;
  flexSeats: number;
  totalSeats: number;
  occupancyPercent: number;
};

export type PlanDiagnostics = {
  mode: SolverMode;
  exactFeasible: boolean;
  relaxedApplied: boolean;
  fairnessMinRatio: number;
  totalFulfilledDays: number;
  contiguityPenalty: number;
  teamDiagnostics: TeamDiagnostics[];
  dayDiagnostics: DayDiagnostics[];
};

export type PlanResult = {
  allocations: BenchAllocation[];
  flexAllocations: FlexAllocation[];
  teamSchedules: TeamSchedule[];
  diagnostics: PlanDiagnostics;
};

export type PlannerResponse = {
  primary: PlanResult;
  comparison: PlanResult;
};
