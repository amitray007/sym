import type { MemoryId, SlackChannelId, SlackThreadTs, SlackUserId, WorkspaceId } from './ids.js';

/** The five memory scopes. Mirrors `memory_entries.scope`. */
export type MemoryScope = 'workspace' | 'channel' | 'thread' | 'dm' | 'custom_relational';

export type MemoryStatus = 'active' | 'superseded' | 'forgotten';

export type SubjectConsentStatus = 'pending' | 'accepted' | 'rejected' | 'not_applicable';

/** Change-policy classifier output (S7a), evaluated against a promptfoo set. */
export type ChangePolicyDecision = 'add' | 'update' | 'supersede' | 'ignore';

/** A memory row. Mirrors `memory_entries`. */
export interface MemoryEntry {
  id: MemoryId;
  workspaceId: WorkspaceId;
  scope: MemoryScope;
  /** NULL for workspace; channel/thread/dm key; `actor:subject` for relational. */
  scopeKey?: string;
  actorId: SlackUserId;
  subjectId?: SlackUserId;
  content: string;
  status: MemoryStatus;
  supersedesId?: MemoryId;
  subjectConsentStatus: SubjectConsentStatus;
  createdAt: Date;
  updatedAt: Date;
  lastReferencedAt?: Date;
}

/**
 * A recall request. The gate resolves which scopes the requester may see and
 * returns only permitted entries — enforced in `@sym/memory` (S7a), never in
 * the prompt.
 */
export interface RetrievalRequest {
  workspaceId: WorkspaceId;
  requester: SlackUserId;
  /** Limit to these scopes; omit for all the requester is entitled to. */
  scopes?: MemoryScope[];
  channelId?: SlackChannelId;
  threadTs?: SlackThreadTs;
}

/** The retrieval gate — the only sanctioned read path for memory. */
export interface RetrievalGate {
  getMemories(req: RetrievalRequest): Promise<MemoryEntry[]>;
}
