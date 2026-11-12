import { isValidAmount } from "./amount.js";
import type { TenantCreatedData, WithdrawalRefundedData } from "./events.js";
import { isStorableText } from "./text.js";

// Events from other services, as the consumers receive them. Whatever arrives is untrusted until it is parsed here: the
// parsers return null for anything that is not what the contract says, and the consumer drops such an event.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_MAX_LENGTH = 255;
const USER_ID_MAX_LENGTH = 255;

/** A CloudEvents 1.0 envelope from another publisher. */
export interface ReceivedEvent<TData = unknown> {
  id: string;
  type: string;
  source: string;
  subject: string;
  time: string;
  /** The "tenantid" extension: the tenant the event is about (a UUID, in lower case). */
  tenantId: string;
  correlationId: string;
  causationId: string;
  data: TData;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** An optional text attribute: "" when it is absent or not text, null when it is text PostgreSQL cannot store as it is. */
const optionalText = (value: unknown): string | null => (typeof value !== "string" ? "" : isStorableText(value) ? value : null);

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The envelope of a CloudEvent, or null when it lacks the specversion, the id, the type, a UUID tenant id or a data object,
 * or when a text attribute holds a NUL or a lone surrogate (such an event could never be stored, and would come back forever).
 */
export function parseReceivedEvent(value: unknown): ReceivedEvent | null {
  if (!isRecord(value) || value["specversion"] !== "1.0") return null;
  const { id, type, tenantid, data } = value;
  if (typeof id !== "string" || id === "" || id.length > EVENT_ID_MAX_LENGTH || !isStorableText(id)) return null;
  if (typeof type !== "string" || type === "" || !isStorableText(type)) return null;
  if (!isUuid(tenantid)) return null;
  if (!isRecord(data)) return null;
  const source = optionalText(value["source"]);
  const subject = optionalText(value["subject"]);
  const time = optionalText(value["time"]);
  const correlationId = optionalText(value["correlationid"]);
  const causationId = optionalText(value["causationid"]);
  if (source === null || subject === null || time === null || correlationId === null || causationId === null) return null;
  return { id, type, source, subject, time, tenantId: tenantid.toLowerCase(), correlationId, causationId, data };
}

/** TenantCreated: the id of the new tenant (in the data, and equal to the envelope's tenant id). Name and slug are ignored. */
export function parseTenantCreated(event: ReceivedEvent): TenantCreatedData | null {
  const data = event.data;
  if (!isRecord(data) || !isUuid(data["tenantId"])) return null;
  if (data["tenantId"].toLowerCase() !== event.tenantId) return null;
  return { tenantId: event.tenantId };
}

/** WithdrawalRefunded (a proposal): which withdrawal's credits went back, to whom, how many. The tenant is the envelope's. */
export function parseWithdrawalRefunded(event: ReceivedEvent): WithdrawalRefundedData | null {
  const data = event.data;
  if (!isRecord(data)) return null;
  const { withdrawalId, userId, amount } = data;
  if (!isUuid(withdrawalId)) return null;
  if (typeof userId !== "string" || userId.length < 1 || userId.length > USER_ID_MAX_LENGTH || !isStorableText(userId)) return null;
  if (!isValidAmount(amount)) return null;
  return { withdrawalId: withdrawalId.toLowerCase(), userId, amount };
}
