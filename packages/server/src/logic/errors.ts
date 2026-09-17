/** Errors with an HTTP meaning: every message is one a curator or operator can act on. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = new.target.name;
  }
}

/** Per-owner quota reached; `retryAt` (ms since the epoch) says when the next slot opens. */
export class TooManyRunsError extends HttpError {
  constructor(message: string, readonly retryAt?: number) {
    super(429, message, retryAt === undefined ? {} : { "retry-after": String(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))) });
  }
}

export class QueueFullError extends HttpError {
  constructor(message = "Every render slot and the whole waiting line are taken right now. Try again in a few minutes.") {
    super(503, message, { "retry-after": "120" });
  }
}

export class TooManyListenersError extends HttpError {
  constructor(message = "Too many tabs are following this run. Close one and try again.") {
    super(429, message);
  }
}

/** The identity provider could not answer (Access certs unreachable): the caller is not refused, just asked to retry. */
export class SignInUnavailableError extends HttpError {
  constructor() {
    super(503, "Sign-in could not be verified right now.", { "retry-after": "5" });
  }
}
