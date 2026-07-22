import { afterEach, describe, expect, test } from "bun:test";
import { fetchAllComments, fetchIssues, searchAllIssueKeys, searchIssues } from "../src/issues.js";
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

const issue = (key: string, parentKey?: string) => ({
	key,
	fields: {
		summary: `Summary ${key}`,
		status: { name: "To Do" },
		issuetype: { name: "Task" },
		parent: parentKey ? { key: parentKey } : undefined,
		labels: ["backend"],
	},
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Jira issue reads", () => {
	test("formats search links and parent keys without retaining the raw response", async () => {
		globalThis.fetch = (async () => Response.json({ issues: [issue("HRMM-1", "HRMM-EPIC")], nextPageToken: "next" })) as typeof fetch;
		const result = await searchIssues(workspace, { jql: "project = HRMM", fields: ["labels"] });

		expect(result.text).toContain("[HRMM-1](https://example.atlassian.net/browse/HRMM-1)");
		expect(result.text).toContain("parent:HRMM-EPIC");
		expect(result.text).toContain('fields:{"labels":["backend"]}');
		expect(result.details.nextPageToken).toBe("next");
		expect(result.details).not.toHaveProperty("rawResponse");
	});

	test("accepts null continuation tokens on final search pages", async () => {
		globalThis.fetch = (async () => Response.json({ issues: [], nextPageToken: null, isLast: true })) as typeof fetch;
		await expect(searchIssues(workspace, { jql: "project = HRMM" })).resolves.toMatchObject({ details: { nextPageToken: undefined } });
	});

	test("fetches explicit issues through one bulk request", async () => {
		let requests = 0;
		globalThis.fetch = (async (input, init) => {
			requests++;
			expect(String(input)).toBe("https://example.atlassian.net/rest/api/3/issue/bulkfetch");
			expect(JSON.parse(String(init?.body))).toMatchObject({ issueIdsOrKeys: ["HRMM-1", "HRMM-2"], fields: ["summary"] });
			return Response.json({ issues: [issue("HRMM-1"), issue("HRMM-2")], issueErrors: [] });
		}) as typeof fetch;

		const result = await fetchIssues(workspace, ["HRMM-1", "HRMM-2"], ["summary"]);
		expect(result.issues.map((item) => item.key)).toEqual(["HRMM-1", "HRMM-2"]);
		expect(requests).toBe(1);
	});

	test("rejects malformed comment pages instead of returning an empty list", async () => {
		globalThis.fetch = (async () => Response.json({ comments: "not-an-array", total: 1 })) as typeof fetch;
		await expect(fetchAllComments(workspace, "HRMM-1")).rejects.toThrow("invalid page");
	});

	test("rejects fractional comment pagination metadata", async () => {
		globalThis.fetch = (async () => Response.json({ comments: [], startAt: 0, maxResults: 100, total: 0.5 })) as typeof fetch;
		await expect(fetchAllComments(workspace, "HRMM-1")).rejects.toThrow("inconsistent pagination");
	});

	test("follows enhanced-search tokens up to the requested total", async () => {
		const requestBodies: Array<Record<string, unknown>> = [];
		globalThis.fetch = (async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requestBodies.push(body);
			if (requestBodies.length === 1) return Response.json({ issues: [issue("HRMM-1"), issue("HRMM-2")], nextPageToken: "page-2" });
			return Response.json({ issues: [issue("HRMM-3")] });
		}) as typeof fetch;

		await expect(searchAllIssueKeys(workspace, "project = HRMM", 3)).resolves.toEqual(["HRMM-1", "HRMM-2", "HRMM-3"]);
		expect(requestBodies).toHaveLength(2);
		expect(requestBodies[0]).toMatchObject({ maxResults: 3 });
		expect(requestBodies[1]).toMatchObject({ maxResults: 1, nextPageToken: "page-2" });
	});

	test("continues pagination when pages repeat issue keys", async () => {
		let request = 0;
		globalThis.fetch = (async () => {
			request++;
			if (request === 1) return Response.json({ issues: [issue("HRMM-1"), issue("HRMM-2")], nextPageToken: "page-2" });
			if (request === 2) return Response.json({ issues: [issue("HRMM-2"), issue("HRMM-3")], nextPageToken: "page-3" });
			return Response.json({ issues: [issue("HRMM-4")], nextPageToken: null, isLast: true });
		}) as typeof fetch;

		await expect(searchAllIssueKeys(workspace, "project = HRMM", 4)).resolves.toEqual(["HRMM-1", "HRMM-2", "HRMM-3", "HRMM-4"]);
		expect(request).toBe(3);
	});
});
