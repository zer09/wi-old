import { CommandIdSchema, RunIdSchema, SessionIdSchema } from "@wi/protocol";

import type { Logger } from "../logging/logger.js";

export const TEST_FAILPOINTS = [
  "after_command_event_insert_before_commit",
  "after_command_commit_before_ack",
  "after_event_commit_before_publish",
  "after_tool_requested_commit",
  "after_tool_started_commit",
  "after_tool_result_commit_before_provider_continue",
  "after_provider_text_commit",
  "after_run_terminal_commit",
  "after_session_create_before_catalog_ready",
  "after_catalog_session_repair",
  "after_catalog_replacement_before_repair",
  "after_provider_lifecycle_prepare",
  "after_provider_file_effect",
  "after_provider_file_observed",
  "after_provider_lifecycle_terminal_before_ack",
  "after_provider_stage_cleanup",
  "after_provider_stage_temp_flush",
  "after_provider_credential_temp_flush",
  "after_provider_stage_commit",
  "before_provider_provisioning_ref_return",
  "after_recovery_admission",
  "after_recovery_prepare",
  "after_environment_run_acceptance_before_request",
  "after_provider_stage_delete_before_flush",
  "after_provider_credential_rename_before_flush",
  "after_provider_credential_unlink_before_flush",
  "after_provider_stage_rename_before_flush",
] as const;

export type TestFailpointName = (typeof TEST_FAILPOINTS)[number];

type TestFailpointSelector =
  | { readonly kind: "session"; readonly sessionId: string }
  | {
      readonly kind: "command";
      readonly sessionId: string;
      readonly commandId: string;
    }
  | {
      readonly kind: "run";
      readonly sessionId: string;
      readonly commandId: string;
      readonly runId: string;
    }
  | { readonly kind: "creation-command"; readonly commandId: string }
  | { readonly kind: "provider-command"; readonly commandId: string }
  | { readonly kind: "catalog-global" };

export interface TestFailpointController {
  readonly name: TestFailpointName;
  readonly exitCode: number;
  is(name: TestFailpointName): boolean;
  matches(
    name: TestFailpointName,
    fields?: Readonly<Record<string, unknown>>,
  ): boolean;
  takeRunIdForCommand(sessionId: string, commandId: string): string | null;
  hit(name: TestFailpointName, fields?: Readonly<Record<string, unknown>>): void;
}

const selectorEnvironmentKeys = [
  "WI_TEST_FAILPOINT_SESSION_ID",
  "WI_TEST_FAILPOINT_COMMAND_ID",
  "WI_TEST_FAILPOINT_RUN_ID",
  "WI_TEST_FAILPOINT_CATALOG_GLOBAL",
] as const;

const selectorKindByFailpoint = {
  after_command_event_insert_before_commit: "command",
  after_command_commit_before_ack: "command",
  after_event_commit_before_publish: "run",
  after_tool_requested_commit: "run",
  after_tool_started_commit: "run",
  after_tool_result_commit_before_provider_continue: "run",
  after_provider_text_commit: "run",
  after_run_terminal_commit: "run",
  after_session_create_before_catalog_ready: "creation-command",
  after_catalog_session_repair: "session",
  after_catalog_replacement_before_repair: "catalog-global",
  after_provider_lifecycle_prepare: "provider-command",
  after_provider_file_effect: "provider-command",
  after_provider_file_observed: "provider-command",
  after_provider_lifecycle_terminal_before_ack: "provider-command",
  after_provider_stage_cleanup: "provider-command",
  after_provider_stage_delete_before_flush: "provider-command",
  after_provider_stage_temp_flush: "provider-command",
  after_provider_credential_temp_flush: "provider-command",
  after_provider_stage_commit: "provider-command",
  before_provider_provisioning_ref_return: "provider-command",
  after_recovery_admission: "provider-command",
  after_recovery_prepare: "provider-command",
  after_environment_run_acceptance_before_request: "provider-command",
  after_provider_credential_rename_before_flush: "provider-command",
  after_provider_credential_unlink_before_flush: "provider-command",
  after_provider_stage_rename_before_flush: "provider-command",
} as const satisfies Readonly<Record<TestFailpointName, TestFailpointSelector["kind"]>>;

function invalidSelector(name: TestFailpointName): never {
  throw new Error(`Invalid test failpoint selector for ${name}`);
}

function validatedId(
  value: string | undefined,
  schema: typeof SessionIdSchema | typeof CommandIdSchema | typeof RunIdSchema,
  name: TestFailpointName,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidSelector(name);
  return parsed.data;
}

