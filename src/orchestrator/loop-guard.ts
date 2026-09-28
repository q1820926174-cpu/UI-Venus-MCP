/**
 * Agent anti-stagnation guard (spec §32).
 *
 * Detectors: same-action, same-element, same-screen (perceptual hash),
 * general stagnation. Recovery ladder caller-side: re-observe → re-locate
 * → alternate strategy → give up honestly.
 */
import { hammingDistance } from "../screenshot/pipeline.js";

export interface StepFingerprint {
  index: number;
  actionType: string;
  actionSummary: string;
  elementId?: string;
  screenHash?: string;
  ok: boolean;
}

export interface StagnationVerdict {
  stagnant: boolean;
  reasons: string[];
  /** recommended recovery */
  recovery: "none" | "reobserve" | "alternate-strategy" | "give-up";
}

export interface LoopGuardOptions {
  /** consecutive identical (action+element+screen) steps tolerated */
  maxStagnation?: number;
  /** hamming distance below which two screens count as "same" */
  sameScreenDistance?: number;
  /** max consecutive identical failed actions */
  maxRepeatedFailures?: number;
}

export class LoopGuard {
  private history: StepFingerprint[] = [];
  private stagnationStrikes = 0;

  constructor(private readonly opts: Required<LoopGuardOptions> = {
    maxStagnation: 3,
    sameScreenDistance: 4,
    maxRepeatedFailures: 3,
  }) {}

  record(step: StepFingerprint): void {
    this.history.push(step);
  }

  /** Evaluate AFTER recording a step. */
  evaluate(): StagnationVerdict {
    const reasons: string[] = [];
    const n = this.history.length;
    if (n === 0) return { stagnant: false, reasons, recovery: "none" };
    const last = this.history[n - 1]!;

    // same-action + same-element + same-screen streak
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      const h = this.history[i]!;
      const sameAction = h.actionSummary === last.actionSummary;
      const sameElement = (h.elementId ?? "") === (last.elementId ?? "");
      const sameScreen =
        h.screenHash !== undefined &&
        last.screenHash !== undefined &&
        hammingDistance(h.screenHash, last.screenHash) <= this.opts.sameScreenDistance;
      if (sameAction && sameElement && sameScreen) streak++;
      else break;
    }
    if (streak >= this.opts.maxStagnation) {
      reasons.push(`identical action/element/screen repeated ${streak}×`);
    }

    // same screen without any state change (even with different actions)
    if (n >= this.opts.maxStagnation) {
      const recent = this.history.slice(-this.opts.maxStagnation);
      const allSameScreen =
        last.screenHash !== undefined &&
        recent.every(
          (h) => h.screenHash !== undefined && hammingDistance(h.screenHash, last.screenHash!) <= this.opts.sameScreenDistance,
        );
      if (allSameScreen && !last.ok) {
        reasons.push(`screen unchanged across last ${recent.length} steps and last action failed`);
      }
    }

    // repeated identical failures
    let failStreak = 0;
    for (let i = n - 1; i >= 0; i--) {
      const h = this.history[i]!;
      if (!h.ok && h.actionSummary === last.actionSummary) failStreak++;
      else break;
    }
    if (failStreak >= this.opts.maxRepeatedFailures) {
      reasons.push(`action "${last.actionSummary}" failed ${failStreak}× consecutively`);
    }

    if (reasons.length === 0) {
      this.stagnationStrikes = 0;
      return { stagnant: false, reasons, recovery: "none" };
    }
    this.stagnationStrikes++;
    if (this.stagnationStrikes >= 2) {
      return { stagnant: true, reasons, recovery: "give-up" };
    }
    // First strike: ask for a strategy change (re-observe happens in the loop anyway).
    return { stagnant: true, reasons, recovery: "alternate-strategy" };
  }

  reset(): void {
    this.history = [];
    this.stagnationStrikes = 0;
  }
}
