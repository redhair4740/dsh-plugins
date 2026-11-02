# dsh-plugins

DeepSeek Harness（DSH）插件合集，单仓多包：每个子目录是一个**可独立安装**的插件，用 git 子目录地址安装，不需要发布到 npm。

## 插件

| 插件 | 说明 |
| --- | --- |
| [`dsh-thinking-levels`](dsh-thinking-levels/) | 为每个模型设置思考等级（推理等级 / Effort），选中该模型时直接使用该等级；带 Web 设置页 |

## 安装

DSH 的「插件」页 →「添加插件」，粘贴：

```text
git+https://github.com/redhair4740/dsh-plugins.git#main&path:/<子目录>
```

例如 Thinking Levels：

```text
git+https://github.com/redhair4740/dsh-plugins.git#main&path:/dsh-thinking-levels
```

命令行等价：

```bash
dsh plugin --profile web add "git+https://github.com/redhair4740/dsh-plugins.git#main&path:/dsh-thinking-levels"
```

`#main` 可换成某个提交（`#<sha>`）来固定版本。非官方插件没有「更新」按钮，升级靠卸载后重装。

## 仓库结构

```text
dsh-plugins/
├── package.json          # 工作区根（private，不发布）
├── pnpm-workspace.yaml
├── README.md
└── dsh-thinking-levels/  # 一个插件 = 一个可独立安装的包
    ├── package.json      # name / dsh.bundle / files 都写在子目录里
    ├── cordis.patch.yml  # 组合包 patch
    ├── index.js          # Host 半边
    ├── client.js         # Web 客户端半边
    ├── locale/
    └── test/
```

## 新增一个插件

1. 新建 `dsh-<名字>/` 目录，里面放完整的 `package.json`（`name`、`dsh`、`files`）。
2. `cordis.patch.yml` 里 `insert` 自己的 entry，`name` 与包名一致。
3. 提交后即可按 `&path:/dsh-<名字>` 安装，根目录文件不用动。

## 开发

```bash
node --test dsh-thinking-levels/test/apply.test.mjs
```

各插件的说明见其自身 README。
