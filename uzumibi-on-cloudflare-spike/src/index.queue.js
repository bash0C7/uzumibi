import { DurableObject } from "cloudflare:workers";
import { instantiate } from "asyncify-wasm";
import mod from "./uzumibi_on_cloudflare_spike_queue.wasm";

const wasmModule = mod;
const KV_SET_ERROR_INVALID_OPTIONS_JSON = -2;

/**
 * Durable Object storage retained for Uzumibi::LegacyKV.
 */
export class UzumibiKVObject extends DurableObject {
	async get(key) {
		const value = await this.ctx.storage.get(key);
		return value ?? null;
	}

	async set(key, value) {
		await this.ctx.storage.put(key, value);
	}
}

export default {
	async fetch(request, env, ctx) {
		return new Response("This endpoint is for queue processing. Please send messages to the queue instead.", { status: 400 });
	},

	async queue(batch, env, ctx) {
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();

		const kv = env.UZUMIBI_KV ?? null;

		// Durable Object stub retained for Uzumibi::LegacyKV.
		const doStub = env.UZUMIBI_KV_DATA
			? env.UZUMIBI_KV_DATA.getByName("default")
			: null;

		// Current message being processed (set per iteration)
		const getMessage = (id) => {
			const message = batch.messages.find((m) => m.id === id);
			if (!message) throw new Error(`Message not found for id: ${id}`);
			return message;
		};

		const importObject = {
			env: {
				debug_console_log: (ptr, size) => {
					const memory = exports.memory;
					const buffer = new Uint8Array(memory.buffer, ptr, size);
					console.log(`[debug]: ${decoder.decode(buffer)}`);
					return 0;
				},

				// Fetch.fetch(url, method, body, headers) -> packed Uzumibi::Response
				uzumibi_cf_fetch: async (
					urlPtr, urlSize,
					methodPtr, methodSize,
					bodyPtr, bodySize,
					headersPtr, headersSize,
					resultPtr, resultMaxSize,
				) => {
					const memory = exports.memory;
					const url = decoder.decode(new Uint8Array(memory.buffer, urlPtr, urlSize));
					const method = decoder.decode(new Uint8Array(memory.buffer, methodPtr, methodSize));
					const body = bodySize > 0
						? decoder.decode(new Uint8Array(memory.buffer, bodyPtr, bodySize))
						: null;

					const fetchOptions = { method };
					if (body && method !== "GET" && method !== "HEAD") {
						fetchOptions.body = body;
					}

					// Unpack request headers: u16 LE count, then (u16 LE key_size, key, u16 LE value_size, value) * count
					if (headersSize >= 2) {
						const hView = new DataView(memory.buffer, headersPtr, headersSize);
						const hCount = hView.getUint16(0, true);
						if (hCount > 0) {
							const reqHeaders = {};
							let hPos = 2;
							for (let i = 0; i < hCount; i++) {
								const kLen = hView.getUint16(hPos, true);
								hPos += 2;
								const k = decoder.decode(new Uint8Array(memory.buffer, headersPtr + hPos, kLen));
								hPos += kLen;
								const vLen = hView.getUint16(hPos, true);
								hPos += 2;
								const v = decoder.decode(new Uint8Array(memory.buffer, headersPtr + hPos, vLen));
								hPos += vLen;
								reqHeaders[k] = v;
							}
							fetchOptions.headers = reqHeaders;
						}
					}

					const response = await fetch(url, fetchOptions);
					const responseBody = await response.text();

					const respHeaders = [];
					response.headers.forEach((value, key) => {
						respHeaders.push({ key, value });
					});

					const resultView = new DataView(memory.buffer, resultPtr, resultMaxSize);
					const resultBuffer = new Uint8Array(memory.buffer, resultPtr, resultMaxSize);
					let pos = 0;

					resultView.setUint16(pos, response.status, true);
					pos += 2;

					resultView.setUint16(pos, respHeaders.length, true);
					pos += 2;

					for (const header of respHeaders) {
						const keyBytes = encoder.encode(header.key);
						resultView.setUint16(pos, keyBytes.length, true);
						pos += 2;
						resultBuffer.set(keyBytes, pos);
						pos += keyBytes.length;

						const valueBytes = encoder.encode(header.value);
						resultView.setUint16(pos, valueBytes.length, true);
						pos += 2;
						resultBuffer.set(valueBytes, pos);
						pos += valueBytes.length;
					}

					const bodyBytes = encoder.encode(responseBody);
					resultView.setUint32(pos, bodyBytes.length, true);
					pos += 4;

					const bodyLen = Math.min(bodyBytes.length, resultMaxSize - pos);
					resultBuffer.set(bodyBytes.slice(0, bodyLen), pos);
					pos += bodyLen;

					return pos;
				},

				// KV.get(key) -> value string
				uzumibi_cf_kv_get: async (keyPtr, keySize, resultPtr, resultMaxSize) => {
					if (!kv) return -1;
					const memory = exports.memory;
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));

					const value = await kv.get(key);
					if (value === null) return -1;

					const valueBytes = encoder.encode(value);
					const length = Math.min(valueBytes.length, resultMaxSize);
					const resultBuffer = new Uint8Array(memory.buffer, resultPtr, resultMaxSize);
					resultBuffer.set(valueBytes.slice(0, length));
					return length;
				},

				// KV.set(key, value, options)
				uzumibi_cf_kv_set: async (
					keyPtr,
					keySize,
					valuePtr,
					valueSize,
					optionsPtr,
					optionsSize,
				) => {
					if (!kv) return -1;
					const memory = exports.memory;
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));
					const value = decoder.decode(new Uint8Array(memory.buffer, valuePtr, valueSize));
					const optionsJson = decoder.decode(
						new Uint8Array(memory.buffer, optionsPtr, optionsSize),
					);
					let options;
					try {
						options = JSON.parse(optionsJson);
					} catch (error) {
						console.error("Failed to parse KV options JSON", error);
						return KV_SET_ERROR_INVALID_OPTIONS_JSON;
					}

					await kv.put(key, value, options);
					return 0;
				},

				// LegacyKV.get(key) -> value string (via Durable Object)
				uzumibi_cf_durable_object_get: async (keyPtr, keySize, resultPtr, resultMaxSize) => {
					if (!doStub) return -1;
					const memory = exports.memory;
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));

					const value = await doStub.get(key);
					if (value === null) return -1;

					const valueBytes = encoder.encode(value);
					const length = Math.min(valueBytes.length, resultMaxSize);
					const resultBuffer = new Uint8Array(memory.buffer, resultPtr, resultMaxSize);
					resultBuffer.set(valueBytes.slice(0, length));
					return length;
				},

				// LegacyKV.set(key, value) (via Durable Object)
				uzumibi_cf_durable_object_set: async (keyPtr, keySize, valuePtr, valueSize) => {
					if (!doStub) return -1;
					const memory = exports.memory;
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));
					const value = decoder.decode(new Uint8Array(memory.buffer, valuePtr, valueSize));

					await doStub.set(key, value);
					return 0;
				},

				// Secret.get(key) -> secret value from env bindings
				uzumibi_cf_secret_get: (keyPtr, keySize, resultPtr, resultMaxSize) => {
					const memory = exports.memory;
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));
					const value = env[key];
					if (value === undefined || value === null) {
						return -1;
					}
					const valueBytes = encoder.encode(String(value));
					const length = Math.min(valueBytes.length, resultMaxSize);
					new Uint8Array(memory.buffer, resultPtr, resultMaxSize).set(valueBytes.slice(0, length));
					return length;
				},

				// Queue.send(queue_name, message)
				uzumibi_cf_queue_send: async (queueNamePtr, queueNameSize, messagePtr, messageSize) => {
					const memory = exports.memory;
					const queueName = decoder.decode(new Uint8Array(memory.buffer, queueNamePtr, queueNameSize));
					const message = decoder.decode(new Uint8Array(memory.buffer, messagePtr, messageSize));

					const queue = env[queueName];
					if (!queue) {
						console.error(`Queue binding '${queueName}' not found`);
						return -1;
					}
					await queue.send(message);
					return 0;
				},

				// RateLimit.limit(binding_name, key) -> 1 within the limit, 0 over it
				uzumibi_cf_rate_limit: async (bindingNamePtr, bindingNameSize, keyPtr, keySize) => {
					const memory = exports.memory;
					const bindingName = decoder.decode(new Uint8Array(memory.buffer, bindingNamePtr, bindingNameSize));
					const key = decoder.decode(new Uint8Array(memory.buffer, keyPtr, keySize));

					const limiter = env[bindingName];
					if (!limiter || typeof limiter.limit !== "function") {
						console.error(`Rate limit binding '${bindingName}' not found`);
						return -1;
					}
					const { success } = await limiter.limit({ key });
					return success ? 1 : 0;
				},

				// Assets.exist?(path) -> 1 when the assets binding serves that path
				uzumibi_cf_assets_exist: async (pathPtr, pathSize) => {
					const memory = exports.memory;
					const path = decoder.decode(new Uint8Array(memory.buffer, pathPtr, pathSize));

					if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
						console.error("Assets binding not found");
						return -1;
					}
					// The assets binding wants an absolute URL; only the path is read.
					const base = typeof request !== "undefined" && request
						? new URL(request.url).origin
						: "http://assets.local";
					let url;
					try {
						url = new URL(path, base);
					} catch {
						return 0;
					}
					const response = await env.ASSETS.fetch(new Request(url));
					return response.ok ? 1 : 0;
				},

				// D1.query(binding_name, sql, params_json) -> JSON array of rows
				uzumibi_cf_d1_query: async (bindingNamePtr, bindingNameSize, sqlPtr, sqlSize, paramsPtr, paramsSize, resultPtr, resultMaxSize) => {
					const memory = exports.memory;
					const bindingName = decoder.decode(new Uint8Array(memory.buffer, bindingNamePtr, bindingNameSize));
					const sql = decoder.decode(new Uint8Array(memory.buffer, sqlPtr, sqlSize));
					const paramsJson = paramsSize > 0
						? decoder.decode(new Uint8Array(memory.buffer, paramsPtr, paramsSize))
						: "[]";

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
					new Uint8Array(memory.buffer, resultPtr, resultMaxSize).set(rowBytes);
					return rowBytes.length;
				},

				uzumibi_cf_message_ack: async (idPtr, idSize) => {
					const id = decoder.decode(new Uint8Array(exports.memory.buffer, idPtr, idSize));
					getMessage(id).ack();
					return 0;
				},

				uzumibi_cf_message_retry: async (idPtr, idSize, delaySeconds) => {
					const id = decoder.decode(new Uint8Array(exports.memory.buffer, idPtr, idSize));
					getMessage(id).retry({ delaySeconds });
					return 0;
				},
			},
		};

		const instance = await instantiate(wasmModule, importObject);
		const exports = instance.exports;

		for (const message of batch.messages) {
			const idBytes = encoder.encode(message.id);
			const timestampBytes = encoder.encode(
				message.timestamp.toISOString(),
			);
			const bodyBytes = encoder.encode(
				typeof message.body === "string"
					? message.body
					: JSON.stringify(message.body),
			);
			const attempts = message.attempts;

			// Pack message data:
			//   u16 LE id_size, id bytes,
			//   u16 LE timestamp_size, timestamp bytes,
			//   u32 LE body_size, body bytes,
			//   u32 LE attempts
			const totalSize =
				2 +
				idBytes.length +
				2 +
				timestampBytes.length +
				4 +
				bodyBytes.length +
				4;

			const msgResult =
				await exports.uzumibi_initialize_message(totalSize);
			const msgOffset = Number(msgResult & 0xffffffffn);
			if (msgOffset === 0) {
				const errOffset = Number(
					(msgResult >> 32n) & 0xffffffffn,
				);
				const buffer = new Uint8Array(
					exports.memory.buffer,
					errOffset,
				);
				let errStr = "";
				for (let i = 0; buffer[i] !== 0; i++) {
					errStr += String.fromCharCode(buffer[i]);
				}
				throw new Error(
					`Failed to initialize message: ${errStr}`,
				);
			}

			const msgBuffer = new Uint8Array(
				exports.memory.buffer,
				msgOffset,
				totalSize,
			);
			const dataView = new DataView(
				exports.memory.buffer,
				msgOffset,
			);
			let pos = 0;

			// id
			dataView.setUint16(pos, idBytes.length, true);
			pos += 2;
			msgBuffer.set(idBytes, pos);
			pos += idBytes.length;

			// timestamp
			dataView.setUint16(pos, timestampBytes.length, true);
			pos += 2;
			msgBuffer.set(timestampBytes, pos);
			pos += timestampBytes.length;

			// body
			dataView.setUint32(pos, bodyBytes.length, true);
			pos += 4;
			msgBuffer.set(bodyBytes, pos);
			pos += bodyBytes.length;

			// attempts
			dataView.setUint32(pos, attempts, true);

			const result = await exports.uzumibi_start_message();
			if (result !== 0) {
				const buffer = new Uint8Array(
					exports.memory.buffer,
					result,
				);
				let errStr = "";
				for (let i = 0; buffer[i] !== 0; i++) {
					errStr += String.fromCharCode(buffer[i]);
				}
				throw new Error(
					`Failed to process message: ${errStr}`,
				);
			}
		}
	},
};
