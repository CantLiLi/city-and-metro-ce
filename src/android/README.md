# Android 版

用系统 WebView 跑同一份前端，Kotlin 复刻桌面版 `bridge.py` 的桥。

## 打包

```bash
python src/android/build_apk.py
```

产物在 `.tmp/build/android/output/CityAndMetroCE_v<版本>-debug.apk`（约 11.7 MB），
装上就能用。版本号直接读 `src/python/citymetro/about.py`，跟桌面版同源。

打 release 包：

```bash
python src/android/build_apk.py --release
```

没有签名文件时 release 也走 debug 签名（本地安装够用，不能上架）。
要正式签名就照 `local.properties.example` 旁边那份说明建 `cm-signing.properties`：

```properties
storeFile=keystore.jks
storePassword=xxx
keyAlias=xxx
keyPassword=xxx
```

## 前置条件

脚本开头会自己检查，缺什么直接说缺什么：

- **JDK 17**：注意 GraalVM 不行，AGP 8.4 要的 `jlink` 它跑不了
- **Android SDK**：优先用本目录的 `sdk/`（见下），否则看 `ANDROID_HOME` 或
  `local.properties` 的 `sdk.dir`。需要 `platforms;android-34` 和 `build-tools;34.0.0`
- **Gradle 8.7+**：工程里有 `gradlew` 就用它，否则用本目录的 `gradle-tools/gradle-*`，
  最后才找 PATH

两份工具链都放在本目录、已被 `.gitignore` 忽略，不污染仓库：

```
src/android/sdk/            cmdline-tools + platforms + build-tools 装的 SDK
src/android/gradle-tools/   解压的 gradle-8.7
```

从零装一次（就是上面两个目录的来源）：

```powershell
$env:JAVA_HOME = "C:\Program Files\Java\jdk-17"
$sdk = "$PWD\src\android\sdk"
Invoke-WebRequest -Uri "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" -OutFile cmdline-tools.zip
Expand-Archive cmdline-tools.zip -DestinationPath tmp-clt
New-Item -ItemType Directory -Force -Path "$sdk\cmdline-tools" | Out-Null
Move-Item tmp-clt\cmdline-tools "$sdk\cmdline-tools\latest"
"y`n" * 40 | & "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --licenses
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" "platform-tools" "platforms;android-34" "build-tools;34.0.0"

New-Item -ItemType Directory -Force -Path src\android\gradle-tools | Out-Null
Invoke-WebRequest -Uri "https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip" -OutFile gradle.zip
Expand-Archive gradle.zip -DestinationPath src\android\gradle-tools
```

之后直接 `python src/android/build_apk.py` 就行，不再需要设环境变量。

国内下载走阿里云镜像，源配在 `settings.gradle.kts` 里。

> `local.properties` 里的 `sdk.dir` 是 Java properties，路径中的反斜杠必须写成两个：
> `sdk.dir=G:\\CodeDevelop\\...\\sdk-root`。手写成单个反斜杠时 Gradle 会把 `\C`
> 当转义序列吃掉，报「文件名或目录名语法不正确」。脚本会识别这种错误并重写该文件。

## 目录

| 路径 | 作用 |
| --- | --- |
| `app/src/main/java/com/cityandmetro/ce/MainActivity.kt` | WebView 外壳，加载 `assets/src/index.html`，注入 `__CM_DESKTOP__` |
| `app/src/main/java/com/cityandmetro/ce/ShellApi.kt` | 桥 + 存档/缓存实现，方法名对齐 `bridge.py` |
| `app/src/main/java/com/cityandmetro/ce/DocActivity.kt` | 查看许可与第三方声明（`open_doc`） |
| `sync_assets.py` | 把 `src/` 拷进 `assets/src/`，构建前自动跑 |
| `make_icons.py` | 从 `src/resources/icon.png` 切各密度图标，图标变了才需要跑 |
| `build_apk.py` | 一键打包 |
| `sdk/` | 本地 Android SDK，`cmdline-tools` 装的，不进版本控制 |
| `gradle-tools/` | 本地 Gradle，脚本在没 `gradlew` 时用它 |

`app/src/main/assets/` 和 `local.properties` 都在 `.gitignore` 里：前者是 `src/` 的拷贝，
提交进去只会让两份代码打架。

## 和桌面版的差别

前端代码一行没改，靠 `js/platform/desktop.js` 里每个方法自带的
`if (!isDesktop())` 退路。能力上缺这些：

- `set_gpu` / `set_window_mode` / `perf_stats`：Android 没有对应的东西，直接返回不支持
- `open_data_dir`：Android 没法用文件管理器打开应用私有目录，改由系统的导出/导入流程代替
- 导入存档走系统文件选择器（异步），所以 `open_import_file` 先返回 `pending`，
  真正的文本通过 `window.__cmAndroidImport` 回推

存档存在 `getFilesDir()/saves/`，卸载应用才会清掉。目录结构与桌面版一致：
`index.json` 是清单，`slots/` 下一个存档一个文件。

## 数据布局

```
files/
  saves/index.json        存档清单
  saves/slots/cm1.slot.*  存档本体
  cache/                  渲染缓存（按 key 散列命名，超过 4000 个自动清旧的）
  exports/                导出的存档，导完走系统分享
  profile/
```
