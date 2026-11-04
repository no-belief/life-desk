# 日常规划 · 生活工作台

一个只为「把明天想清楚」而存在的页面。计划存在**你自己的 GitHub 仓库**里，
每次增删改都即时写回线上，换设备、换浏览器打开数据都还在。

- 纯静态：`index.html` + `styles.css` + `app.js`，无框架、无构建、无第三方脚本
- 数据层：GitHub Contents API（读 + 带 sha 乐观锁的写 + 冲突自动合并重试）
- 先渲染界面再拉数据；读/写失败都有明确提示与重试，不白屏、不静默丢数据

---

## 一、准备两个仓库

GitHub **免费账号的 Pages 不能发布私有仓库**，所以把「放页面的仓库」和「放数据的仓库」分开：

| 用途 | 可见性 | 说明 |
| --- | --- | --- |
| 页面仓库（如 `life-desk`） | **公开** | 只放 `index.html` / `styles.css` / `app.js`，不含任何私人数据 |
| 数据仓库（如 `life-desk-data`） | **私有** | 只有 `data/workspace.json`，你的计划都在这里 |

> 用付费账号也可以只用**一个私有仓库**同时发布 Pages 与存数据，页面里的「数据仓库」填成同一个即可。

## 二、发布页面

1. 新建公开仓库 `life-desk`，把 `index.html`、`styles.css`、`app.js` 三个文件传到根目录。
2. 仓库 **Settings → Pages**，Source 选 `Deploy from a branch`，分支 `main`、目录 `/`（root），保存。
3. 等 1 分钟左右，打开 `https://<你的用户名>.github.io/life-desk/`。

## 三、建数据仓库

1. 新建**私有**仓库 `life-desk-data`，勾选 *Add a README* 让它非空。
2. 在仓库里新建文件 `data/workspace.json`，内容：

   ```json
   { "v": 1, "updatedAt": 0, "days": {} }
   ```

   （也可以跳过：页面第一次连接时若发现文件不存在，会自动创建。）

## 四、签发访问令牌

**Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**

- **Repository access**：Only select repositories → 只勾选 `life-desk-data`
- **Permissions → Repository permissions → Contents**：**Read and write**（其余全部保持 No access）
- 有效期建议 1 年，到期后换一个即可

复制 `github_pat_…` 开头的令牌。

## 五、连接

打开页面 → 右上角 **设置** → 填写：

| 字段 | 示例 |
| --- | --- |
| 仓库所有者 | `your-name` |
| 数据仓库名 | `life-desk-data` |
| 分支 | `main` |
| 数据文件路径 | `data/workspace.json` |
| 访问令牌 | `github_pat_…` |

点 **保存并连接**。状态变成「已同步 · 时:分」就成功了。

**换设备/换浏览器**时重复这一步（令牌存在该设备自己的 localStorage 里，不会跟着账号走）。

---

## 用法

- 页面默认停在**明天**；顶部日期条可切到任意一天，左右箭头前后翻。
- 输入框写一句话回车加入；聚焦时可顺手选**轻重**（要紧／照常／从容）、**分类**、**预计时长**。
- 点任务文字可直接改写，回车保存；勾选框标记完成；右侧「删除」移除。
- 侧栏「今日收尾」列出**前一天**未完成的事，一键顺延到当前这一天。
- 「一周概览」给出未来 7 天的分布，点条目跳到那天。

## 数据可靠吗

| 情况 | 行为 |
| --- | --- |
| 正常读写 | 每次改动约 0.5 秒后自动写回 GitHub，状态显示「已保存 · 时:分」 |
| 写入失败（断网/限流/令牌过期） | 界面不清空，顶部提示条说明原因并给「重试保存」；改动标记为待推送，自动退避重试 |
| 关掉页面后重新打开 | 待推送的改动从本机缓存恢复，**并优先补推**，不会被线上版本覆盖 |
| 两台设备同时改 | 写入带 sha 乐观锁；冲突时自动重新拉取、按任务 ID 合并、再写入（最多重试两次） |
| 读取失败 | 先渲染本机缓存，不白屏；提示条说明原因并可重试 |
| 线上文件被改坏 | 拒绝覆盖，提示文件异常，本机数据保留 |
| 切回标签页 / 网络恢复 | 自动重新拉取（若有未保存改动则先推送） |

合并粒度是**单个任务**（按 id）。同一任务在两台设备上被同时编辑时，保留时间戳较晚的那一份。

## 安全边界

- 页面不加载任何第三方脚本、字体或统计，所有请求只发往 `api.github.com`。
- 令牌只存在**这台设备的 localStorage**，随请求直发 GitHub，不经过任何中间服务器。
- 令牌权限限定在单个数据仓库的 Contents 读写，即使泄露也碰不到你其他仓库。
- 公开的页面仓库里没有任何私人数据。

> 注意：浏览器 localStorage 内的令牌对本机同源脚本可见，请勿在公用电脑上保存令牌。公共电脑上用完点「设置 → 清除本机缓存」。

## 本地预览

纯静态页面，任何静态服务器都可以：

```bash
python -m http.server 8080
# 打开 http://localhost:8080/
```

直接双击 `index.html`（file://）也能用，但部分浏览器对 file:// 下的跨域请求更严格，建议用上面的方式。

## 文件

```
index.html            结构
styles.css            纸感排版样式（含移动端与 prefers-reduced-motion）
app.js                状态、渲染、GitHub 数据层
data/workspace.json   初始数据（可选）
```
