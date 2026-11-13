// Server-only HTTP helpers shared by the prepare and authorize handlers (Fetch API Request/Response only).

/** The most a handler reads of a request body. */
export const MAX_BODY_BYTES = 16 * 1024;

export function json(
  status: number,
  body: unknown,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

// A JSON content type makes a cross-origin POST preflight, so a form or text/plain post from another site never runs.
export const isJsonRequest = (req: Request): boolean =>
  req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ===
  "application/json";

/** The body's text, or null past `max` bytes: the stream is cancelled there, never read to its end. */
export async function readBody(
  req: Request,
  max: number,
): Promise<string | null> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Not awaited: a cloned body's cancel settles only once the other branch is cancelled too.
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
