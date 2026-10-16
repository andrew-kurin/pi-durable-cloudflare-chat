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
type State = Awaited<ReturnType<TaskWorkspace["open"]>>;
export type WorkspaceProgress = (
  phase: "starting" | "ready" | "failed",
) => Promise<void>;
type Binding = { workspaceId: string; fingerprint: string };
export class WorkspaceCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private starts = new Map<string, Promise<State>>();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => {});
    return next;
  }
  private stopped(session: string) {
    return this.store.get<{ epoch?: string; blocked: boolean }>(
      "workspace-auto-stop:" + session,
    );
  }
  private async stopAutomation(session: string, id: string) {
    await this.store.transaction(async (tx) => {
      if ((await tx.get<string>("workspace-session:" + session)) === id)
        await tx.put("workspace-auto-stop:" + session, {
          epoch: crypto.randomUUID(),
          blocked: true,
        });
    });
  }
  private async fingerprint(input: WorkspaceToolRequest) {
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(input)),
        ),
      ),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  }
  private state(id: string): Promise<State> {
    return this.stub(id).request(statusRequest(id)) as Promise<State>;
  }
  private start(session: string, id: string) {
    const prior = this.starts.get(id);
    if (prior) return prior;
    const job = Promise.resolve()
      .then(() =>
        this.stub(id).open(id, session, this.config.WORKSPACE_REPOSITORY!),
      )
      .finally(() => {
        if (this.starts.get(id) === job) this.starts.delete(id);
      });
    this.starts.set(id, job);
    void job.catch(() => {});
    return job;
  }
  private async cancelStarted(
    session: string,
    id: string,
    refuse = true,
    expected?: { epoch?: string },
  ) {
    const intent = await this.stopped(session);
    if (intent?.blocked || (expected && intent?.epoch !== expected.epoch)) {
      const operationId = await this.fingerprint({
        action: "cancel",
        workspaceId: id,
        operationId: "activation-stop",
      });
      try {
        await this.stub(id).request({
          workspaceId: id,
          action: "cancel",
          operationId,
        });
      } catch {}
      if (!refuse) return this.state(id);
      throw new RequestError(
        409,
        "Workspace startup was cancelled. Open a workspace explicitly to resume.",
      );
    }
  }
  private async reserve(session: string, id: string, manual: boolean) {
    const intent = await this.stopped(session);
    const old = await this.store.get<string>("workspace-session:" + session);
    if (old && old !== id) {
      if (this.starts.has(old) || (await this.state(old)).phase !== "closed")
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
      if (
        this.starts.has(active) ||
        (await this.state(active)).phase !== "closed"
      )
        throw new RequestError(
          409,
          "Cancel the active workspace before opening another task",
        );
    }
    await this.store.transaction(async (tx) => {
      const latest = await tx.get<{ epoch?: string; blocked: boolean }>(
        "workspace-auto-stop:" + session,
      );
      if (latest?.blocked && (!manual || latest.epoch !== intent?.epoch))
        throw new RequestError(
          409,
          "Workspace was stopped. Open a workspace explicitly to resume.",
        );
      if (manual)
        await tx.put("workspace-auto-stop:" + session, {
          ...(latest?.epoch ? { epoch: latest.epoch } : {}),
          blocked: false,
        });
      await tx.put("workspace-active", id);
      await tx.put("workspace-owner:" + id, session);
      await tx.put("workspace-session:" + session, id);
    });
  }

  constructor(
    private store: Pick<DurableObjectStorage, "get" | "put" | "transaction">,
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
  async execute(
    session: string,
    input: WorkspaceToolRequest,
    progress?: WorkspaceProgress,
  ) {
    this.ensureEnabled();
    const activates = ["read", "edit", "exec"].includes(input.action);
    if (!activates) {
      const id =
        input.workspaceId ??
        (await this.store.get<string>("workspace-session:" + session));
      if (!id)
        throw Error("No workspace is associated with this conversation.");
      const stub = await this.owned(session, id);
      if (input.action === "cancel") {
        if (!/^[a-f0-9]{64}$/.test(input.operationId))
          throw new RequestError(400, "Invalid operation ID");
        await this.stopAutomation(session, id);
      }
      return stub.request({ ...input, workspaceId: id } as WorkspaceRequest);
    }
    if (!/^[a-f0-9]{64}$/.test(input.operationId))
      throw new RequestError(400, "Invalid operation ID");
    const fingerprint = await this.fingerprint(input),
      key = "workspace-activation-op:" + session + ":" + input.operationId;
    const plan = await this.serial(async () => {
      await this.requireChat(session);
      if ((await this.stopped(session))?.blocked)
        throw new RequestError(
          409,
          "Workspace was stopped. Open a workspace explicitly to resume.",
        );
      const binding = await this.store.get<Binding>(key);
      if (binding && binding.fingerprint !== fingerprint)
        throw new RequestError(409, "Operation ID already used");
      let id =
        binding?.workspaceId ??
        input.workspaceId ??
        (await this.store.get<string>("workspace-session:" + session));
      let startup: Promise<State> | undefined;
      if (id) {
        await this.owned(session, id);
        startup = this.starts.get(id);
        if (!startup) {
          const state = await this.state(id);
          if (state.phase === "initializing") startup = this.start(session, id);
          else if (state.phase === "closed" && !binding) {
            if (input.workspaceId || state.canAutoReplace !== true)
              throw new RequestError(
                409,
                "Previous workspace is closed and may contain work. Open a new workspace explicitly; saved artifacts remain available.",
              );
            id = undefined;
          } else if (state.phase === "stopping")
            throw new RequestError(
              409,
              "Workspace is stopping. Wait for cleanup; no operation was started.",
            );
        }
      }
      if (!id) {
        id = crypto.randomUUID();
        await this.reserve(session, id, false);
        startup = this.start(session, id);
      }
      if (!binding) await this.store.put(key, { workspaceId: id, fingerprint });
      return { id, startup, epoch: (await this.stopped(session))?.epoch };
    });
    let activating = !!plan.startup;
    try {
      if (plan.startup) {
        await progress?.("starting");
        const state = await plan.startup;
        await this.cancelStarted(session, plan.id, true, { epoch: plan.epoch });
        if (state.phase !== "ready")
          throw new RequestError(
            503,
            "Workspace startup failed; no tool operation ran. Open a workspace explicitly to try again.",
          );
        await progress?.("ready");
        activating = false;
      }
      await this.cancelStarted(session, plan.id, true, { epoch: plan.epoch });
      // One dispatch, no automatic retries. The guest journal owns operation deduplication.
      return await this.stub(plan.id).request({
        ...input,
        workspaceId: plan.id,
      } as WorkspaceRequest);
    } catch (error) {
      if (activating)
        try {
          await progress?.("failed");
        } catch {}
      throw error;
    }
  }
  async open(session: string, id: string) {
    this.ensureEnabled();
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new RequestError(400, "Invalid workspace ID");
    const plan = await this.serial(async () => {
      await this.reserve(session, id, true);
      return { startup: this.start(session, id) };
    });
    const state = await plan.startup;
    return (await this.cancelStarted(session, id, false)) ?? state;
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
    const stub = await this.owned(session, id);
    if (action === "cancel") {
      if (!/^[a-f0-9]{64}$/.test(operationId))
        throw new RequestError(400, "Invalid operation ID");
      await this.stopAutomation(session, id);
    }
    return stub.request({ workspaceId: id, action, operationId });
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
