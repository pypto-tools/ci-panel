import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteServiceConfig } from "../../src/app/entity/entity_interface";
import RemoteService from "../../src/app/entity/remote_service";

// authRejected decides three things at once: whether a waiting request gives up, which error
// the user sees ("key rejected" vs "node unavailable"), and how often the patrol retries. So it
// has to mean exactly "the node's most recent answer was an explicit no" — neither a stale no
// from an earlier attempt nor a timeout.
//
// RemoteRequest is replaced so auth() can be driven to each outcome without a daemon. What is
// under test is RemoteService's own bookkeeping around that call, not the transport.
// vi.mock is hoisted above the imports, so the static import already sees the stand-in.

const outcome = vi.hoisted(() => ({ next: (): Promise<unknown> => Promise.resolve(true) }));

vi.mock("../../src/app/service/remote_command", () => ({
  default: class {
    request() {
      return outcome.next();
    }
  }
}));

const makeService = () => {
  const svc = new RemoteService("uuid-auth", new RemoteServiceConfig());
  // socket.io reports "active" while it is reconnecting — the state in which waiting makes sense
  svc.socket = { active: true } as never;
  return svc;
};

beforeEach(() => {
  outcome.next = () => Promise.resolve(true);
});

describe("authRejected", () => {
  it("is set when the node answers no", async () => {
    const svc = makeService();
    outcome.next = () => Promise.resolve(false);
    await svc.auth();
    expect(svc.authRejected).toBe(true);
  });

  it("is not kept from an earlier rejection when this attempt only times out", async () => {
    // Rejected once, then the next attempt times out. The timeout says nothing about the key —
    // keeping the old verdict would report "key rejected", stop waiting for a node that may be
    // coming back, and put it on the slow retry cadence reserved for rejected keys.
    const svc = makeService();
    outcome.next = () => Promise.resolve(false);
    await svc.auth();
    expect(svc.authRejected).toBe(true);

    outcome.next = () => Promise.reject(new Error("timeout"));
    await svc.auth();
    expect(svc.authRejected).toBe(false);
  });
});

describe("a rejection wakes requests that are waiting", () => {
  it("releases them at once instead of letting them sit out the wait", async () => {
    const svc = makeService();
    svc.markAvailable(); // connected once, so a drop now counts as a blip worth waiting through
    svc.markUnavailable();

    const t0 = Date.now();
    const waiting = svc.waitForReady(5000);

    outcome.next = () => Promise.resolve(false);
    await svc.auth();
    await waiting;

    // The answer is final the moment the node says no. Without the wake-up every request that
    // started waiting during the reconnect would hold for the full 5s before reporting it.
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(svc.authRejected).toBe(true);
  });
});
