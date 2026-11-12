import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { JWK, JWTVerifyGetKey } from "jose";

export const ISSUER = "http://localhost:8081/realms/test";
export const AUDIENCE = "chance-test";
/** The key id in the header of every token the test keys sign, and in the key set they publish. */
export const KEY_ID = "test-key";

export interface TokenOptions {
  sub?: string;
  /**
   * The roles of the user, as shorthand (token contract v2): "trader" and "tenant-admin" become the group "/trader" or
   * "/tenant-admin" of every organization in `organization`; any other role, such as "platform-admin", is a realm role.
   * Default none.
   */
  roles?: string[];
  /** Further groups of the organization, as Keycloak's group mapper writes them, added to those from `roles`. */
  groups?: string[];
  /** Realm roles exactly as given, also "trader" or "tenant-admin" (for the tests that these are ignored). */
  realmAccessRoles?: string[];
  /**
   * The organization claim. An array of aliases is sent as Keycloak sends it with the group mapper: an object keyed by
   * alias, each value holding the groups. An object keyed by alias is sent as given; an entry without `groups` gets them.
   * A string is sent as it is.
   */
  organization?: string[] | Record<string, unknown> | string | null;
  /** Claims merged last, exactly as given: a token of a shape Keycloak would not send. */
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  /** Seconds from now; negative = already expired. Default 300. */
  expiresIn?: number;
  /** The "kid" in the token header. Default KEY_ID. */
  kid?: string;
}

const GROUP_OF_TENANT_ROLE: ReadonlyMap<string, string> = new Map([
  ["trader", "/trader"],
  ["tenant-admin", "/tenant-admin"],
]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function organizationClaim(options: TokenOptions): unknown {
  const groups = [...(options.roles ?? []).flatMap((role) => GROUP_OF_TENANT_ROLE.get(role) ?? []), ...(options.groups ?? [])];
  const { organization } = options;
  if (Array.isArray(organization)) return Object.fromEntries(organization.map((alias) => [alias, { groups }]));
  if (isRecord(organization)) {
    return Object.fromEntries(
      Object.entries(organization).map(([alias, entry]) => [alias, isRecord(entry) && "groups" in entry ? entry : { ...(isRecord(entry) ? entry : {}), groups }]),
    );
  }
  return organization;
}

/** A local RSA key pair: tokens are really signed and really verified, only the JWKS fetch is replaced. */
export async function createTestKeys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const getKey: JWTVerifyGetKey = () => Promise.resolve(publicKey);
  /** The key set the identity provider would publish at its JWKS URL. */
  const jwks = async (): Promise<{ keys: JWK[] }> => ({ keys: [{ ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" }] });

  async function sign(options: TokenOptions = {}, key = privateKey): Promise<string> {
    const realmRoles = [...(options.roles ?? []).filter((role) => !GROUP_OF_TENANT_ROLE.has(role)), ...(options.realmAccessRoles ?? [])];
    const claims: Record<string, unknown> = { realm_access: { roles: realmRoles } };
    if (options.organization !== undefined && options.organization !== null) claims["organization"] = organizationClaim(options);
    Object.assign(claims, options.claims);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: options.kid ?? KEY_ID })
      .setSubject(options.sub ?? "user-1")
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (options.expiresIn ?? 300))
      .sign(key);
  }

  /** A token signed with a key the service does not trust. */
  const signWithOtherKey = (options: TokenOptions = {}) => sign(options, other.privateKey);

  return { getKey, jwks, sign, signWithOtherKey };
}
