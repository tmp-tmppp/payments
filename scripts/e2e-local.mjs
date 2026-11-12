// End to end run on one machine: the mock payment provider and the payments service run as processes (see README, "Run it
// end to end"); this script plays everybody else: the identity provider (it serves a key set and signs tokens, so payments
// verifies real signatures), the tenants service (TenantCreated), the buyer (the pay button of the payment page) and trading
// (WithdrawalRefunded). It prints every step and exits 1 at the first one that does not come out as expected.
//
//   node scripts/e2e-local.mjs
// Settings, all optional: PAYMENTS_URL, PROVIDER_URL, NATS_URL, JWKS_PORT, RUNTIME_FILE (the runtime.json payments watches),
// TENANT_ID, AUTH_ISSUER, AUTH_AUDIENCE.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";

const env = (name, fallback) => process.env[name] ?? fallback;
const PAYMENTS = env("PAYMENTS_URL", "http://127.0.0.1:8080");
const NATS = env("NATS_URL", "nats://127.0.0.1:4222");
const JWKS_PORT = Number(env("JWKS_PORT", "8099"));
const RUNTIME_FILE = env("RUNTIME_FILE", "");
const TENANT = env("TENANT_ID", randomUUID());
const ISSUER = env("AUTH_ISSUER", "http://localhost:8081/realms/chance");
const AUDIENCE = env("AUTH_AUDIENCE", "chance");
const KID = "e2e-key";

