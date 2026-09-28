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
  /** perceptual hash of the screenshot (fallback signal) */
  screenHash?: string;
  /** digest of the structured UI state (leaf texts/values) — strictly
   *  better than pixels when available: thin-stroke text changes ("0"→"7")
   *  are invisible to average hashes but obvious in the tree */
  treeDigest?: string;
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
  /** hamming distance (of the 256-bit aHash) below which two screens count as "same" */
  sameScreenDistance?: number;
  /** max consecutive identical failed actions */
  maxRepeatedFailures?: number;
}

export class LoopGuard {
  private history: StepFingerprint[] = [];
  private stagnationStrikes = 0;

  constructor(private readonly opts: Required<LoopGuardOptions> = {
    maxStagnation: 3,
    sameScreenDistance: 16,
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

    const screenKey = (h: StepFingerprint): string | undefined => h.treeDigest ?? h.screenHash;
    const sameScreenAs = (a: StepFingerprint, b: StepFingerprint): boolean => {
      const ka = screenKey(a);
      const kb = screenKey(b);
      if (ka === undefined || kb === undefined) return false;
      // tree digests compare by equality; pixel hashes by hamming distance
      if (a.treeDigest !== undefined && b.treeDigest !== undefined) return ka === kb;
      return hammingDistance(ka, kb) <= this.opts.sameScreenDistance;
    };

    // same-action + same-element + same-screen streak
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      const h = this.history[i]!;
      const sameAction = h.actionSummary === last.actionSummary;
      const sameElement = (h.elementId ?? "") === (last.elementId ?? "");
      if (sameAction && sameElement && sameScreenAs(h, last)) streak++;
      else break;
    }
    if (streak >= this.opts.maxStagnation) {
      reasons.push(
        last.ok
          ? `identical action/element/screen repeated ${streak}× with no screen change`
          : `identical action/element/screen repeated ${streak}×`,
      );
    }

    // same screen without any state change (even with different actions)
    if (n >= this.opts.maxStagnation) {
      const recent = this.history.slice(-this.opts.maxStagnation);
      const allSameScreen = recent.every((h) => sameScreenAs(h, last));
      if (allSameScreen) {
        reasons.push(`screen unchanged across last ${recent.length} steps${last.ok ? "" : " and last action failed"}`);
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
