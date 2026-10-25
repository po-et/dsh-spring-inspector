# dsh-spring-inspector — DeepSeek Harness 的有界 Spring Boot 诊断插件

> [!IMPORTANT]
> **非官方社区插件。** 本项目独立维护，与 DeepSeek 无隶属或背书关系；
> 使用前请审阅源码并评估风险。

这是一个面向 DeepSeek Harness 的本地 Spring Boot Actuator 诊断插件。它
提供五个只读、结构化、结果有界的工具：

- `spring_health`：有界健康状态/组件状态树（不返回任意 details）
- `spring_route_search`：搜索 MVC/WebFlux 路由
- `spring_bean_search`：搜索 Bean 元数据
- `spring_condition_report`：查看自动配置条件匹配
- `spring_metric_read`：读取单项指标及 tag 过滤结果

[English](README.md)

## 设计重点

它不是通用 HTTP 客户端。模型只能选择预先配置的 target id 和过滤条件，
不能传 URL、HTTP 方法、Header 或任意 Actuator 路径。

- 只允许 `127.0.0.1`、`[::1]` 或精确的 `localhost`
- `localhost` 在请求前改写为 `127.0.0.1`，不走 DNS
- 只执行固定端点的 `GET`，拒绝所有重定向
- 只接受 JSON / `application/*+json`，拒绝压缩响应
- 同时检查 `Content-Length` 和实际流字节数
- canonical JSON 在进入 Native / Code Mode 前完成脱敏
- canonical JSON 有全局节点预算，并显式报告 source truncation
- Native 模型文本使用 compact JSON，并有独立的 256 KiB 上限
- 不实现 `env`、`configprops`、`heapdump`、`threaddump`、`loggers`、
  `shutdown`、`httpexchanges` 等高风险端点

完整说明见 [架构与威胁模型](docs/architecture.md) 和
[上游源码与贡献分析](docs/upstream-analysis.md)。

## 预览兼容性状态

> [!WARNING]
> **真实 DSH 宿主兼容性尚未通过验证。** 在提交 `7c4812f` 的
> [2026-10-25 CI 运行](https://github.com/po-et/dsh-spring-inspector/actions/runs/40197520714)
> 中，隔离 DSH `0.1.0-rc.6` smoke 在宿主启动阶段报
> `TypeError: hmr.registerConfig is not a function`，五个工具的验收尚未完成。

同次运行的 Node 22.19、24、26 验证任务均通过，覆盖类型检查、单元/集成
测试、构建、产物检查、打包及安装后导入。这些结果验证了插件与包的对应
检查，真实 DSH 宿主门槛仍然失败。以下安装命令用于预览评估；宿主兼容性
问题仍待解决。

## 安装

要求 Node.js `^22.19.0 || >=24.0.0`；安装前请先阅读上面的
[预览兼容性状态](#预览兼容性状态)。

目前尚未发布 `v0.1.0` 标签。预览评估固定到以下公开源码提交：

```sh
dsh plugin --profile spring add github:po-et/dsh-spring-inspector#7c4812fcef3a96b4eafe516eb8bfed2afce4c8ba
dsh --profile spring --dump-config
```

仓库提交了编译后的 `lib/`，且没有 `prepare` 安装脚本，因此通过 GitHub
安装时不需要授予 pnpm `allowBuilds` 权限。

## Spring Boot 端配置

Spring Boot 默认只通过 HTTP 暴露 `health`。建议使用独立的 loopback 管理
端口，并且只开放本插件使用的端点：

```properties
management.server.address=127.0.0.1
management.server.port=8081
management.endpoints.web.exposure.include=health,mappings,beans,conditions,metrics
management.endpoint.health.show-components=when_authorized
management.endpoint.health.show-details=never
```

不要配置 `include=*`，也不要为了插件关闭 Spring Security。

## DSH Profile 配置

默认地址是 `http://127.0.0.1:8080/actuator`。在
`$DSH_HOME/profiles/spring/cordis.patch.yml` 中覆盖插件行：

```yaml
- id: spring-inspector
  config:
    targets:
      - id: orders
        actuatorUrl: http://127.0.0.1:8081/actuator
        authorizationRef: SPRING_ACTUATOR_AUTHORIZATION
    timeoutMs: 5000
    maxResponseBytes: 262144
    defaultLimit: 25
    maxLimit: 100
```

`authorizationRef` 保存的是凭据引用，不是明文。引用解析后的值应是完整
`Authorization` Header，例如 `Bearer ...` 或 `Basic ...`；插件每次请求
都会通过可选的 DSH credentials 服务重新解析，凭据轮换无需重启。配置了
`authorizationRef` 但调用时 credentials 服务不可用会明确失败。

## 示例

```text
用 spring_health 检查 orders。
用 spring_route_search 找 orders 中所有 POST 订单接口。
查看 orders 中 Redis 相关的 negative conditions。
读取 orders 的 jvm.memory.used，tag 使用 area:heap。
```

## 开发验证

```sh
pnpm install
pnpm check
pnpm pack
pnpm test:dsh:rc6
```

测试覆盖 SSRF/URL 策略、路径约束、raw 参数校验、真实本地 HTTP、重定向、
503 health、MIME、字节上限、取消、脱敏和 Actuator 结构化投影。
rc.6 smoke 的目标是把 tarball 安装到隔离 profile，检查 peer，使用真实
Loader 启动插件，再通过 `ctx.tools.execute()` 调用全部五个 Spring 工具。
最近一次运行完成了安装和 peer 检查，随后在宿主启动阶段失败，尚未完成
工具验收；详见[预览兼容性状态](#预览兼容性状态)。临时 profile 会保留并
打印路径，便于继续审计。

## 许可证

[MIT](LICENSE)
