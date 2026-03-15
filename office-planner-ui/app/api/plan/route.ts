import { NextResponse } from "next/server";
import { plan } from "@/lib/planner";
import { DAYS, type Day, type PlannerInput } from "@/lib/types";

function isDay(value: string): value is Day {
  return DAYS.includes(value as Day);
}

function validateInput(raw: PlannerInput): string[] {
  const errors: string[] = [];

  if (!raw.benches.length) {
    errors.push("At least one bench is required.");
  }

  for (const bench of raw.benches) {
    if (!bench.id) {
      errors.push("Bench id cannot be empty.");
    }
    if (bench.capacity < 0) {
      errors.push(`Bench ${bench.id} capacity must be >= 0.`);
    }
    if (bench.layout) {
      const { x, y, w, h, rotation } = bench.layout;
      if ([x, y, w, h].some((value) => Number.isNaN(value))) {
        errors.push(`Bench ${bench.id} layout values must be numbers.`);
      }
      if (rotation !== undefined && Number.isNaN(rotation)) {
        errors.push(`Bench ${bench.id} layout rotation must be a number.`);
      }
      if (w <= 0 || h <= 0) {
        errors.push(`Bench ${bench.id} layout width/height must be > 0.`);
      }
      if (x < 0 || y < 0 || x > 100 || y > 100) {
        errors.push(`Bench ${bench.id} layout x/y must be between 0 and 100.`);
      }
    }
  }

  for (const team of raw.teams) {
    if (!team.id) {
      errors.push("Team id cannot be empty.");
    }
    if (team.size <= 0) {
      errors.push(`Team ${team.id} size must be > 0.`);
    }
    if (team.targetDays < 0 || team.targetDays > 5) {
      errors.push(`Team ${team.id} targetDays must be between 0 and 5.`);
    }
    if (typeof team.contiguousDaysRequired !== "boolean") {
      errors.push(`Team ${team.id} contiguousDaysRequired must be true or false.`);
    }
    if (!team.preferredDays.every((day) => isDay(day))) {
      errors.push(`Team ${team.id} has invalid preferred days.`);
    }
    const anchorBenchId = (team.anchorBenchId ?? "").trim();
    const anchorSeatsRaw = Number(team.anchorSeats ?? 0);
    if (anchorBenchId) {
      if (!raw.benches.some((bench) => bench.id === anchorBenchId)) {
        errors.push(`Team ${team.id} anchor bench ${anchorBenchId} does not exist.`);
      }
      if (!Number.isFinite(anchorSeatsRaw) || anchorSeatsRaw < 1) {
        errors.push(`Team ${team.id} anchorSeats must be >= 1 when anchorBenchId is set.`);
      } else if (anchorSeatsRaw > team.size) {
        errors.push(`Team ${team.id} anchorSeats cannot exceed team size.`);
      }
    } else if (team.anchorSeats !== undefined && Number(team.anchorSeats) > 0) {
      errors.push(`Team ${team.id} has anchorSeats but no anchorBenchId.`);
    }
  }

  for (const item of raw.preallocations) {
    if (!isDay(item.day)) {
      errors.push(`Preallocation for bench ${item.benchId} has invalid day.`);
    }
    if (item.seats < 0) {
      errors.push(`Preallocation seats for bench ${item.benchId} must be >= 0.`);
    }
  }

  if (raw.flexPolicy.defaultPercent < 0 || raw.flexPolicy.defaultPercent > 100) {
    errors.push("Flex default percent must be between 0 and 100.");
  }

  if (
    raw.benchStabilityWeight !== undefined &&
    (raw.benchStabilityWeight < 0 || raw.benchStabilityWeight > 10)
  ) {
    errors.push("benchStabilityWeight must be between 0 and 10.");
  }

  if (raw.proximityRequests) {
    for (const request of raw.proximityRequests) {
      if (!request.teamA || !request.teamB) {
        errors.push("Proximity requests must include teamA and teamB.");
        continue;
      }
      if (request.teamA === request.teamB) {
        errors.push(`Proximity request ${request.teamA} must reference two different teams.`);
      }
      if (request.strength < 1 || request.strength > 5) {
        errors.push(`Proximity request ${request.teamA}-${request.teamB} strength must be between 1 and 5.`);
      }
      if (request.strict !== undefined && typeof request.strict !== "boolean") {
        errors.push(`Proximity request ${request.teamA}-${request.teamB} strict must be true or false.`);
      }
      if (request.days !== undefined) {
        if (!Array.isArray(request.days) || request.days.length === 0) {
          errors.push(`Proximity request ${request.teamA}-${request.teamB} must include at least one day.`);
          continue;
        }
        if (!request.days.every((day) => isDay(day))) {
          errors.push(`Proximity request ${request.teamA}-${request.teamB} has invalid days.`);
        }
      }
    }
  }

  return errors;
}

export async function POST(req: Request) {
  try {
    const input = (await req.json()) as PlannerInput;
    const errors = validateInput(input);
    if (errors.length > 0) {
      return NextResponse.json({ errors }, { status: 400 });
    }

    const result = plan(input);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ errors: ["Invalid request payload."] }, { status: 400 });
  }
}
