import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const DEFAULT_MODELS_URL = "https://api.commandcode.ai/provider/v1/models"

/** Default TTL for cached model list: 6 hours. */
export const DEFAULT_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000

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
  return join(homedir(), ".pi", "agent", "cache")
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
function hasModelsChanged(
  cached: ModelsCache,
  fresh: CommandCodeModel[],
): boolean {
  if (cached.models.length !== fresh.length) return true
  return !cached.models.every((c, i) =>
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
): Promise<CommandCodeModel[]> {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
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
 * Cache lives at `cacheDir/commandcode-models.json`, defaulting to
 * `~/.pi/agent/cache/`. On cache hit within TTL, returns instantly (~0.02ms)
 * without any network request. On cache miss or expiry, fetches from
 * the Provider API and writes the result to cache.
 *
 * When the network is unreachable and stale cache exists, silently
 * returns stale data as a degradation strategy.
 */
export async function fetchCommandCodeModels(
  options: FetchCommandCodeModelsOptions = {},
): Promise<readonly CommandCodeModel[]> {
  const url = options.url ?? DEFAULT_MODELS_URL
  const fetchImpl = options.fetchImpl ?? fetch
  const ttlMs = options.ttlMs ?? DEFAULT_MODELS_CACHE_TTL_MS
  const cacheDir = options.cacheDir ?? defaultCacheDir()

  // --- Cache hit: return fresh cached data without network ---
  if (ttlMs > 0) {
    const cachePath = cacheFilePath(cacheDir)
    const cached = readCacheFile(cachePath)
    if (cached && Date.now() - cached.cachedAt < ttlMs) {
      return cached.models
    }
  }

  // --- Cache miss or expired: fetch from network ---
  try {
    const models = await fetchCommandCodeModelsRaw(url, fetchImpl)

    if (ttlMs > 0) {
      const cachePath = cacheFilePath(cacheDir)
      const cached = readCacheFile(cachePath)
      // 只在内容发生变化时才写盘，避免不必要 IO
      if (!cached || hasModelsChanged(cached, models)) {
        writeCacheFile(cachePath, models)
      }
    }

    return models
  } catch (err) {
    // --- Network failure with stale cache: degrade silently ---
    if (ttlMs > 0) {
      const cachePath = cacheFilePath(cacheDir)
      const cached = readCacheFile(cachePath)
      if (cached) return cached.models
    }
    throw err
  }
}
