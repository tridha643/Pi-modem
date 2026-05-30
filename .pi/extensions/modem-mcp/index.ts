import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type JsonRecord = Record<string, unknown>;

type StoredOAuthState = {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
};

type ModemToolInfo = {
	name: string;
	description?: string;
	inputSchema?: {
		type: "object";
		properties?: Record<string, object>;
		required?: string[];
	};
};

const MODEM_MCP_URL = process.env.MODEM_MCP_URL ?? "https://mcp.modem.dev/mcp";
const CALLBACK_PORT = Number(process.env.MODEM_MCP_CALLBACK_PORT ?? "17173");
const CALLBACK_PATH = process.env.MODEM_MCP_CALLBACK_PATH ?? "/callback";
const CALLBACK_URL = process.env.MODEM_MCP_CALLBACK_URL ?? `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
const AUTH_TIMEOUT_MS = Number(process.env.MODEM_MCP_AUTH_TIMEOUT_MS ?? "300000");
const TOKEN_FILE = process.env.MODEM_MCP_TOKEN_FILE ?? join(homedir(), ".pi", "agent", "modem-mcp-oauth.json");
const CLIENT_NAME = "Pi Modem MCP Extension";
const CLIENT_VERSION = "0.1.0";
const INVOKE_TOOL_NAME = "invoke_modem_agent";

function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function readStoredOAuthState(): Promise<StoredOAuthState> {
	try {
		const raw = await readFile(TOKEN_FILE, "utf8");
		return JSON.parse(raw) as StoredOAuthState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function writeStoredOAuthState(state: StoredOAuthState): Promise<void> {
	await mkdir(dirname(TOKEN_FILE), { recursive: true });
	await writeFile(TOKEN_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(TOKEN_FILE, 0o600);
	} catch {
		// chmod can fail on some filesystems; the write mode above is the important bit.
	}
}

class PersistentOAuthProvider implements OAuthClientProvider {
	clientMetadataUrl?: string;
	private storedState: StoredOAuthState = {};
	private loaded = false;
	private pendingAuthorizationUrl: URL | undefined;

	constructor(
		private readonly redirectUri: string,
		private readonly metadata: OAuthClientMetadata,
	) {}

	get redirectUrl(): string {
		return this.redirectUri;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.metadata;
	}

	get authorizationUrl(): URL | undefined {
		return this.pendingAuthorizationUrl;
	}

	clearAuthorizationUrl(): void {
		this.pendingAuthorizationUrl = undefined;
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.storedState = await readStoredOAuthState();
		this.loaded = true;
	}

	private async save(): Promise<void> {
		await writeStoredOAuthState(this.storedState);
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		await this.ensureLoaded();
		return this.storedState.clientInformation;
	}

	async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
		await this.ensureLoaded();
		this.storedState.clientInformation = clientInformation;
		await this.save();
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		await this.ensureLoaded();
		return this.storedState.tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		await this.ensureLoaded();
		this.storedState.tokens = tokens;
		await this.save();
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.pendingAuthorizationUrl = authorizationUrl;
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.ensureLoaded();
		this.storedState.codeVerifier = codeVerifier;
		await this.save();
	}

	async codeVerifier(): Promise<string> {
		await this.ensureLoaded();
		if (!this.storedState.codeVerifier) {
			throw new Error("No OAuth code verifier was saved for the pending Modem authorization flow.");
		}
		return this.storedState.codeVerifier;
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		await this.ensureLoaded();
		this.storedState.discoveryState = discoveryState;
		await this.save();
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		await this.ensureLoaded();
		return this.storedState.discoveryState;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.ensureLoaded();
		if (scope === "all") {
			this.storedState = {};
		} else if (scope === "client") {
			delete this.storedState.clientInformation;
		} else if (scope === "tokens") {
			delete this.storedState.tokens;
		} else if (scope === "verifier") {
			delete this.storedState.codeVerifier;
		} else if (scope === "discovery") {
			delete this.storedState.discoveryState;
		}
		await this.save();
	}
}

function openBrowser(url: string): void {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => undefined);
	child.unref();
}

async function waitForOAuthCallback(timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let server: Server | undefined;
		let done = false;

		const finish = (error: Error | undefined, code?: string) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			server?.close();
			if (error) reject(error);
			else resolve(code ?? "");
		};

		const timer = setTimeout(() => {
			finish(new Error(`Timed out waiting for Modem OAuth callback after ${Math.round(timeoutMs / 1000)}s.`));
		}, timeoutMs);

		server = createServer((req, res) => {
			const requestUrl = new URL(req.url ?? "/", CALLBACK_URL);
			if (requestUrl.pathname !== new URL(CALLBACK_URL).pathname) {
				res.writeHead(404, { "content-type": "text/plain" });
				res.end("Not found");
				return;
			}

			const code = requestUrl.searchParams.get("code");
			const error = requestUrl.searchParams.get("error");
			if (error) {
				res.writeHead(400, { "content-type": "text/html" });
				res.end("<h1>Modem authorization failed</h1><p>You can close this window and return to pi.</p>");
				finish(new Error(`Modem OAuth authorization failed: ${error}`));
				return;
			}

			if (!code) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("Missing authorization code");
				return;
			}

			res.writeHead(200, { "content-type": "text/html" });
			res.end("<h1>Modem authorized</h1><p>You can close this window and return to pi.</p>");
			finish(undefined, code);
		});

		server.on("error", finish);
		server.listen(CALLBACK_PORT, "127.0.0.1");
	});
}

function createOAuthProvider(): PersistentOAuthProvider {
	return new PersistentOAuthProvider(CALLBACK_URL, {
		client_name: CLIENT_NAME,
		redirect_uris: [CALLBACK_URL],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "client_secret_post",
	});
}

async function writeTempOutput(content: string): Promise<string> {
	const path = join(tmpdir(), `pi-modem-mcp-${randomUUID()}.txt`);
	await writeFile(path, content, "utf8");
	return path;
}

async function truncateToolText(content: string): Promise<string> {
	const truncation = truncateHead(content, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncation.truncated) return truncation.content;

	const tempFile = await writeTempOutput(content);
	return `${truncation.content}\n\n[Modem output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full output saved to: ${tempFile}]`;
}

async function formatMcpContent(content: unknown): Promise<string> {
	if (!Array.isArray(content)) return truncateToolText(JSON.stringify(content, null, 2));

	const parts = content.map((part) => {
		if (!part || typeof part !== "object") return JSON.stringify(part);
		const record = part as JsonRecord;
		if (record.type === "text" && typeof record.text === "string") return record.text;
		if (record.type === "image") return "[Modem returned an image content item; see tool details for raw data.]";
		if (record.type === "audio") return "[Modem returned an audio content item; see tool details for raw data.]";
		return JSON.stringify(record, null, 2);
	});

	return truncateToolText(parts.filter(Boolean).join("\n\n"));
}

function buildInvokeArguments(tool: ModemToolInfo | undefined, prompt: string): JsonRecord {
	const properties = tool?.inputSchema?.properties ?? {};
	const required = tool?.inputSchema?.required ?? [];
	const preferredKeys = ["prompt", "query", "question", "input", "message"];

	for (const key of preferredKeys) {
		if (key in properties) return { [key]: prompt };
	}

	const requiredStringKeys = required.filter((key) => {
		const prop = properties[key] as JsonRecord | undefined;
		return prop?.type === "string";
	});
	if (requiredStringKeys.length === 1) return { [requiredStringKeys[0]]: prompt };

	const stringKeys = Object.entries(properties)
		.filter(([, value]) => (value as JsonRecord | undefined)?.type === "string")
		.map(([key]) => key);
	if (stringKeys.length === 1) return { [stringKeys[0]]: prompt };

	return { prompt };
}

class ModemMcpClientManager {
	private client: Client | undefined;
	private transport: StreamableHTTPClientTransport | undefined;
	private provider = createOAuthProvider();
	private connectPromise: Promise<Client> | undefined;

	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.transport = undefined;
		this.connectPromise = undefined;
		await client?.close().catch(() => undefined);
	}

	async resetAuth(): Promise<void> {
		await this.close();
		await rm(TOKEN_FILE, { force: true });
		this.provider = createOAuthProvider();
	}

	async connect(ctx?: ExtensionContext): Promise<Client> {
		if (this.client) return this.client;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = this.connectFresh(ctx).finally(() => {
			this.connectPromise = undefined;
		});
		return this.connectPromise;
	}

	private async connectFresh(ctx?: ExtensionContext): Promise<Client> {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const client = new Client({ name: "pi-modem-mcp", version: CLIENT_VERSION }, { capabilities: {} });
			const transport = new StreamableHTTPClientTransport(new URL(MODEM_MCP_URL), { authProvider: this.provider });
			try {
				await client.connect(transport);
				this.client = client;
				this.transport = transport;
				return client;
			} catch (error) {
				await client.close().catch(() => undefined);
				if (!(error instanceof UnauthorizedError)) throw error;

				const authorizationUrl = this.provider.authorizationUrl;
				if (!authorizationUrl) {
					throw new Error("Modem requires OAuth, but the MCP SDK did not provide an authorization URL.");
				}

				const callbackPromise = waitForOAuthCallback(AUTH_TIMEOUT_MS);
				const urlText = authorizationUrl.toString();
				if (ctx?.hasUI) {
					ctx.ui.notify(`Authorize Modem in your browser: ${urlText}`, "info");
				} else {
					console.error(`Authorize Modem in your browser: ${urlText}`);
				}
				openBrowser(urlText);

				const code = await callbackPromise;
				await transport.finishAuth(code);
				this.provider.clearAuthorizationUrl();
			}
		}

		throw new Error("Modem OAuth authorization completed, but reconnecting to the Modem MCP server failed.");
	}

	async listTools(ctx?: ExtensionContext): Promise<ModemToolInfo[]> {
		const client = await this.connect(ctx);
		const result = await client.listTools();
		return result.tools as ModemToolInfo[];
	}

	async invokeAgent(prompt: string, ctx?: ExtensionContext, signal?: AbortSignal, timeoutMs?: number): Promise<{ text: string; raw: unknown; arguments: JsonRecord }> {
		const client = await this.connect(ctx);
		const tools = await this.listTools(ctx);
		const tool = tools.find((candidate) => candidate.name === INVOKE_TOOL_NAME);
		if (!tool) {
			throw new Error(`Modem MCP server did not expose ${INVOKE_TOOL_NAME}. Available tools: ${tools.map((candidate) => candidate.name).join(", ") || "none"}`);
		}

		const args = buildInvokeArguments(tool, prompt);
		const result = await client.callTool(
			{ name: INVOKE_TOOL_NAME, arguments: args },
			CallToolResultSchema,
			{ signal, timeout: timeoutMs, resetTimeoutOnProgress: true },
		);
		return { text: await formatMcpContent(result.content), raw: result, arguments: args };
	}
}

const manager = new ModemMcpClientManager();

const invokeModemAgentTool = defineTool({
	name: "invoke_modem_agent",
	label: "Invoke Modem Agent",
	description: "Ask the Modem Agent about customer feedback, topics, people, companies, and connected tools via Modem's remote MCP server.",
	promptSnippet: "Ask Modem about customer feedback, topics, people, companies, and connected tools",
	promptGuidelines: [
		"Use invoke_modem_agent when the user asks a question that should be answered from Modem customer-feedback data or Modem-connected tools.",
		"Every invoke_modem_agent call is self-contained; include all context the Modem Agent needs in the prompt.",
	],
	parameters: Type.Object({
		prompt: Type.String({
			description: "A complete, self-contained natural-language task for the Modem Agent.",
		}),
		timeoutMs: Type.Optional(Type.Number({
			description: "Optional MCP request timeout in milliseconds. Defaults to the MCP SDK timeout.",
		})),
	}),
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		onUpdate?.({ content: [{ type: "text", text: "Calling the Modem MCP server..." }], details: {} });
		try {
			const result = await manager.invokeAgent(params.prompt, ctx, signal, params.timeoutMs);
			return {
				content: [{ type: "text", text: result.text || "Modem returned no text content." }],
				details: {
					serverUrl: MODEM_MCP_URL,
					mcpTool: INVOKE_TOOL_NAME,
					arguments: result.arguments,
					result: result.raw,
				},
			};
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				await manager.close();
			}
			return {
				content: [{ type: "text", text: `Modem MCP call failed: ${asErrorMessage(error)}` }],
				details: { serverUrl: MODEM_MCP_URL, error: asErrorMessage(error) },
				isError: true,
			};
		}
	},
});

const modemMcpToolsTool = defineTool({
	name: "list_modem_mcp_tools",
	label: "List Modem MCP Tools",
	description: "List tools exposed by the Modem MCP server and verify OAuth connectivity.",
	promptSnippet: "List Modem MCP server tools and auth/connectivity status",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
		try {
			const tools = await manager.listTools(ctx);
			return {
				content: [{ type: "text", text: tools.map((tool) => `- ${tool.name}${tool.description ? `: ${tool.description}` : ""}`).join("\n") || "No tools returned by Modem MCP." }],
				details: { serverUrl: MODEM_MCP_URL, tools },
			};
		} catch (error) {
			return {
				content: [{ type: "text", text: `Could not list Modem MCP tools: ${asErrorMessage(error)}` }],
				details: { serverUrl: MODEM_MCP_URL, error: asErrorMessage(error) },
				isError: true,
			};
		}
	},
});

export default function modemMcpExtension(pi: ExtensionAPI) {
	pi.registerTool(invokeModemAgentTool);
	pi.registerTool(modemMcpToolsTool);

	pi.registerCommand("modem-auth", {
		description: "Authorize and verify the Modem MCP connection",
		handler: async (_args, ctx) => {
			try {
				const tools = await manager.listTools(ctx);
				ctx.ui.notify(`Connected to Modem MCP. Tools: ${tools.map((tool) => tool.name).join(", ") || "none"}`, "info");
			} catch (error) {
				ctx.ui.notify(`Modem MCP authorization failed: ${asErrorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("modem-reset-auth", {
		description: "Delete saved Modem MCP OAuth credentials",
		handler: async (_args, ctx) => {
			await manager.resetAuth();
			ctx.ui.notify("Deleted saved Modem MCP OAuth credentials. Run /modem-auth to authorize again.", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		await manager.close();
	});
}
