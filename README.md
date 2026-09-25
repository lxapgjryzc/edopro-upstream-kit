# edopro-upstream-kit

把 EDOPro 的上游按提交钉住，并在需要时拼出一份可以直接给无头驱动读的数据根、编出 x64 的 `ocgcore.dll`。
Pins the EDOPro upstream by commit, assembles an EDOPro-shaped data root from it and builds an x64 `ocgcore.dll`.

本仓库只做上游整合，不含任何具体作品的卡片、脚本、补丁或剧本。使用方把它挂成 git submodule，自己的补丁在 `fetch` 时传进来，
自己的卡片在 `fetch` 之后部署进数据根。

## 钉住的上游（`upstream.lock.json`）

| 名字 | 仓库 | 用途 |
|---|---|---|
| `ygopro-core` | edo9300/ygopro-core（含 lua 子模块） | 引擎源码 |
| `BabelCDB` | ProjectIgnis/BabelCDB | 官方卡库，数据根的基础层 |
| `CardScripts` | ProjectIgnis/CardScripts | 官方卡脚本与共用库，数据根的更新层（`Project Ignis updates`） |
| `Distribution` | ProjectIgnis/Distribution 的 `config/strings.conf` | 英文系统字符串 |
| `ygopro-database` | mycard/ygopro-database 的 `locales/zh-CN/cards.cdb` | 社区简中卡名 |

数据根的结构和理由写在 `upstream.cjs` 文件头。

## 命令

```bash
node upstream.cjs show                                   # 现在钉在哪
node upstream.cjs bump [--dry-run]                       # 把每个 pin 移到上游当前 HEAD
node upstream.cjs fetch --dest D [--patches DIR]...      # 检出到 D，打补丁，拼出 D/edopro（锁文件和补丁都没变时不重做；--force 重做）
node upstream.cjs build --dest D                         # Windows：premake5 vs2022 + MSBuild，x64 Release（premake5 下到 D/.tools）
node upstream.cjs env --dest D                           # 打印 EDOPRO_PATH=… 与 OCGCORE_PATH=…
```

`build` 需要 VS 2022 生成工具（MSBuild 与 x64 C++ 工具集），用 vswhere 找 MSBuild。`--dest` 省略时是当前目录下的 `upstream/`。

## 更新由本仓库负责（`.github/workflows/upstream.yml`）

| 触发 | 做什么 |
|---|---|
| 每周一 03:17 UTC、手动 `workflow_dispatch` | `bump` → 在 `windows-latest` 上按新 pin 检出、拼数据根、编引擎 → 全绿提交新锁文件；有红开（或追加到）带 `upstream` 标签的 issue，锁文件不动 |
| `push`、`pull_request` | 按当前锁文件检出并编译 |

这里的检查只证明「上游能检出、引擎能编」。新 pin 会不会改变某个作品的行为，由使用方在自己的仓库里跑验收判断：
使用方用 Dependabot（`package-ecosystem: gitsubmodule`）跟随本仓库，每次锁文件前进，使用方就收到一个升级 submodule 的 PR，
它自己的 CI 在 PR 上跑整套验收，全绿再合并。
Dependabot 默认给新提交加冷却期；本仓库周一升级，使用方把检查排在周二并设 `cooldown: default-days: 1`，当周就能收到 PR。

## 许可

本仓库的脚本与工作流以 [MIT](LICENSE) 发布。它检出的上游（ygopro-core、EDOPro 的卡库与脚本等）不在本仓库里，各按其自身许可证使用。
