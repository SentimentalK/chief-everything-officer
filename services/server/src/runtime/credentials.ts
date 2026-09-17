import type { GitHubAppClient } from "../github/app-client.js";
import type { GitCredential, GitCredentialProvider } from "../git.js";

export class GitHubAppGitCredentialProvider implements GitCredentialProvider {
  constructor(
    private readonly appClient: GitHubAppClient,
    private readonly installationId: string,
  ) {}

  async getCredential(): Promise<GitCredential> {
    const token = await this.appClient.getInstallationToken(this.installationId);
    return {
      username: "x-access-token",
      token,
    };
  }
}
