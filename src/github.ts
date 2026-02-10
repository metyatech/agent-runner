import { Octokit } from "@octokit/rest";

export type RepoInfo = {
  owner: string;
  repo: string;
};

export type IssueInfo = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  repo: RepoInfo;
  labels: string[];
  url: string;
  isPullRequest: boolean;
};

export type IssueComment = {
  id: number;
  body: string;
  createdAt: string;
  author?: string | null;
  authorAssociation?: string | null;
};

type SearchResponse = {
  data: {
    items: any[];
  };
};

export type PullRequestReviewComment = {
  id: number;
  body: string;
  createdAt: string;
  author?: string | null;
  authorAssociation?: string | null;
  url?: string | null;
  path?: string | null;
  line?: number | null;
};

export type PullRequestReview = {
  id: number;
  state: string;
  submittedAt: string | null;
  author: string | null;
  body: string | null;
};

export type PullRequestDetails = {
  number: number;
  url: string;
  draft: boolean;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headRef: string;
  headSha: string;
  headRepoFullName: string | null;
  requestedReviewerLogins: string[];
};

export type RepoMergeOptions = {
  allowSquashMerge: boolean;
  allowMergeCommit: boolean;
  allowRebaseMerge: boolean;
};

export type PullRequestReviewThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
};

export type LabelInfo = {
  name: string;
  color: string;
  description: string | null;
};

export class GitHubClient {
  private octokit: Octokit;
  private authLogin: string | null | undefined;

  constructor(tokenOrOctokit: string | Octokit) {
    this.octokit = typeof tokenOrOctokit === "string" ? new Octokit({ auth: tokenOrOctokit }) : tokenOrOctokit;
  }

  private async searchIssuesAndPullRequests(options: {
    query: string;
    sort?: "updated" | "created" | "comments";
    order?: "asc" | "desc";
    perPage: number;
    page: number;
  }): Promise<SearchResponse> {
    const response = await this.octokit.request("GET /search/issues", {
      q: options.query,
      sort: options.sort,
      order: options.order,
      per_page: options.perPage,
      page: options.page
    });
    return response as unknown as SearchResponse;
  }

  async listRepos(owner: string): Promise<RepoInfo[]> {
    const authLogin = await this.resolveAuthenticatedLogin();
    if (authLogin && authLogin.toLowerCase() === owner.toLowerCase()) {
      return this.listOwnedReposForAuthenticatedUser(owner);
    }
    return this.listReposForUser(owner);
  }

  private async resolveAuthenticatedLogin(): Promise<string | null> {
    if (this.authLogin !== undefined) {
      return this.authLogin;
    }
    try {
      const response = await this.octokit.users.getAuthenticated();
      this.authLogin = response.data.login ?? null;
    } catch {
      this.authLogin = null;
    }
    return this.authLogin;
  }

  async getAuthenticatedLogin(): Promise<string | null> {
    return this.resolveAuthenticatedLogin();
  }