const log = (step, text) => console.log(`[${new Date().toISOString()}] ${step}: ${text}`);
const fail = (step, text) => {
  console.error(`[${new Date().toISOString()}] ${step}: FAILED ${text}`);
  process.exitCode = 1;
  throw new Error(`${step}: ${text}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(step, read, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) fail(step, "timed out");
    await sleep(250);
  }
}

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
const jwksServer = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
}).listen(JWKS_PORT, "127.0.0.1");
log("identity", `key set on http://127.0.0.1:${JWKS_PORT}/ (payments must have AUTH_JWKS_URL pointing at it)`);

const token = (userId, roles = ["trader"]) =>
  new SignJWT({ realm_access: { roles }, organization: [TENANT] })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);

async function api(method, path, { userId = "trader-e2e", body, key } = {}) {
  const headers = { authorization: `Bearer ${await token(userId)}`, "content-type": "application/json" };
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`${PAYMENTS}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const nc = await connect({ servers: NATS });
const manager = await jetstreamManager(nc);
const js = jetstream(nc);
for (const [name, subjects] of [["TENANTS", ["chance.tenants.>"]], ["TRADING", ["chance.trading.>"]]]) {
  try {
    await manager.streams.info(name);
  } catch {
    await manager.streams.add({ name, subjects });
  }
}
const cloudEvent = (type, subject, data) =>
  new TextEncoder().encode(
    JSON.stringify({ specversion: "1.0", id: randomUUID(), type, source: "e2e", subject, time: new Date().toISOString(), datacontenttype: "application/json", tenantid: TENANT, correlationid: randomUUID(), causationid: randomUUID(), data }),
  );
const lastEvent = async (name) => {
  try {
    const message = await manager.streams.getMessage("PAYMENTS", { last_by_subj: `chance.payments.${name}.${TENANT}` });
    return message ? message.json() : null;
  } catch {
    return null;
  }
};

try {
  // 1. TenantCreated from "tenants": payments creates the tenant's schema through its inbox.
  await js.publish(`chance.tenants.TenantCreated.${TENANT}`, cloudEvent("si.chance.tenants.TenantCreated.v1", `tenant/${TENANT}`, { tenantId: TENANT, name: "E2E" }));
  log("tenants", `published TenantCreated for ${TENANT}`);
  await eventually("tenant schema", async () => (await api("GET", `/v1/deposits/${randomUUID()}`)).status === 404);
  log("payments", "the tenant schema exists (an unknown deposit answers 404, not 503)");

  // 2. Deposit: create, pay on the payment page, the signed webhook arrives, the deposit succeeds.
  const created = await api("POST", "/v1/deposits", { body: { amount: 2500 }, key: `e2e-deposit-${TENANT}` });
  if (created.status !== 201 || created.body.status !== "pending" || !created.body.checkoutUrl) fail("deposit", `expected 201 pending with a checkoutUrl, got ${created.status} ${JSON.stringify(created.body)}`);
  const deposit = created.body;
  log("deposit", `201 pending, amount ${deposit.amount}, checkoutUrl ${deposit.checkoutUrl}`);
  const replay = await api("POST", "/v1/deposits", { body: { amount: 2500 }, key: `e2e-deposit-${TENANT}` });
  if (replay.body?.id !== deposit.id) fail("deposit replay", "the same key and body did not return the same deposit");
  const other = await api("POST", "/v1/deposits", { body: { amount: 2501 }, key: `e2e-deposit-${TENANT}` });
  if (other.status !== 409) fail("deposit key reuse", `expected 409, got ${other.status}`);
  log("deposit", `same key and body -> same deposit (${replay.status}); same key, other body -> 409`);
  const page = await (await fetch(deposit.checkoutUrl)).text();
  const action = [...page.matchAll(/<form[^>]*action="([^"]+)"/g)].map((match) => match[1]).find((value) => value.endsWith("/pay"));
  if (!action) fail("payment page", "no pay form found on the payment page");
  const payUrl = new URL(action.replace(/&amp;/g, "&"), deposit.checkoutUrl).toString();
  const paid = await fetch(payUrl, { method: "POST", redirect: "manual" });
  log("buyer", `POST ${new URL(payUrl).pathname} -> ${paid.status} Location ${paid.headers.get("location")}`);
  const succeeded = await eventually("deposit succeeded", async () => {
    const current = (await api("GET", `/v1/deposits/${deposit.id}`)).body;
    return current?.status === "succeeded" ? current : null;
  });
  log("deposit", `status ${succeeded.status}, completedAt ${succeeded.completedAt}`);
  const depositEvent = await eventually("DepositSucceeded event", () => lastEvent("DepositSucceeded"));
  log("events", `DepositSucceeded on the PAYMENTS stream: type ${depositEvent.type}, data ${JSON.stringify(depositEvent.data)}`);
  const foreign = await fetch(`${PAYMENTS}/v1/deposits/${deposit.id}`, { headers: { authorization: `Bearer ${await token("someone-else")}` } });
  if (foreign.status !== 404) fail("isolation", `another user read the deposit: ${foreign.status}`);
  log("deposit", "another user asking for this deposit gets 404");

  // 3. Withdrawal with the flag off: the payout is created at the provider and paid.
  const w1 = await api("POST", "/v1/withdrawals", { body: { amount: 1000 }, key: `e2e-withdrawal-1-${TENANT}` });
  if (![200, 201, 202].includes(w1.status)) fail("withdrawal", `expected 2xx, got ${w1.status} ${JSON.stringify(w1.body)}`);
  log("withdrawal 1", `${w1.status} ${w1.body.status} (flag off)`);
  const paidOut = await eventually("withdrawal paid_out", async () => {
    const current = (await api("GET", `/v1/withdrawals/${w1.body.id}`)).body;
    return current?.status === "paid_out" ? current : null;
  });
  log("withdrawal 1", `status ${paidOut.status}`);
  const succeededEvent = await eventually("WithdrawalSucceeded event", () => lastEvent("WithdrawalSucceeded"));
  log("events", `WithdrawalSucceeded: ${JSON.stringify(succeededEvent.data)}`);

  // 4. The flag in the watched file is switched on without a restart: the payout is declined by payments itself.
  if (!RUNTIME_FILE) fail("flag", "RUNTIME_FILE is not set");
  await writeFile(RUNTIME_FILE, `${JSON.stringify({ forcePayoutFailure: true }, null, 2)}\n`);
  log("flag", `wrote forcePayoutFailure=true to ${RUNTIME_FILE}`);
  await sleep(3000);
  const w2 = await api("POST", "/v1/withdrawals", { body: { amount: 700 }, key: `e2e-withdrawal-2-${TENANT}` });
  if (![200, 201, 202].includes(w2.status)) fail("withdrawal 2", `expected 2xx, got ${w2.status} ${JSON.stringify(w2.body)}`);
  log("withdrawal 2", `${w2.status} ${w2.body.status} (flag on)`);
  const failed = await eventually("withdrawal failed", async () => {
    const current = (await api("GET", `/v1/withdrawals/${w2.body.id}`)).body;
    return current?.status === "failed" ? current : null;
  });
  if (failed.reason !== "forced") fail("withdrawal 2", `expected reason forced, got ${failed.reason}`);
  log("withdrawal 2", `status ${failed.status}, reason ${failed.reason}`);
  const failedEvent = await eventually("WithdrawalFailed event", () => lastEvent("WithdrawalFailed"));
  log("events", `WithdrawalFailed: ${JSON.stringify(failedEvent.data)}`);

  // 5. Trading returns the credits: WithdrawalRefunded ends the saga.
  await js.publish(
    `chance.trading.WithdrawalRefunded.${TENANT}`,
    cloudEvent("si.chance.trading.WithdrawalRefunded.v1", `withdrawal/${w2.body.id}`, { withdrawalId: w2.body.id, userId: "trader-e2e", amount: 700 }),
  );
  log("trading", "published WithdrawalRefunded");
  const refunded = await eventually("withdrawal refunded", async () => {
    const current = (await api("GET", `/v1/withdrawals/${w2.body.id}`)).body;
    return current?.status === "refunded" ? current : null;
  });
  log("withdrawal 2", `status ${refunded.status}`);

  await writeFile(RUNTIME_FILE, `${JSON.stringify({ forcePayoutFailure: false }, null, 2)}\n`);
  log("flag", "restored forcePayoutFailure=false");
  log("result", "END TO END OK");
} finally {
  await nc.drain().catch(() => undefined);
  jwksServer.close();
}
