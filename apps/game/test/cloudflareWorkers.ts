// A stand-in for the Workers runtime module in tests: just enough of the
// Durable Object base class for a room to be constructed and sent messages.

export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
