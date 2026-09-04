export class PaymentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}
