# LexiCS Android — 计算机学术英语

基于 LexiCS 原有 137 词汇的 **离线 Android 安装应用**。

- Android 8.0+，适配 Android 14
- 不需要联网，不需要 AI API，不需要登录
- 闪卡学习、间隔复习、学术词库、拼写和选择题
- 数据保存到应用私有存储
- 使用 Android 系统朗读服务
- 系统文件选择器导入 JSON 备份 / 系统文档保存器导出 JSON

## 构建

- Android Gradle Plugin 8.7.3
- Gradle 8.9
- JDK 17
- compile SDK 35, target SDK 34

`gradle :app:assembleDebug`

GitHub Actions 在推送 `lexics-android` 分支时自动构建，并将 `app-debug.apk` 上传到 **Actions → 构建任务 → Artifacts**。从 Artifacts 下载 ZIP 后解压获得 APK，可以安装到 Android 14。

注意：这是一款 Android WebView 混合式原生安装应用，而不是纯 Kotlin/Compose 重写；页面全部打包为本地 assets，不依赖远程网页。Debug APK 使用 Android 调试签名，重复云编译生成的调试签名可能变化，升级时可能需要先备份并卸载旧版。
