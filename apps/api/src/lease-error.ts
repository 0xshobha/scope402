export class LeaseError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
  }
}
