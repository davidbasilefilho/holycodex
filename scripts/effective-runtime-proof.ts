// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Effect } from "effect";

import { desiredRootConfig, parseConfig } from "../packages/cli/src/installer.ts";
import { patchCurrentModelCatalog } from "../packages/cli/src/model-catalog.ts";
import {
  nativeModelCatalogPath,
  projectNativeAgents,
  renderGenericBuiltinSentinel,
  renderNativeAgent,
  rootPersonalityIsNone,
} from "../packages/cli/src/native-agents.ts";
import { stringifyToml } from "../packages/cli/src/toml.ts";
import { readTomlPath, type TomlDocument } from "../packages/codex/src/runtime-config.ts";
import {
  GENERIC_BUILTIN_AGENT_TYPES,
  type GenericBuiltinAgentType,
} from "../packages/core/src/routes.ts";

type JsonObject = Record<string, unknown>;

/** Captured local Codex requests and tool results used by acceptance assertions. */
export type EffectiveRuntimeEvidence = Readonly<{
  codexVersion: string;
  rootRequest: JsonObject;
  allRequests: readonly JsonObject[];
  rootRequests: readonly JsonObject[];
  specialistRequests: readonly JsonObject[];
  rootTools: readonly JsonObject[];
  rootToolCalls: readonly JsonObject[];
  rootToolResults: readonly JsonObject[];
  specialistToolCalls: readonly JsonObject[];
  specialistToolResults: readonly JsonObject[];
  specialistTools: readonly JsonObject[];
  specialistResponses: readonly JsonObject[];
  rootBaseInstructions: string;
  specialistBaseInstructions: string;
  rootSupportsSearchTool: boolean | undefined;
  parentPersonality: string | undefined;
  expectedChildPersonality: "friendly" | "none";
  projectedConfig: string;
  projectedAgentConfigs: Readonly<Record<string, string>>;
  blockedEndpoints: readonly string[];
  stdout: string;
  stderr: string;
}>;

/** Route argument supplied by the deterministic local mock provider. */
export type RouteProbe = "concrete" | "omitted" | "invalid" | `generic-${GenericBuiltinAgentType}`;

