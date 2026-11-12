// Rule violations of the domain. They carry a stable code; the use cases decide what each one means for a caller.
export type DomainErrorCode = "invalid_amount" | "illegal_transition";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
