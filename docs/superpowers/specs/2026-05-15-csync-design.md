# csync — 设计规格文档

**日期：** 2026-05-15  
**状态：** 已批准，待实现  
**包名：** `csync`  
**定位：** 零依赖浏览器 TypeScript npm 包，实现本地结构化数据与远端文件仓库（GitHub）之间的"一条记录 = 一个 JSON 文件"同步。

---

## 1. 目标与约束

- **纯浏览器环境**，只使用原生 Web API（`fetch`、`IndexedDB`、`AbortSignal`）
- **核心包零外部依赖**
- **构建工具**：tsup（ESM 输出，自动生成 `.d.ts`）
- **适配器模式**：用户传入普通对象（字段为闭包函数），通过闭包捕获自己的 DB/API 实例，无需继承或实现类
- **无 storeName 概念**：不再以"集合/表"为同步单元，改用标签驱动的批量同步
- **内部状态自管理**：csync 用原生 IndexedDB 维护 baseline 快照，不依赖用户的数据库

---

## 2. 文件结构

```
csync/
├── src/
│   ├── types.ts        # 所有公共/内部类型与接口
│   ├── store.ts        # 内部存储模块（baseline + 待删除列表）
│   ├── queue.ts        # 并发引擎 runWithConcurrency()
│   ├── diff.ts         # 三路合并算法 computeDiff()
│   ├── syncer.ts       # createSyncer() 工厂函数
│   ├── index.ts        # 主入口导出
│   └── adapters/
│       └── github.ts   # createGitHubAdapter()
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

**package.json exports map：**

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./adapters/github": {
      "import": "./dist/adapters/github.js",
      "types": "./dist/adapters/github.d.ts"
    }
  }
}
```

---

## 3. Path 与 Tags 设计原则

**Path：** `SyncMetadata.path` 是逻辑文件路径，也是记录的唯一标识符。

- **使用者负责拼接 path**：用户在写入自己数据库时，将业务主键拼接成路径格式（如 `notes/abc123.json`）并维护在记录的元数据中
- **远端适配器负责解析 path**：GitHub 适配器自行将 path 拼接为完整 API 路径（如 `{basePath}/{path}`）
- 核心引擎完全透传 path，不做任何路径构造或解析

**Tags：** 标签是唯一的分组/批量同步机制，完全取代 storeName。

- `tags` 由用户在 `getLocalManifest` 返回的元数据中提供，也通过 `markForDeletion` 传入
- csync 的内部存储（baseline、待删除列表）均保留 tags 字段，用于按标签过滤
- 远端文件不存储标签（GitHub 不支持文件级自定义元数据）
- `prepare()` 通过标签决定本次同步哪些记录；不传标签则同步全部

---

## 4. 类型与接口（`src/types.ts`）

### 4.1 核心数据类型

```ts
interface SyncMetadata {
  path: string       // 逻辑文件路径，如 "notes/abc123.json"，唯一标识该记录
  hash: string       // 远端返回的 blob hash；本地有未同步修改时由用户清空为 ""
  updatedAt: number  // Unix 时间戳（ms）
  tags?: string[]    // 可选标签，用于分组过滤
}

interface DiffResult {
  upload: string[]    // path 列表
  download: string[]
  deleteRemote: string[]
  deleteLocal: string[]
  conflict: { path: string; local: SyncMetadata; remote: SyncMetadata }[]
}

interface SyncSummary {
  uploaded: string[]
  downloaded: string[]
  deletedRemote: string[]
  deletedLocal: string[]
  skippedConflicts: string[]
  failed: { path: string; reason: unknown }[]
}
```

### 4.2 适配器接口

`LocalDatabaseAdapter` 只包含用户业务数据库的读写闭包，**不涉及 csync 内部状态**：

