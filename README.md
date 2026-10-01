# 活字字模与铅字档案（gbmovabletype）

面向活字印刷体验馆、铅字工坊与字体研究者的字模 / 字盘 / 试印档案工具：登记字模的字体、字号与材质，在行列网格上编辑字盘落位，记录缺笔磨损等损耗并据此停用或补刻；并可导入**车间回执**做盘点对账——先按编号配对、改号按字符 / 字体 / 盘内格位确认，异常列待裁定，馆员确认后一次性更新字模、落位与缺损记录。**纯前端单页应用**，数据全部保存在浏览器本地，不依赖任何后端服务、数据库或外部接口。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:21829**

其它常用命令：

```bash
docker compose ps          # 查看容器状态（healthy 即就绪）
docker compose logs -f     # 查看 nginx 日志
docker compose down        # 停止并移除容器（数据在浏览器本地，不受影响）
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript（严格模式） |
| 构建 | Vite 6，`npm run build` = `tsc -b && vite build`（含类型检查） |
| 样式 | Tailwind CSS v3 + PostCSS + Autoprefixer（无 UI 组件库，样式自写） |
| 状态 | Zustand（筛选偏好走 persist） |
| 路由 | React Router 6（`createBrowserRouter`） |
| 本地存储 | IndexedDB（Dexie，库名 `gbmovabletype-db`）+ localStorage（表单 / 布局草稿） |
| 部署 | 多阶段 Docker：`node:20-alpine` 构建 → `nginx:alpine` 托管静态产物 |

## 数据模型（`src/types/` 四个独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| TypeMatrix 字模 | `src/types/matrix.ts` | 字模编号、字符、字体（宋体/楷体/仿宋）、字号（初号 42pt … 八号 5pt 共 16 档）、材质（铜模/木活字/铅合金）、字面尺寸 mm、字身高度 mm、制作年代、刻工、可用性 |
| TypeCase 字盘 | `src/types/case.ts` | 字盘编号、类型（常用字盘/生僻字盘）、行数、列数、格位布局（行/列/字符/字模 id）、所在工位、容量 |
| DefectLog 缺损记录 | `src/types/defect.ts` | 字模 id、缺损类型（缺笔/磨损/变形/锈蚀/断裂）、程度（轻/中/重）、发现日期、处理方式、可用性（可用/停用/待补刻） |
| ProofRecord 试印记录 | `src/types/proof.ts` | 字符或字盘、压力 kg、用墨、印次、样张编号、清晰度评价（清晰/偏淡/糊版）、试印日期 |

### IndexedDB 版本与升级迁移（Dexie）

- **v1**：建 `matrices` 表（含 code / character / font / sizeName / material / availability 索引）
- **v2**：加 `cases` 表与 `matrixId` 多值索引；升级时按 `slots` 回填历史字盘的 `matrixId`
- **v3**：加 `defects`、`proofs` 表；升级时为「停用 / 待补刻」的历史字模回填缺损原因记录
- **v4**：加 `reconBatches` 表（车间回执盘点对账批次：回执原文、核对条目、断点进度）

首次打开且库为空时会写入一批示例档案（16 枚字模、2 个字盘、5 条缺损、6 条试印），便于直接体验；已有数据则跳过。

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | `Overview` | 字模总览：按字体 / 字号 / 材质 / 可用性筛选，卡片显示字符大样与缺损角标，可按部首笔画排序 |
| `/matrices/new` | `MatrixNew` | 字模登记：字符选择器按部首与笔画校验并给出候选，填写字体、字号、材质、尺寸与年代 |
| `/matrices/:id` | `MatrixDetail` | 字模详情：字面信息、所在字盘格位、缺损历史、试印记录，可就地新增缺损或试印、补刻恢复可用 |
| `/cases` | `CaseEditor` | 字盘布局编辑器：行列网格点击落位 / 取出 / 调换，实时提示空格与重复落位 |
| `/defects` | `DefectBoard` | 缺损登记：提交后自动停用字模并进入待补刻清单，补刻完成一键恢复 |
| `/proofs` | `ProofList` | 试印记录：登记压力、用墨与清晰度，按样张编号回溯试印批次 |
| `/stocktake` | `Stocktake` | 车间回执盘点对账：导入回执 → 自动核对 → 馆员裁定 → 统一落账 |

## 车间回执盘点对账（`/stocktake`）

车间交回的盘点回执（制表符或逗号分隔，每行 `字模编号 / 字符 / 字体 / 字盘编号 / 盘内格位`，格位支持 `A1`、`1-1`、`1行1列`）按以下规则核对，**裁定确认前绝不改动档案**：

1. **先按编号配对**：编号在档案中存在，再核对字符、字体与盘内格位。
2. **改号后按字符、字体、格位确认**：编号在档案中找不到，但回执字盘内（申报格位或盘内唯一匹配）有同字符同字体字模的，列为「疑似改号」建议，采纳后改号并按需移位。
3. 编号一致、字符字体相符但仅格位不符的，给出「按回执格位移位」的建议。
4. **先列待裁定**的异常：同一枚字模占两个格位（保留申报格取净其余 / 全部取出）、盘里有档案找不到的字模（补登记新字模 / 忽略）、停用或待补刻字模出现在盘内（复查复置 / 维持停用并取出）、字符或字体与档案不符（按回执纠正 / 以档案为准）。
5. 馆员逐条处理（采纳或忽略）完毕后，点「统一落账」：字模、字盘格位、缺损记录在**同一个 Dexie 事务**内更新，失败整体回滚；**既有试印记录照原样保留**。
6. 导入 / 核对失败时**回执原文与已核对进度都保留**，恢复后从断点继续；同一份回执（按内容哈希识别）再次提交直接复用既有批次，**不重复生成结果**。


## 目录结构

```
.
├── docker-compose.yml        # 无 version 字段；顶层 name: gbmovabletype
├── .env.example              # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine → nginx:alpine
    ├── nginx.conf            # try_files 前端路由兜底 + gzip
    ├── index.html
    ├── package.json          # build = tsc -b && vite build
    ├── tailwind.config.js / postcss.config.js / vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{matrix,case,defect,proof,reconcile}.ts
        ├── db/index.ts       # Dexie 库、版本迁移、示例档案
        ├── stores/{matrixStore,caseStore,uiStore,reconStore}.ts
        ├── hooks/{useMatrixSearch,useLocalDraft,useCaseSlots}.ts
        ├── components/common/{MatrixCell,LayoutGrid,CharacterPicker,DefectBadge,EmptyState}.tsx
        ├── components/stocktake/{ReceiptImportPanel,ReconBatchDetail,ReconItemRow}.tsx
        ├── layouts/AppShell.tsx
        ├── pages/{Overview,MatrixNew,MatrixDetail,CaseEditor,DefectBoard,ProofList,Stocktake}.tsx
        ├── router/index.tsx
        └── utils/{charIndex,layout,format,receipt,reconcile}.ts
```

## 数据存储说明

- **业务数据**：IndexedDB（Dexie，库名 `gbmovabletype-db`，共 5 张表 `matrices` / `cases` / `defects` / `proofs` / `reconBatches`）。写入前统一 `toPlain()` 深拷贝，避免响应式对象写库抛 `DataCloneError`。
- **草稿数据**：localStorage，前缀 `gbmovabletype-draft:`，覆盖字模登记、字盘布局、缺损登记、试印登记四处表单，刷新后可恢复。
- **界面偏好**：localStorage，键 `gbmovabletype-ui`（Zustand persist，保存筛选条件与当前选中字盘）。
- 容器完全无状态：不挂载命名卷、不连接数据库服务，删除重建容器不影响浏览器里的档案。

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev      # http://localhost:21829
npm run build    # 类型检查 + 生产构建
```

## 说明

- `frontend/public` 下静态资源已 `chmod 644`，Dockerfile 运行阶段额外 `chmod -R a+rX`，避免 nginx worker 读不到导致 favicon 403。
- 所有表单的数值输入均带 `min` / `max` 约束，枚举字段提供固定选项，不在前端做自由文本写入。
