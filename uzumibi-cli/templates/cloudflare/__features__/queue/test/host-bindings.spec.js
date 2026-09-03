import { afterEach, describe, expect, it, vi } from "vitest";
import {
    assetExists,
    checkRateLimit,
    writeD1RowsToWasm,
} from "../src/host-bindings.js";

function createMemory() {
    const memory = new WebAssembly.Memory({ initial: 4 });
    return {
        memory,
        readResult: (ptr, length) =>
            new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, length)),
    };
}

function createLimiter(success) {
    const calls = [];
    return {
        calls,
        limit: async ({ key }) => {
            calls.push(key);
            return { success };
        },
    };
}

function createAssets(statusByPath) {
    const requests = [];
    return {
        requests,
        fetch: async (request) => {
            requests.push(request.url);
            const status = statusByPath[new URL(request.url).pathname] ?? 404;
            return new Response(null, { status });
        },
    };
}

function createD1(results, { throwing } = {}) {
    const sql = [];
    const bindArgs = [];
    const statement = {
        bind: (...args) => {
            bindArgs.push(args);
            return statement;
        },
        all: async () => ({ results }),
    };
    return {
        sql,
        bindArgs,
        prepare: (query) => {
            if (throwing) {
                throw new Error(throwing);
            }
            sql.push(query);
            return statement;
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("checkRateLimit", () => {
    it("returns 1 when the limiter reports success", async () => {
        const limiter = createLimiter(true);
        const env = { RATE_LIMITER: limiter };

        const result = await checkRateLimit(env, "RATE_LIMITER", "user-1");

        expect(result).toBe(1);
        expect(limiter.calls).toEqual(["user-1"]);
    });

    it("returns 0 when the limiter reports failure", async () => {
        const limiter = createLimiter(false);
        const env = { RATE_LIMITER: limiter };

        const result = await checkRateLimit(env, "RATE_LIMITER", "user-1");

        expect(result).toBe(0);
    });

    it("returns -1 and logs when the binding is missing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const env = {};

        const result = await checkRateLimit(env, "RATE_LIMITER", "user-1");

        expect(result).toBe(-1);
        expect(errorSpy).toHaveBeenCalledWith("Rate limit binding 'RATE_LIMITER' not found");
    });

    it("returns -1 and logs when the binding has no limit() function", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const env = { RATE_LIMITER: {} };

        const result = await checkRateLimit(env, "RATE_LIMITER", "user-1");

        expect(result).toBe(-1);
        expect(errorSpy).toHaveBeenCalledWith("Rate limit binding 'RATE_LIMITER' not found");
    });

    it("forwards the given key to limit()", async () => {
        const limiter = createLimiter(true);
        const env = { RATE_LIMITER: limiter };

        await checkRateLimit(env, "RATE_LIMITER", "some-specific-key");

        expect(limiter.calls).toEqual(["some-specific-key"]);
    });
});

describe("assetExists", () => {
    it("returns 1 when the response is ok", async () => {
        const assets = createAssets({ "/img/a.png": 200 });
        const env = { ASSETS: assets };

        const result = await assetExists(env, "/img/a.png", "https://example.com");

        expect(result).toBe(1);
    });

    it("returns 0 when the response is a 404", async () => {
        const assets = createAssets({ "/missing.png": 404 });
        const env = { ASSETS: assets };

        const result = await assetExists(env, "/missing.png", "https://example.com");

        expect(result).toBe(0);
    });

    it("returns -1 and logs when the ASSETS binding is missing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const env = {};

        const result = await assetExists(env, "/img/a.png", "https://example.com");

        expect(result).toBe(-1);
        expect(errorSpy).toHaveBeenCalledWith("Assets binding not found");
    });

    it("passes the resolved URL to ASSETS.fetch", async () => {
        const assets = createAssets({ "/img/a.png": 200 });
        const env = { ASSETS: assets };

        await assetExists(env, "/img/a.png", "https://example.com");

        expect(assets.requests).toEqual(["https://example.com/img/a.png"]);
    });

    it("returns 0 without calling fetch when the URL cannot be parsed", async () => {
        const assets = createAssets({});
        const env = { ASSETS: assets };

        const result = await assetExists(env, "http://[", "http://x");

        expect(result).toBe(0);
        expect(assets.requests).toEqual([]);
    });
});

describe("writeD1RowsToWasm", () => {
    it("writes the JSON rows into wasm memory and returns the byte length", async () => {
        const wasm = createMemory();
        const rows = [{ id: 1, name: "uzumibi" }];
        const db = createD1(rows);
        const env = { DB: db };

        const length = await writeD1RowsToWasm(
            wasm,
            env,
            "DB",
            "select * from items",
            "[]",
            0,
            65536,
        );

        const expectedJson = JSON.stringify(rows);
        expect(length).toBe(new TextEncoder().encode(expectedJson).length);
        expect(wasm.readResult(0, length)).toBe(expectedJson);
    });

    it("calls bind with parsed params when params is non-empty", async () => {
        const wasm = createMemory();
        const db = createD1([]);
        const env = { DB: db };

        await writeD1RowsToWasm(
            wasm,
            env,
            "DB",
            "select * from items where id = ?",
            "[42]",
            0,
            65536,
        );

        expect(db.bindArgs).toEqual([[42]]);
    });

    it("does not call bind when paramsJson is '[]'", async () => {
        const wasm = createMemory();
        const db = createD1([]);
        const env = { DB: db };

        await writeD1RowsToWasm(wasm, env, "DB", "select 1", "[]", 0, 65536);

        expect(db.bindArgs).toEqual([]);
    });

    it("writes '[]' when results is undefined", async () => {
        const wasm = createMemory();
        const db = createD1(undefined);
        const env = { DB: db };

        const length = await writeD1RowsToWasm(wasm, env, "DB", "select 1", "[]", 0, 65536);

        expect(length).toBe(2);
        expect(wasm.readResult(0, length)).toBe("[]");
    });

    it("returns -1 and logs when the D1 binding is missing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const wasm = createMemory();
        const env = {};

        const result = await writeD1RowsToWasm(wasm, env, "DB", "select 1", "[]", 0, 65536);

        expect(result).toBe(-1);
        expect(errorSpy).toHaveBeenCalledWith("D1 binding 'DB' not found");
    });

    it("returns -2 and logs when the statement throws", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const wasm = createMemory();
        const db = createD1(undefined, { throwing: "syntax error" });
        const env = { DB: db };

        const result = await writeD1RowsToWasm(wasm, env, "DB", "not sql", "[]", 0, 65536);

        expect(result).toBe(-2);
        expect(errorSpy).toHaveBeenCalledWith("D1 query failed: syntax error");
    });

    it("returns -3 and logs when the result exceeds the buffer size, writing nothing", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const wasm = createMemory();
        const rows = [{ id: 1, name: "x".repeat(100) }];
        const db = createD1(rows);
        const env = { DB: db };
        const resultMaxSize = 10;
        const rowBytes = new TextEncoder().encode(JSON.stringify(rows));

        const result = await writeD1RowsToWasm(
            wasm,
            env,
            "DB",
            "select * from items",
            "[]",
            0,
            resultMaxSize,
        );

        expect(result).toBe(-3);
        expect(errorSpy).toHaveBeenCalledWith(
            `D1 result of ${rowBytes.length} bytes exceeds the ${resultMaxSize} byte buffer`,
        );
        expect(new Uint8Array(wasm.memory.buffer, 0, resultMaxSize)).toEqual(
            new Uint8Array(resultMaxSize),
        );
    });
});
