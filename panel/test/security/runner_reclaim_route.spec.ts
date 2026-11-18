import type Router from "@koa/router";
import { io } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../setup";
import router from "../../src/app/routers/runner_router";
import { ROLE, User } from "../../src/app/entity/user";
import { RemoteServiceConfig } from "../../src/app/entity/entity_interface";
import RemoteService from "../../src/app/entity/remote_service";
import RemoteRequest from "../../src/app/service/remote_command";
import remoteServices from "../../src/app/service/remote_service";
import users from "../../src/app/service/user_service";

const layer = router.stack.find((r) => r.path === "/runner/reclaim")!;
const socket = io("http://127.0.0.1:1", { autoConnect: false });
const remote = new RemoteService("node", new RemoteServiceConfig());
remote.socket = socket;

beforeEach(() => {
  users.objects.clear();
  for (const [uuid, level] of [
    ["admin", ROLE.ADMIN],
    ["user", ROLE.USER]
  ] as const) {
    const user = new User();
    user.uuid = uuid;
    user.userName = uuid;
    user.permission = level;
    users.objects.set(uuid, user);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  socket.disconnect();
});

async function request(body: unknown, uuid = "admin") {
  const header = { "x-requested-with": "XMLHttpRequest" };
  const fake = {
    method: "POST",
    query: { daemonId: "node", token: "T" },
    header,
    request: { header, body },
    session: { login: true, token: "T", uuid, userName: uuid },
    status: 200,
    body: undefined as unknown
  };
  const ctx = fake as unknown as Router.RouterContext;
  async function next(i = 0): Promise<void> {
    if (i < layer.stack.length) await layer.stack[i](ctx, () => next(i + 1));
  }
  await next();
  return fake;
}

describe("runner reclaim HTTP boundary", () => {
  it("requires administrator permission", async () => {
    const forward = vi.spyOn(remoteServices, "getInstance");
    const result = await request({ dir: "/runners/example" }, "user");
    expect(result.status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { dir: {} },
    { dir: "" },
    { dir: "relative" },
    { dir: "/bad\0path" }
  ])("rejects malformed input %j before forwarding", async (body) => {
    const forward = vi.spyOn(remoteServices, "getInstance");
    expect((await request(body)).status).toBe(400);
    expect(forward).not.toHaveBeenCalled();
  });

  it("forwards only the directory, never a caller-supplied process identity", async () => {
    vi.spyOn(remoteServices, "getInstance").mockReturnValue(remote);
    const forward = vi
      .spyOn(RemoteRequest.prototype, "request")
      .mockResolvedValue({ ownership: "self" });
    const result = await request({ dir: "/runners/example", pid: 1, pgid: 1 });
    expect(forward).toHaveBeenCalledWith("runner/reclaim", { dir: "/runners/example" }, 30000);
    expect(result.body).toEqual({ ownership: "self" });
  });

  it("returns a daemon refusal as an error, not a successful empty object", async () => {
    vi.spyOn(remoteServices, "getInstance").mockReturnValue(remote);
    vi.spyOn(RemoteRequest.prototype, "request").mockRejectedValue(new Error("recovery refused"));
    const result = await request({ dir: "/runners/example" });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ err: "recovery refused" });
  });
});
