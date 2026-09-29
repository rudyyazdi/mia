import { match, P } from "ts-pattern";
import type { Profile, RuntimeFileReader } from "@mia/agent-adapter";
import { createKernel, type Decide, type FeedLimits, type Machine } from "@mia/kernel";
import { errorMessage, type ClientCommand, type ErrorCode } from "@mia/protocol";
import type { Catalog, NewId, RecordWriter, StoredObject } from "@mia/records";
import { ClientOwnership, recordHeartbeat, type Delivery } from "./client-ownership.ts";
import type { EngineEffect } from "./engine-effects.ts";
import {
  commitEvents,
  committedEvents,
  eventSequence,
  type EngineRecord,
  type EventChange,
} from "./engine-records.ts";
import {
  prepareConversationProvenance,
  type ProvenancePlan,
  type ServerIdentity,
} from "./provenance.ts";

// What D1's `Engine` and D2's `DelegationEngine` share: the command contract the gateway and server see, and the
// plumbing around a conversation's kernel machine that does not depend on its rules.

export interface CommandContext {
  connectionId: string;
  clientId: string;
  commandId: string;
  clientBuild: unknown;
}

export type CommandResult =
  { ok: true; result?: Record<string, unknown> } | { ok: false; code: ErrorCode; message: string };

export const fail = (code: ErrorCode, message: string): CommandResult => ({
  ok: false,
  code,
  message,
});

/** What the gateway and the server need from an engine: D1's and D2's both are one. */
export interface CommandEngine {
  readonly conversation: { readonly id: string } | null;
  handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult>;
  adoptConnection(connectionId: string, clientId: string): boolean;
  onDisconnect(connectionId: string): void;
  attachDelivery(delivery: Delivery): () => void;
  shutdown(turnWait: AbortSignal): Promise<void>;
}

type Payload<Type extends ClientCommand["type"]> = Extract<
  ClientCommand,
  { type: Type }
>["payload"];
type Result = Promise<CommandResult> | CommandResult;

/** The command methods both engines have, one per client command. */
export interface CommandMethods {
  startConversation(ctx: CommandContext): Result;
  submitText(ctx: CommandContext, payload: Payload<"submit_text">): Result;
  approvalDecision(ctx: CommandContext, payload: Payload<"approval_decision">): Result;
  interruptTask(ctx: CommandContext, payload: Payload<"interrupt_task">): Result;
  interruptAll(ctx: CommandContext, payload: Payload<"interrupt_all">): Result;
  diagnosticSnapshot(ctx: CommandContext, payload: Payload<"diagnostic_snapshot">): Result;
  heartbeat(ctx: CommandContext, payload: Payload<"heartbeat">): Result;
}

/**
 * Run `command` with the engine's method for it; once shutdown has begun (`shuttingDown`), every command is refused
 * unrun.
 */
export const routeCommand = async (
  engine: CommandMethods,
  input: { ctx: CommandContext; command: ClientCommand; shuttingDown: boolean },
): Promise<CommandResult> => {
  const { ctx, command } = input;
  if (input.shuttingDown) return fail("invalid_state", "the server is shutting down");
  return match(command)
    .with({ type: "start_conversation" }, () => engine.startConversation(ctx))
    .with({ type: "submit_text" }, (cmd) => engine.submitText(ctx, cmd.payload))
    .with({ type: "approval_decision" }, (cmd) => engine.approvalDecision(ctx, cmd.payload))
    .with({ type: "interrupt_task" }, (cmd) => engine.interruptTask(ctx, cmd.payload))
    .with({ type: "interrupt_all" }, (cmd) => engine.interruptAll(ctx, cmd.payload))
    .with({ type: "diagnostic_snapshot" }, (cmd) => engine.diagnosticSnapshot(ctx, cmd.payload))
    .with({ type: "heartbeat" }, (cmd) => engine.heartbeat(ctx, cmd.payload))
    .exhaustive();
};

