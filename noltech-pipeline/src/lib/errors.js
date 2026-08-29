// Typed errors. Every upstream-call failure carries a code so route handlers
// can decide whether to surface it directly, retry, or fall back.

export class PipelineError extends Error {
  constructor(code, message, { status = 500, cause = null, retryable = false } = {}) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

export class BrightDataError extends PipelineError {
  constructor(message, { status = 502, body = '', cause = null } = {}) {
    super('brightdata_error', message, { status, cause, retryable: status >= 500 });
    this.body = body;
  }
}

export class BotChallengeError extends PipelineError {
  constructor(snippet = '') {
    super('bot_challenge', 'upstream returned a bot-challenge page', { status: 502, retryable: true });
    this.snippet = snippet;
  }
}

export class ParserError extends PipelineError {
  constructor(message, diagnostics = {}) {
    super('parser_failed', message, { status: 502, retryable: false });
    this.diagnostics = diagnostics;
  }
}

export class SupabaseError extends PipelineError {
  constructor(operation, supabaseErr) {
    super('supabase_error', `${operation}: ${supabaseErr?.message || supabaseErr}`, {
      status: 500,
      cause: supabaseErr,
      retryable: true,
    });
  }
}

export class AuthError extends PipelineError {
  constructor(message = 'unauthorized') {
    super('unauthorized', message, { status: 401 });
  }
}

export class BadRequestError extends PipelineError {
  constructor(message) {
    super('bad_request', message, { status: 400 });
  }
}

// Try a fetch with retries on retryable errors. Used for Bright Data + Lambda
// calls where transient blips are normal but persistent failures should
// surface.
export async function withRetries(fn, { maxAttempts = 3, baseDelayMs = 500, log } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof PipelineError ? e.retryable : true;
      if (!retryable || attempt === maxAttempts) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      log?.warn('retry', { attempt, maxAttempts, delayMs: delay, code: e?.code, message: e?.message });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
