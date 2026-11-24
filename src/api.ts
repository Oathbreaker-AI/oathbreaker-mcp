// A thin client of Oathbreaker's public API. Sign-in, rate limits, billing and
// request validation all stay on oathbreaker.ai; this file only forwards the
// caller's key and reads the answer.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PublicModel {
  model: string;
  name: string;
  inferenceReady: boolean;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
  memberInputPerMillion?: number;
  memberOutputPerMillion?: number;
  maxOutputTokens: number;
  contextLimit: number;
  toolCalling?: boolean;
  reasoning?: boolean;
}

export interface Catalog {
  models: PublicModel[];
  memberPercentOff?: number;
}

export interface Balance {
  balance_usd: number;
  held_usd: number;
  available_usd: number;
  status?: string;
}

export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user"; content: string }[];
  max_tokens: number;
  reasoning_effort?: string;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
}

export interface ChatResult {
  model: string;
  answer: string;
  reasoning: string;
  finishReason: string | null;
  usage: ChatUsage | null;
}

export interface StreamProgress {
  answerChars: number;
  reasoningChars: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly requestId?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiOptions {
  baseUrl: string;
  apiKey?: string;
  userAgent: string;
  fetch?: FetchLike;
  /** Abort a streamed answer when no bytes arrive for this long. */
  idleTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 180_000;

export class OathbreakerApi {
  private readonly fetcher: FetchLike;
  private readonly base: string;

  constructor(private readonly options: ApiOptions) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = options.baseUrl.replace(/\/+$/, "");
  }

  get hasKey() {
    return Boolean(this.options.apiKey);
  }

  /** Public model list, prices and limits. Needs no key. */
  async catalog(signal?: AbortSignal): Promise<Catalog> {
    const response = await this.fetcher(`${this.base}/api/config`, {
      headers: { accept: "application/json", "user-agent": this.options.userAgent },
      signal,
    });
    if (!response.ok) throw await toApiError(response);
    const body = (await response.json()) as { models?: unknown; membership?: { percentOff?: unknown } };
    const models = Array.isArray(body.models) ? body.models.filter(isPublicModel) : [];
    const percentOff = typeof body.membership?.percentOff === "number" ? body.membership.percentOff : undefined;
    return { models, memberPercentOff: percentOff };
  }

  async balance(signal?: AbortSignal): Promise<Balance> {
    const response = await this.fetcher(`${this.base}/v1/account/balance`, {
      headers: this.headers({ accept: "application/json" }),
      signal,
    });
    if (!response.ok) throw await toApiError(response);
    return (await response.json()) as Balance;
  }

  /** Streams one Chat Completions answer and returns it whole. */
  async chat(request: ChatRequest, options: { signal?: AbortSignal; onProgress?: (progress: StreamProgress) => void } = {}): Promise<ChatResult> {
    const idle = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, idle.signal]) : idle.signal;
    const idleMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let timer = setTimeout(() => idle.abort(new Error("idle")), idleMs);
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error("idle")), idleMs);
    };

    try {
      const response = await this.fetcher(`${this.base}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers({ accept: "text/event-stream", "content-type": "application/json" }),
        body: JSON.stringify({ ...request, stream: true, stream_options: { include_usage: true } }),
        signal,
      });
      if (!response.ok) throw await toApiError(response);
      if (!response.body) throw new ApiError(502, "empty_response", "The API returned no answer.");

      const result: ChatResult = { model: request.model, answer: "", reasoning: "", finishReason: null, usage: null };
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;
        touch();
        buffer += chunk.value;
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
          if (readEvent(event, result)) {
            done = true;
            break;
          }
        }
        options.onProgress?.({ answerChars: result.answer.length, reasoningChars: result.reasoning.length });
      }
      if (!done && buffer.trim()) readEvent(buffer, result);
      reader.releaseLock();
      return result;
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) {
        throw new ApiError(504, "stream_idle", `The answer stopped arriving for ${Math.round(idleMs / 1000)} seconds.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(extra: Record<string, string>) {
    return {
      ...extra,
      "user-agent": this.options.userAgent,
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }
}

/** Applies one server-sent event to the result. Returns true at [DONE]. */
function readEvent(event: string, result: ChatResult): boolean {
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return false;
  if (data.trim() === "[DONE]") return true;
  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (parsed?.error) {
    const error = parsed.error;
    throw new ApiError(typeof error.status === "number" ? error.status : 502, error.code, String(error.message ?? "The answer was interrupted."), error.request_id);
  }
  if (typeof parsed?.model === "string") result.model = parsed.model;
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string") result.answer += delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string") result.reasoning += reasoning;
  if (typeof choice?.finish_reason === "string") result.finishReason = choice.finish_reason;
  const usage = parsed?.usage;
  if (usage && typeof usage === "object") {
    result.usage = {
      inputTokens: num(usage.prompt_tokens),
      cachedInputTokens: num(usage.prompt_tokens_details?.cached_tokens),
      outputTokens: num(usage.completion_tokens),
      ...(typeof usage.completion_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
    };
  }
  return false;
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function toApiError(response: Response): Promise<ApiError> {
  const retry = Number(response.headers.get("retry-after"));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : undefined;
  let code: string | undefined;
  let message = `HTTP ${response.status}`;
  let requestId = response.headers.get("x-request-id") ?? undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string; request_id?: string } };
    if (body?.error) {
      code = body.error.code;
      if (body.error.message) message = body.error.message;
      requestId = body.error.request_id ?? requestId;
    }
  } catch {
    /* Not JSON: keep the status line. */
  }
  return new ApiError(response.status, code, message, requestId, retryAfter);
}

function isPublicModel(value: unknown): value is PublicModel {
  const model = value as PublicModel;
  return Boolean(model) && typeof model.model === "string" && typeof model.inputPerMillion === "number"
    && typeof model.outputPerMillion === "number" && typeof model.maxOutputTokens === "number";
}
