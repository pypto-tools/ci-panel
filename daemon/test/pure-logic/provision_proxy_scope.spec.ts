import { afterEach, describe, expect, it } from "vitest";
import { withProxyDefaults } from "../../src/service/runner_provision";

// The proxy has to reach two different environments, and only one of them was ever written.
// <dir>/.env builds the environment for jobs and steps; Runner.Listener never reads it. So a node
// that relies on the daemon's CIP_RUNNER_PROXY got a listener with no proxy at all, and the panel
// reported it as a runner that starts and immediately dies. The add-runner dialog even carries a
// button whose only purpose is pasting these variables into the listener box by hand.
//
// Both scopes take the same block under the same precedence rule, so they compose it through one
// function: two copies would drift, and the copy that drifted would be the listener one, which is
// the harder of the two to notice from the panel.

const keysOf = (proxy: string, vars?: { key: string; value: string }[]) =>
  withProxyDefaults(proxy, vars).map((v) => v.key);

afterEach(() => {
  delete process.env.CIP_RUNNER_PROXY;
});

describe("the proxy block", () => {
  it("is the four variables the runner reads", () => {
    expect(keysOf("http://127.0.0.1:7890")).toEqual([
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY"
    ]);
  });

  it("is absent when there is no proxy, rather than written empty", () => {
    // An empty HTTPS_PROXY is not the same as an unset one: the runner would take it as an
    // instruction to use a proxy at the empty address.
    expect(withProxyDefaults("", [{ key: "DEVICE_ID", value: "3" }])).toEqual([
      { key: "DEVICE_ID", value: "3" }
    ]);
  });
});

describe("what the user typed", () => {
  it("wins over the block on the same name", () => {
    const vars = withProxyDefaults("http://127.0.0.1:7890", [
      { key: "HTTPS_PROXY", value: "http://10.0.0.1:3128" }
    ]);
    expect(vars).toContainEqual({ key: "HTTPS_PROXY", value: "http://10.0.0.1:3128" });
    // Only the named one is displaced; the rest of the block still applies.
    expect(vars).toContainEqual({ key: "HTTP_PROXY", value: "http://127.0.0.1:7890" });
  });

  it("is validated, not passed through", () => {
    // This is the last point where an illegal name or a value with a newline can be refused
    // before it is written into a file the listener will be handed.
    expect(() => withProxyDefaults("", [{ key: "no-dashes", value: "x" }])).toThrow();
    expect(() => withProxyDefaults("", [{ key: "OK", value: "a\nb" }])).toThrow();
  });
});
