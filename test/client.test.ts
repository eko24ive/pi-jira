import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeDescriptionField } from "../src/adf.js";
import { jiraDownloadFiles, jiraJson, jiraUploadAttachments } from "../src/client.js";
import type { JiraWorkspace } from "../src/types.js";

const originalFetch = globalThis.fetch;
const workspace: JiraWorkspace = {
	profileName: "test",
	siteUrl: "https://example.atlassian.net",
	email: "user@example.com",
	apiToken: "token",
	root: "/tmp",
	exportBaseDir: "/tmp/pi-jira-test",
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Jira client mutations", () => {
	test("uploads files as multipart attachments with Jira CSRF bypass", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-upload-"));
		const filePath = join(directory, "sample.txt");
		await writeFile(filePath, "sample", "utf8");

		try {
			globalThis.fetch = (async (input, init) => {
				expect(String(input)).toBe("https://example.atlassian.net/rest/api/3/issue/HRMM-1/attachments");
				expect(init?.method).toBe("POST");
				expect(init?.headers).toMatchObject({ Accept: "application/json", "X-Atlassian-Token": "no-check" });
				expect(init?.body).toBeInstanceOf(FormData);
				const files = (init?.body as FormData).getAll("file");
				expect(files).toHaveLength(1);
				expect((files[0] as File).name).toBe("sample.txt");
				expect(await (files[0] as File).text()).toBe("sample");
				return Response.json([{ id: "10", filename: "sample.txt" }]);
			}) as typeof fetch;

			await expect(jiraUploadAttachments(workspace, "HRMM-1", [filePath])).resolves.toEqual([{ id: "10", filename: "sample.txt" }]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("preflights every upload path before starting a mutation", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-upload-preflight-"));
		const videoPath = join(directory, "sample.mp4");
		await writeFile(videoPath, "video", "utf8");
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			return Response.json({});
		}) as typeof fetch;

		try {
			await expect(jiraUploadAttachments(workspace, "HRMM-1", [videoPath, join(directory, "missing.png")])).rejects.toThrow();
			expect(requests).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("uploads videos through the documented REST attachment endpoint", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-video-"));
		const filePath = join(directory, "sample.mov");
		const content = Buffer.from("video sample");
		await writeFile(filePath, content);
		let requests = 0;

		try {
			globalThis.fetch = (async (input, init) => {
				requests++;
				expect(String(input)).toBe("https://example.atlassian.net/rest/api/3/issue/HRMM-1/attachments");
				const files = (init?.body as FormData).getAll("file");
				expect(files).toHaveLength(1);
				expect((files[0] as File).name).toBe("sample.mov");
				expect((files[0] as File).type).toBe("video/quicktime");
				expect(Buffer.from(await (files[0] as File).arrayBuffer())).toEqual(content);
				return Response.json([{ id: "20", filename: "sample.mov", size: content.byteLength, mimeType: "video/quicktime" }]);
			}) as typeof fetch;

			await expect(jiraUploadAttachments(workspace, "HRMM-1", [filePath])).resolves.toEqual([
				{ id: "20", filename: "sample.mov", size: content.byteLength, mimeType: "video/quicktime" },
			]);
			expect(requests).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rejects successful non-JSON responses", async () => {
		globalThis.fetch = (async () => new Response("<html>login</html>")) as typeof fetch;
		await expect(jiraJson(workspace, "GET", "/issue/HRMM-1")).rejects.toThrow("returned invalid JSON");
	});

	test("downloads atomically and refuses to overwrite existing files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-download-"));
		const outputPath = join(directory, "attachment.bin");
		await writeFile(outputPath, "existing", "utf8");
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("replacement");
		}) as typeof fetch;

		try {
			await expect(jiraDownloadFiles(workspace, [{ apiPath: "/attachment/content/10", outputPath: outputPath }])).rejects.toThrow("Refusing to overwrite");
			expect(fetched).toBe(false);
			expect(await readFile(outputPath, "utf8")).toBe("existing");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("publishes successful downloads without leaving temporary files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-download-"));
		const outputPath = join(directory, "attachment.bin");
		globalThis.fetch = (async () => new Response("complete")) as typeof fetch;

		try {
			await jiraDownloadFiles(workspace, [{ apiPath: "/attachment/content/10", outputPath: outputPath }]);
			expect(await readFile(outputPath, "utf8")).toBe("complete");
			expect(await readdir(directory)).toEqual(["attachment.bin"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("rolls back completed files when a batch download fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-jira-download-batch-"));
		let request = 0;
		globalThis.fetch = (async () => {
			request++;
			return request === 1 ? new Response("complete") : new Response("failed", { status: 500 });
		}) as typeof fetch;

		try {
			await expect(
				jiraDownloadFiles(workspace, [
					{ apiPath: "/attachment/content/10", outputPath: join(directory, "10.bin") },
					{ apiPath: "/attachment/content/11", outputPath: join(directory, "11.bin") },
				]),
			).rejects.toThrow("failed: 500");
			expect(await readdir(directory)).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("normalizes string descriptions for create and edit payloads", () => {
		const normalized = normalizeDescriptionField({ summary: "Test", description: "Plain text" });
		expect(normalized.summary).toBe("Test");
		expect(normalized.description).toMatchObject({ type: "doc", version: 1 });
	});

	test("sends deleteSubtasks when deleting an issue", async () => {
		globalThis.fetch = (async (input, init) => {
			expect(String(input)).toBe("https://example.atlassian.net/rest/api/3/issue/HRMM-1?deleteSubtasks=false");
			expect(init?.method).toBe("DELETE");
			return new Response(null, { status: 204 });
		}) as typeof fetch;

		await expect(jiraJson(workspace, "DELETE", "/issue/HRMM-1", { query: { deleteSubtasks: false } })).resolves.toBeUndefined();
	});
});