/** A heartbeat command: recorded under the active conversation when it names that one (see `recordHeartbeat`). */
export const heartbeatCommand = (
  sources: { writer: RecordWriter; newId: NewId; now: () => Date },
  input: { conversationId: string | null; ctx: CommandContext; payload: Payload<"heartbeat"> },
): CommandResult => {
  const { payload } = input;
  try {
    recordHeartbeat({
      ...sources,
      from: input.ctx,
      conversationId:
        payload.conversation_id !== null && payload.conversation_id === input.conversationId
          ? payload.conversation_id
          : null,
      payload,
    });
    return { ok: true };
  } catch (error) {
    return fail("record_failure", errorMessage(error));
  }
};

/**
 * Why `ctx` may not act on conversation `conversationId` now, or null: there is no conversation, it is another, or
 * another client owns it. A free connection is adopted on the way (see `ClientOwnership.refusal`).
 */
export const guardConversation = (input: {
  conversation: { readonly id: string } | null;
  clients: ClientOwnership;
  ctx: CommandContext;
  conversationId: string;
}): CommandResult | null => {
  const { conversation, ctx, conversationId } = input;
  if (!conversation) return fail("invalid_state", "no conversation; send start_conversation first");
  if (conversation.id !== conversationId)
    return fail("not_found", `conversation ${conversationId} is not active`);
  const refusal = input.clients.refusal(ctx.connectionId, ctx.clientId);
  return refusal === null ? null : fail("busy", refusal);
};

/** Everything a conversation start reads its provenance with (see `prepareConversationProvenance`). */
export interface StartSources {
  profile: Profile;
  readEvidence: RuntimeFileReader;
  identity: ServerIdentity;
  writer: RecordWriter;
}

export const prepareStart = (
  sources: StartSources,
  ctx: CommandContext,
  signal: AbortSignal,
): Promise<ProvenancePlan<StoredObject>> =>
  prepareConversationProvenance({
    profile: sources.profile,
    read: sources.readEvidence,
    identity: sources.identity,
    clientBuild: ctx.clientBuild,
    objects: sources.writer.objects,
    signal,
  });

/**
 * A new conversation's machine, at null until its start is dispatched into it, on a kernel of its own: the kernel
 * commits the records with `commitEvents` in one catalog transaction and reads the clock once per dispatch. A commit
 * that throws keeps the state and performs no effect. After a commit each effect runs on its own: one that throws is
 * logged as a delivery failure, and the records, the state and the remaining effects stand. `perform` is called only
 * from inside a dispatch into the machine returned, with that machine.
 */
export const openConversationMachine = <State, Event, Rejection, Effect>(input: {
  conversationId: string;
  decide: Decide<State | null, Event, Rejection, EngineRecord, Effect>;
  writer: RecordWriter;
  catalog: Catalog;
  now: () => Date;
  log: (message: string) => void;
  limits: FeedLimits;
  perform: (
    effect: Effect,
    committed: {
      machine: Machine<State | null, Event, Rejection, EventChange>;
      changes: readonly EventChange[];
    },
  ) => void;
}): Machine<State | null, Event, Rejection, EventChange> => {
  const kernel = createKernel<EngineRecord, EventChange, Effect>({
    commit: (records) => commitEvents(input.writer, records),
    perform: (effect, changes) => input.perform(effect, { machine, changes }),
    reportEffectFailure: (error) =>
      input.log(`delivery failed after commit; records stand: ${errorMessage(error)}`),
    replay: committedEvents(input.catalog, input.conversationId),
    now: input.now,
    limits: input.limits,
  });
  const machine = kernel.machine(input.decide, null);
  return machine;
};

/** The effects both engines perform alike: activating a started conversation, and delivering to its client. */
export type SharedEffect = Extract<
  EngineEffect,
  { kind: "activate_conversation" | "deliver_event" | "notify_tool_call" }
>;

/** Matches a shared effect's kind in an engine's `perform`, so it hands every shared effect to `performShared`. */
export const SHARED_KINDS = P.union("activate_conversation", "deliver_event", "notify_tool_call");

/**
 * Perform a shared effect of a committed transition. Activation makes the conversation's client and connection the
 * active ones and calls `activate`, which makes the conversation's machine the engine's; a delivery sends a committed
 * event with the sequence the catalog gave it among `changes`, or a tool call's progress notice, which is never
 * recorded and so has no sequence.
 */