  private async listOwnedReposForAuthenticatedUser(owner: string): Promise<RepoInfo[]> {
    const repos: RepoInfo[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.repos.listForAuthenticatedUser({
        affiliation: "owner",
        per_page: 100,
        page
      });
      for (const repo of response.data) {
        if (repo.owner?.login?.toLowerCase() !== owner.toLowerCase()) {
          continue;
        }
        repos.push({ owner, repo: repo.name });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return repos;
  }

  private async listReposForUser(owner: string): Promise<RepoInfo[]> {
    const repos: RepoInfo[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.repos.listForUser({
        username: owner,
        per_page: 100,
        page
      });
      for (const repo of response.data) {
        repos.push({ owner, repo: repo.name });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return repos;
  }

  async listIssuesByLabel(repo: RepoInfo, label: string): Promise<IssueInfo[]> {
    const issues: IssueInfo[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.issues.listForRepo({
        owner: repo.owner,
        repo: repo.repo,
        labels: label,
        per_page: 100,
        page,
        state: "open"
      });
      for (const issue of response.data) {
        const isPullRequest = Boolean((issue as unknown as { pull_request?: unknown }).pull_request);
        issues.push({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          author: issue.user?.login ?? null,
          repo,
          labels: issue.labels.map((item) => (typeof item === "string" ? item : item.name ?? "")),
          url: issue.html_url,
          isPullRequest
        });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return issues;
  }

  async addLabels(issue: IssueInfo, labels: string[]): Promise<void> {
    await this.octokit.issues.addLabels({
      owner: issue.repo.owner,
      repo: issue.repo.repo,
      issue_number: issue.number,
      labels
    });
  }

  async addAssignees(repo: RepoInfo, issueNumber: number, assignees: string[]): Promise<void> {
    const unique = Array.from(new Set(assignees.map((assignee) => assignee.trim()).filter((assignee) => assignee.length > 0)));
    if (unique.length === 0) {
      return;
    }
    for (let index = 0; index < unique.length; index += 10) {
      const chunk = unique.slice(index, index + 10);
      await this.octokit.issues.addAssignees({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber,
        assignees: chunk
      });
    }
  }

  async removeLabel(issue: IssueInfo, label: string): Promise<void> {
    await this.octokit.issues.removeLabel({
      owner: issue.repo.owner,
      repo: issue.repo.repo,
      issue_number: issue.number,
      name: label
    });
  }

  async commentIssue(repo: RepoInfo, issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
      body
    });
  }

  async comment(issue: IssueInfo, body: string): Promise<void> {
    await this.commentIssue(issue.repo, issue.number, body);
  }

  async findIssueByTitle(repo: RepoInfo, title: string): Promise<IssueInfo | null> {
    const escaped = title.replace(/"/g, '\\"');
    const query = `repo:${repo.owner}/${repo.repo} is:issue in:title "${escaped}"`;
    const response = await this.searchIssuesAndPullRequests({
      query,
      perPage: 10,
      page: 1
    });
    const match = response.data.items.find(
      (item: any) => !("pull_request" in item) && item.title === title
    );
    if (!match) {
      return null;
    }
    return {
      id: match.id,
      number: match.number,
      title: match.title,
      body: match.body ?? null,
      author: match.user?.login ?? null,
      repo,
      labels: match.labels.map((item: any) => (typeof item === "string" ? item : item.name ?? "")),
      url: match.html_url,
      isPullRequest: false
    };
  }

  async searchOpenIssuesByLabelAcrossOwner(
    owner: string,
    label: string,
    options?: {
      excludeLabels?: string[];
      maxPages?: number;
      perPage?: number;
    }
  ): Promise<IssueInfo[]> {
    const issues: IssueInfo[] = [];
    const encodedLabel = label.includes('"') ? label.replace(/"/g, '\\"') : label;
    const exclude = options?.excludeLabels ?? [];
    const excludeQuery = exclude
      .filter((entry) => entry.length > 0)
      .map((entry) => ` -label:"${entry.replace(/"/g, '\\"')}"`)
      .join("");
    const query = `user:${owner} is:issue state:open label:"${encodedLabel}"${excludeQuery}`;
    const pageSize = Math.min(100, Math.max(1, options?.perPage ?? 100));
    let page = 1;
    const maxPages = Math.min(10, Math.max(1, options?.maxPages ?? 10));

    while (true) {
      const response = await this.searchIssuesAndPullRequests({
        query,
        sort: "updated",
        order: "desc",
        perPage: pageSize,
        page
      });

      for (const item of response.data.items) {
        if ("pull_request" in item) {
          continue;
        }
        const repoUrl = (item as { repository_url?: string }).repository_url;
        if (!repoUrl) {
          continue;
        }
        const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repoUrl);
        if (!match) {
          continue;
        }
        const repo: RepoInfo = { owner: match[1], repo: match[2] };
        issues.push({
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body ?? null,
          author: item.user?.login ?? null,
          repo,
          labels: item.labels.map((label: any) => (typeof label === "string" ? label : label.name ?? "")),
          url: item.html_url,
          isPullRequest: false
        });
      }

      if (response.data.items.length < pageSize || response.data.items.length === 0) {
        break;
      }
      page += 1;
      if (page > maxPages) {
        break;
      }
    }

    return issues;
  }

  async searchOpenItemsByLabelAcrossOwner(
    owner: string,
    label: string,
    options?: {
      excludeLabels?: string[];
      maxPages?: number;
      perPage?: number;
    }
  ): Promise<IssueInfo[]> {
    const items: IssueInfo[] = [];
    const encodedLabel = label.includes('"') ? label.replace(/"/g, '\\"') : label;
    const exclude = options?.excludeLabels ?? [];
    const excludeQuery = exclude
      .filter((entry) => entry.length > 0)
      .map((entry) => ` -label:"${entry.replace(/"/g, '\\"')}"`)
      .join("");
    const baseQuery = `user:${owner} state:open label:"${encodedLabel}"${excludeQuery}`;
    const pageSize = Math.min(100, Math.max(1, options?.perPage ?? 100));
    const maxPages = Math.min(10, Math.max(1, options?.maxPages ?? 10));

    const qualifiers = ["is:issue", "is:pull-request"] as const;
    const seen = new Set<number>();
    for (const qualifier of qualifiers) {
      let page = 1;
      const query = `${baseQuery} ${qualifier}`;
      while (true) {
        const response = await this.searchIssuesAndPullRequests({
          query,
          sort: "updated",
          order: "desc",
          perPage: pageSize,
          page
        });

        for (const item of response.data.items as any[]) {
          if (seen.has(item.id)) {
            continue;
          }
          const repoUrl = (item as { repository_url?: string }).repository_url;
          if (!repoUrl) {
            continue;
          }
          const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repoUrl);
          if (!match) {
            continue;
          }
          const repo: RepoInfo = { owner: match[1], repo: match[2] };
          items.push({
            id: item.id,
            number: item.number,
            title: item.title,
            body: item.body ?? null,
            author: item.user?.login ?? null,
            repo,
            labels: item.labels.map((label: any) => (typeof label === "string" ? label : label.name ?? "")),
            url: item.html_url,
            isPullRequest: "pull_request" in item
          });
          seen.add(item.id);
        }

        if (response.data.items.length < pageSize || response.data.items.length === 0) {
          break;
        }
        page += 1;
        if (page > maxPages) {
          break;
        }
      }
    }

    return items;
  }

  async searchOpenItemsByCommentPhraseAcrossOwner(
    owner: string,
    phrase: string,
    options?: {
      excludeLabels?: string[];
      maxPages?: number;
      perPage?: number;
    }
  ): Promise<IssueInfo[]> {
    const items: IssueInfo[] = [];
    const encodedPhrase = phrase.replace(/"/g, '\\"');
    const exclude = options?.excludeLabels ?? [];
    const excludeQuery = exclude
      .filter((entry) => entry.length > 0)
      .map((entry) => ` -label:"${entry.replace(/"/g, '\\"')}"`)
      .join("");
    const baseQuery = `user:${owner} state:open in:comments "${encodedPhrase}"${excludeQuery}`;
    const pageSize = Math.min(100, Math.max(1, options?.perPage ?? 100));
    const maxPages = Math.min(10, Math.max(1, options?.maxPages ?? 10));

    const qualifiers = ["is:issue", "is:pull-request"] as const;
    const seen = new Set<number>();
    for (const qualifier of qualifiers) {
      let page = 1;
      const query = `${baseQuery} ${qualifier}`;
      while (true) {
        const response = await this.searchIssuesAndPullRequests({
          query,
          sort: "updated",
          order: "desc",
          perPage: pageSize,
          page
        });

        for (const item of response.data.items as any[]) {
          if (seen.has(item.id)) {
            continue;
          }
          const repoUrl = (item as { repository_url?: string }).repository_url;
          if (!repoUrl) {
            continue;
          }
          const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repoUrl);
          if (!match) {
            continue;
          }
          const repo: RepoInfo = { owner: match[1], repo: match[2] };
          items.push({
            id: item.id,
            number: item.number,
            title: item.title,
            body: item.body ?? null,
            author: item.user?.login ?? null,
            repo,
            labels: item.labels.map((label: any) => (typeof label === "string" ? label : label.name ?? "")),
            url: item.html_url,
            isPullRequest: "pull_request" in item
          });
          seen.add(item.id);
        }

        if (response.data.items.length < pageSize || response.data.items.length === 0) {
          break;
        }
        page += 1;
        if (page > maxPages) {
          break;
        }
      }
    }

    return items;
  }

  async searchOpenPullRequestsByAuthorAcrossOwner(
    owner: string,
    author: string,
    options?: {
      excludeLabels?: string[];
      maxPages?: number;
      perPage?: number;
    }
  ): Promise<IssueInfo[]> {
    const pullRequests: IssueInfo[] = [];
    const encodedAuthor = author.replace(/"/g, '\\"');
    const exclude = options?.excludeLabels ?? [];
    const excludeQuery = exclude
      .filter((entry) => entry.length > 0)
      .map((entry) => ` -label:"${entry.replace(/"/g, '\\"')}"`)
      .join("");
    const query = `user:${owner} is:pull-request state:open author:"${encodedAuthor}"${excludeQuery}`;
    const pageSize = Math.min(100, Math.max(1, options?.perPage ?? 100));
    let page = 1;
    const maxPages = Math.min(10, Math.max(1, options?.maxPages ?? 10));

    while (true) {
      const response = await this.searchIssuesAndPullRequests({
        query,
        sort: "updated",
        order: "desc",
        perPage: pageSize,
        page
      });

      for (const item of response.data.items as any[]) {
        if (!("pull_request" in item)) {
          continue;
        }
        const repoUrl = (item as { repository_url?: string }).repository_url;
        if (!repoUrl) {
          continue;
        }
        const match = /\/repos\/([^/]+)\/([^/]+)$/.exec(repoUrl);
        if (!match) {
          continue;
        }
        const repo: RepoInfo = { owner: match[1], repo: match[2] };
        pullRequests.push({
          id: item.id,
          number: item.number,
          title: item.title,
          body: item.body ?? null,
          author: item.user?.login ?? null,
          repo,
          labels: item.labels.map((label: any) => (typeof label === "string" ? label : label.name ?? "")),
          url: item.html_url,
          isPullRequest: true
        });
      }

      if (response.data.items.length < pageSize || response.data.items.length === 0) {
        break;
      }
      page += 1;
      if (page > maxPages) {
        break;
      }
    }

    return pullRequests;
  }

  async createIssue(repo: RepoInfo, title: string, body: string): Promise<IssueInfo> {
    const response = await this.octokit.issues.create({
      owner: repo.owner,
      repo: repo.repo,
      title,
      body
    });
    return {
      id: response.data.id,
      number: response.data.number,
      title: response.data.title,
      body: response.data.body ?? null,
      author: response.data.user?.login ?? null,
      repo,
      labels: response.data.labels.map((item) => (typeof item === "string" ? item : item.name ?? "")),
      url: response.data.html_url,
      isPullRequest: false
    };
  }

  async listIssueComments(issue: IssueInfo): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.issues.listComments({
        owner: issue.repo.owner,
        repo: issue.repo.repo,
        issue_number: issue.number,
        per_page: 100,
        page
      });
      for (const comment of response.data) {
        comments.push({
          id: comment.id,
          body: comment.body ?? "",
          createdAt: comment.created_at,
          author: comment.user?.login ?? null,
          authorAssociation: (comment as { author_association?: string }).author_association ?? null
        });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return comments;
  }

  async listPullRequestReviewComments(repo: RepoInfo, pullNumber: number): Promise<PullRequestReviewComment[]> {
    const comments: PullRequestReviewComment[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        per_page: 100,
        page
      });
      for (const comment of response.data) {
        comments.push({
          id: comment.id,
          body: comment.body ?? "",
          createdAt: comment.created_at,
          author: comment.user?.login ?? null,
          authorAssociation: (comment as { author_association?: string }).author_association ?? null,
          url: comment.html_url ?? null,
          path: comment.path ?? null,
          line: typeof (comment as { line?: number }).line === "number" ? (comment as { line?: number }).line! : null
        });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return comments;
  }

  async getIssue(repo: RepoInfo, issueNumber: number): Promise<IssueInfo | null> {
    try {
      const response = await this.octokit.issues.get({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: issueNumber
      });
      if (response.data.state !== "open") {
        return null;
      }
      return {
        id: response.data.id,
        number: response.data.number,
        title: response.data.title,
        body: response.data.body ?? null,
        author: response.data.user?.login ?? null,
        repo,
        labels: response.data.labels.map((item) => (typeof item === "string" ? item : item.name ?? "")),
        url: response.data.html_url,
        isPullRequest: Boolean((response.data as unknown as { pull_request?: unknown }).pull_request)
      };
    } catch (error) {
      if (error instanceof Error && "status" in error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return null;
        }
      }
      throw error;
    }
  }

  async getLabel(repo: RepoInfo, name: string): Promise<LabelInfo | null> {
    try {
      const response = await this.octokit.issues.getLabel({
        owner: repo.owner,
        repo: repo.repo,
        name
      });
      return {
        name: response.data.name,
        color: response.data.color,
        description: response.data.description ?? null
      };
    } catch (error) {
      if (error instanceof Error && "status" in error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return null;
        }
      }
      throw error;
    }
  }

  async createLabel(repo: RepoInfo, label: LabelInfo): Promise<void> {
    await this.octokit.issues.createLabel({
      owner: repo.owner,
      repo: repo.repo,
      name: label.name,
      color: label.color,
      description: label.description ?? ""
    });
  }

  async updateLabel(repo: RepoInfo, label: LabelInfo): Promise<void> {
    await this.octokit.issues.updateLabel({
      owner: repo.owner,
      repo: repo.repo,
      name: label.name,
      color: label.color,
      description: label.description ?? ""
    });
  }

  async getRepoDefaultBranch(repo: RepoInfo): Promise<string> {
    const response = await this.octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo
    });
    const branch = response.data.default_branch;
    if (!branch) {
      throw new Error(`Missing default branch for ${repo.owner}/${repo.repo}`);
    }
    return branch;
  }

  async getPullRequestHead(repo: RepoInfo, pullNumber: number): Promise<{
    headRef: string;
    headSha: string;
    headRepoFullName: string | null;
  } | null> {
    try {
      const response = await this.octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber
      });
      const headRef = response.data.head.ref;
      const headSha = response.data.head.sha;
      const headRepoFullName = response.data.head.repo?.full_name ?? null;
      if (!headRef || !headSha) {
        return null;
      }
      return { headRef, headSha, headRepoFullName };
    } catch (error) {
      if (error instanceof Error && "status" in error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return null;
        }
      }
      throw error;
    }
  }

  async getRepoMergeOptions(repo: RepoInfo): Promise<RepoMergeOptions> {
    const response = await this.octokit.repos.get({
      owner: repo.owner,
      repo: repo.repo
    });

    return {
      allowSquashMerge: Boolean((response.data as { allow_squash_merge?: boolean }).allow_squash_merge),
      allowMergeCommit: Boolean((response.data as { allow_merge_commit?: boolean }).allow_merge_commit),
      allowRebaseMerge: Boolean((response.data as { allow_rebase_merge?: boolean }).allow_rebase_merge)
    };
  }

  async getPullRequest(repo: RepoInfo, pullNumber: number): Promise<PullRequestDetails | null> {
    try {
      const response = await this.octokit.pulls.get({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber
      });

      const headRef = response.data.head.ref ?? "";
      const headSha = response.data.head.sha ?? "";
      if (!headRef || !headSha) {
        return null;
      }

      const mergeableState =
        typeof (response.data as { mergeable_state?: string }).mergeable_state === "string"
          ? (response.data as { mergeable_state?: string }).mergeable_state!
          : null;

      return {
        number: response.data.number,
        url: response.data.html_url,
        draft: Boolean((response.data as { draft?: boolean }).draft),
        state: response.data.state ?? "open",
        merged: Boolean((response.data as { merged?: boolean }).merged),
        mergeable:
          typeof (response.data as { mergeable?: boolean | null }).mergeable === "boolean"
            ? (response.data as { mergeable?: boolean | null }).mergeable!
            : (response.data as { mergeable?: boolean | null }).mergeable ?? null,
        mergeableState,
        headRef,
        headSha,
        headRepoFullName: response.data.head.repo?.full_name ?? null,
        requestedReviewerLogins: Array.isArray(
          (response.data as { requested_reviewers?: Array<{ login?: string | null }> | null }).requested_reviewers
        )
          ? (
              (response.data as { requested_reviewers?: Array<{ login?: string | null }> | null })
                .requested_reviewers ?? []
            )
              .map((reviewer) => reviewer?.login ?? "")
              .filter((reviewer): reviewer is string => reviewer.length > 0)
          : []
      };
    } catch (error) {
      if (error instanceof Error && "status" in error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return null;
        }
      }
      throw error;
    }
  }

  async findOpenPullRequestByHead(repo: RepoInfo, headBranch: string): Promise<{ number: number; url: string } | null> {
    const response = await this.octokit.pulls.list({
      owner: repo.owner,
      repo: repo.repo,
      state: "open",
      head: `${repo.owner}:${headBranch}`,
      per_page: 1,
      page: 1
    });
    const first = response.data[0];
    if (!first) {
      return null;
    }
    const number = typeof (first as { number?: unknown }).number === "number" ? (first as { number: number }).number : null;
    const url = typeof (first as { html_url?: unknown }).html_url === "string" ? (first as { html_url: string }).html_url : "";
    if (!number || number <= 0 || url.length === 0) {
      return null;
    }
    return { number, url };
  }

  async listPullRequestReviews(repo: RepoInfo, pullNumber: number): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    let page = 1;
    while (true) {
      const response = await this.octokit.pulls.listReviews({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        per_page: 100,
        page
      });
      for (const review of response.data) {
        reviews.push({
          id: review.id,
          state: review.state ?? "",
          submittedAt: (review as { submitted_at?: string | null }).submitted_at ?? null,
          author: review.user?.login ?? null,
          body: review.body ?? null
        });
      }
      if (response.data.length < 100) {
        break;
      }
      page += 1;
    }
    return reviews;
  }

  async mergePullRequest(options: {
    repo: RepoInfo;
    pullNumber: number;
    sha?: string | null;
    mergeMethod?: "merge" | "squash" | "rebase";
    commitTitle?: string | null;
    commitMessage?: string | null;
  }): Promise<{ merged: boolean; message?: string | null }> {
    const response = await this.octokit.pulls.merge({
      owner: options.repo.owner,
      repo: options.repo.repo,
      pull_number: options.pullNumber,
      sha: options.sha ?? undefined,
      merge_method: options.mergeMethod ?? undefined,
      commit_title: options.commitTitle ?? undefined,
      commit_message: options.commitMessage ?? undefined
    });
    return {
      merged: Boolean((response.data as { merged?: boolean }).merged),
      message: (response.data as { message?: string | null }).message ?? null
    };
  }

  async deleteBranchRef(repo: RepoInfo, ref: string): Promise<void> {
    await this.octokit.git.deleteRef({
      owner: repo.owner,
      repo: repo.repo,
      ref
    });
  }

  async listPullRequestReviewThreads(repo: RepoInfo, pullNumber: number): Promise<PullRequestReviewThread[]> {
    const threads: PullRequestReviewThread[] = [];
    let cursor: string | null = null;

    while (true) {
      const response = await this.octokit.request("POST /graphql", {
        query: `
          query($owner: String!, $name: String!, $number: Int!, $after: String) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $after) {
                  nodes {
                    id
                    isResolved
                    isOutdated
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        `,
        owner: repo.owner,
        name: repo.repo,
        number: pullNumber,
        after: cursor
      });

      const data = response.data as {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id: string;
                isResolved: boolean;
                isOutdated: boolean;
              }> | null;
              pageInfo?: { hasNextPage: boolean; endCursor: string | null } | null;
            } | null;
          } | null;
        } | null;
      };

      const nodes = data.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) continue;
        threads.push({
          id: node.id,
          isResolved: Boolean(node.isResolved),
          isOutdated: Boolean(node.isOutdated)
        });
      }

      const pageInfo = data.repository?.pullRequest?.reviewThreads?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) {
        break;
      }
      cursor = pageInfo.endCursor;
    }

    return threads;
  }

  async resolvePullRequestReviewThread(threadId: string): Promise<void> {
    await this.octokit.request("POST /graphql", {
      query: `
        mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread {
              id
              isResolved
            }
          }
        }
      `,
      threadId
    });
  }

  async requestPullRequestReviewers(repo: RepoInfo, pullNumber: number, reviewers: string[]): Promise<void> {
    const unique = Array.from(
      new Set(reviewers.map((reviewer) => reviewer.trim()).filter((reviewer) => reviewer.length > 0))
    );
    if (unique.length === 0) {
      return;
    }
    for (let index = 0; index < unique.length; index += 15) {
      const chunk = unique.slice(index, index + 15);
      await this.octokit.pulls.requestReviewers({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        reviewers: chunk
      });
    }
  }

  async removeRequestedPullRequestReviewers(repo: RepoInfo, pullNumber: number, reviewers: string[]): Promise<void> {
    const unique = Array.from(
      new Set(reviewers.map((reviewer) => reviewer.trim()).filter((reviewer) => reviewer.length > 0))
    );
    if (unique.length === 0) {
      return;
    }
    for (let index = 0; index < unique.length; index += 15) {
      const chunk = unique.slice(index, index + 15);
      await this.octokit.pulls.removeRequestedReviewers({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: pullNumber,
        reviewers: chunk
      });
    }
  }
}
