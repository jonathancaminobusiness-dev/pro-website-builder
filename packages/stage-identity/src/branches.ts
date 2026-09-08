import { Applier, PatchGate, type VersionRecord, type VersionStore } from '@pwb/orchestrator';

/**
 * Three directors patch `/identity` from the same base version at the same
 * time. That is not concurrent writing: each answer opens its own branch and
 * the branches are never merged, so the captain compares whole documents rather
 * than a blend nobody proposed.
 *
 * The mechanism is one `PatchGate` per branch over one shared `VersionStore`.
 * The gate's overlap rule exists to stop two patches from silently combining on
 * one lineage, and it still does inside a branch; across branches there is
 * nothing to combine. Versions stay content-addressed, so the three siblings
 * share a parent and differ by hash, and only an `Applier` ever writes one.
 */
export class CandidateBranchStore {
  private readonly appliers = new Map<string, Applier>();

  constructor(private readonly store: VersionStore) {}

  applierFor(directionId: string): Applier {
    const existing = this.appliers.get(directionId);
    if (existing) return existing;
    const applier = new Applier(this.store, new PatchGate());
    this.appliers.set(directionId, applier);
    return applier;
  }

  version(versionId: string): VersionRecord {
    const record = this.store.get(versionId);
    if (!record) throw new Error(`Version ${versionId} is not in the store.`);
    return record;
  }
}

export function siblingsOf(store: VersionStore, versionIds: string[]): { parentId: string | undefined; siblings: VersionRecord[] } {
  const siblings = versionIds.map((id) => {
    const record = store.get(id);
    if (!record) throw new Error(`Version ${id} is not in the store.`);
    return record;
  });
  const parents = new Set(siblings.map((record) => record.parentId));
  if (parents.size > 1) throw new Error(`Candidate versions ${versionIds.join(', ')} do not share one parent, so they are not alternative branches.`);
  return { parentId: [...parents][0], siblings };
}
