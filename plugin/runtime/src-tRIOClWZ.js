//#region packages/mcp-stdio-core/src/record.ts
function isPlainRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region packages/mcp-stdio-core/src/responses.ts
function successResponse(id, result) {
	return {
		jsonrpc: "2.0",
		id,
		result
	};
}
function errorResponse(id, code, message, data) {
	return {
		jsonrpc: "2.0",
		id,
		error: data === void 0 ? {
			code,
			message
		} : {
			code,
			message,
			data
		}
	};
}
function jsonRpcId(value) {
	return typeof value === "string" || typeof value === "number" || value === null ? value : null;
}
function messageFromError(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region packages/mcp-stdio-core/src/transport.ts
var HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
async function* readStdioJsonRpcMessages(input) {
	let buffer = Buffer.alloc(0);
	for await (const chunk of input) {
		buffer = Buffer.concat([buffer, bufferFromChunk(chunk)]);
		while (true) {
			const result = readNextMessage(buffer);
			if (result.kind === "incomplete") break;
			buffer = result.remaining;
			if (result.message) yield result.message;
		}
	}
	const trailing = buffer.toString("utf8").trim();
	if (trailing.length > 0) yield parseJsonPayload(trailing, "line");
}
function writeStdioJsonRpcResponse(output, response, responseMode) {
	const body = JSON.stringify(response);
	if (responseMode === "framed") {
		output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
		return;
	}
	output.write(`${body}\n`);
}
function readNextMessage(buffer) {
	if (buffer.length === 0) return { kind: "incomplete" };
	return startsWithContentLength(buffer) ? readFramedMessage(buffer) : readLineMessage(buffer);
}
function readLineMessage(buffer) {
	const newlineIndex = buffer.indexOf(10);
	if (newlineIndex === -1) return { kind: "incomplete" };
	const line = buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "");
	if (line.trim().length === 0) return {
		kind: "complete",
		remaining: buffer.subarray(newlineIndex + 1)
	};
	return {
		kind: "complete",
		message: parseJsonPayload(line, "line"),
		remaining: buffer.subarray(newlineIndex + 1)
	};
}
function readFramedMessage(buffer) {
	const separatorIndex = buffer.indexOf(HEADER_SEPARATOR);
	if (separatorIndex === -1) return { kind: "incomplete" };
	const contentLength = parseContentLength(buffer.subarray(0, separatorIndex).toString("ascii"));
	const bodyStart = separatorIndex + HEADER_SEPARATOR.length;
	if (contentLength === void 0) return {
		kind: "complete",
		message: {
			kind: "parse_error",
			message: "Missing or invalid Content-Length header",
			responseMode: "framed"
		},
		remaining: buffer.subarray(bodyStart)
	};
	const bodyEnd = bodyStart + contentLength;
	if (buffer.length < bodyEnd) return { kind: "incomplete" };
	return {
		kind: "complete",
		message: parseJsonPayload(buffer.subarray(bodyStart, bodyEnd).toString("utf8"), "framed"),
		remaining: buffer.subarray(bodyEnd)
	};
}
function startsWithContentLength(buffer) {
	return buffer.subarray(0, 15).toString("ascii").toLowerCase() === "content-length:";
}
function parseContentLength(headers) {
	for (const line of headers.split("\r\n")) {
		const match = /^content-length:\s*(\d+)$/i.exec(line);
		if (match === null) continue;
		const value = match[1];
		if (value === void 0) return void 0;
		return Number(value);
	}
}
function parseJsonPayload(payload, responseMode) {
	try {
		return {
			kind: "request",
			payload: JSON.parse(payload),
			responseMode
		};
	} catch (error) {
		return {
			kind: "parse_error",
			message: error instanceof Error ? error.message : String(error),
			responseMode
		};
	}
}
function bufferFromChunk(chunk) {
	if (Buffer.isBuffer(chunk)) return chunk;
	if (typeof chunk === "string") return Buffer.from(chunk);
	throw new TypeError(`Unsupported stdio chunk type: ${typeof chunk}`);
}
//#endregion
//#region packages/mcp-stdio-core/src/server.ts
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 6e4;
var noopLog = () => {};
async function runJsonRpcStdioServer(config) {
	const log = config.log ?? noopLog;
	const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const idleTimer = createIdleTimer(idleTimeoutMs, log, config.onIdleTimeout);
	log("stdio_started", {
		cwd: process.cwd(),
		idle_timeout_ms: idleTimeoutMs
	});
	idleTimer.arm();
	try {
		for await (const message of readStdioJsonRpcMessages(config.input)) {
			if (idleTimer.closed()) break;
			idleTimer.arm();
			if (message.kind === "parse_error") {
				handleParseError(message, config, log);
				continue;
			}
			await handleRequest(message, config, log);
		}
	} finally {
		idleTimer.clear();
		log("stdio_stopped");
	}
}
function handleParseError(message, config, log) {
	log("parse_error", { message: message.message });
	const response = config.parseErrorResponse?.(message.message) ?? errorResponse(null, -32700, "Parse error", message.message);
	if (response !== void 0) writeStdioJsonRpcResponse(config.output, response, message.responseMode);
}
async function handleRequest(message, config, log) {
	const parsed = message.payload;
	const id = isPlainRecord(parsed) ? jsonRpcId(parsed["id"]) : null;
	const method = isPlainRecord(parsed) && typeof parsed["method"] === "string" ? parsed["method"] : null;
	log("request", {
		id: id === null ? null : String(id),
		method
	});
	try {
		const response = await config.handler(parsed, config.handlerOptions);
		if (response === void 0) return;
		writeStdioJsonRpcResponse(config.output, response, message.responseMode);
		log("response", {
			id: String(response.id),
			method,
			is_error: response.error !== void 0
		});
	} catch (error) {
		if (config.onHandlerError === void 0) throw error;
		config.onHandlerError(error);
	}
}
function createIdleTimer(idleTimeoutMs, log, onIdleTimeout) {
	let timer = null;
	let isClosed = false;
	return {
		arm: () => {
			if (timer !== null) clearTimeout(timer);
			if (idleTimeoutMs <= 0) return;
			timer = setTimeout(() => {
				isClosed = true;
				log("idle_timeout", { idle_timeout_ms: idleTimeoutMs });
				onIdleTimeout?.();
			}, idleTimeoutMs);
			timer.unref();
		},
		clear: () => {
			if (timer === null) return;
			clearTimeout(timer);
			timer = null;
		},
		closed: () => isClosed
	};
}
//#endregion
export { successResponse as a, messageFromError as i, errorResponse as n, isPlainRecord as o, jsonRpcId as r, runJsonRpcStdioServer as t };
