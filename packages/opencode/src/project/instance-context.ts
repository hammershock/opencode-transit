import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Location } from "@opencode-ai/core/location"
import type { Project } from "./project"
import type { WorkspaceV2 } from "@opencode-ai/core/workspace"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
  target?: Location.Target
  workspaceID?: WorkspaceV2.ID
}

/** Placement identity excludes display names and distinguishes omitted/local from remote targets. */
export function instanceKey(input: Pick<InstanceContext, "directory" | "target" | "workspaceID">) {
  return JSON.stringify([
    input.target?.type === "rexd" ? input.target.targetID : "local",
    input.directory,
    input.workspaceID ?? null,
  ])
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  if (FSUtil.contains(ctx.directory, filepath)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(ctx.worktree, filepath)
}
