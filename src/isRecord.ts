/** A non-null, non-array object: narrows parsed JSON before reading its keys. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
