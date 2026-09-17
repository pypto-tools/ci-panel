import { h, type VNode } from "vue";

import type { ContainerInfo, ImageInfo } from "@/types";

// 镜像／容器详情弹窗的内容构造。抽成独立函数不是为了复用，而是为了能被断言。
//
// 这里的对象整个来自 daemon 转发的 Docker 响应，其中有几处的内容由镜像作者或
// 起容器的人决定：ImageInfo.RepoTags、ContainerInfo.Labels（声明为任意键值）、
// ContainerInfo.Names 与 Image。也就是说只要有人能让节点拉到一个镜像，他就能决定
// 这里渲染什么。因此 JSON 必须作为**文本子节点**交给 <pre>，绝不能走 innerHTML：
// 后者会把 `<img src=x onerror=...>` 当标签解析，而这个卡片就挂在面板自己的
// origin 上，会话 token 就在同一个上下文里。
//
// 联合类型不是为了泛用：imageManager 的 showDetail 同时挂在镜像表和容器表的操作列上
// （index.vue 两处 `showDetail(record)`），两种 record 都会走到这里。
export function buildDockerDetailContent(
  info: ImageInfo | ContainerInfo,
  caption: string
): VNode[] {
  return [
    h("p", caption),
    h(
      "pre",
      {
        style: {
          maxHeight: "460px",
          overflow: "auto"
        }
      },
      JSON.stringify(info, null, 4)
    )
  ];
}
