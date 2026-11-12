import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The chart side of the metrics convention, checked on the files of the chart: helm lint and kubeconform pass without
// any of it, so nothing else would notice a dropped annotation, a renamed port or a lost NetworkPolicy rule.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface Schema {
  properties: {
    podAnnotations: { propertyNames: { not: { pattern: string } } };
    env: { propertyNames: { not: { enum: string[] } } };
    metrics: { required: string[]; properties: { port: { minimum: number; maximum: number } } };
    networkPolicy: { properties: { metrics: { required: string[]; properties: { namespace: { pattern: string } } } } };
  };
  required: string[];
}

describe("the metrics port in the chart", () => {
  it("is a container port named metrics, rendered from metrics.port, with the three scrape annotations", () => {
    const deployment = read("helm/templates/deployment.yaml");
    expect(deployment).toContain('prometheus.io/scrape: "true"');
    expect(deployment).toContain("prometheus.io/port: {{ .Values.metrics.port | quote }}");
    expect(deployment).toContain("prometheus.io/path: /metrics");
    expect(deployment).toMatch(/- name: metrics\n\s+containerPort: \{\{ \.Values\.metrics\.port \}\}/);
    expect(read("helm/values.yaml")).toMatch(/^metrics:\n {2}port: 9464$/m);
  });

  it("is METRICS_PORT of the service, and the template refuses a metrics port equal to the API port", () => {
    const configmap = read("helm/templates/configmap.yaml");
    expect(configmap).toContain("METRICS_PORT: {{ .Values.metrics.port | quote }}");
    expect(configmap).toMatch(/if eq \(int \.Values\.metrics\.port\) \(int \.Values\.service\.port\)/);
  });

  it("is not a port of the Service: only the HTTP port is", () => {
    const ports = read("helm/templates/service.yaml").split(/^ {2}ports:\n/m)[1] ?? "";
    expect([...ports.matchAll(/^\s+- name: (\S+)/gm)].map((match) => match[1])).toEqual(["http"]);
  });
});

describe("the NetworkPolicy of the metrics port", () => {
  const policy = read("helm/templates/networkpolicy.yaml");
  const rule = policy.split(/^ {4}- from:\n/m).find((part) => /- port: metrics/.test(part)) ?? "";

  it("admits the namespace named by networkPolicy.metrics.namespace on the metrics port, and no Pod selector", () => {
    expect(rule).toMatch(/kubernetes\.io\/metadata\.name: \{\{ \.Values\.networkPolicy\.metrics\.namespace \| quote \}\}\n\s+ports:\n\s+- port: metrics/);
    expect(rule).not.toMatch(/podSelector/);
  });

  it("keeps the metrics port out of the rule of the HTTP port", () => {
    const httpRule = policy.split(/^ {4}- from:\n/m).find((part) => /- port: http/.test(part)) ?? "";
    expect(httpRule).not.toMatch(/port: metrics/);
  });

  it("defaults the namespace to monitoring; the policy itself is off by default, so the isolation is a setting to turn on", () => {
    const values = read("helm/values.yaml");
    expect(values).toMatch(/^ {2}metrics:\n {4}namespace: monitoring$/m);
    expect(values).toMatch(/^networkPolicy:\n {2}enabled: false$/m);
  });
});

describe("values.schema.json", () => {
  const schema = JSON.parse(read("helm/values.schema.json")) as Schema;

  it("requires metrics.port as a port number and validates the namespace of the monitoring rule", () => {
    expect(schema.required).toContain("metrics");
    expect(schema.properties.metrics.required).toEqual(["port"]);
    expect(schema.properties.metrics.properties.port).toMatchObject({ minimum: 1, maximum: 65535 });
    const namespace = new RegExp(schema.properties.networkPolicy.properties.metrics.properties.namespace.pattern);
    expect(namespace.test("monitoring")).toBe(true);
    for (const bad of ["Bad_Name", "-monitoring", "monitoring-", "a/b", ""]) expect(namespace.test(bad), bad).toBe(false);
  });

  it("refuses prometheus.io/* in podAnnotations (the chart writes them, a second copy would be a duplicate key) and METRICS_PORT in env", () => {
    const forbidden = new RegExp(schema.properties.podAnnotations.propertyNames.not.pattern);
    for (const key of ["prometheus.io/scrape", "prometheus.io/port", "prometheus.io/path"]) expect(forbidden.test(key), key).toBe(true);
    for (const key of ["checksum/app-env", "example.com/prometheus.io/port", "team.example/owner"]) expect(forbidden.test(key), key).toBe(false);
    expect(schema.properties.env.propertyNames.not.enum).toContain("METRICS_PORT");
  });
});

describe("the transport of trading's debit in the chart (REQ-17)", () => {
  const schema = JSON.parse(read("helm/values.schema.json")) as { properties: { env: { properties: Record<string, { enum?: string[]; pattern?: string }> } } };
  const env = loadConfigFromValues();

  /** The env map of values.yaml as the service reads it: the chart's default configuration must start. */
  function loadConfigFromValues(): Record<string, string> {
    const block = read("helm/values.yaml").split(/^env:\n/m)[1]?.split(/^\S/m)[0] ?? "";
    return Object.fromEntries(
      [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*): "?([^"\n]*)"?$/gm)].map((match) => [match[1] ?? "", match[2] ?? ""]),
    );
  }

  it("defaults to gRPC on trading:8082 and keeps the REST address for a switch back", () => {
    expect(env).toMatchObject({ TRADING_DEBIT_TRANSPORT: "grpc", TRADING_GRPC_URL: "trading:8082", TRADING_BASE_URL: "http://trading:8081" });
  });

  it("validates the two settings in the schema the way the service does", () => {
    expect(schema.properties.env.properties["TRADING_DEBIT_TRANSPORT"]?.enum).toEqual(["grpc", "rest"]);
    const address = new RegExp(schema.properties.env.properties["TRADING_GRPC_URL"]?.pattern ?? "^$");
    for (const good of ["trading:8082", "trading.chance.svc.cluster.local:8082", "192.0.2.10:8082", "[::1]:8082"]) expect(address.test(good), good).toBe(true);
    for (const bad of ["http://trading:8082", "trading", "-trading:8082", "trading:8082/x"]) expect(address.test(bad), bad).toBe(false);
  });
});
