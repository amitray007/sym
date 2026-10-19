# 007. Learning in three layers, code through worker PRs

Status: accepted
Date: 2026-10-19

## Context

Sym should improve from feedback. Self-written changes can drift or carry injected text. Eve's remote self-modification extension needs microsandbox on the server.

## Decision

Layer 1, memory facts, applies at once. Layer 2, playbooks and rules, loads through `defineDynamic` only after an owner approves it. Layer 3, code, is a worker thread in Sym's repository that opens a draft PR, which a person merges.

## Consequences

Nothing Sym learns is opaque: it is text, rows, or code under review. No microsandbox is needed. See `docs/learning.md`.
