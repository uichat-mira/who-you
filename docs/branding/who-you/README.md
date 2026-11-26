# 狐邮 Who-You · Web 物料包

基于用户提供的原始 PNG 提取标识和字标；没有重新绘制图形或改变品牌名称。背景透明，信封和尾巴内部白色保留。深色版采用浅色描边及浅色字标。

## 文件选择
- `logo/light/horizontal-bilingual.png`：浅色网站导航栏（建议显示高度 32–44 CSS px）。
- `logo/{light,dark}/horizontal-{zh,en,bilingual}`：中文、英文、双语横版。
- `logo/{light,dark}/vertical-{zh,en,bilingual}`：登录页、关于页等竖版。
- `logo/{light,dark}/symbol`：无文字标识，PNG 和无损 WebP。
- `icon/`：透明图标，16–512px，含 120px 规格。
- `favicon/`：ICO、16/32px PNG、180px Apple touch icon。
- `pwa/`：192/512px maskable 图标及可合并到项目 manifest 的示例配置（路径相对于该文件）。
- `tokens.css`：从原图归纳的建议品牌色，并非历史官方色值。
- `source/original.png`：原始输入文件。`preview.html`：离线预览。

## Web 示例
```html
<link rel="icon" href="/brand/favicon/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/brand/favicon/apple-touch-icon.png">
<img src="/brand/logo/light/horizontal-bilingual.webp" alt="狐邮 Who-You" height="40">
```
不要拉伸图标；CSS 设置 `width:auto`。深色界面使用 `dark` 目录。透明图标适合普通浅色背景；深色界面优先使用带外描边的 symbol。所有资产为从原图提取的位图，不是可编辑矢量 SVG；细小尺寸由高分辨率原图缩放而来。

## 项目内归档

原始 Web 物料包 SHA-256：`de9b28b4cf9324496f7312c117f15f355dda44ea54f6bc68278e6f608bb255db`。

可部署的图片和 PWA 示例位于 [public/brand](../../../public/brand/)；本目录的原图、色值文件和预览仅作为设计档案。离线预览 HTML 的资源引用已调整为项目内相对路径，图片文件保持原始字节。运行时 token 以 [design-tokens.ts](../../../src/web/design-tokens.ts) 为准。
