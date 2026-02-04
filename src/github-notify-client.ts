import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { GitHubClient } from "./github.js";
import { resolveGitHubNotifyToken } from "./github-notify-token.js";
import { resolveGitHubNotifyAppConfig } from "./github-notify-app.js";

export type GitHubNotifyClientSource = "github-app" | "token";

export type GitHubNotifyClientResult = {
  client: GitHubClient;
  source: GitHubNotifyClientSource;
};

export function createGitHubNotifyClient(workdirRoot: string): GitHubNotifyClientResult | null {
  const appConfig = resolveGitHubNotifyAppConfig(workdirRoot);
  if (appConfig) {
    const octokit = new Octokit({
      baseUrl: appConfig.apiBaseUrl,
      authStrategy: createAppAuth,
      auth: {
        appId: appConfig.appId,
        privateKey: appConfig.privateKey,
        installationId: appConfig.installationId
      }
    });
    return { client: new GitHubClient(octokit), source: "github-app" };
  }

  const token = resolveGitHubNotifyToken(workdirRoot);
  if (token) {
    return { client: new GitHubClient(token), source: "token" };
  }

  return null;
}

