import type { KeycloakConfig } from "../../config.js";
import type { ServiceTokenSource } from "../../usecases/ports.js";
import { HttpStatusError, isRecord } from "../http/resilience.js";

export interface TokenSourceOptions extends KeycloakConfig {
  fetch?: typeof fetch;
  /** Milliseconds since the epoch; replaced in tests. */
  nowMs?: () => number;
}

/** The token is renewed this long before it expires, so that a call never starts with a token about to run out. */
const TOKEN_SKEW_MS = 30_000;

/**
 * Client-credentials access token of the client "payments" (audience chance), for the calls to trading. Cached until
 * shortly before it expires; one request at a time, however many callers wait for it. A failure is thrown as it is
 * (a network error, an HttpStatusError): the caller's resilience policy decides what to do with it.
 */
export class ClientCredentialsTokenSource implements ServiceTokenSource {
  private readonly http: typeof fetch;
  private readonly nowMs: () => number;
  private token: { value: string; expiresAtMs: number } | null = null;
  private request: Promise<string> | null = null;

  constructor(private readonly options: TokenSourceOptions) {
    this.http = options.fetch ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
  }

  getToken(signal?: AbortSignal): Promise<string> {
    if (this.token && this.nowMs() < this.token.expiresAtMs - TOKEN_SKEW_MS) return Promise.resolve(this.token.value);
    this.request ??= this.fetchToken(signal).finally(() => {
      this.request = null;
    });
    return this.request;
  }

  invalidate(): void {
    this.token = null;
  }

  private async fetchToken(signal?: AbortSignal): Promise<string> {
    const response = await this.http(this.options.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpStatusError(response.status);
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body["access_token"] !== "string") throw new Error("The token response has no access_token");
    const lifetimeSeconds = typeof body["expires_in"] === "number" ? body["expires_in"] : 60;
    this.token = { value: body["access_token"], expiresAtMs: this.nowMs() + lifetimeSeconds * 1000 };
    return this.token.value;
  }
}
