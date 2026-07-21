/**
 * Global Jira config and cwd-to-workspace resolution.
 *
 * This module is the only place that reads `~/.pi/agent/jira.json`. The Jira
 * extension intentionally ignores project-local config so a repository cannot
 * silently change Jira credentials or workspace routing.
 */
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DISPLAY_PATH, DEFAULT_EXPORT_BASE_DIR, type JiraConfig, type JiraWorkspace, type JiraWorkspaceConfig } from "./types.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "jira.json");

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function expandUserPath(input: string): string {
	let value = input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
	value = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "");
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function resolveConfigPath(pathValue: string): string {
	const expanded = expandUserPath(pathValue);
	return isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
}

/** Resolve a user-provided output directory from `ctx.cwd`, supporting `~` and env interpolation. */
export function normalizeOutputDir(pathValue: string, cwd: string): string {
	const withoutAt = pathValue.startsWith("@") ? pathValue.slice(1) : pathValue;
	const expanded = expandUserPath(withoutAt);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Read and minimally validate the global user-owned Jira config. */
async function readConfig(): Promise<JiraConfig> {
	let raw: string;
	try {
		raw = await readFile(CONFIG_PATH, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(`Jira config not found: ${CONFIG_DISPLAY_PATH}`);
		throw new Error(`Could not read Jira config ${CONFIG_DISPLAY_PATH}: ${message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: ${message}`);
	}

	const config = asObject(parsed);
	if (!config) throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: expected a JSON object.`);
	if (!asObject(config.profiles)) throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: profiles must be an object.`);
	if (!Array.isArray(config.workspaces)) throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: workspaces must be an array.`);

	return parsed as JiraConfig;
}

function normalizeSiteUrl(siteUrl: string, profileName: string): string {
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		throw new Error(`Jira profile "${profileName}" has invalid siteUrl.`);
	}

	if (url.protocol !== "https:" || !url.hostname.endsWith(".atlassian.net")) {
		throw new Error(`Jira profile "${profileName}" siteUrl must be an https://*.atlassian.net URL.`);
	}
	if (url.pathname !== "/" && url.pathname !== "") {
		throw new Error(`Jira profile "${profileName}" siteUrl must not include a path.`);
	}
	url.hash = "";
	url.search = "";
	return url.origin;
}

function pathContains(root: string, cwd: string): boolean {
	const rel = relative(root, cwd);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(message);
	return value;
}

/** Validate one workspace mapping without accepting extra policy knobs. */
function parseWorkspaceConfig(raw: unknown, index: number): JiraWorkspaceConfig {
	const workspace = asObject(raw);
	if (!workspace) throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: workspaces[${index}] must be an object.`);

	const root = requireString(workspace.root, `Invalid Jira config ${CONFIG_DISPLAY_PATH}: workspaces[${index}].root must be a string.`);
	const profile = requireString(workspace.profile, `Invalid Jira config ${CONFIG_DISPLAY_PATH}: workspaces[${index}].profile must be a string.`);

	return {
		root,
		profile,
	};
}

/**
 * Resolve the Jira workspace for the current Pi cwd.
 *
 * The deepest matching configured root wins. If no root contains `cwd`, Jira is
 * disabled for that session location and tools fail before touching Jira.
 */
export async function resolveWorkspace(cwd: string): Promise<JiraWorkspace> {
	const config = await readConfig();
	let realCwd: string;
	try {
		realCwd = await realpath(cwd);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Jira disabled here: cwd does not exist: ${cwd} (${message})`);
	}

	const matches: Array<{ config: JiraWorkspaceConfig; root: string }> = [];
	for (let index = 0; index < config.workspaces.length; index++) {
		const workspace = parseWorkspaceConfig(config.workspaces[index], index);
		let workspaceRoot: string;
		try {
			workspaceRoot = await realpath(resolveConfigPath(workspace.root));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Invalid Jira config ${CONFIG_DISPLAY_PATH}: workspace root not found: ${workspace.root} (${message})`);
		}

		if (pathContains(workspaceRoot, realCwd)) matches.push({ config: workspace, root: workspaceRoot });
	}

	if (matches.length === 0) {
		throw new Error("Jira disabled here: cwd is not under any configured jira workspace root.");
	}

	matches.sort((a, b) => b.root.length - a.root.length);
	if (matches.length > 1 && matches[0].root.length === matches[1].root.length) {
		throw new Error(`Jira disabled here: multiple jira workspace roots match cwd at the same depth: ${matches[0].root}`);
	}

	const workspace = matches[0];
	const profileName = workspace.config.profile;
	const profile = config.profiles[profileName];
	if (!profile || typeof profile !== "object") {
		throw new Error(`Jira profile "${profileName}" not found in ${CONFIG_DISPLAY_PATH}.`);
	}

	const siteUrl = normalizeSiteUrl(requireString(profile.siteUrl, `Jira profile "${profileName}" requires siteUrl.`), profileName);
	const email = requireString(profile.email, `Jira profile "${profileName}" requires email in ${CONFIG_DISPLAY_PATH}.`);
	const apiToken = requireString(profile.apiToken, `Jira profile "${profileName}" requires apiToken in ${CONFIG_DISPLAY_PATH}.`);

	const exportBaseDir = normalizeOutputDir(config.export?.baseDir ?? DEFAULT_EXPORT_BASE_DIR, cwd);

	return {
		profileName,
		siteUrl,
		email,
		apiToken,
		root: workspace.root,
		exportBaseDir,
	};
}
