/**
 * Release-scoring kernel — rejection rules, size/codec heuristics, and the
 * shared score+sort pipeline used by every download path (auto-grab, manual
 * grab, RSS). Domain-agnostic on which fetcher produced the candidates.
 */
export * from './release-rejection.helper';
