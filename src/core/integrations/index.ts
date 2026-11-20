import type { ToolRegistry } from '../tools'
import { GitHubApi, githubTools } from './github'
import { gmailStubTools } from './gmail-stub'

export { GITHUB_TOKEN, GitHubApi } from './github'

/** Registers every tool. Pass `github` to point the GitHub tools at a fake server in tests. */
export function registerTools(
  registry: ToolRegistry,
  github: GitHubApi = new GitHubApi()
): ToolRegistry {
  return registry.register(...githubTools(github), ...gmailStubTools())
}
