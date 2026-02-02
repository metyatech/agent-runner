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
};

export type IssueComment = {
  id: number;
  body: string;
  createdAt: string;
  author?: string | null;
};

export type LabelInfo = {
  name: string;
  color: string;
  description: string | null;
};

export class GitHubClient {
  private octokit: Octokit;
  private authLogin: string | null | undefined;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
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
        if (issue.pull_request) {
          continue;
        }
        issues.push({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          author: issue.user?.login ?? null,
          repo,
          labels: issue.labels.map((item) => (typeof item === "string" ? item : item.name ?? "")),
          url: issue.html_url
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

  async removeLabel(issue: IssueInfo, label: string): Promise<void> {
    await this.octokit.issues.removeLabel({
      owner: issue.repo.owner,
      repo: issue.repo.repo,
      issue_number: issue.number,
      name: label
    });
  }

  async comment(issue: IssueInfo, body: string): Promise<void> {
    await this.octokit.issues.createComment({
      owner: issue.repo.owner,
      repo: issue.repo.repo,
      issue_number: issue.number,
      body
    });
  }

  async findIssueByTitle(repo: RepoInfo, title: string): Promise<IssueInfo | null> {
    const escaped = title.replace(/"/g, '\\"');
    const query = `repo:${repo.owner}/${repo.repo} type:issue in:title "${escaped}"`;
    const response = await this.octokit.search.issuesAndPullRequests({
      q: query,
      per_page: 10
    });
    const match = response.data.items.find(
      (item) => !("pull_request" in item) && item.title === title
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
      labels: match.labels.map((item) => (typeof item === "string" ? item : item.name ?? "")),
      url: match.html_url
    };
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
      url: response.data.html_url
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
          author: comment.user?.login ?? null
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
      if (response.data.pull_request) {
        return null;
      }
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
        url: response.data.html_url
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
}
