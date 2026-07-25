/**
 * Single place where the Gemini key is used. Imported by the Vercel function
 * and by the Vite dev middleware so local and deployed behaviour cannot drift.
 *
 * The key is read from the environment and never leaves the server.
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Schema mirrors ORDER_SCHEMA_DOC. Constrained decoding beats prompt-begging. */
const ORDER_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      unit: { type: 'integer' },
      order: {
        type: 'string',
        enum: ['hold', 'advance_to', 'flank', 'suppress', 'retreat', 'regroup'],
      },
      x: { type: 'integer', nullable: true },
      y: { type: 'integer', nullable: true },
      target: { type: 'integer', nullable: true },
      reason: { type: 'string' },
    },
    required: ['unit', 'order', 'reason'],
  },
};

export interface AskResult {
  text: string;
  model: string;
  usage?: unknown;
}

/** Gemini 3.x uses thinkingLevel; 2.x uses thinkingBudget. They are not interchangeable. */
function thinkingConfigFor(model: string, level: 'off' | 'low' | 'default') {
  if (level === 'default') return {};
  // Only the 2.x series takes thinkingBudget. Everything else — 3.x and the
  // moving aliases like gemini-flash-latest — takes thinkingLevel, and sending
  // the wrong one is a hard 400. Default to the 3.x form so an unrecognised
  // model name fails toward the current API rather than the legacy one.
  if (/^gemini-2\./.test(model)) {
    return { thinkingConfig: { thinkingBudget: level === 'off' ? 0 : 512 } };
  }
  return { thinkingConfig: { thinkingLevel: 'low' } };
}

export async function askGemini(
  system: string,
  user: string,
  opts: {
    model?: string;
    structured?: boolean;
    signal?: AbortSignal;
    thinking?: 'off' | 'low' | 'default';
  } = {},
): Promise<AskResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server');

  const model = opts.model || DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 700,
      ...thinkingConfigFor(model, opts.thinking ?? 'off'),
      ...(opts.structured === false
        ? {}
        : { responseMimeType: 'application/json', responseSchema: ORDER_RESPONSE_SCHEMA }),
    },
  };

  // Without an abort the socket can hang indefinitely; Promise.race only stops
  // waiting, it does not cancel the request.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal ?? ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text();
    // 429 is the one you will actually hit: free tier is ~10-15 requests/min.
    throw new Error(`gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { thoughtsTokenCount?: number; totalTokenCount?: number };
  };

  const text =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

  return { text, model, usage: data.usageMetadata };
}

/** Lists models the key can actually see — model IDs change often. */
export async function listModels(): Promise<string[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const res = await fetch(`${BASE}/models?key=${key}&pageSize=200`);
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  return (data.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
}