/** Exercise Codex CLI with a local Responses stub and an isolated CODEX_HOME. */
function collectEffectiveRuntimeEvidence(
  routeProbe: RouteProbe = "concrete",
): Effect.Effect<EffectiveRuntimeEvidence, unknown> {
  return Effect.suspend(() => {
    const requests: JsonObject[] = [];
    const providerResponses: JsonObject[] = [];
    const blockedEndpoints: string[] = [];
    const projectedAgentConfigs: Record<string, string> = {};
    const state = {
      codexVersion: "unknown",
      stdout: "",
      stderr: "",
      rootInstructions: "",
      specialistInstructions: "",
      parentPersonality: undefined as string | undefined,
      expectedChildPersonality: "none" as "friendly" | "none",
      projectedConfig: "",
      rootSupportsSearchTool: undefined as boolean | undefined,
    };
    let rootPath: string | undefined;
    const evidence = (): EffectiveRuntimeEvidence => {
      const rootRequests = rootRequestsFrom(requests);
      const rootRequest = rootRequests[0] ?? {};
      const specialistRequests = requests.filter((entry) => !rootRequests.includes(entry));
      return {
        codexVersion: state.codexVersion,
        rootRequest,
        allRequests: requests,
        rootRequests,
        specialistRequests,
        rootTools: toolDefinitions(rootRequest),
        rootToolCalls: providerResponses
          .filter((entry) => rootRequests.some((request) => sameRequestThread(request, entry)))
          .flatMap((entry) => outputItems(entry, "function_call")),
        rootToolResults: rootRequests.flatMap((entry) =>
          outputItems(entry, "function_call_output"),
        ),
        specialistToolCalls: providerResponses
          .filter((entry) => !rootRequests.some((request) => sameRequestThread(request, entry)))
          .flatMap((entry) => outputItems(entry, "function_call")),
        specialistToolResults: specialistRequests.flatMap((entry) =>
          outputItems(entry, "function_call_output"),
        ),
        specialistTools: specialistRequests.flatMap((entry) => toolDefinitions(entry)),
        specialistResponses: providerResponses.filter(
          (entry) => !rootRequests.some((request) => sameRequestThread(request, entry)),
        ),
        rootBaseInstructions: state.rootInstructions,
        specialistBaseInstructions: state.specialistInstructions,
        rootSupportsSearchTool: state.rootSupportsSearchTool,
        parentPersonality: state.parentPersonality,
        expectedChildPersonality: state.expectedChildPersonality,
        projectedConfig: state.projectedConfig,
        projectedAgentConfigs,
        blockedEndpoints,
        stdout: state.stdout,
        stderr: state.stderr,
      };
    };
    const server = createServer((request, response) => {
      void Effect.runPromise(
        answerResponseRequest(
          request,
          response,
          requests,
          providerResponses,
          blockedEndpoints,
          routeProbe,
        ),
      );
    });
    server.on("connect", (request, socket) => {
      blockedEndpoints.push(String(request.url));
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });

    const program = Effect.gen(function* () {
      const root = yield* tryPromise(() => mkdtemp(join(tmpdir(), "holycodex-effective-runtime-")));
      rootPath = root;
      const codexHome = join(root, "codex-home");
      const catalogPath = nativeModelCatalogPath(codexHome);
      const address = yield* startServer(server);
      yield* tryPromise(() => mkdir(codexHome, { recursive: true }));
      const sourceCatalogPath =
        process.env["CODEX_MODEL_CATALOG_PATH"] ??
        join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "models_cache.json");
      const sourceCatalogText = yield* tryPromise(() => readFile(sourceCatalogPath, "utf8"));
      const catalog = patchCurrentModelCatalog(JSON.parse(sourceCatalogText));
      const rootModel = findCatalogModel(catalog.catalog, "gpt-6.1-sol");
      state.rootSupportsSearchTool =
        typeof rootModel?.["supports_search_tool"] === "boolean"
          ? rootModel["supports_search_tool"]
          : undefined;
      state.rootInstructions = catalog.rootInstructions;
      state.specialistInstructions = catalog.specialistInstructions;
      yield* tryPromise(() => mkdir(dirname(catalogPath), { recursive: true }));
      yield* tryPromise(() => writeFile(catalogPath, JSON.stringify(catalog.catalog)));
      const sourceCodexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
      const originalConfigText = yield* tryPromise(() =>
        readFile(join(sourceCodexHome, "config.toml"), "utf8"),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));
      const originalPersonality = readTomlPath(parseConfig(originalConfigText), "personality");
      state.parentPersonality =
        typeof originalPersonality === "string" ? originalPersonality : undefined;
      const parentPersonalityNone = rootPersonalityIsNone(originalPersonality);
      state.expectedChildPersonality = parentPersonalityNone ? "friendly" : "none";
      const desired = desiredRootConfig(
        "default",
        "standard",
        { parentPersonalityNone },
        codexHome,
        catalog.catalog,
      );
      const desiredValues = desired as Record<string, unknown>;
      yield* Effect.forEach(projectNativeAgents("default"), (agent) =>
        Effect.gen(function* () {
          const configPath = desiredValues[`agents."${agent.name}".config_file`];
          if (typeof configPath !== "string")
            return yield* Effect.fail(
              new Error(`Root projection omitted ${agent.name}'s managed config path.`),
            );
          const path = configWithinHome(codexHome, configPath);
          yield* tryPromise(() => mkdir(dirname(path), { recursive: true }));
          const contents = renderNativeAgent(agent, { parentPersonalityNone });
          projectedAgentConfigs[agent.name] = contents;
          yield* tryPromise(() => writeFile(path, contents));
        }),
      );
      yield* Effect.forEach(GENERIC_BUILTIN_AGENT_TYPES, (agentType) =>
        Effect.gen(function* () {
          const configPath = desiredValues[`agents.${agentType}.config_file`];
          if (typeof configPath !== "string")
            return yield* Effect.fail(
              new Error(`Root projection omitted the ${agentType} sentinel config path.`),
            );
          const path = configWithinHome(codexHome, configPath);
          yield* tryPromise(() => mkdir(dirname(path), { recursive: true }));
          const contents = renderGenericBuiltinSentinel(agentType, parentPersonalityNone);
          projectedAgentConfigs[`sentinel-${agentType}`] = contents;
          yield* tryPromise(() => writeFile(path, contents));
        }),
      );
      state.projectedConfig = configText(address.port, desired, state.parentPersonality);
      yield* tryPromise(() => writeFile(join(codexHome, "config.toml"), state.projectedConfig));
      const executable = yield* resolveCodexExecutable();
      const result = yield* runCodex(executable, codexHome, root, address.port);
      state.codexVersion = result.version;
      state.stdout = result.stdout;
      state.stderr = result.stderr;
      const rootRequests = rootRequestsFrom(requests);
      if (rootRequests[0] === undefined)
        return yield* Effect.fail(
          new Error("Codex did not issue a Root request to the local stub."),
        );
      return evidence();
    });
    return Effect.ensuring(
      program.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const path = yield* persistEffectiveRuntimeFailure(evidence(), String(error));
            return yield* Effect.fail(
              new Error(`${String(error)}\nPartial runtime evidence: ${path}`),
            );
          }),
        ),
      ),
      Effect.gen(function* () {
        yield* closeServer(server).pipe(Effect.catch(() => Effect.void));
        if (rootPath !== undefined)
          yield* tryPromise(() => rm(rootPath as string, { recursive: true, force: true })).pipe(
            Effect.catch(() => Effect.void),
          );
      }),
    );
  });
}

