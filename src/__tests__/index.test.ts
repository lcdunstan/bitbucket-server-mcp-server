import { vi, describe, test, expect, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { AxiosInstance, AxiosResponse } from "axios";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

function createAxiosResponse<T>(data: T): AxiosResponse<T> {
  return {
    data,
    status: 200,
    statusText: "OK",
    headers: {},
    config: {} as AxiosResponse<T>["config"],
  };
}

const mockCreate: Mock<(config?: unknown) => AxiosInstance> = vi.fn();
const mockApiGet: Mock<(url: string) => Promise<AxiosResponse>> = vi.fn();
const mockApiPost: Mock<
  (url: string, data?: unknown) => Promise<AxiosResponse>
> = vi.fn();
const mockApiPut: Mock<
  (url: string, data?: unknown) => Promise<AxiosResponse>
> = vi.fn();
const mockIsAxiosError: Mock<(payload: unknown) => boolean> = vi.fn();
const mockSetRequestHandler: Mock<
  (
    schema: typeof CallToolRequestSchema | typeof ListToolsRequestSchema,
    handler:
      | ((request: CallToolRequest) => Promise<CallToolResult>)
      | ((request: ListToolsRequest) => Promise<ListToolsResult>),
  ) => void
> = vi.fn();

vi.mock("axios", () => {
  const mockAxios = {
    create: mockCreate,
    isAxiosError: mockIsAxiosError,
  };
  return {
    default: mockAxios,
  };
});

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => {
  return {
    Server: class MockServer {
      setRequestHandler = mockSetRequestHandler;
      connect = vi.fn();
      onerror = undefined;
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// Dynamic import after mocks are registered.
const { BitbucketServer } = await import("../index.js");

// ---- helpers ----------------------------------------------------------------

function withEnv(vars: NodeJS.ProcessEnv, fn: () => void): void {
  const original = process.env;
  process.env = { ...vars };
  try {
    fn();
  } finally {
    process.env = original;
  }
}

function makeServer(env: NodeJS.ProcessEnv): void {
  withEnv(env, () => {
    new BitbucketServer();
  });
}

async function callTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
  // ListToolsRequestSchema is registered first (index 0), CallToolRequestSchema second (index 1).
  type Handler = (
    req: unknown,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handler = mockSetRequestHandler.mock.calls[1]?.[1] as
    | Handler
    | undefined;
  if (!handler) throw new Error("CallTool handler not registered");
  return handler(
    { params: { name: toolName, arguments: args } },
    {},
  ) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

const BASE_ENV: NodeJS.ProcessEnv = {
  BITBUCKET_URL: "https://bb.example.com",
  BITBUCKET_TOKEN: "test-token",
  BITBUCKET_DEFAULT_PROJECT: "DEFAULT",
};

// ---- tests ------------------------------------------------------------------

describe("BitbucketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReturnValue({
      get: mockApiGet,
      post: mockApiPost,
      put: mockApiPut,
    } as unknown as AxiosInstance);
  });

  describe("Configuration", () => {
    test("should throw if BITBUCKET_URL is not defined", () => {
      withEnv({ BITBUCKET_TOKEN: "tok" }, () => {
        expect(() => new BitbucketServer()).toThrow(
          "BITBUCKET_URL is required",
        );
      });
    });

    test("should throw if neither token nor credentials are provided", () => {
      withEnv({ BITBUCKET_URL: "https://bb.example.com" }, () => {
        expect(() => new BitbucketServer()).toThrow(
          "Either BITBUCKET_TOKEN or BITBUCKET_USERNAME/PASSWORD is required",
        );
      });
    });

    test("should configure axios with token and read default project", () => {
      withEnv(
        {
          BITBUCKET_URL: "https://bb.example.com",
          BITBUCKET_TOKEN: "test-token",
        },
        () => {
          new BitbucketServer();
          expect(mockCreate).toHaveBeenCalledWith(
            expect.objectContaining({
              baseURL: "https://bb.example.com/rest/api/1.0",
              headers: expect.objectContaining({
                Authorization: "Bearer test-token",
              }),
            }),
          );
        },
      );
    });

    test("should include custom headers when BITBUCKET_CUSTOM_HEADERS is set", () => {
      withEnv(
        {
          BITBUCKET_URL: "https://bb.example.com",
          BITBUCKET_TOKEN: "test-token",
          BITBUCKET_CUSTOM_HEADERS:
            "X-Zero-Trust-Token=eyJ.payload.sig,X-Custom=value",
        },
        () => {
          new BitbucketServer();
          const call = mockCreate.mock.calls[0];
          if (!call || call.length === 0)
            throw new Error("mockCreate was not called");
          const config = call[0] as { headers: Record<string, string> };
          expect(Object.keys(config.headers)).toContain("X-Zero-Trust-Token");
          expect(Object.keys(config.headers)).toContain("X-Custom");
          expect(config.headers["X-Zero-Trust-Token"]).toBe("eyJ.payload.sig");
          expect(config.headers["X-Custom"]).toBe("value");
        },
      );
    });

    test("should not add extra headers when BITBUCKET_CUSTOM_HEADERS is unset", () => {
      withEnv(
        {
          BITBUCKET_URL: "https://bb.example.com",
          BITBUCKET_TOKEN: "test-token",
        },
        () => {
          new BitbucketServer();
          const call = mockCreate.mock.calls[0];
          if (!call || call.length === 0)
            throw new Error("mockCreate was not called");
          const callArgs = call[0] as { headers: Record<string, string> };
          expect(Object.keys(callArgs.headers)).toEqual(["Authorization"]);
        },
      );
    });
  });

  describe("Pull Request Operations", () => {
    beforeEach(() => {
      makeServer(BASE_ENV);
    });

    test("should create a pull request with explicit project", async () => {
      mockApiPost.mockResolvedValueOnce(createAxiosResponse({ id: 1 }));

      const result = await callTool("create_pull_request", {
        project: "TEST",
        repository: "repo",
        title: "Test PR",
        description: "Test description",
        sourceBranch: "feature",
        targetBranch: "main",
        reviewers: ["user1"],
      });

      expect(mockApiPost).toHaveBeenCalledWith(
        "/projects/TEST/repos/repo/pull-requests",
        expect.objectContaining({
          title: "Test PR",
          description: "Test description",
          fromRef: expect.any(Object),
          toRef: expect.any(Object),
          reviewers: [{ user: { name: "user1" } }],
        }),
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
    });

    test("should create a pull request using default project", async () => {
      mockApiPost.mockResolvedValueOnce(createAxiosResponse({ id: 1 }));

      const result = await callTool("create_pull_request", {
        repository: "repo",
        title: "Test PR",
        description: "Test description",
        sourceBranch: "feature",
        targetBranch: "main",
        reviewers: ["user1"],
      });

      expect(mockApiPost).toHaveBeenCalledWith(
        "/projects/DEFAULT/repos/repo/pull-requests",
        expect.objectContaining({
          title: "Test PR",
          description: "Test description",
          fromRef: expect.any(Object),
          toRef: expect.any(Object),
          reviewers: [{ user: { name: "user1" } }],
        }),
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 1 });
    });

    test("should throw error when no project is provided or defaulted", async () => {
      vi.clearAllMocks();
      mockCreate.mockReturnValue({
        get: mockApiGet,
        post: mockApiPost,
        put: mockApiPut,
      } as unknown as AxiosInstance);
      makeServer({
        BITBUCKET_URL: "https://bb.example.com",
        BITBUCKET_TOKEN: "tok",
      });

      await expect(
        callTool("get_pull_request", { repository: "repo", prId: 1 }),
      ).rejects.toThrow("Project must be provided");
    });

    test("should merge a pull request", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({ id: 1, version: 3 }),
      );
      mockApiPost.mockResolvedValueOnce(
        createAxiosResponse({ state: "MERGED" }),
      );

      const result = await callTool("merge_pull_request", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        message: "Merged PR",
        strategy: "squash",
      });

      expect(mockApiPost).toHaveBeenCalledWith(
        "/projects/TEST/repos/repo/pull-requests/1/merge",
        expect.objectContaining({
          version: 3,
          message: "Merged PR",
          strategy: "squash",
        }),
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ state: "MERGED" });
    });

    test("should handle API errors", async () => {
      mockIsAxiosError.mockReturnValue(true);
      mockApiGet.mockRejectedValueOnce({
        response: { data: { message: "Not found" } },
        message: "Request failed",
      });

      await expect(
        callTool("get_pull_request", {
          project: "TEST",
          repository: "repo",
          prId: 1,
        }),
      ).rejects.toThrow("Bitbucket API error: Not found");
    });
  });

  describe("Reviews and Comments", () => {
    beforeEach(() => {
      makeServer(BASE_ENV);
    });

    test("should filter review activities", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({
          values: [
            { action: "APPROVED", user: { name: "user1" } },
            { action: "COMMENTED", user: { name: "user2" } },
            { action: "REVIEWED", user: { name: "user3" } },
          ],
          isLastPage: true,
        }),
      );

      const result = await callTool("get_reviews", {
        project: "TEST",
        repository: "repo",
        prId: 1,
      });

      const { values: reviews, isLastPage } = JSON.parse(result.content[0].text);
      expect(reviews).toHaveLength(2);
      expect(
        reviews.every((r: { action: string }) =>
          ["APPROVED", "REVIEWED"].includes(r.action),
        ),
      ).toBe(true);
      expect(isLastPage).toBe(true);
    });

    test("should add comment with parent", async () => {
      mockApiPost.mockResolvedValueOnce(createAxiosResponse({ id: 456 }));

      const result = await callTool("add_comment", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        text: "Test comment",
        parentId: 123,
      });

      expect(mockApiPost).toHaveBeenCalledWith(
        "/projects/TEST/repos/repo/pull-requests/1/comments",
        { text: "Test comment", parent: { id: 123 } },
      );
      expect(JSON.parse(result.content[0].text)).toEqual({ id: 456 });
    });
  });

  describe("Activities / Comments / Reviews pagination", () => {
    beforeEach(() => {
      makeServer(BASE_ENV);
    });

    const ACTIVITIES_URL =
      "/projects/TEST/repos/repo/pull-requests/1/activities";

    // ---- start / limit pass-through ----------------------------------------

    test("get_activities passes start and limit to the API", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({ values: [], isLastPage: true }),
      );

      await callTool("get_activities", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        start: 25,
        limit: 50,
      });

      expect(mockApiGet).toHaveBeenCalledWith(ACTIVITIES_URL, {
        params: { start: 25, limit: 50 },
      });
    });

    test("get_comments passes start and limit to the API", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({ values: [], isLastPage: true }),
      );

      await callTool("get_comments", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        start: 25,
        limit: 50,
      });

      expect(mockApiGet).toHaveBeenCalledWith(ACTIVITIES_URL, {
        params: { start: 25, limit: 50 },
      });
    });

    test("get_reviews passes start and limit to the API", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({ values: [], isLastPage: true }),
      );

      await callTool("get_reviews", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        start: 25,
        limit: 50,
      });

      expect(mockApiGet).toHaveBeenCalledWith(ACTIVITIES_URL, {
        params: { start: 25, limit: 50 },
      });
    });

    test("get_activities without pagination sends no params", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({ values: [], isLastPage: true }),
      );

      await callTool("get_activities", {
        project: "TEST",
        repository: "repo",
        prId: 1,
      });

      expect(mockApiGet).toHaveBeenCalledWith(ACTIVITIES_URL, {
        params: {},
      });
    });

    // ---- fetchAll walks multiple pages --------------------------------------

    test("get_activities with fetchAll walks all pages and returns merged values", async () => {
      mockApiGet
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [{ action: "COMMENTED", id: 1 }],
            isLastPage: false,
            nextPageStart: 1,
          }),
        )
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [{ action: "APPROVED", id: 2 }],
            isLastPage: true,
          }),
        );

      const result = await callTool("get_activities", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        fetchAll: true,
      });

      expect(mockApiGet).toHaveBeenCalledTimes(2);
      expect(mockApiGet).toHaveBeenNthCalledWith(1, ACTIVITIES_URL, {
        params: { start: 0, limit: 100 },
      });
      expect(mockApiGet).toHaveBeenNthCalledWith(2, ACTIVITIES_URL, {
        params: { start: 1, limit: 100 },
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.values).toHaveLength(2);
      expect(parsed.isLastPage).toBe(true);
      expect(parsed.size).toBe(2);
    });

    test("get_comments with fetchAll filters COMMENTED across all pages", async () => {
      mockApiGet
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [
              { action: "COMMENTED", id: 1 },
              { action: "APPROVED", id: 2 },
            ],
            isLastPage: false,
            nextPageStart: 2,
          }),
        )
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [
              { action: "COMMENTED", id: 3 },
              { action: "REVIEWED", id: 4 },
            ],
            isLastPage: true,
          }),
        );

      const result = await callTool("get_comments", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        fetchAll: true,
      });

      expect(mockApiGet).toHaveBeenCalledTimes(2);
      const comments = JSON.parse(result.content[0].text);
      expect(comments).toHaveLength(2);
      expect(comments.every((c: { action: string }) => c.action === "COMMENTED")).toBe(true);
    });

    test("get_reviews with fetchAll filters APPROVED and REVIEWED across all pages", async () => {
      mockApiGet
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [
              { action: "COMMENTED", id: 1 },
              { action: "APPROVED", id: 2 },
            ],
            isLastPage: false,
            nextPageStart: 2,
          }),
        )
        .mockResolvedValueOnce(
          createAxiosResponse({
            values: [
              { action: "REVIEWED", id: 3 },
              { action: "COMMENTED", id: 4 },
            ],
            isLastPage: true,
          }),
        );

      const result = await callTool("get_reviews", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        fetchAll: true,
      });

      expect(mockApiGet).toHaveBeenCalledTimes(2);
      const reviews = JSON.parse(result.content[0].text);
      expect(reviews).toHaveLength(2);
      expect(
        reviews.every((r: { action: string }) =>
          ["APPROVED", "REVIEWED"].includes(r.action),
        ),
      ).toBe(true);
    });

    // ---- paged result exposes nextPageStart ---------------------------------

    test("get_comments returns isLastPage and nextPageStart for further paging", async () => {
      mockApiGet.mockResolvedValueOnce(
        createAxiosResponse({
          values: [{ action: "COMMENTED", id: 1 }],
          isLastPage: false,
          nextPageStart: 25,
        }),
      );

      const result = await callTool("get_comments", {
        project: "TEST",
        repository: "repo",
        prId: 1,
        limit: 25,
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.isLastPage).toBe(false);
      expect(parsed.nextPageStart).toBe(25);
      expect(parsed.values).toHaveLength(1);
    });
  });

  describe("Build Status Operations", () => {
    beforeEach(() => {
      makeServer(BASE_ENV);
    });

    describe("get_commit_build_status", () => {
      test("should fetch build statuses for a commit", async () => {
        const buildData = {
          size: 2,
          values: [
            { state: "SUCCESSFUL", key: "build-1", name: "CI Pipeline", url: "https://ci.example.com/1" },
            { state: "FAILED", key: "build-2", name: "Security Scan", url: "https://ci.example.com/2" },
          ],
        };
        mockApiGet.mockResolvedValueOnce(createAxiosResponse(buildData));

        const result = await callTool("get_commit_build_status", {
          commitHash: "abc123def456abc123def456abc123def456abc1",
        });

        expect(mockApiGet).toHaveBeenCalledWith(
          "/commits/abc123def456abc123def456abc123def456abc1",
          expect.objectContaining({
            baseURL: "https://bb.example.com/rest/build-status/1.0",
            params: {},
          }),
        );
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.values).toHaveLength(2);
        expect(parsed.values[0].state).toBe("SUCCESSFUL");
      });

      test("should forward pagination params", async () => {
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({ size: 1, values: [{ state: "INPROGRESS", key: "build-3" }] }),
        );

        await callTool("get_commit_build_status", {
          commitHash: "abc123def456abc123def456abc123def456abc1",
          limit: 10,
          start: 5,
        });

        expect(mockApiGet).toHaveBeenCalledWith(
          "/commits/abc123def456abc123def456abc123def456abc1",
          expect.objectContaining({
            params: { limit: 10, start: 5 },
          }),
        );
      });
    });

    describe("get_commit_build_summary", () => {
      test("should fetch aggregated build counts for a commit", async () => {
        const summaryData = { successful: 3, failed: 1, inProgress: 0 };
        mockApiGet.mockResolvedValueOnce(createAxiosResponse(summaryData));

        const result = await callTool("get_commit_build_summary", {
          commitHash: "abc123def456abc123def456abc123def456abc1",
        });

        expect(mockApiGet).toHaveBeenCalledWith(
          "/commits/stats/abc123def456abc123def456abc123def456abc1",
          expect.objectContaining({
            baseURL: "https://bb.example.com/rest/build-status/1.0",
          }),
        );
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.successful).toBe(3);
        expect(parsed.failed).toBe(1);
        expect(parsed.inProgress).toBe(0);
      });
    });

    describe("get_pull_request_build_status", () => {
      test("should resolve PR head commit and return combined build info", async () => {
        // First call: get PR details
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({
            fromRef: { latestCommit: "head123abc456def789head123abc456def789ab" },
          }),
        );
        // Second call: build status for that commit
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({
            values: [{ state: "SUCCESSFUL", key: "pipeline", name: "CI" }],
          }),
        );
        // Third call: build summary
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({ successful: 1, failed: 0, inProgress: 0 }),
        );

        const result = await callTool("get_pull_request_build_status", {
          project: "TEST",
          repository: "my-repo",
          prId: 42,
        });

        // Verify PR was fetched
        expect(mockApiGet).toHaveBeenCalledWith(
          "/projects/TEST/repos/my-repo/pull-requests/42",
        );
        // Verify build status fetched with head commit
        expect(mockApiGet).toHaveBeenCalledWith(
          "/commits/head123abc456def789head123abc456def789ab",
          expect.objectContaining({
            baseURL: "https://bb.example.com/rest/build-status/1.0",
          }),
        );
        // Verify combined response
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.commit).toBe("head123abc456def789head123abc456def789ab");
        expect(parsed.summary.successful).toBe(1);
        expect(parsed.builds).toHaveLength(1);
        expect(parsed.builds[0].state).toBe("SUCCESSFUL");
      });

      test("should throw when head commit cannot be determined", async () => {
        // PR response with no latestCommit
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({ fromRef: {} }),
        );

        await expect(
          callTool("get_pull_request_build_status", {
            project: "TEST",
            repository: "my-repo",
            prId: 99,
          }),
        ).rejects.toThrow("Could not determine head commit for pull request");
      });

      test("should use default project when project is omitted", async () => {
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({
            fromRef: { latestCommit: "def456abc789def456abc789def456abc789def4" },
          }),
        );
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({ values: [] }),
        );
        mockApiGet.mockResolvedValueOnce(
          createAxiosResponse({ successful: 0, failed: 0, inProgress: 0 }),
        );

        await callTool("get_pull_request_build_status", {
          repository: "my-repo",
          prId: 7,
        });

        // Should use DEFAULT from BASE_ENV
        expect(mockApiGet).toHaveBeenCalledWith(
          "/projects/DEFAULT/repos/my-repo/pull-requests/7",
        );
      });
    });
  });

  describe("create_or_update_file", () => {
    beforeEach(() => {
      makeServer(BASE_ENV);
    });

    function getFormValue(form: unknown, key: string): string | null {
      // Node's global FormData is used by the implementation.
      return (form as FormData).get(key) as string | null;
    }

    test("commits file content to the browse endpoint with explicit project", async () => {
      mockApiPut.mockResolvedValueOnce(
        createAxiosResponse({ id: "newcommit123" }),
      );

      const result = await callTool("create_or_update_file", {
        project: "TEST",
        repository: "repo",
        filePath: "src/config.yml",
        content: "key: value\n",
        message: "Update config",
        branch: "main",
        sourceCommitId: "oldcommit456",
      });

      expect(mockApiPut).toHaveBeenCalledTimes(1);
      const [url, form] = mockApiPut.mock.calls[0];
      expect(url).toBe("/projects/TEST/repos/repo/browse/src/config.yml");
      expect(getFormValue(form, "content")).toBe("key: value\n");
      expect(getFormValue(form, "message")).toBe("Update config");
      expect(getFormValue(form, "branch")).toBe("main");
      expect(getFormValue(form, "sourceCommitId")).toBe("oldcommit456");
      expect(JSON.parse(result.content[0].text)).toEqual({ id: "newcommit123" });
    });

    test("uses default project and encodes path segments", async () => {
      mockApiPut.mockResolvedValueOnce(createAxiosResponse({ id: "c1" }));

      await callTool("create_or_update_file", {
        repository: "repo",
        filePath: "docs/my file.md",
        content: "# Title",
        message: "Add doc",
        branch: "main",
      });

      const [url, form] = mockApiPut.mock.calls[0];
      // Space encoded, slash preserved as separator.
      expect(url).toBe("/projects/DEFAULT/repos/repo/browse/docs/my%20file.md");
      // Optional fields omitted when not provided.
      expect(getFormValue(form, "sourceCommitId")).toBeNull();
      expect(getFormValue(form, "sourceBranch")).toBeNull();
    });

    test("includes sourceBranch when creating a new branch", async () => {
      mockApiPut.mockResolvedValueOnce(createAxiosResponse({ id: "c2" }));

      await callTool("create_or_update_file", {
        repository: "repo",
        filePath: "README.md",
        content: "hello",
        message: "edit on new branch",
        branch: "feature/edit",
        sourceBranch: "main",
      });

      const [, form] = mockApiPut.mock.calls[0];
      expect(getFormValue(form, "sourceBranch")).toBe("main");
    });

    test("surfaces conflict errors from the API", async () => {
      mockIsAxiosError.mockReturnValue(true);
      mockApiPut.mockRejectedValueOnce({
        response: {
          status: 409,
          data: { message: "The file has changed since commit oldcommit456" },
        },
        message: "Request failed with status code 409",
      });

      await expect(
        callTool("create_or_update_file", {
          project: "TEST",
          repository: "repo",
          filePath: "src/config.yml",
          content: "key: value",
          message: "Update config",
          branch: "main",
          sourceCommitId: "oldcommit456",
        }),
      ).rejects.toThrow(
        "Bitbucket API error: The file has changed since commit oldcommit456",
      );
    });

    test("is rejected in read-only mode", async () => {
      vi.clearAllMocks();
      mockCreate.mockReturnValue({
        get: mockApiGet,
        post: mockApiPost,
        put: mockApiPut,
      } as unknown as AxiosInstance);
      makeServer({ ...BASE_ENV, BITBUCKET_READ_ONLY: "true" });

      await expect(
        callTool("create_or_update_file", {
          repository: "repo",
          filePath: "README.md",
          content: "x",
          message: "m",
          branch: "main",
        }),
      ).rejects.toThrow("not available in read-only mode");
      expect(mockApiPut).not.toHaveBeenCalled();
    });
  });
});
