/**
 * Approval scopes and untrusted-content tracking for write tools.
 *
 * A grant for "this task" or "always" lets later calls of the same write tool run without
 * asking, but only while the task hasn't read untrusted content: after that, every write asks
 * again and only a one-off approval is offered. That keeps a prompt injection in an email or
 * PR from using an earlier grant.
 */
import type { JsonValue } from '../json'
import type { ApprovalScope, PreferenceStore } from '../ports'

const ALWAYS_ALLOWED_KEY = 'always_allowed_tools'

/** The user's "always allow" choices, kept in the preference store. */
export class ApprovalPolicy {
  constructor(private readonly store: PreferenceStore) {}

  async alwaysAllowed(): Promise<string[]> {
    const value: JsonValue | undefined = await this.store.get(ALWAYS_ALLOWED_KEY)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  }

  async isAlwaysAllowed(toolName: string): Promise<boolean> {
    return (await this.alwaysAllowed()).includes(toolName)
  }

  async allowAlways(toolName: string): Promise<void> {
    const current = await this.alwaysAllowed()
    if (!current.includes(toolName))
      await this.store.set(ALWAYS_ALLOWED_KEY, [...current, toolName].sort())
  }

  async revoke(toolName: string): Promise<void> {
    const current = await this.alwaysAllowed()
    await this.store.set(
      ALWAYS_ALLOWED_KEY,
      current.filter((name) => name !== toolName)
    )
  }
}

/** Safety state for one task (one run): "this task" grants and untrusted reads. */
export class TaskSafety {
  private readonly granted = new Set<string>()
  private readonly sources = new Set<string>()

  /** True once any tool output from outside (mail, PRs, ...) has been read in this task. */
  get tainted(): boolean {
    return this.sources.size > 0
  }

  get untrustedSources(): string[] {
    return [...this.sources]
  }

  noteUntrustedRead(toolName: string): void {
    this.sources.add(toolName)
  }

  grantForTask(toolName: string): void {
    this.granted.add(toolName)
  }

  isGrantedForTask(toolName: string): boolean {
    return this.granted.has(toolName)
  }

  /** The scopes the user may choose from right now. */
  offeredScopes(): ApprovalScope[] {
    return this.tainted ? ['once'] : ['once', 'task', 'always']
  }
}
