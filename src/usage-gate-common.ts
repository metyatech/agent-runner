export type UsageRampSchedule = {
  startMinutes: number;
  minRemainingPercentAtStart: number;
  minRemainingPercentAtEnd: number;
};

export type UsageRampDecision = {
  allow: boolean;
  reason: string;
  requiredPercent?: number;
  minutesToReset?: number;
};

/**
 * Calculates the required remaining percentage based on a ramp schedule.
 */
export function evaluateUsageRamp(
  percentRemaining: number,
  resetAt: Date,
  schedule: UsageRampSchedule,
  now: Date = new Date()
): UsageRampDecision {
  let minutesToReset = Math.round((resetAt.getTime() - now.getTime()) / 60000);
  if (!Number.isFinite(minutesToReset) || minutesToReset < 0) {
    minutesToReset = 0;
  }

  if (minutesToReset > schedule.startMinutes) {
    return {
      allow: false,
      reason: `Reset not close enough: ${minutesToReset}m to reset (threshold ${schedule.startMinutes}m).`,
      minutesToReset
    };
  }

  const span = schedule.startMinutes <= 0 ? 1 : schedule.startMinutes;
  const ratio = Math.min(Math.max(minutesToReset / span, 0), 1);
  const required =
    schedule.minRemainingPercentAtEnd +
    (schedule.minRemainingPercentAtStart - schedule.minRemainingPercentAtEnd) * ratio;

  if (percentRemaining < required) {
    return {
      allow: false,
      reason: `Remaining ${percentRemaining.toFixed(1)}% < required ${required.toFixed(1)}% at ${minutesToReset}m to reset.`,
      requiredPercent: required,
      minutesToReset
    };
  }

  return {
    allow: true,
    reason: `Reset within ${schedule.startMinutes}m with ${percentRemaining.toFixed(1)}% remaining (required ${required.toFixed(1)}%).`,
    requiredPercent: required,
    minutesToReset
  };
}