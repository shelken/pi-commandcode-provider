import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  commandCodeModelsFromApiResponse,
  type CommandCodeModel,
  DEFAULT_MODELS_CACHE_TTL_MS,
  fetchCommandCodeModels,
} from "../src/models.ts"

describe("commandCodeModelsFromApiResponse()", () => {
  it("converts the Provider API model list to pi models", () => {
    const models = commandCodeModelsFromApiResponse({
      object: "list",
      data: [
        {
          id: "Qwen/Qwen3.7-Max",
          object: "model",
          created: 1779824324,
          owned_by: "command-code",
          name: "Qwen 3.7 Max",
          context_length: 1_000_000,
        },
      ],
    })

    assert.deepEqual(models, [
      {
        id: "Qwen/Qwen3.7-Max",
        name: "Qwen 3.7 Max (CC)",
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 65_536,
      },
    ])
  })

  it("rejects unexpected API shapes", () => {
    assert.throws(() => commandCodeModelsFromApiResponse({ object: "list", data: [{}] }))
  })
})

// ---------------------------------------------------------------------------
// Cache tests
// ---------------------------------------------------------------------------

const A_MODEL_RESPONSE = {
  object: "list",
  data: [
    {
      id: "claude-sonnet-4-6",
      object: "model",
      created: 1779824324,
      owned_by: "command-code",
      name: "Claude Sonnet 4.6",
      context_length: 200_000,
    },
  ],
}

const A_MODEL: CommandCodeModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6 (CC)",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 65_536,
}

const A_MODEL_RESPONSE_2 = {
  object: "list",
  data: [
    {
      id: "deepseek/deepseek-v4-flash",
      object: "model",
      created: 1779824325,
      owned_by: "command-code",
      name: "DeepSeek V4 Flash",
      context_length: 1_000_000,
    },
  ],
}

const B_MODEL: CommandCodeModel = {
  id: "deepseek/deepseek-v4-flash",
  name: "DeepSeek V4 Flash (CC)",
  reasoning: true,
  contextWindow: 1_000_000,
  maxTokens: 65_536,
}

function makeMockResponse(init: {
  ok: boolean
  status: number
  statusText?: string
  body?: unknown
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? "",
    headers: new Headers(),
    redirected: false,
    type: "basic" as const,
    url: "",
    body: null,
    bodyUsed: false,
    json: async () => init.body,
    text: async () => "",
    blob: async () => new Blob(),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
    clone: function () {
      return makeMockResponse(init)
    },
  } as unknown as Response
}

function makeFetch(
  responseBody: unknown,
): { fetchImpl: typeof fetch; callCount: () => number } {
  let count = 0
  return {
    fetchImpl: async () => {
      count++
      return makeMockResponse({ ok: true, status: 200, body: responseBody })
    },
    callCount: () => count,
  }
}

function makeFetchFail(): { fetchImpl: typeof fetch; callCount: () => number } {
  let count = 0
  return {
    fetchImpl: async () => {
      count++
      return makeMockResponse({ ok: false, status: 500, statusText: "Internal Server Error" })
    },
    callCount: () => count,
  }
}

function writeCacheFile(cacheDir: string, models: CommandCodeModel[], cachedAt: number): void {
  writeFileSync(
    join(cacheDir, "commandcode-models.json"),
    JSON.stringify({
      version: 1,
      cachedAt,
      models,
    }),
    "utf-8",
  )
}

describe("fetchCommandCodeModels() with cache", () => {
  it("scenario 1: no cache → fetches and writes cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    const { fetchImpl, callCount } = makeFetch(A_MODEL_RESPONSE)

    const models = await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 30_000,
    })

    assert.equal(callCount(), 1, "should have called fetch")
    assert.deepEqual(models, [A_MODEL])
  })

  it("scenario 2: fresh cache → returns cache without fetch", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    writeCacheFile(cacheDir, [A_MODEL], Date.now())

    const { fetchImpl, callCount } = makeFetch(A_MODEL_RESPONSE)

    const models = await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 30_000,
    })

    assert.equal(callCount(), 0, "should NOT have called fetch")
    assert.deepEqual(models, [A_MODEL])
  })

  it("scenario 3: expired cache + network OK → fetches, updates cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    writeCacheFile(cacheDir, [A_MODEL], Date.now() - 60_000)

    const { fetchImpl, callCount } = makeFetch(A_MODEL_RESPONSE_2)

    const models = await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 30_000,
    })

    assert.equal(callCount(), 1, "should have called fetch")
    // 返回新数据
    assert.deepEqual(models, [B_MODEL])
  })

  it("scenario 4: expired cache + network fail + stale cache → degrades", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    writeCacheFile(cacheDir, [A_MODEL], Date.now() - 60_000)

    const { fetchImpl } = makeFetchFail()

    const models = await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 30_000,
    })

    // 静默返回过期缓存
    assert.deepEqual(models, [A_MODEL])
  })

  it("scenario 5: expired cache + network fail + no cache → throws", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    const { fetchImpl } = makeFetchFail()

    await assert.rejects(
      () =>
        fetchCommandCodeModels({
          fetchImpl: fetchImpl as unknown as typeof fetch,
          cacheDir,
          ttlMs: 30_000,
        }),
      /Failed to fetch Command Code models/,
    )
  })

  it("scenario 6: ttlMs=0 disables cache, always fetches", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    writeCacheFile(cacheDir, [A_MODEL], Date.now())

    const { fetchImpl, callCount } = makeFetch(A_MODEL_RESPONSE)

    const models = await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 0,
    })

    assert.equal(callCount(), 1, "should have called fetch even with cache present")
    assert.deepEqual(models, [A_MODEL])
  })

  it("does not write cache when ttlMs=0", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cc-models-test-"))
    const { fetchImpl } = makeFetch(A_MODEL_RESPONSE)

    await fetchCommandCodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      cacheDir,
      ttlMs: 0,
    })

    // 确认没有写缓存文件
    const { readFileSync, existsSync } = await import("node:fs")
    assert.equal(existsSync(join(cacheDir, "commandcode-models.json")), false)
  })

  it("defaults to 6h TTL", async () => {
    assert.equal(DEFAULT_MODELS_CACHE_TTL_MS, 21_600_000)
  })
})
