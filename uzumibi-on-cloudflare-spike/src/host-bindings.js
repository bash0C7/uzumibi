// RateLimit.limit(binding_name, key) -> 1 within the limit, 0 over it, -1 when the binding is missing
export async function checkRateLimit(env, bindingName, key) {
    const limiter = env[bindingName];
    if (!limiter || typeof limiter.limit !== "function") {
        console.error(`Rate limit binding '${bindingName}' not found`);
        return -1;
    }
    const { success } = await limiter.limit({ key });
    return success ? 1 : 0;
}

// Assets.exist?(path) -> 1 when the assets binding serves that path, -1 when the binding is missing
export async function assetExists(env, path, base) {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
        console.error("Assets binding not found");
        return -1;
    }
    // The assets binding wants an absolute URL; only the path is read.
    let url;
    try {
        url = new URL(path, base);
    } catch {
        return 0;
    }
    const response = await env.ASSETS.fetch(new Request(url));
    return response.ok ? 1 : 0;
}

// D1.query(binding_name, sql, params_json) -> JSON array of rows written into wasm memory
export async function writeD1RowsToWasm(exports, env, bindingName, sql, paramsJson, resultPtr, resultMaxSize) {
    const encoder = new TextEncoder();
    const db = env[bindingName];
    if (!db || typeof db.prepare !== "function") {
        console.error(`D1 binding '${bindingName}' not found`);
        return -1;
    }

    let rows;
    try {
        const params = JSON.parse(paramsJson);
        const statement = params.length > 0
            ? db.prepare(sql).bind(...params)
            : db.prepare(sql);
        rows = (await statement.all()).results ?? [];
    } catch (error) {
        console.error(`D1 query failed: ${(error && error.message) || error}`);
        return -2;
    }

    // Truncating would hand back unparsable JSON, so an oversized result fails.
    const rowBytes = encoder.encode(JSON.stringify(rows));
    if (rowBytes.length > resultMaxSize) {
        console.error(`D1 result of ${rowBytes.length} bytes exceeds the ${resultMaxSize} byte buffer`);
        return -3;
    }
    new Uint8Array(exports.memory.buffer, resultPtr, resultMaxSize).set(rowBytes);
    return rowBytes.length;
}
