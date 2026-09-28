/**
 * Cross-platform recorder (spec §24/§25).
 *
 * Wraps action execution on a session and records semantic evidence:
 * timestamp, target, action, element refs, coordinates, before/after
 * screen hashes. Records are convertible into the portable Automation DSL
 * (never raw coordinate scripts).
 */
import type { Action, ActionResult } from "../core/types-action.js";
import type { ElementRef, Screenshot, Target } from "../core/types.js";
import { actionSummary } from "../core/actions.js";

export interface RecordEntry {
  timestamp: number;
  platform: string;
  deviceId?: string;
  app?: string;
  window?: string;
  action: Action;
  actionSummary: string;
  element?: ElementRef;
  point?: { x: number; y: number };
  ok: boolean;
  method?: string;
  error?: string;
  beforeScreenHash?: string;
  afterScreenHash?: string;
  screenshotRefs?: { before?: string; after?: string };
}

export class Recorder {
  readonly entries: RecordEntry[] = [];
  private startedAt = Date.now();
  private lastHash: string | undefined;
  /** store screenshots so record_to_script/evidence can embed them */
  readonly screenshots: { id: string; shot: Screenshot }[] = [];
  private shotSeq = 0;

  constructor(readonly target: Target) {}

  captureBefore(shot?: Screenshot): void {
    this.lastHash = shot?.hash;
    if (shot) this.storeShot(shot, "before");
  }

  recordAction(action: Action, result: ActionResult, context?: { app?: string; window?: string; afterShot?: Screenshot }): void {
    const entry: RecordEntry = {
      timestamp: Date.now(),
      platform: this.target.platform,
      deviceId: this.target.deviceId,
      app: context?.app,
      window: context?.window,
      action,
      actionSummary: actionSummary(action),
      element: "element" in action ? action.element : undefined,
      point: result.point,
      ok: result.ok,
      method: result.method,
      error: result.error?.message,
      beforeScreenHash: this.lastHash,
      afterScreenHash: context?.afterShot?.hash,
    };
    if (context?.afterShot) this.storeShot(context.afterShot, "after");
    this.entries.push(entry);
  }

  private storeShot(shot: Screenshot, phase: string): void {
    const id = `shot-${this.shotSeq++}-${phase}`;
    this.screenshots.push({ id, shot });
    const last = this.entries[this.entries.length - 1];
    if (last && !last.screenshotRefs) last.screenshotRefs = {};
    if (last) {
      last.screenshotRefs = { ...last.screenshotRefs, [phase]: id };
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      target: this.target,
      startedAt: this.startedAt,
      entries: this.entries,
    };
  }
}
