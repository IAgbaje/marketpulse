import { describe, it, expect, vi, beforeEach } from 'vitest';

const signInWithOtp = vi.fn();
const getSession = vi.fn();
const verifyOtp = vi.fn();
const invoke = vi.fn();

vi.mock('@/src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: (...args: unknown[]) => signInWithOtp(...args),
      getSession: (...args: unknown[]) => getSession(...args),
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
    },
    functions: {
      invoke: (...args: unknown[]) => invoke(...args),
    },
  },
}));

const probeLocalData = vi.fn();
vi.mock('@/src/lib/auth/localDataProbe', () => ({
  probeLocalData: (...args: unknown[]) => probeLocalData(...args),
}));

import { completeUpgrade, requestUpgradeCode, verifyUpgradeCode } from '@/src/lib/auth/upgrade';

const noData = { tripCount: 0, purchaseLineCount: 0, budgetCount: 0, watchlistCount: 0 };
const someData = { tripCount: 3, purchaseLineCount: 12, budgetCount: 0, watchlistCount: 0 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requestUpgradeCode', () => {
  it('requests an OTP for the given email, allowing new-user creation', async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    await requestUpgradeCode('a@b.com');
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.com',
      options: { shouldCreateUser: true },
    });
  });

  it('throws on failure', async () => {
    signInWithOtp.mockResolvedValue({ error: new Error('rate limited') });
    await expect(requestUpgradeCode('a@b.com')).rejects.toThrow('rate limited');
  });
});

describe('verifyUpgradeCode', () => {
  it('captures the prior anonymous session BEFORE verifying, and probes its local data', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: 'B', is_anonymous: true }, refresh_token: 'rt-B' } },
    });
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null });
    probeLocalData.mockResolvedValue(someData);

    const decision = await verifyUpgradeCode('a@b.com', '123456');

    expect(getSession).toHaveBeenCalled();
    expect(probeLocalData).toHaveBeenCalledWith('B');
    expect(decision).toEqual({
      outcome: 'must_choose',
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    });
  });

  it('nothing_to_do when the device had no prior anonymous session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null });

    const decision = await verifyUpgradeCode('a@b.com', '123456');

    expect(probeLocalData).not.toHaveBeenCalled();
    expect(decision).toEqual({ outcome: 'nothing_to_do', reason: 'no_prior_session' });
  });

  it('nothing_to_do when the prior session had no local data', async () => {
    getSession.mockResolvedValue({
      data: { session: { user: { id: 'B', is_anonymous: true }, refresh_token: 'rt-B' } },
    });
    verifyOtp.mockResolvedValue({ data: { session: { user: { id: 'A' } } }, error: null });
    probeLocalData.mockResolvedValue(noData);

    const decision = await verifyUpgradeCode('a@b.com', '123456');
    expect(decision).toEqual({ outcome: 'nothing_to_do', reason: 'no_local_data' });
  });

  it('throws on a verifyOtp error, and does not swallow it', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    verifyOtp.mockResolvedValue({ data: { session: null }, error: new Error('invalid code') });

    await expect(verifyUpgradeCode('a@b.com', 'wrong')).rejects.toThrow('invalid code');
  });

  it('throws if verification reports success but returns no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    verifyOtp.mockResolvedValue({ data: { session: null }, error: null });

    await expect(verifyUpgradeCode('a@b.com', '123456')).rejects.toThrow('no session');
  });
});

describe('completeUpgrade', () => {
  it('merge choice invokes the Edge Function with the merge body shape', async () => {
    invoke.mockResolvedValue({
      data: { kind: 'merge', tripsMoved: 3, purchaseLinesMoved: 12, budgetsMoved: 0, watchlistMoved: 0 },
      error: null,
    });

    const decision = {
      outcome: 'must_choose' as const,
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    };

    const result = await completeUpgrade(decision, 'merge');

    expect(invoke).toHaveBeenCalledWith('merge-anonymous-data', {
      body: { choice: 'merge', sourceRefreshToken: 'rt-B', idempotencyKey: 'merge:B->A' },
    });
    expect(result?.tripsMoved).toBe(3);
  });

  it('keep_separate choice invokes the Edge Function with the keep_separate body shape', async () => {
    invoke.mockResolvedValue({
      data: { kind: 'keep_separate', tripsMoved: 0, purchaseLinesMoved: 0, budgetsMoved: 0, watchlistMoved: 0 },
      error: null,
    });

    const decision = {
      outcome: 'must_choose' as const,
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    };

    await completeUpgrade(decision, 'keep_separate');

    expect(invoke).toHaveBeenCalledWith('merge-anonymous-data', {
      body: { choice: 'keep_separate', sourceUserId: 'B', idempotencyKey: 'merge:B->A' },
    });
  });

  it('throws rather than call the Edge Function when a decision is pending and no choice was made', async () => {
    const decision = {
      outcome: 'must_choose' as const,
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    };
    await expect(completeUpgrade(decision, null)).rejects.toThrow(/silent data loss/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('surfaces an Edge Function error rather than swallowing it', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('merge_failed') });
    const decision = {
      outcome: 'must_choose' as const,
      source: { userId: 'B', refreshToken: 'rt-B' },
      target: 'A',
      pending: someData,
    };
    await expect(completeUpgrade(decision, 'merge')).rejects.toThrow('merge_failed');
  });
});
