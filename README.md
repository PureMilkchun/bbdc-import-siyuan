<div align="center">
  <img src="icon.png" width="120" height="120" alt="不背单词导入插件图标">

# 不背单词导入

**让思源 Agent 帮你收集生词，直接加入「不背单词」的生词本。**

思源桌面版 3.8.6+ · Windows / macOS / Linux

[下载安装包](https://github.com/PureMilkchun/bbdc-import-siyuan/releases/latest) · [查看上架进度](https://github.com/siyuan-note/bazaar/pull/2535)

</div>

---

## 把生词交给 Agent

在阅读笔记或整理词表时，直接告诉思源 Agent：

> 把 resilient、vivid 和 serendipity 加入我的不背单词生词本。

Agent 会调用插件，先检查登录状态和词表。确认窗口会列出本次提交的词，点击「加入生词本」后开始导入。完成后可以让 Agent 汇报新增和已存在的词。

**每批最多 20 个词**，较长的词表可分批导入。也可以说「只核对这些词是否已经在生词本里」，插件会只查询。

## 安装

> 思源集市中可以搜索「不背单词导入」。如果暂时搜索不到，可以按下面的步骤手动安装。

1. 从 [Releases](https://github.com/PureMilkchun/bbdc-import-siyuan/releases/latest) 下载 **package.zip**。
2. 打开思源 **设置 → 集市**，选择本地 ZIP 安装。
3. 安装后启用「不背单词导入」插件。

需要使用思源桌面版 **3.8.6 或更新版本**。无需安装 Python、Node.js 或额外服务。

## 第一次使用

**登录账号**

点击思源顶部工具栏的「不背单词 · 登录」，在独立窗口里登录。完成后关闭窗口，回到思源。登录会话过期时，重新打开窗口登录即可。

**告诉 Agent 要做什么**

在思源 Agent 对话中，可以直接说：

- 「把这份词表加入不背单词生词本。」
- 「先检查这些词哪些已经在我的生词本里。」
- 「从这段内容中整理我指定的生词，发给我确认后导入。」

Agent 将提交选定的英文词或短语。上传前请在弹窗中核对词表。一次最多提交 20 个词。

**查看结果**

Agent 会拿到新增、已存在、未完成和结果待核对的词。如果出现「结果待核对」，这个词可能已经写入，请先查询生词本，再决定是否重试。

## 常见问题

**Agent 找不到工具？**

打开思源「设置 → AI → Agent 能力」，启用「不背单词生词本」，然后新建一个 Agent 对话。

**登录和词表会发到哪里？**

登录会话保存在插件的独立浏览器会话中。插件读取账号的生词本分页列表来核对是否已存在，并向词典查询选定词的释义。插件不会自行读取或修改思源笔记，Agent 只会传入它选定的词。

**支持手机或浏览器版思源吗？**

目前支持 Windows、macOS 和 Linux 桌面版。网页版和移动端可使用 [WordRadar](https://github.com/seven-steven/word-radar) 的 CSV 流程。

## 关于

本插件由社区独立开发，与不背单词官方无隶属关系。实现时参考了 [WordRadar](https://github.com/seven-steven/word-radar) 对网页接口的研究。网页接口可能调整，登录与同步情况以不背单词服务为准。

代码及原创图标采用 [MIT 许可证](LICENSE)。
