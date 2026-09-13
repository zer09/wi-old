export const DEFAULT_RECOVERY_INGRESS_MAXIMUM_FRAMES = 64;
export const DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES = 512 * 1_024;

export interface RecoveryIngressBudgetOptions {
  readonly maximumFrames?: number;
  readonly maximumBytes?: number;
}

export interface RecoveryIngressBudgetSnapshot {
  readonly pendingFrames: number;
  readonly pendingBytes: number;
  readonly maximumFrames: number;
  readonly maximumBytes: number;
}

export interface RecoveryIngressReservation {
  readonly bytes: number;
  release(): void;
}

export type RecoveryIngressRegistrationState =
  | "registered"
  | "epoch_closed"
  | "saturated";

export interface RecoveryIngressRegistration {
  readonly state: RecoveryIngressRegistrationState;
  release(): void;
}

export type RecoveryIngressBudgetResult =
  | { readonly state: "registered"; readonly reservation: RecoveryIngressReservation }
  | { readonly state: "saturated" };

function validateLimit(
  name: string,
  value: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${maximum}`);
  }
  return value;
}

export class RecoveryIngressBudget {
  readonly maximumFrames: number;
  readonly maximumBytes: number;
  private pendingFrames = 0;
  private pendingBytes = 0;

  constructor(options: RecoveryIngressBudgetOptions = {}) {
    this.maximumFrames = validateLimit(
      "Recovery ingress maximum frames",
      options.maximumFrames ?? DEFAULT_RECOVERY_INGRESS_MAXIMUM_FRAMES,
      DEFAULT_RECOVERY_INGRESS_MAXIMUM_FRAMES,
    );
    this.maximumBytes = validateLimit(
      "Recovery ingress maximum bytes",
      options.maximumBytes ?? DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES,
      DEFAULT_RECOVERY_INGRESS_MAXIMUM_BYTES,
    );
  }

  reserve(bytes: number): RecoveryIngressBudgetResult {
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new RangeError("Recovery ingress bytes must be a positive safe integer");
    }
    if (
      this.pendingFrames >= this.maximumFrames ||
      bytes > this.maximumBytes - this.pendingBytes
    ) {
      return { state: "saturated" };
    }

    this.pendingFrames += 1;
    this.pendingBytes += bytes;
    let released = false;
    const reservation: RecoveryIngressReservation = {
      bytes,
      release: (): void => {
        if (released) return;
        released = true;
        if (this.pendingFrames < 1 || bytes > this.pendingBytes) {
          throw new Error("Recovery ingress budget release underflow");
        }
        this.pendingFrames -= 1;
        this.pendingBytes -= bytes;
      },
    };
    return { state: "registered", reservation };
  }

  get snapshot(): RecoveryIngressBudgetSnapshot {
    return {
      pendingFrames: this.pendingFrames,
      pendingBytes: this.pendingBytes,
      maximumFrames: this.maximumFrames,
      maximumBytes: this.maximumBytes,
    };
  }
}