/** Persist full local payload evidence when an effective-runtime assertion fails. */
function persistEffectiveRuntimeFailure(
  evidence: EffectiveRuntimeEvidence,
  failure: string,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const directory = yield* tryPromise(() =>
      mkdtemp(join(tmpdir(), "holycodex-effective-runtime-failure-")),
    );
    const path = join(directory, "evidence.json");
    yield* tryPromise(() =>
      writeFile(
        path,
        JSON.stringify(
          {
            failure,
            codexVersion: evidence.codexVersion,
            parentPersonality: evidence.parentPersonality,
            expectedChildPersonality: evidence.expectedChildPersonality,
            projectedConfig: evidence.projectedConfig,
            projectedAgentConfigs: evidence.projectedAgentConfigs,
            requests: evidence.allRequests.map((request, index) => ({
              index,
              model: request["model"],
              prompt_cache_key: request["prompt_cache_key"],
              client_metadata: request["client_metadata"],
              classifiedAsRoot: evidence.rootRequests.includes(request),
              toolNames: toolNames(request),
              developerLayers: developerLayers(request),
              functionCalls: outputItems(request, "function_call"),
              functionResults: outputItems(request, "function_call_output"),
              fullPayload: request,
            })),
            rootToolNames: toolNames(evidence.rootRequest),
            specialistToolNames: evidence.specialistRequests.map(toolNames),
            rootToolCalls: evidence.rootToolCalls,
            rootToolResults: evidence.rootToolResults,
            specialistToolCalls: evidence.specialistToolCalls,
            specialistToolResults: evidence.specialistToolResults,
            specialistResponses: evidence.specialistResponses,
            blockedEndpoints: evidence.blockedEndpoints,
            stdout: evidence.stdout,
            stderr: evidence.stderr,
          },
          null,
          2,
        ),
      ),
    );
    return path;
  });
}

function answerResponseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requests: JsonObject[],
  providerResponses: JsonObject[],
  blockedEndpoints: string[],
  routeProbe: RouteProbe,
): Effect.Effect<void, unknown> {
  if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
    blockedEndpoints.push(`${request.method} ${request.url}`);
    response.writeHead(404).end();
    return Effect.void;
  }
  return readRequestBody(request).pipe(
    Effect.flatMap((text) =>
      Effect.sync(() => {
        const body = JSON.parse(text) as JsonObject;
        requests.push(body);
        const rootRequests = rootRequestsFrom(requests);
        const isRoot = rootRequests.includes(body);
        const stage = rootRequests.length - 1;
        const rootSchemaRequest = rootRequests[0] ?? body;
        const items = isRoot
          ? rootOutputItems(body, rootSchemaRequest, stage, routeProbe)
          : specialistOutputItems(body);
        const events = [
          ...items.map((item) => ({ type: "response.output_item.done", item })),
          {
            type: "response.completed",
            response: { id: `holycodex-probe-${requests.length}` },
          },
        ];
        providerResponses.push({
          model: body["model"],
          prompt_cache_key: body["prompt_cache_key"],
          client_metadata: body["client_metadata"],
          input: items,
        });
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        for (const event of events)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        response.end();
      }),
    ),
  );
}

