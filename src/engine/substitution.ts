/**
 * Substitution narrative (Handover §7.2, golden case in Technical Requirements
 * §3, minimum test bar).
 *
 * Substitution is NARRATIVE, not a fifth additive ₦ component. Rev. 1 proposed a
 * `substitution_effect` figure computed as net spend change within a
 * `substitute_group` — that double-counts (fresh tomato and paste already each
 * contribute to PRICE and WHAT_YOU_BOUGHT) and silently assumes a
 * cooking-equivalence factor nobody has calibrated.
 *
 * What we do instead: when a commodity is `stopped` and another commodity in the
 * SAME substitute group is `new` in the same period, pair them so the UI can
 * render "you switched from X to Y" as ONE sentence rather than a
 * quantity-drop line plus an unrelated new-item line.
 *
 * This module is pure and changes nothing about the decomposition itself.
 */

import type { DecompositionClassification } from './types';

export interface SubstituteGroup {
  groupId: string;
  /** Commodity ids that are cooking-substitutes for one another. */
  commodityIds: readonly string[];
}

export interface SubstitutionNarrative {
  groupId: string;
  /** Commodity the user stopped buying this period. */
  fromCommodityId: string;
  /** Commodity in the same group the user started buying this period. */
  toCommodityId: string;
}

/**
 * Pair stopped ↔ new commodities within each substitute group. Deterministic:
 * ids are sorted, then paired index-wise up to the shorter side. Any unpaired
 * stopped/new commodities remain in their own classification bucket and render
 * as ordinary stopped / new lines.
 */
export function detectSubstitutions(
  classification: DecompositionClassification,
  groups: readonly SubstituteGroup[],
): SubstitutionNarrative[] {
  const groupOf = new Map<string, string>();
  for (const group of groups) {
    for (const commodityId of group.commodityIds) {
      groupOf.set(commodityId, group.groupId);
    }
  }

  const stoppedByGroup = bucketByGroup(classification.stoppedCommodityIds, groupOf);
  const newByGroup = bucketByGroup(classification.newCommodityIds, groupOf);

  const narratives: SubstitutionNarrative[] = [];
  for (const [groupId, stopped] of stoppedByGroup) {
    const started = newByGroup.get(groupId);
    if (!started || started.length === 0) continue;
    stopped.sort();
    started.sort();
    const pairs = Math.min(stopped.length, started.length);
    for (let i = 0; i < pairs; i++) {
      narratives.push({
        groupId,
        fromCommodityId: stopped[i]!,
        toCommodityId: started[i]!,
      });
    }
  }
  narratives.sort((a, b) => a.groupId.localeCompare(b.groupId) || a.fromCommodityId.localeCompare(b.fromCommodityId));
  return narratives;
}

function bucketByGroup(
  commodityIds: readonly string[],
  groupOf: Map<string, string>,
): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const commodityId of commodityIds) {
    const groupId = groupOf.get(commodityId);
    if (groupId === undefined) continue;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(commodityId);
    else buckets.set(groupId, [commodityId]);
  }
  return buckets;
}