```ts
interface LocalDatabaseAdapter {
  // 扫描本地数据库，返回全部记录的元数据（path/hash/updatedAt/tags）
  // path 由用户自行拼接，hash 为空串表示有未同步修改
  getLocalManifest: () => Promise<SyncMetadata[]>

  // 根据 path 读取该记录的纯数据内容（不含元数据字段）
  // commit 阶段上传队列的每个任务调用此闭包获取数据载荷
  getRecordContent: (path: string) => Promise<Record<string, unknown> | null>

  // 将下载的远端记录写入本地数据库（含远端 hash 等 meta）
  upsertRecord: (
    path: string,
    data: Record<string, unknown>,
    meta: Omit<SyncMetadata, 'path'>,
  ) => Promise<void>

  // 物理删除本地记录（deleteLocal 操作时由引擎调用）
  deleteRecordPermanently: (path: string) => Promise<void>
}

interface RemoteRepositoryAdapter {
  // 列出远端仓库中全部文件的 path + hash（远端不存储 tags）
  getRemoteManifest: () => Promise<SyncMetadata[]>

  // path 由用户实现时自行解析为 API 路径
  uploadFile: (path: string, content: string) => Promise<{ hash: string }>
  downloadFile: (path: string) => Promise<Record<string, unknown>>
  deleteFile: (path: string) => Promise<void>
}
```

### 4.3 配置

```ts
interface SyncerConfig {
  local: LocalDatabaseAdapter
  remote: RemoteRepositoryAdapter
  dbName?: string     // 内部 IndexedDB 数据库名，默认 "_csync"；多实例时可区分
  concurrency?: number  // 默认 5
  timeout?: number      // 单任务超时 ms，默认 30000
  maxRetries?: number   // 默认 3
}
```

---

## 5. 内部存储模块（`src/store.ts`）

csync 用原生 IndexedDB 维护自身状态，对用户透明。

**数据库：** `{dbName}`（默认 `_csync`），版本 1，仅一个 object store：

| Object Store | key | value | 说明 |
|---|---|---|---|
| `baseline` | `'snapshot'`（固定键） | `SyncMetadata[]` | 上次成功同步后的全量快照 |

**暴露的函数（模块内部使用，不导出到公共 API）：**

```ts
function openStore(dbName: string): Promise<IDBDatabase>
function getBaseline(db: IDBDatabase): Promise<SyncMetadata[]>
function saveBaseline(db: IDBDatabase, snapshot: SyncMetadata[]): Promise<void>
```

---

## 6. 并发引擎（`src/queue.ts`）

```ts
type TaskResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  options: {
    concurrency: number
    timeout?: number
    maxRetries?: number
    signal?: AbortSignal
    onProgress?: (completed: number, total: number) => void
  },
): Promise<TaskResult<T>[]>
```

**实现要点：**

- Worker pool 模型：启动 `min(concurrency, tasks.length)` 个并发 worker
- 原子性 `currentIndex++` 避免竞态，每个 worker 取完即取下一个
- `Promise.race([task(), timeoutPromise(timeout)])` 包裹每个任务
- 失败后指数退避：`baseDelay * 2^attempt + jitter`，最多 `maxRetries` 次
- 每次取任务前检查 `signal.aborted`，已中止则停止派发
- 返回类 `Promise.allSettled` 的 settled 数组，单任务失败不影响其他任务
- 每个任务完成后调用 `onProgress(completed, total)`

---

## 7. 三路合并算法（`src/diff.ts`）

```ts
function computeDiff(
  local: SyncMetadata[],   // 含 isDeleted:true 的墓碑条目（来自待删除列表）
  remote: SyncMetadata[],
  baseline: SyncMetadata[],
): DiffResult
```

**纯函数，无副作用。** 以 baseline 为公共祖先，评估每个曾出现过的 path：

| localDirty   | localDeleted     | remoteChanged | remoteDeleted | 结果                              |
| ------------ | ---------------- | ------------- | ------------- | --------------------------------- |
| ✓（hash=""） | —                | ✗             | ✗             | `upload`                          |
| —            | ✓（!L && B 存在）| ✗             | ✗             | `deleteRemote`                    |
| ✗            | ✗                | ✓             | ✗             | `download`                        |
| ✗            | ✗                | —             | ✓             | `deleteLocal`                     |
| ✓            | —                | ✓             | ✗             | hash 相同→无操作；不同→`conflict` |
| ✗            | ✗                | ✗             | ✗             | 无操作                            |

