# FileShare

大文件分片上传 & 分享平台。

项目通过 **ddns-go** 动态更新 Cloudflare AAAA 记录，配合 IPv6 实现持久公网访问。

> **⚠️ 项目状态：学习向，中道崩殂**
>
> 本项目创作目的是学习 **Rust + Axum（Web 框架）+ Tokio（异步运行时）+ SQLx（数据库驱动）+ PostgreSQL + tower-http（中间件）+ SHA-256 + config（配置管理）+ serde（序列化）+ mime_guess + include_dir** 等后端技术，以及 **React + TypeScript + Vite + TailwindCSS + Heroicons** 前端技术栈。
>
> 学到一半玩不动了，没写完。代码仅供参考，不建议生产使用。
>
> **欢迎提交 PR 继续完善！** 🙌 如果你有兴趣把这个项目捡起来，欢迎任何形式的贡献。

## 技术栈

### 后端
- **Rust** — 系统编程语言
- **Axum 0.8** — Web 框架
- **Tokio** — 异步运行时
- **SQLx** — PostgreSQL 数据库驱动（未完成）
- **SHA-256** — 文件完整性校验
- **tower-http** — CORS、静态文件服务

### 前端
- **React 19** — UI 框架
- **TypeScript** — 类型安全
- **Vite** — 构建工具
- **TailwindCSS 4** — 样式
- **Heroicons** — 图标库

### 其他
- **ddns-go** — Cloudflare DDNS（IPv6 AAAA 记录更新）
- **PostgreSQL** — 元数据存储（未接入）

## 已实现功能

- ✅ 大文件分片上传（5MB/片）
- ✅ SHA-256 文件完整性校验
- ✅ 并发上传（6 路全局分片池）
- ✅ 多文件同时上传
- ✅ 拖拽上传
- ✅ 分片过期自动清理（GC）
- ✅ 前端 / 后端单二进制打包（Release）
- ✅ i18n 国际化（中文 / English / 猫猫语）
- ✅ 深色 / 浅色主题（跟随系统）
- ✅ 文件 Library 列表页（前端已完成，后端 API 未接）
- ✅ 文件预览页（前端已完成，后端 API 未接）

## 未完成功能

- ❌ PostgreSQL 元数据存储
- ❌ 文件搜索
- ❌ 文件在线预览（图片/视频/音频）
- ❌ 下载断点续传（Range 请求）
- ❌ 用户认证
- ❌ 管理后台
- ❌ 部署文档
- ❌ Test

## 快速开始

### 开发模式（两个终端）

```bash
# 终端 1：启动后端
cargo run

# 终端 2：启动前端
cd frontend && npm run dev
```

浏览器打开 `http://localhost:5173`

### 生产构建（单二进制）

```bash
cargo build --release
./target/release/FileShare.exe
```

浏览器打开 `http://localhost:114`

> 端口可在 `Config.toml` 中修改。

## 项目结构

```
FileShare/
├── src/main.rs          # Rust 后端入口
├── build.rs             # 构建脚本（Release 时自动构建前端）
├── Config.toml          # 配置文件
├── frontend/
│   ├── src/App.tsx      # 前端主组件
│   ├── src/locales/     # 国际化文件
│   └── ...
├── files/               # 合并后的文件存储
├── uploads/             # 临时分片存储
└── ddns-go/             # DDNS 工具
```

## 架构简图

```
浏览器 → POST /api/upload/chunk
         Headers: X-File-Hash, X-Total-Chunks, X-Chunk-Index
         Body: 原始二进制分片
              ↓
         Axum Handler → 保存分片 → mpsc Channel → Tracker Worker
              ↓                                         ↓
         返回 OK                             分片收齐 → 合并文件 → 存到 files/
```

## License

MIT
