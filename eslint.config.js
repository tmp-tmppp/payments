import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

// Clean Architecture (ADR-001): dependencies point inward. The import rules below fail the lint when the
// domain reaches into outer layers or into a framework, or when a use case reaches into adapters or web.
const frameworks = ["fastify", "pg", "pg/*", "jose", "cockatiel", "uuid", "pino", "@nats-io/*"];
const outer = (layers) => layers.flatMap((layer) => [`**/${layer}/**`, `../${layer}`, `../../${layer}`]);

export default defineConfig(
  { ignores: ["dist/", "coverage/", "reports/", "node_modules/", "helm/"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: frameworks.map((name) => ({ name, message: "The domain is pure: no framework or driver." })),
          patterns: [
            { group: [...outer(["usecases", "adapters", "web"]), "**/config.js", "**/main.js"], message: "The domain imports nothing from outer layers." },
            { group: ["@nats-io/*", "pg/*"], message: "The domain is pure: no framework or driver." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/usecases/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: frameworks.filter((name) => name !== "uuid").map((name) => ({ name, message: "Use cases depend on ports, not on frameworks." })),
          patterns: [{ group: [...outer(["adapters", "web"]), "**/config.js", "**/main.js"], message: "Use cases import only the domain and their ports." }],
        },
      ],
    },
  },
  {
    files: ["src/adapters/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/web/**", "../web", "../../web", "**/main.js"], message: "Adapters do not import the web layer." }] }],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Parsed JSON bodies in tests are untyped on purpose.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
