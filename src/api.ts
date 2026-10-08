export const API_BASE = 'https://api.acedata.cloud/v1';

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  stream: true;
  tools?: Array<{ type: 'function'; function: { name: string; description: string; parameters: object } }>;
  tool_choice?: 'auto' | 'required';
}

export interface ToolCall {
  id: string;
  name: string;
  input: object;
}

function httpError(status: number): Error {
  const hint: Record<number, string> = {
    400: 'Check the model ID, request parameters, and API key permissions.',
    401: 'Check the Ace Data Cloud API key.',
    403: 'Check model access and content policy.',
    404: 'The model or endpoint is unavailable.',
    429: 'Rate limit reached; wait before another request.'
  };
  return new Error(`Ace Data Cloud returned HTTP ${status}. ${hint[status] ?? 'Check service status before retrying.'}`);
}

export async function listModelIds(apiKey: string, signal?: AbortSignal): Promise<Set<string>> {
  const response = await fetch(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'error',
    signal
  });
  if (!response.ok) { throw httpError(response.status); }
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('Ace Data Cloud returned an invalid model list.'); }
  if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) {
    throw new Error('Ace Data Cloud returned an invalid model list.');
  }
  return new Set(data.data.filter((item): item is { id: string } =>
    !!item && typeof item === 'object' && typeof item.id === 'string').map(item => item.id));
}

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  const line = (value: string): string | undefined => {
    if (value === '') {
      if (!data.length) { return undefined; }
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (value.startsWith('data:')) { data.push(value.slice(5).trimStart()); }
    return undefined;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { break; }
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        const event = line(value);
        if (event !== undefined) { yield event; }
      }
    }
    pending += decoder.decode();
    if (pending) {
      const event = line(pending.replace(/\r$/, ''));
      if (event !== undefined) { yield event; }
    }
    const event = line('');
    if (event !== undefined) { yield event; }
  } finally {
    reader.releaseLock();
  }
}

export async function streamChat(
  apiKey: string,
  request: ChatRequest,
  signal: AbortSignal,
  onText: (text: string) => void,
  onToolCall: (call: ToolCall) => void
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(request),
    redirect: 'error',
    signal
  });
  if (!response.ok) { throw httpError(response.status); }
  if (!response.body) { throw new Error('Ace Data Cloud returned an empty response stream.'); }

  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let complete = false;
  let hadOutput = false;
  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') { complete = true; break; }
    let chunk: any;
    try { chunk = JSON.parse(data); } catch { throw new Error('Ace Data Cloud returned an invalid response stream.'); }
    const choice = chunk?.choices?.[0];
    if (!choice) { continue; }
    if (choice.finish_reason === 'content_filter') { throw new Error('Ace Data Cloud blocked this content.'); }
    const delta = choice.delta;
    if (!delta || typeof delta !== 'object') { continue; }
    if (typeof delta.content === 'string' && delta.content) {
      hadOutput = true;
      onText(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        if (!Number.isInteger(part?.index) || part.index < 0) { throw new Error('Ace Data Cloud returned an invalid tool call.'); }
        const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' };
        if (typeof part.id === 'string') { call.id += part.id; }
        if (typeof part.function?.name === 'string') { call.name += part.function.name; }
        if (typeof part.function?.arguments === 'string') { call.arguments += part.function.arguments; }
        calls.set(part.index, call);
      }
    }
  }
  if (!complete) { throw new Error('Ace Data Cloud response ended early. Check usage before retrying.'); }
  for (const [, call] of [...calls].sort(([a], [b]) => a - b)) {
    let input: unknown;
    try { input = JSON.parse(call.arguments || '{}'); } catch { throw new Error('Ace Data Cloud returned invalid tool arguments.'); }
    if (!call.id || !call.name || !input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Ace Data Cloud returned an invalid tool call.');
    }
    hadOutput = true;
    onToolCall({ id: call.id, name: call.name, input: input as object });
  }
  if (!hadOutput) { throw new Error('Ace Data Cloud returned no chat response.'); }
}
