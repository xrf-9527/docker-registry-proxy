# Docker Registry Proxy

基于 Cloudflare Workers 的单上游 Registry HTTP 代理，默认转发 Docker Hub。用于代理网络访问，不实现 pull-through cache，也不会绕过上游认证或限流。

## 工具链与开发

推荐 Node.js 24 LTS（见 `.nvmrc`），最低 Node.js 22.12。使用 npm 锁文件固定依赖：

- Wrangler 4：本地 workerd 运行、打包和部署。
- `@cloudflare/vitest-plugin` + 兼容的 Vitest 4.1：在 Workers 运行时测试。
- Prettier：统一现有代码格式。
- `wrangler.jsonc`：运行时、绑定和部署配置的唯一来源。

这是没有前端构建需求的独立 Worker，按[官方选择指南](https://developers.cloudflare.com/workers/local-development/wrangler-vs-vite/)使用 `wrangler dev`。测试集成遵循[当前官方 Vitest 文档](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)，不再使用旧 `vitest-pool-workers`。

```bash
npm ci
npm run dev
```

验证与部署：

```bash
npm run check        # 格式、Workers 测试、部署 dry-run；不发布
npm audit
npm run smoke -- http://127.0.0.1:8787
npx wrangler login  # 已登录时无需重复
npm run deploy
```

`smoke` 针对 Docker Hub：匿名取 token、读取 busybox 的 linux/amd64 manifest、完整下载 config 和 layer 并校验 SHA-256，检查 HEAD 大小和 Range / 206。它访问真实上游，需要网络并消耗上游请求额度，不运行镜像、不保存 token。部署后将参数替换为 Worker 的 HTTPS 地址再次验证。

GitHub Actions 在 push / PR 时执行安装、检查和依赖审计。当前仓库还连接了 Cloudflare Workers Builds，推送 main 会触发自动部署；已认证的 Wrangler 可用于手动部署。自动部署与 GitHub CI 是独立流程，推送前应先运行本地检查。不要仅复制 `src/index.js` 到控制台，它依赖本地模块。此仓库没有 Pages Functions 构建入口，使用 Workers 部署。

## 代理行为

- Docker Hub 的 **`/token` 精确路径**转发到 `https://auth.docker.io/token`；其他路径转发到配置的上游，不根据镜像名称中的 `token`、`search` 子串分流。
- 原样传递 manifest / blob 字节、Accept、Range、Authorization 等协议字段。只改写需要经代理访问的认证 `realm`、同上游的绝对 Location 和 Link URL；保留 `service`、`scope`、摘要和 ETag。
- GET / HEAD 的重定向最多跟随 5 次，跨 origin 清除 Authorization；拒绝 HTTPS 降级、非 HTTP(S) URL 和 URL 内嵌凭据。
- GET / HEAD 遇到网络错误或 408、429、500、502、503、504 时有限重试。优先采用 Retry-After 秒数或 HTTP 日期，否则使用带抖动的指数退避；等待时间超出总预算时直接返回原响应，不提前重试。
- 写请求原样转发，不重试、不自动跟随重定向。上传仍受 Cloudflare 账户的请求体大小限制；本项目主要验证拉取流程，不宣称完成 Registry 全套一致性认证。
- 收到最终响应头前共用一个时间预算，包含重试、退避和重定向。之后上游响应体原样交给 Workers 运行时直接转发，不经过 JS 逐块读取，不给大镜像下载设置固定总时长上限。逐块经过 JS 会按数据量消耗 CPU 时间，超过 100MB 左右的层（例如 mysql）会因 CPU 超限在传输中途被切断。
- 超过响应头预算返回 504，网络错误返回 502，配置错误返回 500，访问拒绝返回 403。已开始发送的流如果中断，无法再修改已发出的状态码；客户端可重新请求或使用 Range 恢复。
- 每条丢弃的重定向／重试响应都会取消 body；客户端断开时由运行时取消上游读取。
- 子请求与返回响应显式禁用缓存，不提供镜像缓存加速承诺；这也避免对私有镜像或 token 引入共享缓存。

`ns` 是可选的镜像源提示，本代理使用固定上游：只在 `/v2/` 请求中移除该参数，不根据它选择任意目标。该行为符合 [OCI Registry Proxying](https://github.com/opencontainers/distribution-spec/blob/main/spec.md#registry-proxying)。

## 配置

当前部署保留 `docker.950288.xyz` 自定义域名和 workers.dev 入口。Fork 自用时，先修改 Worker 名称并删除或替换 `routes` 中的域名。

修改 `wrangler.jsonc` 的 `vars` 后部署。配置文件中的明文变量会覆盖控制台中的对应配置；机密应使用 `wrangler secret`，不要写入仓库。

| 变量                                                | 默认值                 | 说明                                                                               |
| --------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- |
| `PROXY_HOSTNAME`                                    | `registry-1.docker.io` | 单一上游主机，可含端口，不含协议、路径或凭据；旧 `registry.docker.io` 别名会规范化 |
| `PROXY_PROTOCOL`                                    | `https`                | `https` 或 `http`；HTTP 只用于明确受信的内网上游                                   |
| `REQUEST_TIMEOUT`                                   | `120000`               | 最终响应头前的总预算，1–300000 毫秒                                                |
| `MAX_RETRIES`                                       | `2`                    | GET / HEAD 最多额外尝试次数，0–5；0 禁用重试                                       |
| `DEBUG`                                             | `false`                | `true` 才输出重试调试日志；状态仅属于当前请求                                      |
| `PATHNAME_REGEX`                                    | 无                     | 允许的路径正则；代理 Docker Hub 时必须同时允许 `/token`                            |
| `UA_WHITELIST_REGEX` / `UA_BLACKLIST_REGEX`         | 无                     | 对小写 User-Agent 匹配                                                             |
| `IP_WHITELIST_REGEX` / `IP_BLACKLIST_REGEX`         | 无                     | 对 Cloudflare 提供的客户端 IP 匹配                                                 |
| `REGION_WHITELIST_REGEX` / `REGION_BLACKLIST_REGEX` | 无                     | 对 `request.cf.country` 匹配，缺省回退到 `CF-IPCountry`                            |

黑名单优先；配置身份过滤但请求缺少该身份字段时拒绝。正则无效时返回配置错误。正则默认不自动锚定，需要精确匹配时自行使用 `^`、`$`。User-Agent 可伪造，不应单独用作身份认证。

旧 `URL302` 和伪 nginx 200 页面已删除：拒绝请求现在返回明确的 Registry JSON 错误与 403。旧的 isolate 内存指标与全局 DEBUG 状态也已删除。

## Docker 和 BuildKit

Docker Engine 的 `registry-mirrors` 只适用于 Docker Hub，不能用于通用 GHCR／Quay 镜像源替换。[Docker 官方说明](https://docs.docker.com/docker-hub/image-library/mirror/)

将以下字段合并到已有 `/etc/docker/daemon.json`，不要覆盖原配置，再按你的运行环境重启 Docker：

```json
{
	"registry-mirrors": ["https://your-proxy.example"]
}
```

```bash
docker pull busybox:latest
# 直接指定代理，避免客户端退回 Docker Hub 掩盖代理错误：
docker pull your-proxy.example/library/busybox:latest
```

BuildKit 的 `buildkitd.toml`：

```toml
[registry."docker.io"]
  mirrors = ["your-proxy.example"]
```

其他上游应使用单独的 Worker／配置，例如把 `PROXY_HOSTNAME` 改为 `ghcr.io` 后：

```bash
docker pull your-ghcr-proxy.example/OWNER/IMAGE:TAG
```

同上游 origin 的认证 realm 可经代理访问；Docker Hub 的独立认证服务有明确映射。其他独立认证域名保持原样，需要客户端直接可达，不宣称任意 Registry 都能完全通过一个域名访问。私有镜像仍要求有效上游凭据；仅向自己信任的代理提交凭据。

`docker search` 不由 Docker Engine 的 mirror 设置代理，旧搜索转发说明已移除。上游仍可能限流，尤其是共享 Workers 出口的匿名请求；参见 [Docker Hub 429 说明](https://docs.docker.com/docker-hub/troubleshoot/)。

## 日志与运维

启用 Workers Observability。应用日志仅记录请求 ID、方法、响应头耗时、状态和上游主机，不记录 URL 查询、Authorization、Cookie、响应头或上游异常原文。平台自动收集的 invocation 元数据由 Cloudflare 管理。

`response_headers` 只表示拿到响应头，不代表响应体已完整送达；响应体由运行时转发，应用不再记录流完成事件。传输是否被平台中断看 invocation 的 `outcome`（如 `exceededCpu`）。请求量、错误率等通过 Cloudflare 的原生指标观察，不提供 `/metrics` 端点。

访问控制默认未启用。自用部署应配置合适的过滤规则；生产下载中断或限流问题需要结合实际 Workers 日志与 Docker 输出诊断。

## 协议与平台依据

- [OCI Distribution Specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md)
- [Distribution Token Authentication](https://distribution.github.io/distribution/spec/auth/token/)
- [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)
- [Cloudflare Workers 平台限制](https://developers.cloudflare.com/workers/platform/limits/)
- [Wrangler 配置推荐](https://developers.cloudflare.com/workers/wrangler/configuration/)

本项目参考了 [cf-workers-proxy](https://github.com/jonssonyan/cf-workers-proxy) 的实现；仓库原声明采用 GPL-3.0。
