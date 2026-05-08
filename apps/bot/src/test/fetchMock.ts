import type { Mock } from 'vitest';

/** TS lib `fetch` includes `preconnect`; attach no-op so `vi.fn` mocks type-check. */
export function asFetch(mock: Mock): typeof fetch {
  return Object.assign(mock, {
    preconnect: () => undefined,
  }) as unknown as typeof fetch;
}