export const performShared = (
  effect: SharedEffect,
  input: {
    clients: ClientOwnership;
    activate: () => void;
    conversationId: string;
    changes: readonly EventChange[];
    now: () => Date;
    newId: NewId;
  },
): void => {
  const { conversationId } = input;
  const serverTime = input.now().toISOString();
  match(effect)
    .with({ kind: "activate_conversation" }, ({ origin }) => {
      input.activate();
      input.clients.activate(origin);
    })
    .with({ kind: "deliver_event" }, ({ eventId, event }) =>
      input.clients.deliver(event, {
        id: eventId,
        conversationId,
        sequence: eventSequence(input.changes, eventId),
        serverTime,
      }),
    )
    .with({ kind: "notify_tool_call" }, ({ payload }) =>
      input.clients.deliver(
        { type: "tool_call", payload },
        { id: input.newId("evt"), conversationId, sequence: null, serverTime },
      ),
    )
    .exhaustive();
};

/** A committed transition's context, as an engine performs its effects: the machine, its conversation, the changes. */
export interface Committed<ConversationMachine> {
  machine: ConversationMachine;
  conversationId: string;
  changes: readonly EventChange[];
}

/**
 * What both engines do alike around their conversation's machine: who owns the conversation, delivering its events,
 * routing commands and the shutdown refusal, the conversation guard, heartbeats, and the effects that activate and
 * deliver. Each engine adds its own rules, runtime and commands.
 */
export abstract class ConversationEngine<
  State extends { readonly id: string },
  Event,
  Rejection,
> implements CommandMethods {
  readonly clients = new ClientOwnership();
  /** The active conversation's machine, null before the first start; replaced only through a start's activation. */
  protected machine: Machine<State | null, Event, Rejection, EventChange> | null = null;
  /** Set once by shutdown: from then on every command is refused. */
  protected shuttingDown = false;

  constructor(protected readonly common: { writer: RecordWriter; newId: NewId; now: () => Date }) {}

  /** The active conversation's state as it is now; null before the first start. */
  get conversation(): State | null {
    return this.machine?.state ?? null;
  }

  abstract startConversation(ctx: CommandContext): Result;
  abstract submitText(ctx: CommandContext, payload: Payload<"submit_text">): Result;
  abstract approvalDecision(ctx: CommandContext, payload: Payload<"approval_decision">): Result;
  abstract interruptTask(ctx: CommandContext, payload: Payload<"interrupt_task">): Result;
  abstract interruptAll(ctx: CommandContext, payload: Payload<"interrupt_all">): Result;
  abstract diagnosticSnapshot(ctx: CommandContext, payload: Payload<"diagnostic_snapshot">): Result;

  /** Run one validated client command; once shutdown has begun, every command is refused unrun. */
  handle(ctx: CommandContext, command: ClientCommand): Promise<CommandResult> {
    return routeCommand(this, { ctx, command, shuttingDown: this.shuttingDown });
  }

  heartbeat(ctx: CommandContext, payload: Payload<"heartbeat">): CommandResult {
    return heartbeatCommand(this.common, {
      conversationId: this.conversation?.id ?? null,
      ctx,
      payload,
    });
  }

  /** Attach the function that delivers events to connections (see `ClientOwnership.attach`). */
  attachDelivery(delivery: Delivery): () => void {
    return this.clients.attach(delivery);
  }

  /** A reconnecting client (same client id) may resume ownership when no other connection is active. */
  adoptConnection(connectionId: string, clientId: string): boolean {
    return this.clients.adopt(connectionId, clientId);
  }

  protected guard(ctx: CommandContext, conversationId: string): CommandResult | null {
    return guardConversation({
      conversation: this.conversation,
      clients: this.clients,
      ctx,
      conversationId,
    });
  }

  /** Perform a shared effect of a transition committed by `machine`, conversation `conversationId`'s. */
  protected performShared(
    effect: SharedEffect,
    committed: Committed<Machine<State | null, Event, Rejection, EventChange>>,
  ): void {
    performShared(effect, {
      clients: this.clients,
      activate: () => {
        this.machine = committed.machine;
      },
      conversationId: committed.conversationId,
      changes: committed.changes,
      now: this.common.now,
      newId: this.common.newId,
    });
  }
}
