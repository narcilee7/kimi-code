import { readApiErrorMessage } from './api-error';
import { isRecord } from './utils';
import type {
  ManagedKimiCodeModelInfo,
  ManagedKimiConfigShape,
} from './managed-kimi-code';

export type { ManagedKimiConfigShape };

export interface OpenPlatformDefinition {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly consoleUrl?: string;
  readonly allowedPrefixes?: readonly string[] | undefined;
  /** Wire type for the provider config. Defaults to `'kimi'` for backward compatibility. */
  readonly wireType?: 'kimi' | 'openai' | 'openai_responses' | 'anthropic' | 'google-genai' | 'vertexai';
}

export const OPEN_PLATFORMS: readonly OpenPlatformDefinition[] = [
  {
    id: 'moonshot-cn',
    name: 'Kimi Platform (API key · platform.kimi.com)',
    baseUrl: 'https://api.moonshot.cn/v1',
    consoleUrl: 'https://platform.kimi.com',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'moonshot-ai',
    name: 'Kimi Platform (API key · platform.kimi.ai)',
    baseUrl: 'https://api.moonshot.ai/v1',
    consoleUrl: 'https://platform.kimi.ai',
    allowedPrefixes: ['kimi-k'],
  },
  {
    id: 'volcengine-coding-plan',
    name: 'Volcano Engine Coding Plan (API key)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    consoleUrl: 'https://console.volcengine.com/ark',
    wireType: 'openai',
  },
  {
    id: 'volcengine-agent-plan',
    name: 'Volcano Engine Agent Plan (API key)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    consoleUrl: 'https://console.volcengine.com/ark',
    wireType: 'openai',
  },
];

export function getOpenPlatformById(id: string): OpenPlatformDefinition | undefined {
  return OPEN_PLATFORMS.find((p) => p.id === id);
}

export function isOpenPlatformId(id: string): boolean {
  return OPEN_PLATFORMS.some((p) => p.id === id);
}

function toModelInfo(item: unknown): ManagedKimiCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const contextLength = Number(item['context_length']);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    return undefined;
  }
  const displayName = item['display_name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const supportsToolUse = Object.hasOwn(item, 'supports_tool_use')
    ? Boolean(item['supports_tool_use'])
    : true;
  return {
    id: item['id'],
    contextLength,
    supportsReasoning: Boolean(item['supports_reasoning']),
    supportsImageIn: Boolean(item['supports_image_in']),
    supportsVideoIn: Boolean(item['supports_video_in']),
    supportsToolUse,
    displayName: normalizedDisplayName,
  };
}

/**
 * Infers context length from common model-name patterns.
 * Matches explicit hints like `32k`, `128k`, `4m`, or falls back to a default.
 */
function inferContextLength(modelName: string): number {
  const normalized = modelName.toLowerCase();
  // Look for explicit context-size hints like `32k`, `128k`, `4m`.
  const match = /(\d+)([km])\b/.exec(normalized);
  if (match) {
    const num = parseInt(match[1] ?? '0', 10);
    const suffix = match[2] ?? '';
    if (suffix === 'm') return num * 1_000_000;
    if (suffix === 'k') return num * 1_000;
  }
  // Known model families — fallback when no explicit size hint is present.
  if (normalized.includes('deepseek')) return 64_000;
  if (normalized.includes('doubao')) return 128_000;
  if (normalized.includes('glm')) return 128_000;
  if (normalized.includes('kimi')) return 256_000;
  return 128_000;
}

function inferCapabilitiesFromModelName(modelName: string): {
  supportsReasoning: boolean;
  supportsImageIn: boolean;
  supportsVideoIn: boolean;
  supportsToolUse: boolean;
} {
  const normalized = modelName.toLowerCase();
  return {
    supportsReasoning:
      normalized.includes('reasoning') ||
      normalized.includes('think') ||
      normalized.includes('r1') ||
      normalized.includes('deepseek'),
    supportsImageIn: normalized.includes('vision') || normalized.includes('vl'),
    supportsVideoIn: false,
    supportsToolUse:
      !normalized.includes('embedding') && !normalized.includes('embed'),
  };
}

