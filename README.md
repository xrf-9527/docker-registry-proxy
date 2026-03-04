# Docker Registry Proxy

一个基于 Cloudflare Workers 的轻量级、高性能 Docker 镜像代理服务。它为 Docker Registry 提供稳定的代理访问，具有超时处理、指标收集、访问控制等功能。

> 本项目参考了 [cf-workers-proxy](https://github.com/jonssonyan/cf-workers-proxy) 的实现。

## 功能特性

### 核心功能
- Docker Registry API v2 代理支持
- 自动处理 Registry、Auth、Search 服务
- 内置超时和错误处理
- 完整的访问控制系统
- 指标收集和监控

### 性能优化
- 基于 Cloudflare CDN
- 智能的缓存策略
- 上游请求超时控制与重试退避
- 响应内容处理

### 安全特性
- 请求头清理和安全加固
- IP、地区、User-Agent 访问控制
- 详细的错误日志记录

## 快速开始

### 部署方式

1. Workers 方式：直接复制 src/index.js 内容到 Cloudflare Workers
2. Pages 方式：Fork 仓库，在 Cloudflare Pages 中连接 GitHub 一键部署

### 环境变量配置

| 变量名 | 必填 | 默认值 | 说明 |
|-------|-----|--------|------|
| PROXY_HOSTNAME | 是 | registry-1.docker.io | 代理地址 hostname |
| PROXY_PROTOCOL | 否 | https | 代理协议 |
| REQUEST_TIMEOUT | 否 | 120000 | 上游请求超时（毫秒） |
| MAX_RETRIES | 否 | 0 | 失败重试次数（仅 GET/HEAD，含 429/5xx/超时） |
| PATHNAME_REGEX | 否 | - | 路径过滤正则 |
| UA_WHITELIST_REGEX | 否 | - | UA白名单正则 |
| UA_BLACKLIST_REGEX | 否 | - | UA黑名单正则 |
| IP_WHITELIST_REGEX | 否 | - | IP白名单正则 |
| IP_BLACKLIST_REGEX | 否 | - | IP黑名单正则 |
| REGION_WHITELIST_REGEX | 否 | - | 地区白名单正则 |
| REGION_BLACKLIST_REGEX | 否 | - | 地区黑名单正则 |
| DEBUG | 否 | false | 调试模式 |
| URL302 | 否 | - | 访问被拒绝时跳转地址 |

## 镜像仓库支持

支持代理以下镜像仓库：

| 镜像仓库 | 地址 |
|---------|------|
| Docker Hub | registry-1.docker.io |
| k8s.gcr.io | k8s.gcr.io |
| registry.k8s.io | registry.k8s.io |
| Quay | quay.io |
| GCR | gcr.io |
| GHCR | ghcr.io |
| Cloudsmith | docker.cloudsmith.io |
| ECR Public | public.ecr.aws |

## Docker 配置示例

> 根据 Docker 官方文档，`registry-mirrors` 仅适用于 Docker Hub（`docker.io`）。

1. 设置镜像加速
```bash
# 将 dockerhub.xxx.com 替换为你的 Workers 域名
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["https://dockerhub.xxx.com"]
}
EOF
systemctl daemon-reload
systemctl restart docker
```

2. 构建场景（BuildKit）镜像加速
```toml
# /etc/buildkitd.toml
[registry."docker.io"]
  mirrors = ["https://dockerhub.xxx.com"]
```

3. 查询镜像
```bash
docker search nginx
```

4. 其他镜像仓库（如 GHCR/Quay）建议直接使用代理域名拉取
```bash
# 例如代理 ghcr.io 时
docker pull dockerhub.xxx.com/OWNER/IMAGE:TAG
```

## 监控与日志

### 指标收集
- 请求总数和错误率
- 超时次数和重试次数
- 传输字节数
- 请求处理时间

### 日志记录
- 详细的请求/响应日志
- 错误追踪和诊断信息
- 性能监控数据

## 注意事项

1. 建议自用，使用正则表达式过滤请求
2. 设置 Workers 自定义域名
3. 避免代理整个站点以防风控
4. 定期检查访问日志和性能指标
5. 如出现 Docker Hub 429 限流，优先使用已认证账号拉取，并保留重试退避策略

## 许可证

GPL-3.0 License

---

> 注：本项目仅供学习研究使用，请遵守相关法律法规。
