import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"

/** Default TTL for cached model list: 6 hours. */
export const DEFAULT_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** When stale cache exists, max time to wait for a fresh network response before falling back. */
const STALE_CACHE_FETCH_TIMEOUT_MS = 2_000

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536

interface ApiModel {
  id: string
  name: string
  contextLength: number
}

export interface CommandCodeModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
  maxTokens: number
}

interface ModelsCache {
  version: 1
  cachedAt: number
  models: CommandCodeModel[]
}

interface FetchCommandCodeModelsOptions {
  url?: string
  fetchImpl?: typeof fetch
  /** Cache TTL in milliseconds. Default 6 hours. Set to 0 to disable cache. */
  ttlMs?: number
  /** Cache directory. Default ~/.pi/agent/cache */
  cacheDir?: string
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function defaultCacheDir(): string {
  return process.env.COMMANDCODE_MODELS_CACHE_DIR ?? join(homedir(), ".pi", "agent", "cache")
}

function cacheFilePath(cacheDir: string): string {
  return join(cacheDir, "commandcode-models.json")
}

function readCacheFile(path: string): ModelsCache | null {
  try {
    const raw = readFileSync(path, "utf-8")
    const cache: ModelsCache = JSON.parse(raw)
    if (cache.version !== 1) return null
    if (!Array.isArray(cache.models)) return null
    return cache
  } catch {
    return null
  }
}

function writeCacheFile(path: string, models: CommandCodeModel[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const cache: ModelsCache = {
    version: 1,
    cachedAt: Date.now(),
    models,
  }
  writeFileSync(path, JSON.stringify(cache), "utf-8")
}

/**
 * Semantic comparison: ignore API noise like `created` timestamp,
 * only compare fields that affect pi's model registration.
 */
function hasModelsChanged(cached: ModelsCache, fresh: CommandCodeModel[]): boolean {
  if (cached.models.length !== fresh.length) return true
  return !cached.models.every(
    (c, i) =>
      c.id === fresh[i].id &&
      c.contextWindow === fresh[i].contextWindow &&
      c.maxTokens === fresh[i].maxTokens,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string") throw new Error(`Expected ${key} to be a string`)
  return value
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number") throw new Error(`Expected ${key} to be a number`)
  return value
}

function parseApiModel(value: unknown): ApiModel {
  if (!isRecord(value)) throw new Error("Expected model entry to be an object")

  return {
    id: stringField(value, "id"),
    name: stringField(value, "name"),
    contextLength: numberField(value, "context_length"),
  }
}

export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeModel[] {
  if (!isRecord(value)) throw new Error("Expected models response to be an object")
  if (value.object !== "list") throw new Error("Expected models response object to be 'list'")

  const data = value.data
  if (!Array.isArray(data)) throw new Error("Expected models response data to be an array")

  return data.map(parseApiModel).map((model) => ({
    id: model.id,
    name: `${model.name} (CC)`,
    reasoning: true,
    contextWindow: model.contextLength,
    maxTokens: Math.min(model.contextLength, DEFAULT_MAX_OUTPUT_TOKENS),
  }))
}

/**
 * Raw fetch + parse, no caching. Exported for tests that need to bypass cache.
 */
export async function fetchCommandCodeModelsRaw(
  url: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<CommandCodeModel[]> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal,
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Command Code models: ${response.status} ${response.statusText}`,
    )
  }

  const body: unknown = await response.json()
  return commandCodeModelsFromApiResponse(body) as CommandCodeModel[]
}

/**
 * Fetch models with file-based TTL cache.
 *
 * Priority:
 *  1. Fresh cache (within TTL) → return instantly, no network.
 *  2. Stale cache exists → try fetch with short (2s) timeout.
 *     If fetch completes in time → return fresh + update cache.
 *     If fetch times out / fails → return stale cache silently.
 *  3. No cache at all → block on network (first startup).
 *
 * Cache lives at `cacheDir/commandcode-models.json`, defaulting to
 * `~/.pi/agent/cache/`.
 */
export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const ttlMs = options.ttlMs ?? DEFAULT_MODELS_CACHE_TTL_MS
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const cachePath = cacheFilePath(cacheDir)

  // 1) Fresh cache: return instantly, no network
  if (ttlMs > 0) {
    const cached = readCacheFile(cachePath)
    if (cached && Date.now() - cached.cachedAt < ttlMs) {
      return cached.models
    }
  }

  // 2) Stale cache exists: try network with short timeout
  if (ttlMs > 0) {
    const stale = readCacheFile(cachePath)
    if (stale) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), STALE_CACHE_FETCH_TIMEOUT_MS)
        try {
          const models = await fetchCommandCodeModelsRaw(url, fetchImpl, controller.signal)
          if (hasModelsChanged(stale, models)) {
            writeCacheFile(cachePath, models)
          }
          return models
        } finally {
          clearTimeout(timer)
        }
      } catch {
        // Network timed out or failed → return stale cache silently
        return stale.models
      }
    }
  }

  // 3) No cache at all: must fetch (typically first startup)
  const models = await fetchCommandCodeModelsRaw(url, fetchImpl)
  if (ttlMs > 0) {
    writeCacheFile(cachePath, models)
  }
  return models
}
