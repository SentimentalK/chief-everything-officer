import type { GitHubAppClient } from "../github/app-client.js";
import type { GitCredential, GitCredentialProvider } from "../git.js";

export class GitHubAppGitCredentialProvider implements GitCredentialProvider {
  constructor(
    private readonly appClient: GitHubAppClient,
    private readonly installationId: string,
    private readonly repositoryId: string,
  ) {}

  async getCredential(): Promise<GitCredential> {
    const token = await this.appClient.getScopedInstallationToken({
      githubInstallationId: this.installationId,
      repositoryIds: [this.repositoryId],
      permissions: { contents: "write" },
    });
    return {
      username: "x-access-token",
      token,
    };
  }
}
