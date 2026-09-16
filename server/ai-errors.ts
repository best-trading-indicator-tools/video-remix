export type AIRequestErrorCode = "authentication" | "quota" | "rate-limit" | "service" | "timeout" | "network" |
  "output-truncated" | "invalid-response" | "invalid-schema" | "invalid-evidence";

const failures: Record<AIRequestErrorCode, { message: string; retryable: boolean }> = {
  authentication: { message: "DeepSeek rejected the API credentials. Check the server API key.", retryable: false },
  quota: { message: "DeepSeek account credit is unavailable. Check the provider account balance.", retryable: false },
  "rate-limit": { message: "DeepSeek temporarily limited requests. Try again shortly.", retryable: true },
  service: { message: "DeepSeek is temporarily unavailable. Try again shortly.", retryable: true },
  timeout: { message: "The DeepSeek request exceeded its time limit. Try again.", retryable: true },
  network: { message: "The server could not complete its connection to DeepSeek. Try again.", retryable: true },
  "output-truncated": { message: "DeepSeek reached the response length limit before finishing its answer.", retryable: true },
  "invalid-response": { message: "DeepSeek returned an unreadable or incomplete response.", retryable: true },
  "invalid-schema": { message: "DeepSeek returned a response that did not match the required format.", retryable: true },
  "invalid-evidence": { message: "DeepSeek returned findings whose source quotations or comparisons could not be verified.", retryable: true },
};

/** Fixed diagnostics only: never attach provider bodies, credentials or raw errors. */
export class AIRequestError extends Error {
  override readonly name: string = "AIRequestError";
  readonly retryable: boolean;
  /** Safe request metadata only; no provider text is retained. */
  attempts = 1;
  retryAfterMs?: number;
  constructor(readonly code: AIRequestErrorCode) {
    super(failures[code].message);
    this.retryable = failures[code].retryable;
  }
}
