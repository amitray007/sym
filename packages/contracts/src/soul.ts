/**
 * Soul cascade layers. L0 is the built-in global posture (never persisted);
 * L1–L3 are rows in `soul_layers`. More-specific layers override less-specific.
 */
export type SoulLayerKind = 'l0_global' | 'l1_workspace' | 'l2_channel' | 'l3_user';

/** The persisted subset (matches the `soul_layers.layer` enum). */
export type PersistedSoulLayer = Exclude<SoulLayerKind, 'l0_global'>;

export interface SoulLayer {
  kind: SoulLayerKind;
  /** NULL for l0/l1; slack_channel_id for l2; slack_user_id for l3. */
  scopeId?: string;
  contentMd: string;
}

/** The resolved effective soul for a (workspace, channel, user) tuple. */
export interface SoulCascade {
  layers: SoulLayer[];
  effectiveMd: string;
}

export interface ToneRewriteRequest {
  draftMarkdown: string;
  cascade: SoulCascade;
}

/**
 * Output of the tone-rewrite stage. The substance-diff guard sets
 * `accepted: false` and the runtime delivers the original draft when the
 * rewrite changed factual content rather than only tone.
 */
export interface ToneRewriteResult {
  rewrittenMarkdown: string;
  accepted: boolean;
  rejectionReason?: string;
}