function parseSelector(
  name: TestFailpointName,
  environment: Readonly<Record<string, string | undefined>>,
): TestFailpointSelector {
  const sessionId = validatedId(
    environment.WI_TEST_FAILPOINT_SESSION_ID,
    SessionIdSchema,
    name,
  );
  const commandId = validatedId(
    environment.WI_TEST_FAILPOINT_COMMAND_ID,
    CommandIdSchema,
    name,
  );
  const runId = validatedId(environment.WI_TEST_FAILPOINT_RUN_ID, RunIdSchema, name);
  const catalogGlobal = environment.WI_TEST_FAILPOINT_CATALOG_GLOBAL;
  if (catalogGlobal !== undefined && catalogGlobal !== "1") invalidSelector(name);

  switch (selectorKindByFailpoint[name]) {
    case "creation-command":
    case "provider-command":
      if (
        commandId === undefined ||
        sessionId !== undefined ||
        runId !== undefined ||
        catalogGlobal !== undefined
      ) {
        invalidSelector(name);
      }
      return { kind: selectorKindByFailpoint[name], commandId };
    case "catalog-global":
      if (
        catalogGlobal !== "1" ||
        sessionId !== undefined ||
        commandId !== undefined ||
        runId !== undefined
      ) {
        invalidSelector(name);
      }
      return { kind: "catalog-global" };
    case "command":
      if (
        sessionId === undefined ||
        commandId === undefined ||
        runId !== undefined ||
        catalogGlobal !== undefined
      ) {
        invalidSelector(name);
      }
      return { kind: "command", sessionId, commandId };
    case "run":
      if (
        sessionId === undefined ||
        commandId === undefined ||
        runId === undefined ||
        catalogGlobal !== undefined
      ) {
        invalidSelector(name);
      }
      return { kind: "run", sessionId, commandId, runId };
    case "session":
      if (
        sessionId === undefined ||
        commandId !== undefined ||
        runId !== undefined ||
        catalogGlobal !== undefined
      ) {
        invalidSelector(name);
      }
      return { kind: "session", sessionId };
  }
}

function selectorMatches(
  selector: TestFailpointSelector,
  fields: Readonly<Record<string, unknown>>,
): boolean {
  switch (selector.kind) {
    case "session":
      return fields.sessionId === selector.sessionId;
    case "command":
      return (
        fields.sessionId === selector.sessionId && fields.commandId === selector.commandId
      );
    case "run":
      return fields.sessionId === selector.sessionId && fields.runId === selector.runId;
    case "creation-command":
    case "provider-command":
      return fields.commandId === selector.commandId;
    case "catalog-global":
      return true;
  }
}

export function createTestFailpointController(
  environment: Readonly<Record<string, string | undefined>>,
  logger?: Logger,
): TestFailpointController | null {
  const configured = environment.WI_TEST_FAILPOINT;
  const hasSelector = selectorEnvironmentKeys.some(
    (key) => environment[key] !== undefined,
  );
  if (configured === undefined) {
    if (hasSelector) throw new Error("Test failpoint selector requires WI_TEST_FAILPOINT");
    return null;
  }
  if (environment.NODE_ENV !== "test" || environment.WI_ALLOW_TEST_FAILPOINTS !== "1") {
    throw new Error(
      "WI_TEST_FAILPOINT requires NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
    );
  }
  const index = TEST_FAILPOINTS.indexOf(configured as TestFailpointName);
  if (index < 0) throw new Error(`Unknown test failpoint: ${configured}`);
  const name = TEST_FAILPOINTS[index] as TestFailpointName;
  const selector = parseSelector(name, environment);
  const exitCode = 90 + index;
  let triggered = false;
  let runIdAssigned = false;
  const matches = (
    candidate: TestFailpointName,
    fields: Readonly<Record<string, unknown>> = {},
  ): boolean => candidate === name && selectorMatches(selector, fields);
  return {
    name,
    exitCode,
    is: (candidate) => candidate === name,
    matches,
    takeRunIdForCommand: (sessionId, commandId) => {
      if (
        runIdAssigned ||
        selector.kind !== "run" ||
        selector.sessionId !== sessionId ||
        selector.commandId !== commandId
      ) {
        return null;
      }
      runIdAssigned = true;
      return selector.runId;
    },
    hit: (candidate, fields = {}) => {
      if (triggered || !matches(candidate, fields)) return;
      triggered = true;
      try {
        logger?.warn("test_failpoint_triggered", {
          ...fields,
          testOnly: true,
          failpoint: name,
          exitCode,
        });
      } finally {
        process.exit(exitCode);
      }
    },
  };
}
