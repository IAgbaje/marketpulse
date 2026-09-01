import { describe, it, expect, vi } from 'vitest';
import {
  decideSecondDeviceSignIn,
  resolveSecondDeviceSignIn,
  hasLocalData,
  mergeIdempotencyKey,
  type MergeApi,
  type SecondDeviceContext,
} from '@/src/lib/auth/deviceMerge';

const noData = { tripCount: 0, purchaseLineCount: 0, budgetCount: 0, watchlistCount: 0 };
const someData = { tripCount: 4, purchaseLineCount: 31, budgetCount: 1, watchlistCount: 2 };

const ctx = (over: Partial<SecondDeviceContext>): SecondDeviceContext => ({
  priorAnonSession: { userId: 'B', refreshToken: 'rt-B' },
  signedInUserId: 'A',
  localData: someData,
  ...over,
});

describe('decideSecondDeviceSignIn', () => {
  it('nothing to do when this device never had an anonymous session', () => {
    expect(decideSecondDeviceSignIn(ctx({ priorAnonSession: null }))).toEqual({
      outcome: 'nothing_to_do',
      reason: 'no_prior_session',
    });
  });

  it('nothing to do on the same-device anonymous → permanent upgrade (uid preserved)', () => {
    expect(
      decideSecondDeviceSignIn(
        ctx({ priorAnonSession: { userId: 'A', refreshToken: 'rt-A' }, signedInUserId: 'A' }),
      ),
    ).toEqual({ outcome: 'nothing_to_do', reason: 'same_user' });
  });

  it('nothing to do when the prior anonymous session synced nothing locally', () => {
    expect(decideSecondDeviceSignIn(ctx({ localData: noData }))).toEqual({
      outcome: 'nothing_to_do',
      reason: 'no_local_data',
    });
  });

  it('forces an explicit choice when a different anon uid has local data — the TR §2.3 case', () => {
    const decision = decideSecondDeviceSignIn(ctx({}));
    expect(decision).toEqual({
      outcome: 'must_choose',
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    });
  });

  it('any non-zero local table triggers the choice', () => {
    expect(hasLocalData({ ...noData, watchlistCount: 1 })).toBe(true);
    expect(hasLocalData(noData)).toBe(false);
  });
});

describe('resolveSecondDeviceSignIn', () => {
  const api: MergeApi = {
    merge: vi.fn(async () => ({
      kind: 'merge' as const,
      tripsMoved: 4,
      purchaseLinesMoved: 31,
      budgetsMoved: 1,
      watchlistMoved: 2,
    })),
    keepSeparate: vi.fn(async () => ({
      kind: 'keep_separate' as const,
      tripsMoved: 0,
      purchaseLinesMoved: 0,
      budgetsMoved: 0,
      watchlistMoved: 0,
    })),
  };

  it('THROWS rather than proceed when a merge is pending and no choice was made', async () => {
    const decision = decideSecondDeviceSignIn(ctx({}));
    await expect(resolveSecondDeviceSignIn(decision, null, api)).rejects.toThrow(
      /silent data loss is not a permitted outcome/,
    );
  });

  it('merge path forwards the captured refresh token and a deterministic idempotency key', async () => {
    const decision = decideSecondDeviceSignIn(ctx({}));
    const result = await resolveSecondDeviceSignIn(decision, 'merge', api);
    expect(api.merge).toHaveBeenCalledWith({
      sourceRefreshToken: 'rt-B',
      idempotencyKey: mergeIdempotencyKey('B', 'A'),
    });
    expect(result?.tripsMoved).toBe(4);
  });

  it('keep-separate path records the audit row without moving data', async () => {
    const decision = decideSecondDeviceSignIn(ctx({}));
    const result = await resolveSecondDeviceSignIn(decision, 'keep_separate', api);
    expect(api.keepSeparate).toHaveBeenCalledWith({
      sourceUserId: 'B',
      idempotencyKey: mergeIdempotencyKey('B', 'A'),
    });
    expect(result?.kind).toBe('keep_separate');
  });

  it('no-op when there is nothing to resolve', async () => {
    const decision = decideSecondDeviceSignIn(ctx({ priorAnonSession: null }));
    expect(await resolveSecondDeviceSignIn(decision, null, api)).toBeNull();
  });

  it('idempotency key is stable across retries of the same pair', () => {
    expect(mergeIdempotencyKey('B', 'A')).toBe(mergeIdempotencyKey('B', 'A'));
    expect(mergeIdempotencyKey('B', 'A')).not.toBe(mergeIdempotencyKey('C', 'A'));
  });
});
