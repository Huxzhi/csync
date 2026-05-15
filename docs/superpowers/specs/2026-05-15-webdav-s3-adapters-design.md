# csync — WebDAV & S3 适配器设计规格

**日期：** 2026-05-15  
**状态：** 已批准，待实现  
**范围：** 为 csync 新增两个 `RemoteRepositoryAdapter` 实现：WebDAV 和 S3（含 SigV4 签名）

---

## 1. 目标与约束

- 纯浏览器环境，只使用原生 Web API（`fetch`、`DOMParser`、`crypto.subtle`）
- 零外部依赖
- 完全实现 `RemoteRepositoryAdapter` 接口（与 GitHub 适配器对称）
- Hash 统一使用 ETag（两者均原生提供）
- 两个适配器独立，不共享运行时代码

---

## 2. 文件结构变更

```
src/adapters/
├── github.ts      # 已有
├── webdav.ts      # 新增
└── s3.ts          # 新增
```

**`package.json` 新增导出：**

```json
"./adapters/webdav": {
  "import": "./dist/adapters/webdav.js",
  "types": "./dist/adapters/webdav.d.ts"
},
"./adapters/s3": {
  "import": "./dist/adapters/s3.js",
  "types": "./dist/adapters/s3.d.ts"
}
```

**`tsup.config.ts` 新增入口：**

```ts
'adapters/webdav': 'src/adapters/webdav.ts',
'adapters/s3':     'src/adapters/s3.ts',
```

---

## 3. WebDAV 适配器（`src/adapters/webdav.ts`）

### 3.1 选项接口

```ts
interface WebDAVAdapterOptions {
  baseUrl: string    // 例：https://cloud.example.com/remote.php/dav/files/user
  username: string
  password: string
  basePath?: string  // 默认 "data"
}
```

### 3.2 认证

Basic Auth：每个请求 header 加 `Authorization: Basic <base64(username:password)>`。使用 `btoa(username + ':' + password)` 编码。

### 3.3 方法实现

**`getRemoteManifest()`**

1. 发送 `PROPFIND {baseUrl}/{basePath}/` 请求，header `Depth: infinity`，body 为标准 allprop XML：
   ```xml
   <?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>
   ```
2. 用 `DOMParser` 解析 XML 响应（`text/xml`）
3. 用 `getElementsByTagNameNS('DAV:', 'response')` 遍历每个 `<D:response>`
4. 跳过含 `<D:collection>` 的条目（目录节点）
5. 从 `<D:href>` 提取文件路径，去除 `{baseUrl}/{basePath}/` 前缀还原为 `SyncMetadata.path`
6. 从 `<D:getetag>` 提取 ETag，去除首尾 `"` 引号作为 hash
7. `updatedAt` 设为 0（WebDAV 不在 manifest 中使用时间戳）

**`uploadFile(path, content: ArrayBuffer, currentHash?)`**

- `PUT {baseUrl}/{basePath}/{path}`，body 直接传 `ArrayBuffer`，`Content-Type: application/octet-stream`
- 从响应 `ETag` header 读取 hash（去除引号）
- `currentHash` 参数接受但不使用（WebDAV PUT 天然幂等覆盖，无需当前 SHA）

**`downloadFile(path)`**

- `GET {baseUrl}/{basePath}/{path}`
- 返回 `res.arrayBuffer()`

**`deleteFile(path)`**

- `DELETE {baseUrl}/{basePath}/{path}`

### 3.4 错误处理

- 非 2xx 响应抛出 `Error('WebDAV {status}: {responseText}')`
- PROPFIND 返回 404 时视为空 manifest（目录不存在）

---

## 4. S3 适配器（`src/adapters/s3.ts`）

### 4.1 选项接口

```ts
interface S3AdapterOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string  // 自定义 endpoint，用于 R2/MinIO；未传时构造 AWS 标准 endpoint
  basePath?: string  // key 前缀，默认 "data"
}
```

endpoint 语义：**包含 bucket 路径的 base URL**，所有操作在其后追加 `/{key}` 或 `?` 参数。  
- AWS 默认（虚拟托管样式）：`https://{bucket}.s3.{region}.amazonaws.com`  
- R2 示例：`https://{accountId}.r2.cloudflarestorage.com/{bucket}`  
- MinIO 示例：`http://localhost:9000/{bucket}`

### 4.2 SigV4 签名（内部实现，不导出）

使用 `crypto.subtle` 实现，全部步骤：

1. **Payload hash**：`crypto.subtle.digest('SHA-256', body)` → hex string
2. **Canonical Request**：
   ```
   METHOD\n
   URI\n
   QueryString\n
   CanonicalHeaders\n
   SignedHeaders\n
   PayloadHash
   ```
3. **String to Sign**：
   ```
   AWS4-HMAC-SHA256\n
   datetime\n
   date/region/s3/aws4_request\n
   hash(CanonicalRequest)
   ```
4. **Signing Key** 推导（4 次 HMAC-SHA256）：
   ```
   kDate    = HMAC("AWS4" + secretAccessKey, date)
   kRegion  = HMAC(kDate, region)
   kService = HMAC(kRegion, "s3")
   kSigning = HMAC(kService, "aws4_request")
   ```
5. **Signature**：`HMAC(kSigning, StringToSign)` → hex
6. 将签名加入请求 `Authorization` header

所有 HMAC 操作使用 `crypto.subtle.sign({ name: 'HMAC', hash: 'SHA-256' }, key, data)`。

### 4.3 方法实现

**`getRemoteManifest()`**

1. `GET /?list-type=2&prefix={basePath}/` （带 SigV4 签名）
2. `DOMParser` 解析响应 XML（S3 无命名空间，用 `getElementsByTagName`）
3. 遍历 `<Contents>` → 提取 `<Key>` 和 `<ETag>`，去除 key 前缀还原为 `SyncMetadata.path`，ETag 去除引号作为 hash
4. 若响应含 `<NextContinuationToken>`，递归追加请求直至全量取完（`continuation-token` 参数）

**`uploadFile(path, content: ArrayBuffer, currentHash?)`**

- `PUT /{basePath}/{path}`，body 为 `ArrayBuffer`
- 从响应 `ETag` header 读取 hash（去除引号）
- `currentHash` 不使用（S3 PUT 直接覆盖）

**`downloadFile(path)`**

- `GET /{basePath}/{path}` → `res.arrayBuffer()`

**`deleteFile(path)`**

- `DELETE /{basePath}/{path}`

### 4.4 错误处理

- 非 2xx 响应读取响应体（XML），抛出 `Error('S3 {status}: {responseText}')`

---

## 5. 测试策略

两个适配器均使用 `vi.stubGlobal('fetch', ...)` mock fetch，测试覆盖：

| 测试场景 | WebDAV | S3 |
|---|---|---|
| `getRemoteManifest` 正常列出文件 | PROPFIND XML 解析 | ListObjects XML 解析 |
| `getRemoteManifest` 分页 | — | NextContinuationToken 递归 |
| `uploadFile` 返回正确 hash | ETag header | ETag header |
| `downloadFile` 返回 ArrayBuffer | GET 响应 | GET 响应 |
| `deleteFile` 调用正确 | DELETE 请求 | DELETE 请求 |
| 非 2xx 抛出错误 | ✓ | ✓ |

S3 SigV4 签名正确性通过 Authorization header 格式断言（验证包含正确 service/region/date 字段），不需要对密码学细节做单元测试。

---

## 6. 不在范围内

- Digest Auth / OAuth（WebDAV）
- S3 多部分上传（Multipart Upload）
- S3 服务端加密配置
- 自动创建 bucket 或 WebDAV 目录
