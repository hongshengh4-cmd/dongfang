# 东方夜雀食堂网页复刻 — 静态部署包

本压缩包可直接解压到静态网站仓库根目录（或 `docs/` 目录）部署。无需 Node、Python、构建命令或后端服务。资源引用使用相对路径，可部署在 GitHub Pages 的仓库子路径下。

## GitHub Pages 部署

1. 解压本包，将其中的 `index.html`、`src/`、`assets/`、`data/` 和 `.nojekyll` 放到仓库根目录。也可以全部放进 `docs/`，然后在仓库 **Settings → Pages** 选择该发布目录。
2. 提交并推送到 GitHub。
3. 在 **Settings → Pages** 选择对应分支和目录，等待发布完成后打开 Pages 地址。

其他静态托管平台：将解压后的目录内容作为站点根目录上传即可。不要只上传这个 ZIP 文件；需要先解压并提交里面的文件。

## 当前功能范围

这是当前网页版本的静态部署包，包含首店菜单、夜间接客、烹饪上菜、结算和下一日循环。**白天探索地图、角色自由移动与场景交互尚未实现**，因此不是完整的原作 RPG 复刻。游戏进度保存在浏览器本地存储中。

## 包内内容

- `index.html`、`src/`：页面、交互逻辑与样式。
- `assets/original/sprites/`：运行所需的原作图像素材。
- `data/runtime/`、`data/original/text/`：玩法数据、精灵索引与文本数据。
- `DEPLOY-MANIFEST.txt`：本包每个文件的字节数和 SHA-256。

包内不含 Unity 原始 bundles、提取脚本或虚拟环境；浏览器运行不需要它们。
