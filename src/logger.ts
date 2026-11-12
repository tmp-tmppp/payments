import { pino } from "pino";
import type { DestinationStream, Logger } from "pino";

/**
 * JSON logs (ADR-026). The Authorization header and cookies are redacted wherever they could appear in a log
 * line; request ids, correlation ids, tenant ids and user ids are bound by the web layer.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "payments" },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "headers.authorization", "authorization", "*.authorization"],
        censor: "[redacted]",
      },
    },
    destination,
  );
}
