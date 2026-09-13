import { describe, expect, it, vi } from "vitest";

import { createTestFailpointController, TEST_FAILPOINTS } from "./failpoints.js";

describe("test-only failpoint controls", () => {
  it("is inert without an explicit failpoint", () => {
    expect(createTestFailpointController({ NODE_ENV: "test", WI_ALLOW_TEST_FAILPOINTS: "1" }))
      .toBeNull();
  });

  it.each([
    { WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
    { NODE_ENV: "test", WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
    { WI_ALLOW_TEST_FAILPOINTS: "1", WI_TEST_FAILPOINT: TEST_FAILPOINTS[0] },
  ])("rejects activation unless both test gates are present", (environment) => {
    expect(() => createTestFailpointController(environment)).toThrow(
      "requires NODE_ENV=test and WI_ALLOW_TEST_FAILPOINTS=1",
    );
  });

  it("rejects names outside the closed inventory", () => {
    expect(() =>
      createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "browser_supplied_name",
      }),
    ).toThrow("Unknown test failpoint");
  });

  it("rejects selector fields without a configured failpoint", () => {
    expect(() =>
      createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
      }),
    ).toThrow("selector requires WI_TEST_FAILPOINT");
  });

  it.each([
    {
      name: "after_command_event_insert_before_commit",
      selector: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
    },
    {
      name: "after_event_commit_before_publish",
      selector: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
    },
    {
      name: "after_tool_started_commit",
      selector: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
    },
    {
      name: "after_session_create_before_catalog_ready",
      selector: { WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target" },
    },
    {
      name: "after_catalog_replacement_before_repair",
      selector: { WI_TEST_FAILPOINT_CATALOG_GLOBAL: "1" },
    },
  ] as const)("accepts the required selector for $name", ({ name, selector }) => {
    const controller = createTestFailpointController({
      NODE_ENV: "test",
      WI_ALLOW_TEST_FAILPOINTS: "1",
      WI_TEST_FAILPOINT: name,
      ...selector,
    });
    expect(controller).toMatchObject({ name });
  });

  it.each([
    {
      name: "after_command_commit_before_ack",
      selector: { WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target" },
    },
    {
      name: "after_tool_started_commit",
      selector: { WI_TEST_FAILPOINT_SESSION_ID: "ses_target" },
    },
    {
      name: "after_event_commit_before_publish",
      selector: { WI_TEST_FAILPOINT_SESSION_ID: "ses_target" },
    },
    {
      name: "after_catalog_replacement_before_repair",
      selector: { WI_TEST_FAILPOINT_SESSION_ID: "ses_target" },
    },
    {
      name: "after_catalog_session_repair",
      selector: { WI_TEST_FAILPOINT_CATALOG_GLOBAL: "1" },
    },
  ] as const)("rejects an impossible selector for $name", ({ name, selector }) => {
    expect(() =>
      createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: name,
        ...selector,
      }),
    ).toThrow("Invalid test failpoint selector");
  });

  it.each([
    { WI_TEST_FAILPOINT_SESSION_ID: "invalid" },
    { WI_TEST_FAILPOINT_COMMAND_ID: "invalid" },
    { WI_TEST_FAILPOINT_RUN_ID: "invalid" },
    { WI_TEST_FAILPOINT_CATALOG_GLOBAL: "true" },
  ])("rejects a malformed selector identity", (selector) => {
    expect(() =>
      createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: "after_event_commit_before_publish",
        ...selector,
      }),
    ).toThrow("Invalid test failpoint selector");
  });

  it("assigns a configured run ID only once to the target session", () => {
    const controller = createTestFailpointController({
      NODE_ENV: "test",
      WI_ALLOW_TEST_FAILPOINTS: "1",
      WI_TEST_FAILPOINT: "after_tool_started_commit",
      WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
      WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      WI_TEST_FAILPOINT_RUN_ID: "run_target",
    });
    expect(controller?.takeRunIdForCommand("ses_other", "cmd_target")).toBeNull();
    expect(controller?.takeRunIdForCommand("ses_target", "cmd_other")).toBeNull();
    expect(controller?.takeRunIdForCommand("ses_target", "cmd_target")).toBe(
      "run_target",
    );
    expect(controller?.takeRunIdForCommand("ses_target", "cmd_target")).toBeNull();
  });

  it("matches fields before consuming the one-shot", () => {
    const controller = createTestFailpointController({
      NODE_ENV: "test",
      WI_ALLOW_TEST_FAILPOINTS: "1",
      WI_TEST_FAILPOINT: "after_command_commit_before_ack",
      WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
      WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`);
    });
    try {
      expect(
        controller?.matches("after_command_commit_before_ack", {
          sessionId: "ses_other",
          commandId: "cmd_target",
        }),
      ).toBe(false);
      expect(() =>
        controller?.hit("after_command_commit_before_ack", {
          sessionId: "ses_other",
          commandId: "cmd_target",
        }),
      ).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
      expect(() =>
        controller?.hit("after_command_commit_before_ack", {
          sessionId: "ses_target",
          commandId: "cmd_target",
        }),
      ).toThrow("exit:91");
      expect(exit).toHaveBeenCalledTimes(1);
      expect(() =>
        controller?.hit("after_command_commit_before_ack", {
          sessionId: "ses_target",
          commandId: "cmd_target",
        }),
      ).not.toThrow();
      expect(exit).toHaveBeenCalledTimes(1);
    } finally {
      exit.mockRestore();
    }
  });

  it("assigns stable deterministic exit codes", () => {
    const selectors = {
      after_command_event_insert_before_commit: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_command_commit_before_ack: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_event_commit_before_publish: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_tool_requested_commit: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_tool_started_commit: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_tool_result_commit_before_provider_continue: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_provider_text_commit: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_run_terminal_commit: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
        WI_TEST_FAILPOINT_RUN_ID: "run_target",
      },
      after_session_create_before_catalog_ready: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_catalog_session_repair: {
        WI_TEST_FAILPOINT_SESSION_ID: "ses_target",
      },
      after_catalog_replacement_before_repair: {
        WI_TEST_FAILPOINT_CATALOG_GLOBAL: "1",
      },
      after_provider_lifecycle_prepare: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_file_effect: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_file_observed: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_lifecycle_terminal_before_ack: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_stage_cleanup: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_stage_temp_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_credential_temp_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_stage_commit: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      before_provider_provisioning_ref_return: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_recovery_admission: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_recovery_prepare: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_environment_run_acceptance_before_request: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_stage_delete_before_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_credential_rename_before_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_credential_unlink_before_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
      after_provider_stage_rename_before_flush: {
        WI_TEST_FAILPOINT_COMMAND_ID: "cmd_target",
      },
    } as const;
    for (const [index, name] of TEST_FAILPOINTS.entries()) {
      const controller = createTestFailpointController({
        NODE_ENV: "test",
        WI_ALLOW_TEST_FAILPOINTS: "1",
        WI_TEST_FAILPOINT: name,
        ...selectors[name],
      });
      expect(controller).toMatchObject({ name, exitCode: 90 + index });
      expect(controller?.is(name)).toBe(true);
    }
  });
});
