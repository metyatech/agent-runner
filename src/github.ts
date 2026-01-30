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
  repo: RepoInfo;
  labels: string[];
  url: string;
};

export class GitHubClient {
  private octokit: Octokit;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }

  async listRepos(owner: string): Promise<RepoInfo[]> {
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
}