**变更检测：**

- `localDirty` = `L` 存在 && `L.hash === ""`
- `localDeleted` = `!L` && `B` 存在（用户从自己数据库删除记录后，localManifest 不再包含该 path）
- `remoteChanged` = `R?.hash !== B?.hash`
- `remoteDeleted` = `!R` && `B` 存在

---

## 8. 核心同步引擎（`src/syncer.ts`）

`createSyncer(config)` 返回包含两个方法的对象：

### `prepare(options?): Promise<DiffResult>`

```ts
interface PrepareOptions {
  signal?: AbortSignal
  tags?: string[]  // 只处理含有任意一个匹配标签的记录；未传则同步全部
}
```

1. 并行获取：`local.getLocalManifest()`、`remote.getRemoteManifest()`、内部 `getBaseline()`
2. 若 `options.tags` 非空，对 `localManifest` 和 `baseline` 按标签 OR 过滤；`remoteManifest` 不过滤
3. 调用 `computeDiff(filteredLocal, remoteManifest, filteredBaseline)`
4. **不修改任何数据**，直接返回 `DiffResult`

**本地删除检测**：用户从自己数据库删除记录后，`getLocalManifest()` 不再包含该 path；三路合并自动检测到"baseline 有、local 无"→ 推入 `deleteRemote`，无需额外 API。

### `commit(diff, options?): Promise<SyncSummary>`

```ts
interface CommitOptions {
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}
```

将 `DiffResult` 展开成 task 闭包数组：

| 分类           | task 内容 |
| -------------- | --------- |
| `upload`       | `getRecordContent(path)` → `JSON.stringify` → `uploadFile(path, content)` → 用返回 hash 更新本地 metadata（通过 upsertRecord） |
| `download`     | `downloadFile(path)` → `upsertRecord(path, data, meta)`（写入远端 hash） |
| `deleteRemote` | `deleteFile(path)` → `deleteRecordPermanently(path)` |
| `deleteLocal`  | `deleteRecordPermanently(path)` |
| `conflict`     | **跳过**，记入 `SyncSummary.skippedConflicts` |

**Baseline 更新：** 所有任务执行完毕后，将成功完成的条目合并进旧 baseline（失败项和冲突保留旧条目），调用内部 `saveBaseline()` 持久化。

---

## 9. GitHub 适配器（`src/adapters/github.ts`）

```ts
interface GitHubAdapterOptions {
  owner: string
  repo: string
  branch: string
  token: string
  basePath?: string  // 默认 "data"
}

function createGitHubAdapter(options: GitHubAdapterOptions): RemoteRepositoryAdapter
```

- **path 由适配器自行解析**：完整 API 路径 = `{basePath}/{path}`
- `getRemoteManifest()`：GitHub Git Trees API（`recursive: true`）列出 `{basePath}/` 下所有 blob，SHA 作为 hash，tree path 还原为 SyncMetadata.path
- `uploadFile(path, content)`：PUT Contents API，返回 blob SHA
- `downloadFile(path)`：GET 文件内容，Base64 解码 → `JSON.parse`
- `deleteFile(path)`：先 GET 获取当前文件 SHA，再 DELETE
- 仅使用原生 `fetch`，零外部依赖

---

## 10. 错误处理策略

- 网络错误、超时：自动重试（指数退避），耗尽重试次数后记入 `SyncSummary.failed`
- 冲突：跳过，记入 `SyncSummary.skippedConflicts`，由调用方决策后下次提交
- 单任务失败不影响其他任务（类 `Promise.allSettled` 隔离）
- `AbortSignal` 传递到 `prepare()` 和 `commit()`，取消时停止派发新任务