function readRequestBody(request: IncomingMessage): Effect.Effect<string, unknown> {
  return Effect.callback<string, unknown>((resume) => {
    const chunks: Uint8Array[] = [];
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    request.once("error", (error) => resume(Effect.fail(error)));
    request.once("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))));
  });
}

function rootOutputItems(
  request: JsonObject,
  schemaRequest: JsonObject,
  stage: number,
  routeProbe: RouteProbe,
): JsonObject[] {
  if (stage === 0) {
    const agentType = routeForProbe(routeProbe);
    const spawnArgs = findSpawnArguments(request, agentType);
    if (spawnArgs === undefined) {
      return [assistantText("Root tools lack multi_agent_v1.spawn_agent.")];
    }
    return [functionCall("root-spawn", "multi_agent_v1", "spawn_agent", spawnArgs)];
  }
  if (stage === 1) {
    if (observedAgentIds(request).length === 0)
      return [assistantText("Invalid or omitted route was rejected without creating an agent.")];
    return [functionCall("root-wait", "multi_agent_v1", "wait_agent", waitArguments(request))];
  }
  if (stage === 2 && hasCallOutput(request, "root-wait") && observedAgentIds(request).length > 0) {
    const closeArgs = closeArguments(schemaRequest, request);
    if (closeArgs !== undefined)
      return [functionCall("root-close", "multi_agent_v1", "close_agent", closeArgs)];
  }
  return [assistantText("Runtime acceptance probe completed.")];
}

function hasCallOutput(request: JsonObject, callId: string): boolean {
  return outputItems(request, "function_call_output").some((item) => item["call_id"] === callId);
}

function specialistOutputItems(request: JsonObject): JsonObject[] {
  const instructions = developerInstructions(request);
  const sentinel = matchGenericBuiltinSentinel(instructions);
  return [
    assistantText(
      sentinel === undefined
        ? "HOLYCODEX_SENTINEL_MISSING"
        : `HOLYCODEX_SENTINEL_ACTIVE:${sentinel}`,
    ),
  ];
}

/** Identify a sentinel only when the complete canonical role instruction is present. */
function matchGenericBuiltinSentinel(instructions: string): GenericBuiltinAgentType | undefined {
  const matched = GENERIC_BUILTIN_AGENT_TYPES.filter((agentType) => {
    const generated = parseConfig(renderGenericBuiltinSentinel(agentType));
    const expected = readTomlPath(generated, "developer_instructions");
    return typeof expected === "string" && instructions.includes(expected);
  });
  return matched.length === 1 ? matched[0] : undefined;
}

function routeForProbe(routeProbe: RouteProbe): string | undefined {
  if (routeProbe === "concrete") return "Worker.validation";
  if (routeProbe === "invalid") return "unregistered-route";
  if (routeProbe === "omitted") return undefined;
  return routeProbe.slice("generic-".length);
}

function assistantText(text: string): JsonObject {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function functionCall(
  callId: string,
  namespace: string,
  name: string,
  argumentsValue: unknown,
): JsonObject {
  return {
    type: "function_call",
    call_id: callId,
    namespace,
    name,
    arguments: JSON.stringify(argumentsValue),
  };
}

function findSpawnArguments(
  request: JsonObject,
  agentType: string | undefined,
): JsonObject | undefined {
  const definition = toolDefinitions(request).find(
    (tool) => tool["namespace"] === "multi_agent_v1" && tool["name"] === "spawn_agent",
  );
  const schema = definition?.["parameters"];
  if (!isObject(schema)) return undefined;
  const properties = schema["properties"];
  if (!isObject(properties)) return undefined;

  const args: JsonObject = {};
  for (const [name, property] of Object.entries(properties)) {
    const description =
      isObject(property) && typeof property["description"] === "string"
        ? property["description"]
        : "";
    const normalized = `${name} ${description}`.toLowerCase();
    if (normalized.includes("agent_type")) {
      if (agentType !== undefined) args[name] = agentType;
    } else if (normalized.includes("fork_context")) args[name] = false;
    else if (
      normalized.includes("assignment") ||
      normalized.includes("task") ||
      normalized.includes("prompt")
    ) {
      args[name] = assignmentValue(property);
    } else if (normalized.includes("model") || normalized.includes("effort")) {
      continue;
    }
  }
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  if (required.some((name) => typeof name === "string" && !(name in args))) return undefined;
  return args;
}

function assignmentValue(schema: unknown): unknown {
  if (!isObject(schema)) return undefined;
  if (schema["type"] === "object" && isObject(schema["properties"])) {
    const values: JsonObject = {};
    const required = Array.isArray(schema["required"]) ? schema["required"] : [];
    for (const name of required) {
      if (typeof name !== "string") continue;
      const childSchema = schema["properties"][name];
      if (name === "objective") values[name] = "Verify V1 child runtime behavior";
      else if (name === "scope") values[name] = "One isolated local Codex session";
      else if (name === "constraints")
        values[name] = "No external network, Git writes, or delegation";
      else if (name === "dependencies") values[name] = "None";
      else if (name === "acceptance_criteria" || name === "acceptance")
        values[name] = "Return a terminal result";
      else if (name === "required_evidence" || name === "evidence")
        values[name] = "Observed runtime request payload";
      else values[name] = scalarFor(name, childSchema);
    }
    return values;
  }
  return "Objective: verify V1 child runtime behavior. Scope: one isolated local Codex session. Constraints: no external network, Git writes, or delegation. Dependencies: none. Acceptance: return a terminal result. Evidence: observed runtime request payload.";
}

function scalarFor(name: string, schema: unknown): unknown {
  if (isObject(schema) && Array.isArray(schema["enum"]) && schema["enum"].length > 0)
    return schema["enum"][0];
  if (isObject(schema) && schema["type"] === "array") return [];
  if (isObject(schema) && schema["type"] === "boolean") return false;
  return name.replaceAll("_", " ");
}

function rootRequestsFrom(requests: readonly JsonObject[]): JsonObject[] {
  const firstRoot = requests.find((entry) => entry["model"] === "gpt-6.1-sol");
  if (firstRoot === undefined) return [];
  return requests.filter((entry) => sameRequestThread(firstRoot, entry));
}

function sameRequestThread(root: JsonObject, candidate: JsonObject): boolean {
  if (root === candidate) return true;
  const rootIdentity = requestIdentity(root);
  const candidateIdentity = requestIdentity(candidate);
  if (rootIdentity.thread.length > 0 && candidateIdentity.thread.length > 0)
    return overlaps(rootIdentity.thread, candidateIdentity.thread);
  if (rootIdentity.thread.length > 0 || candidateIdentity.thread.length > 0) return false;
  if (rootIdentity.agent.length > 0 && candidateIdentity.agent.length > 0)
    return overlaps(rootIdentity.agent, candidateIdentity.agent);
  if (rootIdentity.agent.length > 0 || candidateIdentity.agent.length > 0) return false;
  const rootCacheKey = promptCacheKey(root);
  const candidateCacheKey = promptCacheKey(candidate);
  if (rootCacheKey !== undefined && candidateCacheKey !== undefined)
    return rootCacheKey === candidateCacheKey;
  if (rootCacheKey !== undefined || candidateCacheKey !== undefined) return false;
  if (rootIdentity.session.length > 0 && candidateIdentity.session.length > 0)
    return overlaps(rootIdentity.session, candidateIdentity.session);
  return false;
}

function promptCacheKey(request: JsonObject): string | undefined {
  return typeof request["prompt_cache_key"] === "string" ? request["prompt_cache_key"] : undefined;
}

function requestIdentity(request: JsonObject): {
  thread: string[];
  session: string[];
  agent: string[];
} {
  const metadata = request["client_metadata"];
  const identity = { thread: [] as string[], session: [] as string[], agent: [] as string[] };
  if (!isObject(metadata)) return identity;
  const visit = (value: JsonObject): void => {
    for (const [key, nested] of Object.entries(value)) {
      const identityKey = /^(thread|session|agent)(?:_?id)?$/iu.exec(key)?.[1]?.toLowerCase();
      if (identityKey !== undefined && typeof nested === "string")
        identity[identityKey as keyof typeof identity].push(nested);
      else if (isObject(nested)) visit(nested);
    }
  };
  visit(metadata);
  return identity;
}

function overlaps(left: readonly string[], right: readonly string[]): boolean {
  return left.some((value) => right.includes(value));
}

function developerInstructions(request: JsonObject): string {
  const input = request["input"];
  if (!Array.isArray(input)) return "";
  return input
    .flatMap((entry) => {
      if (!isObject(entry) || entry["type"] !== "message" || entry["role"] !== "developer")
        return [];
      const content = entry["content"];
      return Array.isArray(content)
        ? content.flatMap((part) =>
            isObject(part) && typeof part["text"] === "string" ? [part["text"]] : [],
          )
        : [];
    })
    .join("\n");
}

function developerLayers(request: JsonObject): JsonObject[] {
  const input = request["input"];
  if (!Array.isArray(input)) return [];
  return input.filter(
    (entry): entry is JsonObject =>
      isObject(entry) && entry["type"] === "message" && entry["role"] === "developer",
  );
}

function waitArguments(request: JsonObject): JsonObject {
  const definition = toolDefinitions(request).find(
    (tool) => tool["namespace"] === "multi_agent_v1" && tool["name"] === "wait_agent",
  );
  const schema = definition?.["parameters"];
  if (!isObject(schema) || !isObject(schema["properties"])) return {};
  const properties = schema["properties"];
  const args: JsonObject = {};
  const agentId = observedAgentIds(request).at(-1);
  for (const [name, property] of Object.entries(properties)) {
    const description =
      isObject(property) && typeof property["description"] === "string"
        ? property["description"]
        : "";
    const normalized = `${name} ${description}`.toLowerCase();
    if (
      (name === "targets" || normalized.includes("agent_ids")) &&
      isObject(property) &&
      property["type"] === "array"
    )
      args[name] = agentId === undefined ? [] : [agentId];
    else if (normalized.includes("agent_id") && isObject(property) && property["type"] === "array")
      args[name] = agentId === undefined ? [] : [agentId];
    else if (normalized.includes("agent_id")) args[name] = agentId ?? "__missing_agent_id__";
    else if (normalized.includes("timeout_ms")) args[name] = 600000;
  }
  return args;
}

function closeArguments(
  schemaRequest: JsonObject,
  historyRequest: JsonObject,
): JsonObject | undefined {
  const definition = toolDefinitions(schemaRequest).find(
    (tool) => tool["namespace"] === "multi_agent_v1" && tool["name"] === "close_agent",
  );
  const schema = definition?.["parameters"];
  if (!isObject(schema) || !isObject(schema["properties"])) return undefined;
  const agentId = observedAgentIds(historyRequest).at(-1);
  if (agentId === undefined) return undefined;
  for (const name of Object.keys(schema["properties"])) {
    if (name === "target" || name === "agent_id") return { [name]: agentId };
  }
  return undefined;
}

function observedAgentIds(request: JsonObject): string[] {
  const input = request["input"];
  if (!Array.isArray(input)) return [];
  const ids = new Set<string>();
  for (const item of input) {
    if (!isObject(item) || item["type"] !== "function_call_output") continue;
    const output = item["output"];
    if (typeof output !== "string") continue;
    for (const match of output.matchAll(/(?:agent_id|agentId|agent id)["'=: ]+([A-Za-z0-9_-]+)/giu))
      ids.add(match[1] ?? "");
    for (const match of output.matchAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
    ))
      ids.add(match[0]);
  }
  ids.delete("");
  return [...ids];
}

function toolDefinitions(request: JsonObject): JsonObject[] {
  const input = request["input"];
  if (!Array.isArray(input)) return [];
  const toolGroups = input.filter(
    (value): value is JsonObject =>
      isObject(value) && value["type"] === "additional_tools" && Array.isArray(value["tools"]),
  );
  return toolGroups.flatMap((group) =>
    (group["tools"] as unknown[]).flatMap((value) => {
      if (!isObject(value)) return [];
      if (value["type"] === "namespace") {
        const nested = value["tools"];
        return Array.isArray(nested)
          ? nested.filter(isObject).map((tool) => ({ ...tool, namespace: value["name"] }))
          : [];
      }
      return [value];
    }),
  );
}

function outputItems(request: JsonObject, type: string): JsonObject[] {
  const output = request["input"];
  return Array.isArray(output)
    ? output.filter((item): item is JsonObject => isObject(item) && item["type"] === type)
    : [];
}

function toolNames(request: JsonObject): string[] {
  return toolDefinitions(request).map((tool) => {
    const name = typeof tool["name"] === "string" ? tool["name"] : "";
    return typeof tool["namespace"] === "string" ? `${tool["namespace"]}.${name}` : name;
  });
}

function configText(port: number, desired: object, parentPersonality: string | undefined): string {
  const document: Record<string, unknown> = {};
  for (const [keyPath, value] of Object.entries(desired)) {
    if (value !== undefined) setTomlPath(document, keyPath, value);
  }
  setTomlPath(document, "model_provider", "mock");
  setTomlPath(document, "approval_policy", "never");
  setTomlPath(document, "sandbox_mode", "read-only");
  setTomlPath(document, "model_providers.mock.name", "HolyCodex local effective-runtime stub");
  setTomlPath(document, "model_providers.mock.base_url", `http://127.0.0.1:${port}/v1`);
  setTomlPath(document, "model_providers.mock.env_key", "HOLYCODEX_MOCK_API_KEY");
  setTomlPath(document, "model_providers.mock.wire_api", "responses");
  if (parentPersonality !== undefined) setTomlPath(document, "personality", parentPersonality);
  return stringifyToml(document as TomlDocument);
}

function setTomlPath(document: Record<string, unknown>, path: string, value: unknown): void {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const character of path) {
    if (character === '"' && !escaped) quoted = !quoted;
    if (character === "." && !quoted) {
      parts.push(current);
      current = "";
    } else current += character;
    if (character === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  parts.push(current);
  const keys = parts.map((part) => {
    const trimmed = part.trim();
    return trimmed.startsWith('"') ? (JSON.parse(trimmed) as string) : trimmed;
  });
  let table = document;
  for (const key of keys.slice(0, -1)) {
    const existing = table[key];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing))
      table[key] = {};
    table = table[key] as Record<string, unknown>;
  }
  const leaf = keys.at(-1);
  if (leaf !== undefined) table[leaf] = value;
}

function configWithinHome(codexHome: string, configPath: string): string {
  const root = resolve(codexHome);
  const absolute = isAbsolute(configPath) ? resolve(configPath) : resolve(root, configPath);
  const fromRoot = relative(root, absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot))
    throw new Error("The managed agent config path escaped the isolated CODEX_HOME.");
  return absolute;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findCatalogModel(
  catalog: Readonly<Record<string, unknown>>,
  slug: string,
): JsonObject | undefined {
  const models = catalog["models"];
  if (!Array.isArray(models)) return undefined;
  return models.find((model): model is JsonObject => isObject(model) && model["slug"] === slug);
}

function resolveCodexExecutable(): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const command = process.env["CODEX_EXECUTABLE"] ?? "codex";
    if (process.platform !== "win32") return command;
    const result = yield* tryPromise(() => Bun.$`where.exe ${command}`.quiet().nothrow());
    if (result.exitCode === 0) return result.text().trim().split(/\r?\n/u)[0] ?? command;
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData !== undefined) {
      const miseInstall = join(localAppData, "mise", "installs", "npm-openai-codex");
      const versions = yield* tryPromise(() => readdir(miseInstall)).pipe(
        Effect.catch(() => Effect.succeed([] as string[])),
      );
      for (const version of versions.sort((left, right) => right.localeCompare(left))) {
        const candidate = join(miseInstall, version, "bin", "codex.exe");
        if (yield* tryPromise(() => Bun.file(candidate).exists())) return candidate;
      }
    }
    return yield* Effect.fail(
      new Error("Codex CLI executable was not found on PATH or in the standard mise installation."),
    );
  });
}

