/**
 * The provider abstraction layer.
 *
 * Everything above this directory calls these six capabilities and never
 * touches a provider URL, wire format or API key directly:
 *
 *   streamChat / completeChat / completeJson   text generation
 *   embed                                     vector embeddings
 *   transcribe                                speech to text
 *   generateImage                             text to image
 *   speak                                     text to speech
 *   rerank                                    retrieval reranking
 *
 * Model selection goes through `resolveModelForTask`, catalogue discovery
 * through `refreshCatalogue`, and every failure arrives as a `ProviderError`
 * with a `kind` and an actionable `hint`.
 */

export * from './types';
export {
  buildModelRef,
  connectedProviders,
  invalidateCredentialCache,
  loadCredentials,
  parseModelRef,
} from './credentials';
export { resolveTransport, type Transport } from './endpoints';
export { estimateTokens } from './http';
export { completeChat, completeJson, streamChat } from './chat';
export { embed, generateImage, rerank, speak, transcribe } from './capabilities';
export {
  listCatalogue,
  refreshCatalogue,
  seedEntriesFor,
  SEED_MODELS,
  type CatalogueEntry,
  type RefreshOutcome,
} from './catalogue';
export {
  contextWindowFor,
  getUserSettings,
  resolveModelForTask,
  supportsVision,
  updateUserSettings,
  type TaskSlot,
} from './defaults';
export { logUsage, usageByDay, type UsageBucket, type UsageEntry } from './usage';
