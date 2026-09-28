/**
 * Central error taxonomy for the Computer-Use MCP.
 *
 * The system must NEVER fake success. Any environmental restriction
 * (missing permission, offline device, unsupported platform feature)
 * is reported with an explicit machine-readable code so that agents
 * and the test runtime can distinguish BLOCKED from FAILED from PASS.
 */

export type ErrorCode =
  | "invalid_request"
  | "unsupported"
  | "permission_required"
  | "restricted"
  | "device_offline"
  | "device_not_found"
  | "element_not_found"
  | "target_not_found"
  | "timeout"
  | "provider_error"
  | "cancelled"
  | "confirmation_required"
  | "security_blocked"
  | "stalled"
  | "internal_error";

export class ComputerUseError extends Error {
  readonly code: ErrorCode;
  /** Extra structured detail (e.g. which permission, which capability). */
  readonly details?: Record<string, unknown>;
  /** Actionable hint for the calling agent / human. */
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; hint?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ComputerUseError";
    this.code = code;
    this.details = options?.details;
    this.hint = options?.hint;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      hint: this.hint,
    };
  }
}

export function permissionRequired(
  what: string,
  howToFix: string,
  details?: Record<string, unknown>,
): ComputerUseError {
  return new ComputerUseError("permission_required", `${what} is not permitted in this environment`, {
    details,
    hint: howToFix,
  });
}

export function unsupported(what: string, why: string): ComputerUseError {
  return new ComputerUseError("unsupported", `${what}: ${why}`, {
    hint: "This capability is not available for the selected target/platform.",
  });
}

export function restricted(what: string, why: string, howToFix?: string): ComputerUseError {
  return new ComputerUseError("restricted", `${what}: ${why}`, {
    hint: howToFix,
  });
}

export function isComputerUseError(e: unknown): e is ComputerUseError {
  return e instanceof ComputerUseError;
}
