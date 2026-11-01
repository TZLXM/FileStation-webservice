import { closeResourceAfterFailure } from './application-cleanup';

it('bounds a hung close and preserves the startup failure', async () => {
  jest.useFakeTimers();
  try {
    const original = new Error('startup failure');
    const result = closeResourceAfterFailure({ close: () => new Promise<void>(() => {}) }, original);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeInstanceOf(Error);
    expect(original.cause).toMatchObject({ message: expect.stringMatching(/timed out/i) });
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
