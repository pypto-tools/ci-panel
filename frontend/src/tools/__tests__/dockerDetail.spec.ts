import { mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { describe, expect, it } from "vitest";

import { buildDockerDetailContent } from "../dockerDetail";
import type { ContainerInfo, ImageInfo } from "@/types";

// 这个 spec 守的是一条边界，不是一个格式：详情里的每个字段都来自 daemon 转发的 Docker
// 响应，而 ImageInfo.RepoTags 与 ContainerInfo.Labels 的内容由镜像作者／起容器的人决定。
// 之前这里用的是 `h("pre", { innerHTML: JSON.stringify(info) })`，于是一个带
// `<img src=x onerror=...>` 标签的镜像就能在面板自己的 origin 上执行脚本 —— 会话 token
// 就在同一上下文。
//
// 断言的是渲染结果（DOM 里有没有真的元素节点），不是实现写法。把实现换回 innerHTML，
// 下面前三个用例会红。

const makeImage = (overrides: Partial<ImageInfo> = {}): ImageInfo => ({
  Containers: 0,
  Created: 0,
  Id: "sha256:0000",
  Labels: null,
  ParentId: "",
  RepoDigests: [],
  RepoTags: [],
  SharedSize: 0,
  Size: 0,
  VirtualSize: 0,
  ...overrides
});

// 只填断言用得到的字段；其余用 as 收口，避免把整份 Docker 响应抄进夹具。
const makeContainer = (overrides: Partial<ContainerInfo> = {}): ContainerInfo =>
  ({
    Id: "c0000",
    Names: ["/demo"],
    Image: "demo:latest",
    ImageID: "sha256:0000",
    Command: "sleep",
    Created: 0,
    Ports: [],
    Labels: {},
    State: "running",
    Status: "Up",
    ...overrides
  }) as ContainerInfo;

const render = (info: ImageInfo | ContainerInfo, caption = "caption") =>
  mount(
    defineComponent({
      setup: () => () => buildDockerDetailContent(info, caption)
    })
  );

describe("buildDockerDetailContent", () => {
  it("renders an HTML-shaped repo tag as text, creating no element node", () => {
    const wrapper = render(makeImage({ RepoTags: ['<img src=x onerror="alert(1)">'] }));

    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("pre").element.querySelector("*")).toBeNull();
    // 内容本身没有被丢掉，只是当文本渲染
    expect(wrapper.find("pre").text()).toContain("onerror");
  });

  it("does not let a crafted tag close the pre element and inject a sibling", () => {
    const wrapper = render(makeImage({ RepoTags: ["</pre><script>alert(1)</script><pre>"] }));

    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.findAll("pre")).toHaveLength(1);
  });

  // 第二个调用点：容器表。ContainerInfo.Labels 是任意键值映射，`docker run --label`
  // 就能写进去，比 RepoTags 更容易被外部决定。
  it("escapes a container label, which is the other caller's attacker-controlled field", () => {
    const wrapper = render(
      makeContainer({ Labels: { "org.demo": '<img src=x onerror="alert(1)">' } })
    );

    expect(wrapper.find("img").exists()).toBe(false);
    expect(wrapper.find("pre").element.querySelector("*")).toBeNull();
    expect(wrapper.find("pre").text()).toContain("org.demo");
  });

  it("keeps the caption and the formatted payload", () => {
    const wrapper = render(makeImage({ Id: "sha256:abcd" }), "详情");

    expect(wrapper.find("p").text()).toBe("详情");
    expect(wrapper.find("pre").text()).toContain('"Id": "sha256:abcd"');
  });
});
