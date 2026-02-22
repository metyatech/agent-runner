import { createAppAuth } from "@octokit/auth-app";
import { resolveGitHubNotifyAppConfig } from "./github-notify-app.js";

export async function buildGitHubNotifyChildEnv(workdirRoot: string): Promise<NodeJS.ProcessEnv> {
  const config = resolveGitHubNotifyAppConfig(workdirRoot);
  if (!config) {
    return {};
  }

  try {
    const auth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId
    });
    const token = await auth({ type: "installation" });
    return {
      GH_TOKEN: token.token,
      GITHUB_TOKEN: token.token
    };
  } catch {
    return {};
  }
}
