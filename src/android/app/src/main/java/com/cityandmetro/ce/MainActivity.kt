package com.cityandmetro.ce

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Android 外壳：开一个系统 WebView，加载 assets/src/index.html，并注入与桌面版同名的桥。
 *
 * 对应 Python 端的 main.py + window.py：Python 那套 pywebview 在 Android 上没有，这里换成
 * 系统 WebView；前端 js/platform/desktop.js 只认 window.pywebview.api 上的函数名，
 * 所以桥的类名无所谓，方法名必须与 bridge.py 一致。
 */
class MainActivity : AppCompatActivity(), ShellApi.Host {

    private lateinit var web: WebView
    private lateinit var api: ShellApi
    private lateinit var store: Store

    private var filePicker: ValueCallback<Array<Uri>>? = null
    private lateinit var pickJson: androidx.activity.result.ActivityResultLauncher<Array<String>>
    private lateinit var pickSave: androidx.activity.result.ActivityResultLauncher<String>

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)

        store = Store.open(this)
        api = ShellApi(store, this)

        val root = FrameLayout(this)
        root.setBackgroundColor(0xFFEAF1F7.toInt())
        web = WebView(this)
        root.addView(
            web,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        setContentView(root)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = false
            loadWithOverviewMode = false
            builtInZoomControls = false
            displayZoomControls = false
            textZoom = 100
            setSupportZoom(false)
        }
        web.setBackgroundColor(0xFFEAF1F7.toInt())
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        applyInsets(root)

        pickJson = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri == null) {
                api.deliverImport(null)
                return@registerForActivityResult
            }
            val text = runCatching {
                contentResolver.openInputStream(uri)?.use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()
            val name = queryName(uri) ?: "导入的存档"
            if (text == null) {
                Toast.makeText(this, "读取文件失败", Toast.LENGTH_SHORT).show()
                return@registerForActivityResult
            }
            web.evaluateJavascript(
                "(function(){if(window.__cmAndroidImport)window.__cmAndroidImport(" +
                    JSONObject.quote(text) + "," + JSONObject.quote(name) + ");})();",
                null,
            )
            api.deliverImport(text)
        }

        pickSave = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
            val cb = filePicker
            filePicker = null
            cb?.onReceiveValue(if (uri == null) null else arrayOf(uri))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? = null

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                view?.evaluateJavascript(apiExtraJs(), null)
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
                msg ?: return true
                android.util.Log.i("citymetro-web", "${msg.message()} @${msg.lineNumber()}")
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                filePicker?.onReceiveValue(null)
                filePicker = callback
                val accept = params?.acceptTypes?.filter { it.isNotBlank() }?.toTypedArray()
                return try {
                    if (params?.mode == FileChooserParams.MODE_SAVE) {
                        pickSave.launch("城市与地铁社区版-进度.cmsave.json")
                    } else {
                        pickJson.launch(if (accept.isNullOrEmpty()) arrayOf("*/*") else accept)
                    }
                    true
                } catch (e: ActivityNotFoundException) {
                    filePicker = null
                    false
                }
            }
        }

        web.addJavascriptInterface(Bridge(), "pywebviewApiJs")

        if (savedInstanceState == null) {
            web.loadUrl(entryUrl())
        } else {
            web.restoreState(savedInstanceState)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun entryUrl(): String = "file:///android_asset/src/index.html"

    /** 与 main.py 的 on_loaded 一样：页面就绪后再注入 __CM_DESKTOP__，早注入会碰不到 CM.desktop。 */
    private fun apiExtraJs(): String {
        val boot = """
            (function(){
              if(!window.__CM_DESKTOP__){
                window.__CM_DESKTOP__ = true;
                window.CM = window.CM || {};
                if(window.CM.desktop){
                  window.CM.desktop.name = ${JSONObject.quote(About.APP_NAME)};
                  window.CM.desktop.version = ${JSONObject.quote(About.VERSION)};
                }
                window.__CM_UPDATE_INFO__ = ${JSONArray(About.UPDATE_INFO).toString()};
                window.dispatchEvent(new CustomEvent("__cmDesktopReady", {
                  detail: { name: ${JSONObject.quote(About.APP_NAME)},
                            version: ${JSONObject.quote(About.VERSION)},
                            updateInfo: ${JSONArray(About.UPDATE_INFO).toString()} }
                }));
              }
            })();
        """.trimIndent()

        // desktop.js 找的是 window.pywebview.api；这里把注入对象的 API 面拼成同一个形状
        val shape = """
            (function(){
              if(window.pywebview && window.pywebview.api) return;
              var raw = window.pywebviewApiJs;
              if(!raw) return;
              var api = {};
              ${ShellApiMethods.METHODS.joinToString("\n              ") { m ->
            "api['$m'] = function(){ return raw.call('$m', Array.prototype.slice.call(arguments)); };"
        }}
              window.pywebview = { api: api };
              window.dispatchEvent(new Event('pywebviewready'));
            })();
        """.trimIndent()

        return boot + "\n" + shape
    }

    /** 由 JsInterface 暴露给 JS 的唯一入口：call(方法名, 参数数组) -> 返回值的 JSON 文本。 */
    inner class Bridge {
        @JavascriptInterface
        fun call(name: String, args: String): String {
            val arr = runCatching { JSONArray(args) }.getOrNull() ?: JSONArray()
            val arg = { i: Int -> if (i < arr.length()) arr.opt(i) else null }
            val result: Any = when (name) {
                "app_info" -> api.app_info()
                "log_client" -> api.log_client(arg(0)?.toString())
                "save_index_get" -> api.save_index_get()
                "save_index_set" -> api.save_index_set(arg(0))
                "save_index_rebuild" -> api.save_index_rebuild()
                "save_slot_write" -> api.save_slot_write(arg(0)?.toString(), arg(1)?.toString())
                "save_slot_read" -> api.save_slot_read(arg(0)?.toString())
                "save_slot_verify" -> api.save_slot_verify(arg(0)?.toString(), arg(1)?.toString())
                "save_slot_delete" -> api.save_slot_delete(arg(0)?.toString())
                "save_dir" -> api.save_dir()
                "cache_read" -> api.cache_read(arg(0))
                "cache_write" -> api.cache_write(arg(0))
                "export_to_file" -> api.export_to_file(arg(0)?.toString())
                "open_import_file" -> api.open_import_file()
                "open_doc" -> api.open_doc(arg(0)?.toString())
                "open_external" -> api.open_external(arg(0)?.toString())
                "open_data_dir" -> api.open_data_dir()
                "set_gpu" -> api.set_gpu(arg(0))
                "set_window_mode" -> api.set_window_mode(arg(0))
                "perf_stats" -> api.perf_stats(arg(0))
                "quit_app" -> api.quit_app()
                else -> JSONObject().put("ok", false).put("error", "未知接口 $name")
            }
            return (result as? JSONObject)?.toString() ?: JSONObject().put("ok", true).toString()
        }
    }

    private fun queryName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, null, null, null, null)?.use { c ->
            if (!c.moveToFirst()) return@use null
            val idx = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) c.getString(idx) else null
        }
    }.getOrNull()

    private fun applyInsets(root: View) {
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        val ctrl = WindowInsetsControllerCompat(window, root)
        ctrl.isAppearanceLightStatusBars = true
    }

    // ---------------- ShellApi.Host ----------------

    override fun openExternal(url: String): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: Exception) {
        false
    }

    override fun shareExport(file: File, title: String) {
        runOnUiThread {
            try {
                val uri = androidx.core.content.FileProvider.getUriForFile(
                    this, "$packageName.files", file,
                )
                val intent = Intent(Intent.ACTION_SEND).apply {
                    type = "application/json"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_TITLE, title)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(Intent.createChooser(intent, title))
            } catch (e: Exception) {
                Toast.makeText(this, "导出失败：${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun pickImport() {
        runOnUiThread {
            try {
                pickJson.launch(arrayOf("application/json", "*/*"))
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun quit() {
        runOnUiThread {
            web.evaluateJavascript(
                "(function(){try{return typeof window.__cmDesktopClose==='function'?window.__cmDesktopClose():null;}catch(e){return null;}})();",
            ) { _ ->
                android.os.Handler(mainLooper).postDelayed({ finishAndRemoveTask() }, 400)
            }
        }
    }

    override fun openDataDir(): Boolean = false

    override fun openDoc(name: String): Boolean = try {
        val text = assets.open("docs/$name").use { it.readBytes().toString(Charsets.UTF_8) }
        val intent = Intent(this, DocActivity::class.java).apply {
            putExtra(DocActivity.EXTRA_TITLE, name)
            putExtra(DocActivity.EXTRA_TEXT, text)
        }
        startActivity(intent)
        true
    } catch (e: Exception) {
        false
    }

    /** 返回键：先交给网页处理（关面板、退草案），网页不接管再退回桌面。 */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        web.evaluateJavascript(
            "(function(){try{" +
                "var ui=window.CM&&window.CM.ui;" +
                "if(ui&&ui.onBack&&ui.onBack())return 'handled';" +
                "var d=document.querySelector('.sheet.open,.modal.open,.win.open');" +
                "if(d){var b=d.querySelector('.close,[data-close]');if(b){b.click();return 'handled';}}" +
                "return 'exit';}catch(e){return 'exit';}})();",
        ) { result ->
            if (result != null && result.contains("handled")) return@evaluateJavascript
            runOnUiThread { finish() }
        }
    }
}

/** 桥暴露给 JS 的方法名，与 bridge.py 的 ShellApi 公开方法一一对应。 */
object ShellApiMethods {
    val METHODS = listOf(
        "app_info",
        "log_client",
        "save_index_get",
        "save_index_set",
        "save_index_rebuild",
        "save_slot_write",
        "save_slot_read",
        "save_slot_verify",
        "save_slot_delete",
        "save_dir",
        "cache_read",
        "cache_write",
        "export_to_file",
        "open_import_file",
        "open_doc",
        "open_external",
        "open_data_dir",
        "set_gpu",
        "set_window_mode",
        "perf_stats",
        "quit_app",
    )
}
