export { CatalogClient } from "./catalog/client.js";
export type {
  CatalogClientOptions,
  CatalogStartupState,
  CompleteGlobalCommandInput,
  ReconcileSessionInput,
  RecoveryCandidateCursor,
  RecoveryCandidatePage,
  ReserveGlobalCommandInput,
} from "./catalog/client.js";
export type {
  CatalogProjectionUpdateResult,
  CatalogRepairReason,
  FailGlobalCommandInput,
  MarkSessionStatusInput,
  ReconcileSessionResult,
  SetGlobalCommandQuarantineInput,
} from "./catalog/repository.js";
export {
  StorageError,
  WORKER_RPC_PAYLOAD_BOUNDS,
} from "./common/worker-rpc.js";
export type {
  WorkerRequestOptions,
  WorkerRequestOutcome,
} from "./common/worker-rpc.js";
export { CatalogReconciler } from "./manager/catalog-reconciler.js";
export {
  isValidSessionPrefix,
  resolveStoragePath,
  sessionDatabaseRelativePath,
  sessionPrefixFromId,
  stableSessionWorkerIndex,
} from "./manager/paths.js";
export {
  SessionStoreManager,
  validateSessionStoreManagerOptions,
} from "./manager/session-store-manager.js";
export type {
  CatalogObservationFailure,
  CatalogRepairReport,
  CreateSessionStorageResult,
  DrainCatalogObservationsOptions,
  ManagedAcceptCommandResult,
  ManagedAppendResult,
  SessionStoreManagerOptions,
  StorageIdGenerators,
  StorageTestFailpoints,
} from "./manager/session-store-manager.js";
export type { SessionClient } from "./session/client.js";
export type {
  DiscoveredSession,
  InitializeSessionInput,
  SessionDiscoveryInventory,
  SessionDiscoveryPage,
  SessionSqlitePragmas,
  SessionWorkerBarrier,
  SessionWorkerPoolOptions,
  SessionWorkerStats,
} from "./session/worker-pool.js";
export {
  CATALOG_SCHEMA_VERSION,
  SESSION_EVENT_PAGE_BOUNDS,
  SESSION_FORMAT_VERSION,
  SESSION_SCHEMA_VERSION,
  SessionEventPageInputSchema,
  SessionEventPageSchema,
  SessionStatusSchema,
} from "./types.js";
export type {
  AcceptCommandInput,
  AcceptedCommandResult,
  AppendTransactionInput,
  AppendTransactionInspection,
  AppendTransactionResult,
  BoundedProviderRequestData,
  BoundedProviderRequestDataInput,
  GlobalCommandRecord,
  GlobalCommandReservation,
  InputRecord,
  NewSessionEvent,
  PendingApprovalRecord,
  PendingInputRecord,
  ProjectRecord,
  ProviderConnectionRecord,
  ProviderLifecycleOperationRecord,
  ProviderStepRecord,
  ProjectionMutation,
  RunMessageRecord,
  RunProviderMatch,
  RunRecord,
  ToolExecutionRecord,
  SessionCatalogObservation,
  SessionCatalogProjection,
  CreationProvenance,
  SessionCreationRequest,
  SessionEventPage,
  SessionEventPageInput,
  SessionManifest,
  SessionRecoveryResult,
  SessionStatus,
  SessionSummary,
} from "./types.js";
