import type { Logger } from "../logging/logger.js";
import { type CommandAcceptedMessage, type CommandMessage } from "@wi/protocol";
import type {
  CommittedEventHub,
  ResolvedSessionProviderDefaultCommand,
  SessionActorRegistry,
} from "@wi/harness-core";
import type { SessionStoreManager } from "@wi/storage";

export class CommandRoutingError extends Error {
  constructor(
    readonly code: string,
    readonly safeMessage: string,
    readonly diagnosticId?: string,
  ) {
    super(safeMessage);
    this.name = "CommandRoutingError";
  }
}

export type ProviderConnectionCommand = Extract<
  CommandMessage,
  { readonly method:
      | "providerConnection.file.create"
      | "providerConnection.environment.create"
      | "providerConnection.environment.revalidate"
      | "providerConnection.file.replace"
      | "providerConnection.rename"
      | "providerConnection.disable"
      | "providerConnection.logout"
      | "providerConnection.delete"
      | "providerConnection.recover" }
>;

export interface CommandRouteOptions {
  /** Internal backend capability proving recovery ingress was reserved before queueing. */
  readonly recoveryIngressRegistration?: unknown;
}

export interface ProviderConnectionCommandHandler {
  route(
    command: ProviderConnectionCommand,
    options?: CommandRouteOptions,
  ): Promise<CommandAcceptedMessage>;
  resolveSessionDefault(
    command: Extract<CommandMessage, { readonly method: "session.providerDefault.set" }>,
  ): Promise<ResolvedSessionProviderDefaultCommand["params"]["default"]>;
}

export class CommandRouter {
  private accepting = true;

  constructor(
    private readonly storage: SessionStoreManager,
    private readonly actors: SessionActorRegistry,
    private readonly eventHub: CommittedEventHub,
    private readonly logger: Logger,
    private readonly diagnosticId: () => string,
    private readonly providerCommands?: ProviderConnectionCommandHandler,
  ) {}

  stopAccepting(): void {
    this.accepting = false;
  }

  async route(
    command: CommandMessage,
    clientId: string,
    options: CommandRouteOptions = {},
  ): Promise<CommandAcceptedMessage> {
    if (!this.accepting) {
      throw new CommandRoutingError("storage.worker_failed", "The server is shutting down");
    }
    if (command.method === "session.create") return this.createSession(command);
    if (
      command.method === "providerConnection.file.create" ||
      command.method === "providerConnection.environment.create" ||
      command.method === "providerConnection.environment.revalidate" ||
      command.method === "providerConnection.file.replace" ||
      command.method === "providerConnection.rename" ||
      command.method === "providerConnection.disable" ||
      command.method === "providerConnection.logout" ||
      command.method === "providerConnection.delete" ||
      command.method === "providerConnection.recover"
    ) {
      if (this.providerCommands === undefined) {
        throw new CommandRoutingError(
          "provider.not_implemented",
          "Provider connection management is unavailable",
        );
      }
      return this.providerCommands.route(command, options);
    }

    const summary = await this.storage.catalog.getSession(command.sessionId);
    if (summary === null || summary.status === "missing") {
      throw new CommandRoutingError("session.not_found", "Session was not found");
    }
    if (summary.status !== "ready") {
      throw new CommandRoutingError("storage.corrupt", "Session is unavailable");
    }

    const lease = await this.actors.acquire(command.sessionId);
    try {
      switch (command.method) {
        case "message.submit": {
          const result = await lease.actor.submitMessage(command);
          return this.accepted(command, result.acceptance);
        }
        case "run.cancel": {
          const result = await lease.actor.cancelRun(command);
          if (result.acceptance === undefined) {
            throw new CommandRoutingError(
              "session.invalid_transition",
              "Cancellation was not durably accepted",
            );
          }
          return this.accepted(command, result.acceptance);
        }
        case "approval.resolve": {
          const acceptance = await lease.actor.resolveApproval(command, clientId);
          return this.accepted(command, acceptance);
        }
        case "input.respond": {
          const acceptance = await lease.actor.respondToInput(command);
          return this.accepted(command, acceptance);
        }
        case "session.providerDefault.set": {
          if (this.providerCommands === undefined) {
            throw new CommandRoutingError(
              "provider.not_implemented",
              "Provider connection selection is unavailable",
            );
          }
          const acceptance = await lease.actor.setProviderDefault(
            command,
            () => this.providerCommands!.resolveSessionDefault(command),
          );
          return this.accepted(command, acceptance);
        }
      }
    } finally {
      lease.release();
    }
  }

  private async createSession(
    command: Extract<CommandMessage, { readonly method: "session.create" }>,
  ): Promise<CommandAcceptedMessage> {
    const created = await this.storage.createSession(command);
    if (created.outcome === "failed") {
      throw new CommandRoutingError(
        created.command.failureCode ?? "storage.corrupt",
        created.command.failureMessage ?? "Session creation failed",
        created.command.diagnosticId ?? undefined,
      );
    }
    for (const event of created.events) {
      try {
        this.eventHub.publishCommitted(event);
      } catch (error) {
        const diagnosticId = this.diagnosticId();
        this.logger.error("session_create_publication_failed", error, {
          diagnosticId,
          commandId: command.commandId,
          sessionId: created.session.sessionId,
        });
      }
    }
    return {
      v: 1,
      kind: "command.accepted",
      commandId: command.commandId,
      sessionId: created.session.sessionId,
      acceptedSequence: created.events.at(-1)?.sequence ?? 1,
      result: created.command.result ?? { sessionId: created.session.sessionId },
      duplicate: created.duplicate,
    };
  }

  private accepted(
    command: Extract<CommandMessage, { readonly sessionId: string }>,
    acceptance: {
      readonly acceptedSequence: number | null;
      readonly runId: string | null;
      readonly result: CommandAcceptedMessage["result"];
      readonly duplicate: boolean;
    },
  ): CommandAcceptedMessage {
    return {
      v: 1,
      kind: "command.accepted",
      commandId: command.commandId,
      sessionId: command.sessionId,
      ...(acceptance.acceptedSequence === null
        ? {}
        : { acceptedSequence: acceptance.acceptedSequence }),
      ...(acceptance.runId === null ? {} : { runId: acceptance.runId }),
      result: acceptance.result,
      duplicate: acceptance.duplicate,
    };
  }
}
