# Thinking Levels（思考等级）

为 DeepSeek Harness 的每个模型设置思考等级（即模型选择器里的“推理等级” / Effort）。选中该模型时直接使用这个等级；在模型选择器里手动改成别的等级时，仍然以手动选择为准。

本插件属于 [dsh-plugins](https://github.com/redhair4740/dsh-plugins) 合集，位于 `dsh-thinking-levels/` 子目录。

## 安装

用 git 子目录地址安装 —— DSH 的「插件」页 →「添加插件」，粘贴：

```text
git+https://github.com/redhair4740/dsh-plugins.git#main&path:/dsh-thinking-levels
```

命令行等价：

```bash
dsh plugin --profile web add "git+https://github.com/redhair4740/dsh-plugins.git#main&path:/dsh-thinking-levels"
```

`#main` 可换成某个提交（`#<sha>`）来固定版本。装完刷新页面，**设置 → 思考等级** 才会出现；非官方插件没有「更新」按钮，升级靠卸载后重装。

本地开发时也可以直接指向工作副本（改代码立即生效；和 git 装法用同一个包名，切换前先移除已装的那个）：

```text
plugin_manager install_bundle  target: /home/yo/projects/dsh-plugins/dsh-thinking-levels
```

## 使用

1. 打开 Web GUI → 侧边栏底部 **设置** → 左侧 **思考等级**（`Thinking levels`）。
2. 每个提供思考等级的模型一行，右侧下拉框里是该模型**实际支持**的等级（如 Off / Low / High / Max / xhigh，由模型适配器提供，不是写死的列表）。
3. 选好即保存。保存写入 profile 的 `cordis.patch.yml`，重启后依然有效。
4. 选择 **跟随模型默认 / Follow model default** 可以清除该模型的覆盖，恢复适配器自带默认。

每行还会显示“当前生效”的等级，也就是这个模型此刻真正会用的那个。

## 配置

也可以直接写 profile patch（`~/.dsh/profiles/<profile>/cordis.patch.yml`）：

```yaml
- id: thinking-levels
  config:
    models:
      - provider: deepseek-official   # 可省略；省略时对该模型名的所有 provider 生效
        model: deepseek-flash
        reasoningEffort: low
      - model: deepseek-pro           # 只写模型名
        reasoningEffort: high
```

同一个模型同时存在“带 provider”和“不带 provider”的条目时，带 provider 的优先。

`reasoningEffort` 必须是该模型自己声明的等级之一。写了不支持的值不会破坏选模型流程：插件会记录一条警告并退回模型自带默认。

## 行为边界

- 只改**默认值**，不改显式选择。调用方（模型选择器、SDK、ACP、子代理、fork）显式给出的等级永远优先。
- 对“没有显式指定等级”的调用（例如某些入口直接发请求），插件会把配置的等级填进去，让行为和选择器一致。
- 新会话的初始模型来自部署默认（`agent-default-model` 的 `provider`/`model`/`reasoningEffort`）。若那里给该模型写了显式等级，插件会用你配置的等级替换它——这正是“选中这个模型就用这个等级”。替换前会确认该等级被模型支持，避免启动路径报错。
- 卸载插件会恢复被包装的服务方法，模型回到适配器自带默认。

## 实现

| 触点 | 作用 |
| --- | --- |
| `ctx.llm.resolveModelInfo` | 改写模型的 `reasoning.defaultEffort`，模型目录（选择器、设置页）因此显示并发送配置的等级 |
| `ctx.llm.resolveCallConfig` | 调用方没指定等级时，把配置的等级填进去（不支持则回退并警告） |
| `ctx.agentDefaultModel.currentSelection` | 新会话的初始选择也使用配置的等级（仅在该等级已被观测为模型支持时替换） |
| `GET /dsh-thinking-levels/catalog` | 设置页读取：每个模型支持的等级、当前生效等级、覆盖值 |
| `POST /dsh-thinking-levels/set` | 设置页写入：经 `ctx.configEditor` 落到 profile patch |
| 设置导航图标（客户端） | 外壳按 section id 硬编码图标（只有 `account`/`models`/`agent-presets`/`plugins`/`archived-sessions` 有专属字形，其余一律齿轮），slot 契约没有图标字段；客户端把本行的齿轮换成大脑字形 |

所有 wrapper 都在 `ctx.effect` 中安装，卸载即还原。插件激活后会后台预热一次模型能力（填充“支持哪些等级”），让新会话路径也能安全替换。HTTP 路由经 `ctx.get('webServer')` 注册；没有 Web 载体的部署只失去设置页，思考等级照常生效。

## 开发

```bash
node --test test/apply.test.mjs   # 21 个用例：元数据改写、调用默认值、新会话默认、路由、持久化边界
```

宿主的 `webServer` 等可选服务**必须**经 `ctx.get('webServer')` 或 `ctx.inject([...])` 取得；直接读 `ctx.webServer` 会抛 `cannot get property "webServer" without inject`。
