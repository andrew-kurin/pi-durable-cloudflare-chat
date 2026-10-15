import type { TaskWorkspace } from "./workspace-container";
import type { WorkspaceRequest, WorkspaceToolRequest } from "./workspace-tools";
import { RequestError } from "./http-input";
interface Config {
  ENABLE_WORKSPACE?: string;
  WORKSPACE_IMAGE?: string;
  WORKSPACE_REPOSITORY?: string;
  Workspaces?: DurableObjectNamespace<TaskWorkspace>;
}
const statusRequest = (workspaceId: string) => ({
  workspaceId,
  action: "status" as const,
  operationId: "0".repeat(64),
});
/** Chat-to-workspace policy. The guest lifecycle belongs exclusively to TaskWorkspace.
 * open() must run in the Assistant mutation queue; cancel/extend must bypass it.
 */
export class WorkspaceCoordinator {
  constructor(
    private store: Pick<DurableObjectStorage, "get" | "put">,
    private config: Config,
    private requireChat: (id: string) => Promise<unknown>,
  ) {}
  enabled() {
    const c = this.config;
    return (
      c.ENABLE_WORKSPACE === "true" &&
      !!c.WORKSPACE_IMAGE &&
      !!c.Workspaces &&
      !!c.WORKSPACE_REPOSITORY &&
      /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(
        c.WORKSPACE_REPOSITORY,
      ) &&
      !c.WORKSPACE_REPOSITORY.split("/").some((x) => x === "." || x === "..")
    );
  }
  private ensureEnabled() {
    if (!this.enabled()) throw new RequestError(403, "Workspace disabled");
  }
  private stub(id: string) {
    return this.config.Workspaces!.getByName(id);
  }
  private async owned(session: string, id: string) {
    this.ensureEnabled();
    if ((await this.store.get<string>("workspace-owner:" + id)) !== session)
      throw new RequestError(404, "Workspace not found");
    return this.stub(id);
  }
  async current(session: string) {
    this.ensureEnabled();
    return {
      workspaceId: await this.store.get<string>("workspace-session:" + session),
    };
  }
  async execute(session: string, input: WorkspaceToolRequest) {
    this.ensureEnabled();
    const id =
      input.workspaceId ??
      (await this.store.get<string>("workspace-session:" + session));
    if (!id) throw Error("Ask the owner to open a workspace first");
    if ((await this.store.get<string>("workspace-owner:" + id)) !== session)
      throw Error("Workspace is not approved for this conversation");
    return this.stub(id).request({
      ...input,
      workspaceId: id,
    } as WorkspaceRequest);
  }
  async open(session: string, id: string) {
    this.ensureEnabled();
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new RequestError(400, "Invalid workspace ID");
    const old = await this.store.get<string>("workspace-session:" + session);
    if (old && old !== id) {
      const state = (await this.execute(session, statusRequest(old))) as {
        phase: string;
      };
      if (state.phase !== "closed")
        throw new RequestError(
          409,
          "Cancel the active workspace before opening another",
        );
    }
    await this.requireChat(session);
    const owner = await this.store.get<string>("workspace-owner:" + id);
    if (owner && owner !== session)
      throw new RequestError(409, "Workspace identity conflict");
    const active = await this.store.get<string>("workspace-active");
    if (active && active !== id) {
      const state = (await this.stub(active).request(
        statusRequest(active),
      )) as { phase: string };
      if (state.phase !== "closed")
        throw new RequestError(
          409,
          "Cancel the active workspace before opening another task",
        );
    }
    // Reserve mappings durably before long setup; cancel must be able to find them.
    await this.store.put("workspace-active", id);
    await this.store.put("workspace-owner:" + id, session);
    await this.store.put("workspace-session:" + session, id);
    return this.stub(id).open(id, session, this.config.WORKSPACE_REPOSITORY!);
  }
  async status(session: string, id: string) {
    return (await this.owned(session, id)).request(statusRequest(id));
  }
  async ownerAction(
    session: string,
    id: string,
    action: "cancel" | "export",
    operationId: string,
  ) {
    return (await this.owned(session, id)).request({
      workspaceId: id,
      action,
      operationId,
    });
  }
  async extend(
    session: string,
    id: string,
    target: "task" | "command",
    minutes: number,
  ) {
    return (await this.owned(session, id)).extend(target, minutes);
  }
  async artifact(session: string, id: string, exportId?: string) {
    return (await this.owned(session, id)).artifact(exportId);
  }
  async assertChatCanBeTrashed(session: string) {
    const id = await this.store.get<string>("workspace-session:" + session);
    if (id && this.enabled()) {
      const state = (await this.execute(session, statusRequest(id))) as {
        phase: string;
      };
      if (state.phase !== "closed")
        throw new RequestError(
          409,
          "Close the workspace before deleting this chat",
        );
    }
  }
}