function runCodex(
  executable: string,
  codexHome: string,
  workdir: string,
  proxyPort: number,
): Effect.Effect<
  {
    version: string;
    stdout: string;
    stderr: string;
  },
  unknown
> {
  return Effect.gen(function* () {
    const env = isolatedEnvironment(codexHome, proxyPort);
    const versionResult = yield* runProcess(executable, ["--version"], env);
    if (versionResult.code !== 0)
      return yield* Effect.fail(new Error(`Codex --version failed: ${versionResult.stderr}`));
    const result = yield* runProcess(
      executable,
      [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "-C",
        workdir,
        "Run the locally scripted effective-runtime acceptance probe.",
      ],
      env,
    );
    if (result.code !== 0)
      return yield* Effect.fail(
        new Error(`The installed Codex runtime exited ${result.code}: ${result.stderr}`),
      );
    return { version: versionResult.stdout.trim(), stdout: result.stdout, stderr: result.stderr };
  });
}

function isolatedEnvironment(codexHome: string, proxyPort: number): NodeJS.ProcessEnv {
  const proxy = `http://127.0.0.1:${proxyPort}`;
  return {
    PATH: process.env["PATH"],
    SystemRoot: process.env["SystemRoot"],
    WINDIR: process.env["WINDIR"],
    TEMP: process.env["TEMP"],
    TMP: process.env["TMP"],
    USERPROFILE: process.env["USERPROFILE"],
    HOMEDRIVE: process.env["HOMEDRIVE"],
    HOMEPATH: process.env["HOMEPATH"],
    APPDATA: process.env["APPDATA"],
    LOCALAPPDATA: process.env["LOCALAPPDATA"],
    CODEX_HOME: codexHome,
    HOLYCODEX_MOCK_API_KEY: "local-test-only",
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function runProcess(
  executable: string,
  argumentsList: string[],
  env: NodeJS.ProcessEnv,
): Effect.Effect<{ code: number; stdout: string; stderr: string }, unknown> {
  return Effect.callback<{ code: number; stdout: string; stderr: string }, unknown>((resume) => {
    const process = spawn(executable, argumentsList, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void Effect.runPromise(terminateProcessTree(process));
    }, 150_000);
    process.stdout.setEncoding("utf8").on("data", (value: string) => (stdout += value));
    process.stderr.setEncoding("utf8").on("data", (value: string) => (stderr += value));
    process.once("error", (error) => {
      clearTimeout(timeout);
      resume(Effect.fail(error));
    });
    process.once("close", (code) => {
      clearTimeout(timeout);
      if (timedOut)
        resume(Effect.fail(new Error("Installed Codex local probe exceeded its process timeout.")));
      else resume(Effect.succeed({ code: code ?? -1, stdout, stderr }));
    });
  });
}

function terminateProcessTree(child: ReturnType<typeof spawn>): Effect.Effect<void> {
  if (child.pid === undefined) return Effect.void;
  if (process.platform !== "win32") {
    return Effect.sync(() => {
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("close", () => clearTimeout(forceTimer));
    });
  }
  return Effect.callback<void, never>((resume) => {
    const terminator = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const fallback = setTimeout(() => {
      child.kill();
      resume(Effect.void);
    }, 3000);
    terminator.once("error", () => {
      clearTimeout(fallback);
      child.kill();
      resume(Effect.void);
    });
    terminator.once("close", () => {
      clearTimeout(fallback);
      resume(Effect.void);
    });
  });
}

function tryPromise<A>(try_: () => PromiseLike<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: try_, catch: (error) => error });
}

function startServer(
  server: ReturnType<typeof createServer>,
): Effect.Effect<{ port: number }, unknown> {
  return Effect.callback<{ port: number }, unknown>((resume) => {
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        resume(Effect.fail(new Error("The local Responses stub did not bind a TCP port.")));
      } else resume(Effect.succeed({ port: address.port }));
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Effect.Effect<void, unknown> {
  return Effect.callback<void, unknown>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close((error) => (error ? resume(Effect.fail(error)) : resume(Effect.void)));
  });
}

export {
  collectEffectiveRuntimeEvidence,
  matchGenericBuiltinSentinel,
  persistEffectiveRuntimeFailure,
};
