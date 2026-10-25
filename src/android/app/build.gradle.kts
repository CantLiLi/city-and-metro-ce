import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版本号跟桌面版同源：从 src/python/citymetro/about.py 读，改一处两边都变
val aboutFile = file("../../python/citymetro/about.py")
val about = Properties().apply {
    if (aboutFile.isFile) {
        aboutFile.readLines(Charsets.UTF_8).forEach { line ->
            val m = Regex("""^(APP_NAME|VERSION)\s*=\s*['"](.+?)['"]""").find(line)
            if (m != null) setProperty(m.groupValues[1], m.groupValues[2])
        }
    }
}
val appVersion: String = (findProperty("cmVersion") as String?)
    ?: about.getProperty("VERSION", "2.1.0")
val appName: String = about.getProperty("APP_NAME", "城市与地铁社区版")

// 2.1.0 -> 20100；Android 的 versionCode 必须单调递增
val appVersionCode: Int = run {
    val parts = Regex("""\d+""").findAll(appVersion).map { it.value.toInt() }.take(3).toList()
    val padded = parts + List(3 - parts.size) { 0 }
    padded[0] * 10000 + padded[1] * 100 + padded[2]
}

android {
    namespace = "com.cityandmetro.ce"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cityandmetro.ce"
        minSdk = 24
        targetSdk = 34
        versionCode = appVersionCode
        versionName = appVersion
        resourceConfigurations += listOf("zh", "en")
    }

    // 签名：有 cm-signing.properties 就用它，否则回落 debug 签名（本地安装够用）
    val signingFile = rootProject.file("cm-signing.properties")
    signingConfigs {
        if (signingFile.isFile) {
            create("release") {
                val p = Properties().apply { signingFile.inputStream().use { load(it) } }
                storeFile = rootProject.file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isMinifyEnabled = false
            isDebuggable = true
        }
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.findByName("release")
                ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    // assets/ 里是 src/ 的拷贝，已是压缩好的文本与图片，再压一遍只费时间
    androidResources {
        noCompress += listOf("json", "png", "webp", "woff2")
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "DebugProbesKt.bin")
    }

    lint {
        abortOnError = false
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
}
