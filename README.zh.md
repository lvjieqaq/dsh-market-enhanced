<p align="center">
  <img src="assets/logo.svg" width="96" alt="dsh-market logo">
</p>

# dsh-market

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dshmarket)](https://www.npmjs.com/package/dshmarket)
[![stars](https://img.shields.io/github/stars/dsh-market/dsh-market?style=flat)](https://github.com/dsh-market/dsh-market)

装在 DeepSeek Harness 里的插件市场。打开设置 → **插件市场** → 逛一逛，点一下，装好。

![dsh-market](assets/demo-zh.png)

## 安装

```sh
dsh plugin --profile web add dshmarket
```

重启 `dsh web`，打开 **设置 → 插件市场**。

## 你会得到

- **逛与搜**——完整社区目录（230+ 插件，每天在涨），分类筛选、star 数、最热/最新排序，中英描述跟随界面语言
- **一键安装**——确认来源，实时进度；多数插件刷新页面即可用，无需重启
- **更新**——逐插件检测（npm 版本或锁定 commit 对比 HEAD），一键更新；市场自己也走同一通道升级
- **卸载**——两步确认防误触；本次会话装的插件即点即卸
- **零术语**——缺组件（pnpm）时市场自己发现、一键自动装好，全程不见命令行
- **导出日志**——一键生成脱敏纯文本日志方便反馈（home 路径与密钥形状已打码；任何数据都不会被上传）

## 速度

只要插件发布了 npm 包（registry 会校验其 repository 指回同一仓库,防冒名）,安装即走 npm tarball 而非整仓 GitHub 下载——通常秒级;仅 GitHub 分发的插件取决于你到 GitHub 的网络。

## 安全

- 只允许安装 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选列表内的来源,其它一律拒绝
- 构建脚本默认禁止执行（pnpm ≥10）,放行与否由你按包显式决定
- 终端/命令行类插件装进网页版前会被明确提醒
- 安装接口只接受同源 POST;市场不会向任何地方上报数据
- 收录 ≠ 背书:插件是第三方代码,请只安装你信任的来源

## 数据源

实时来自 [awesome-dsh-plugin.com/plugins.json](https://awesome-dsh-plugin.com/plugins.json)——精选条目、npm 映射、star 数由 CI 每日刷新——内置快照做离线兜底。

## 社区增强（本 fork 相对官方 1.1.0 的额外修复）

- **目录磁盘缓存 + 后台静默刷新**：目录秒开、重启不丢数据，页面显示更新时间和数据来源，可手动刷新
- **更新不再死循环**：更新时钉住精确版本号安装（绕过 pnpm 24 小时 minimumReleaseAge 的静默回退），装完校验版本真的变了，未生效会明确报错；被年龄策略拒绝时自动写入 `minimumReleaseAgeExclude` 并重试
- **启用/停用开关**：「已安装」页每个插件带停用/启用按钮（写入用户补丁层，HMR 即时生效，重启后保持）
- **坏插件自动停用保护**：安装后启动失败的插件会被自动写入停用补丁，避免下次启动整个 GUI 挂掉
- **网络快速失败**：单请求 15 秒超时、重试 1 次（环境变量 + 建议配置 pnpm-workspace.yaml 的 fetchTimeout），GitHub 直装不再卡几分钟
- **安装更稳**：超时 10 分钟；pnpm 拦截构建脚本时自动写入 `allowBuilds` 并重试一次
- **界面提示**：无 npm 包的插件显示「GitHub 直装可能很慢」警告；失败时识别网络超时并给出提示

安装（GitHub 源）：

```sh
dsh plugin --profile web add github:<owner>/dsh-market
```

## 许可

MIT · 基于 [dsh-market](https://github.com/dsh-market/dsh-market) · [dshmarket.com](https://dshmarket.com)
