// src/browser.ts
export type ProbeEvent<L extends string = string, V = unknown> = {
    label: L;
    value: V;
  };
  
  // Browser stub for probeEmit – intentionally a no-op.
  export const probeEmit: <L extends string, V>(label: L, value: V) => void = () => {
    /* no-op */
  };
  
  // Browser stub for getProbe – throws if used in the browser.
  export function getProbe(): never {
    throw new Error('vitest-probe: getProbe() is Node‑only and cannot be used in the browser.');
  }
  