function toModelInfoFromOpenAIFormat(item: unknown): ManagedKimiCodeModelInfo | undefined {
  if (!isRecord(item) || typeof item['id'] !== 'string' || item['id'].length === 0) {
    return undefined;
  }
  const id = item['id'];
  const displayName = item['display_name'] ?? item['name'];
  const normalizedDisplayName =
    typeof displayName === 'string' && displayName.length > 0 ? displayName : undefined;
  const inferred = inferCapabilitiesFromModelName(id);
  return {
    id,
    contextLength: inferContextLength(id),
    supportsReasoning: inferred.supportsReasoning,
    supportsImageIn: inferred.supportsImageIn,
    supportsVideoIn: inferred.supportsVideoIn,
    supportsToolUse: inferred.supportsToolUse,
    displayName: normalizedDisplayName,
  };
}

export function capabilitiesForModel(model: ManagedKimiCodeModelInfo): string[] | undefined {
  const caps = new Set<string>();
  if (model.supportsReasoning) caps.add('thinking');
  if (model.supportsImageIn) caps.add('image_in');
  if (model.supportsVideoIn) caps.add('video_in');
  if (model.supportsToolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

export class OpenPlatformApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchOpenPlatformModels(
  platform: OpenPlatformDefinition,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ManagedKimiCodeModelInfo[]> {
  const res = await fetchImpl(`${platform.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) {
    throw new OpenPlatformApiError(
      await readApiErrorMessage(res, `Failed to list models (HTTP ${res.status}).`),
      res.status,
    );
  }
  const payload: unknown = await res.json();
  if (!isRecord(payload) || !Array.isArray(payload['data'])) {
    throw new Error(`Unexpected models response for ${platform.baseUrl}.`);
  }
  const data = payload['data'] as unknown[];

  // Try Kimi-format first.
  const kimiModels = data
    .map((item) => toModelInfo(item))
    .filter((item): item is ManagedKimiCodeModelInfo => item !== undefined);
  if (kimiModels.length > 0) {
    return kimiModels;
  }

  // Fallback to OpenAI standard format (id-only objects).
  return data
    .map((item) => toModelInfoFromOpenAIFormat(item))
    .filter((item): item is ManagedKimiCodeModelInfo => item !== undefined);
}

export function filterModelsByPrefix(
  models: ManagedKimiCodeModelInfo[],
  platform: OpenPlatformDefinition,
): ManagedKimiCodeModelInfo[] {
  if (!platform.allowedPrefixes || platform.allowedPrefixes.length === 0) {
    return models;
  }
  const prefixes = platform.allowedPrefixes;
  return models.filter((m) => prefixes.some((p) => m.id.startsWith(p)));
}

export interface ApplyOpenPlatformResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
}

export function applyOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly platform: OpenPlatformDefinition;
    readonly models: readonly ManagedKimiCodeModelInfo[];
    readonly selectedModel: ManagedKimiCodeModelInfo;
    readonly thinking: boolean;
    readonly apiKey: string;
  },
): ApplyOpenPlatformResult {
  const providerKey = options.platform.id;
  const modelKey = `${providerKey}/${options.selectedModel.id}`;

  config.providers[providerKey] = {
    type: options.platform.wireType ?? 'kimi',
    baseUrl: options.platform.baseUrl,
    apiKey: options.apiKey,
  };

  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerKey) {
      delete existingModels[key];
    }
  }

  for (const model of options.models) {
    const aliasKey = `${providerKey}/${model.id}`;
    existingModels[aliasKey] = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.contextLength,
      capabilities: capabilitiesForModel(model),
      displayName: model.displayName,
    };
  }

  config.models = existingModels;
  config.defaultModel = modelKey;
  config.defaultThinking = options.thinking;

  return { defaultModel: modelKey, defaultThinking: options.thinking };
}

export function removeOpenPlatformConfig(
  config: ManagedKimiConfigShape,
  platformId: string,
): void {
  delete config.providers[platformId];

  let removedDefault = false;
  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== platformId) continue;
    delete existingModels[key];
    if (config.defaultModel === key) removedDefault = true;
  }
  config.models = existingModels;

  if (removedDefault) {
    config.defaultModel = undefined;
  }

  if (config['defaultProvider'] === platformId) {
    config['defaultProvider'] = undefined;
  }
}
