package com.cityandmetro.ce

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 进程占用采样，对应 Python 端 perf.py 里 Windows/macOS 那两套实现。
 *
 * CPU 取 /proc 里本进程的 utime+stime，与上次采样差分后除以经过的时间，再摊到整机核数上——
 * 与桌面版一个口径（1 核跑满时多核机器显示 100/核数%）。Android 8 起 /proc 里别的进程不可读，
 * 本进程的仍可读，所以只报本进程，子进程（WebView 渲染等）不在统计内。
 * GPU 在 Android 上没有可移植的进程级入口，只在系统暴露 /sys/class/kgsl 等计数器时才有值。
 */
class Perf {
    private var lastCpu = 0.0
    private var lastAt = 0L
    private val cores = Runtime.getRuntime().availableProcessors().coerceAtLeast(1)

    private fun ticksPerSec(): Double = android.system.Os.sysconf(android.system.OsConstants._SC_CLK_TCK).toDouble()

    private fun cpuSeconds(): Double? {
        val stat = runCatching { File("/proc/self/stat").readText() }.getOrNull() ?: return null
        // 第 2 项 comm 带括号、里面可能有空格，所以从最后一个 ')' 之后再数
        val tail = stat.substring(stat.lastIndexOf(')') + 1).trim().split(' ')
        val utime = tail.getOrNull(11)?.toLongOrNull() ?: return null
        val stime = tail.getOrNull(12)?.toLongOrNull() ?: return null
        return (utime + stime) / ticksPerSec()
    }

    fun cpu(): Double? {
        val now = cpuSeconds() ?: return null
        val at = System.nanoTime()
        val prevCpu = lastCpu
        val prevAt = lastAt
        lastCpu = now
        lastAt = at
        if (prevAt == 0L) return null
        val elapsed = (at - prevAt) / 1e9
        if (elapsed <= 0) return null
        return round1(((now - prevCpu) / elapsed * 100 / cores).coerceIn(0.0, 100.0 * cores))
    }

    fun ram(): Int {
        // 先用内核的 RSS（不含 WebView 进程共享页的开销），拿不到再退回虚拟机统计
        val statm = runCatching { File("/proc/self/statm").readText() }.getOrNull()
        if (statm != null) {
            val pages = statm.trim().split(' ').getOrNull(1)?.toLongOrNull()
            if (pages != null) {
                val pageKb = android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE) / 1024
                return (pages * pageKb).toInt()
            }
        }
        val rt = Runtime.getRuntime()
        return ((rt.totalMemory() - rt.freeMemory()) / 1024 / 1024).toInt()
    }

    fun gpu(): Double? {
        val u = gpuBusyUs() ?: return null
        val at = System.nanoTime()
        val prev = lastGpu
        val prevAt = lastGpuAt
        lastGpu = u
        lastGpuAt = at
        if (prevAt == 0L || prev == null) return null
        val elapsedUs = (at - prevAt) / 1000.0
        if (elapsedUs <= 0) return null
        return round1(((u - prev) / elapsedUs * 100).coerceIn(0.0, 100.0))
    }

    private var lastGpu: Long? = null
    private var lastGpuAt = 0L

    private fun gpuBusyUs(): Long? {
        // Adreno：kgsl 把本进程的 gpu 忙时间写成纳秒
        runCatching { readFirstLine("/sys/class/kgsl/kgsl-3d0/gpubusy") }.getOrNull()?.let { line ->
            val parts = line.trim().split(' ')
            if (parts.size >= 2) {
                val busy = parts[0].toLongOrNull()
                if (busy != null) return busy / 1000
            }
        }
        // Mali：只有全局 busy 百分比，没有进程级计数，这里不猜
        return null
    }

    private fun readFirstLine(path: String): String? {
        val f = File(path)
        if (!f.canRead()) return null
        return f.bufferedReader().use { it.readLine() }
    }

    private fun round1(v: Double): Double = Math.round(v * 10.0) / 10.0
}

/**
 * 桌面壳的数据目录，对应 Python 端的 storage.py + saves.py。
 *
 * 目录结构照搬桌面版：files/saves/slots/ 下每个存档一个文件，清单是 slots/mk-1.index。
 */
class Store(root: File) {
    private val saves = File(root, "saves")
    private val slots = File(saves, "slots")
    private val cache = File(root, "cache")
    private val exports = File(root, "exports")
    private val prof = File(root, "profile")

    val indexFile = File(slots, INDEX_KEY)
    val cacheDir: File get() = cache
    val exportDir: File get() = exports
    val profileDir: File get() = prof
    val saveDir: File get() = slots

    init {
        slots.mkdirs()
        cache.mkdirs()
        exports.mkdirs()
        prof.mkdirs()
    }

    companion object {
        const val KEY_MAX = 120
        const val BODY_MAX = 64L * 1024 * 1024
        const val INDEX_KEY = "index.json"
        const val FILE_SUFFIX = ".mksave"
        const val CACHE_KEEP = 4000
        const val CACHE_KEY_MAX = 200
        const val CACHE_TEXT_MAX = 300_000

        fun open(context: Context): Store = Store(context.filesDir)

        /** 键来自前端，只允许它出现在文件名里：路径分隔符、上跳与保留字符一律拒绝。 */
        fun slotName(key: String?): String? {
            if (key == null || key.isEmpty() || key.length > KEY_MAX) return null
            if (key.any { it in "/\\:*?\"<>|" }) return null
            if (key.startsWith(".") || key.contains("..")) return null
            return key
        }
    }

    fun slotFile(key: String?): File? {
        val name = slotName(key) ?: return null
        return File(slots, name)
    }

    fun cacheFile(key: String): File =
        File(cache, sha1(key))

    /** 先写临时文件再改名，写到一半断电也不会把旧档写坏。 */
    fun writeAtomic(target: File, text: String) {
        val tmp = File(target.path + ".tmp")
        tmp.writeText(text, Charsets.UTF_8)
        if (!tmp.renameTo(target)) {
            target.delete()
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        }
    }

    fun readText(file: File): String? = try {
        if (file.isFile) file.readText(Charsets.UTF_8) else null
    } catch (e: Exception) {
        null
    }

    fun pruneCache() {
        val files = cache.listFiles()?.filter { it.isFile } ?: return
        val extra = files.size - CACHE_KEEP
        if (extra <= 0) return
        files.sortedBy { it.lastModified() }.take(extra).forEach { it.delete() }
    }

    private fun sha1(text: String): String {
        val d = MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(d.size * 2)
        for (b in d) sb.append("%02x".format(b.toInt() and 0xff))
        return sb.toString()
    }
}

/**
 * 网页与外壳之间的桥，方法名与返回结构逐字对齐 Python 端的 bridge.py / saves.py。
 * 网页侧见 js/platform/desktop.js，它只认 window.pywebview.api 上同名的函数。
 */
class ShellApi(
    private val store: Store,
    private val host: Host,
) {
    private val perf = Perf()

    interface Host {
        fun openExternal(url: String): Boolean
        fun shareExport(file: File, title: String)
        fun pickImport(): Unit
        fun quit(): Unit
        fun openDataDir(): Boolean
        fun openDoc(name: String): Boolean
    }

    // 导入是异步的：前端调一次，外壳弹选择器，选完再把文本送到 window.__cmAndroidImport
    @Volatile
    private var pendingImport: ((String?) -> Unit)? = null

    fun takeImportHandler(): ((String?) -> Unit)? = pendingImport

    fun open_import_file(): JSONObject {
        // Python 端这条是同步阻塞的；Android 的文档选择器只能异步，所以先返回 pending，
        // 前端那层不认这个值（desktop.js 只判断 ok/error），真正的文本由回调推送
        host.pickImport()
        return JSONObject().put("ok", false).put("pending", true)
    }

    fun deliverImport(text: String?) {
        val handler = pendingImport ?: return
        pendingImport = null
        handler(text)
    }

    fun app_info(): JSONObject = JSONObject()
        .put("name", About.APP_NAME)
        .put("version", About.VERSION)
        .put("platform", "android")

    fun log_client(msg: String?): JSONObject {
        android.util.Log.i("citymetro", "CLIENT $msg")
        return JSONObject().put("ok", true)
    }

    // ---------------- 存档 ----------------

    fun save_index_get(): JSONObject {
        val latest = runCatching { latestSlot() }.getOrNull()
        val latestJson: Any = latest?.second ?: JSONObject.NULL
        val file = store.indexFile
        if (!file.isFile) return JSONObject().put("ok", true).put("index", JSONObject.NULL).put("latest", latestJson)
        val raw = store.readText(file) ?: return error("清单内容已损坏（不是合法的存档清单）")
        val data = runCatching { JSONObject(raw) }.getOrNull()
            ?: return error("清单内容已损坏（不是合法的存档清单）")
        val norm = normalizeIndex(data) ?: return error("清单内容已损坏（不是合法的存档清单）")
        return JSONObject().put("ok", true).put("index", norm).put("latest", latestJson)
    }

    fun save_index_set(index: Any?): JSONObject {
        val obj = normalizeIndex(index as? JSONObject ?: return error("清单格式不对")) ?: return error("清单格式不对")
        return try {
            store.writeAtomic(store.indexFile, obj.toString())
            JSONObject().put("ok", true)
        } catch (e: Exception) {
            error(e.message ?: "写入存档清单失败")
        }
    }

    fun save_rebuild(): JSONObject = rebuildIndex(this)

    fun save_index_rebuild(): JSONObject = rebuildIndex(this)

    fun save_latest(with_text: Boolean): JSONObject {
        val found = latestSlot() ?: return JSONObject().put("ok", true)
            .put("slot", JSONObject.NULL).put("text", JSONObject.NULL)
        if (!with_text) return JSONObject().put("ok", true).put("slot", found.second).put("text", JSONObject.NULL)
        return try {
            JSONObject().put("ok", true).put("slot", found.second).put("text", found.first.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            error("读取存档文件失败：" + (e.message ?: ""))
        }
    }

    private fun latestSlot(): Pair<File, JSONObject>? {
        var best: Pair<File, JSONObject>? = null
        for (file in slotFiles()) {
            val entry = slotEntry(file) ?: continue
            val cur = best
            if (cur == null) { best = file to entry; continue }
            val a = cur.second
            val newer = when {
                entry.optLong("savedAt") != a.optLong("savedAt") -> entry.optLong("savedAt") > a.optLong("savedAt")
                else -> entry.optString("key") > a.optString("key")
            }
            if (newer) best = file to entry
        }
        return best
    }

    fun save_slot_write(key: String?, text: String?): JSONObject {
        val file = store.slotFile(key) ?: return error("存档键不合法")
        if (text == null) return error("存档内容格式不对")
        if (text.length > Store.BODY_MAX) return error("存档过大（超过 64 MB）")
        if (runCatching { JSONObject(text) }.isFailure) return error("存档内容不是合法的 JSON")
        return try {
            store.writeAtomic(file, text)
            val back = file.length()
            if (back <= 0) error("写入存档失败：文件为空")
            else JSONObject().put("ok", true).put("size", back)
        } catch (e: Exception) {
            error(e.message ?: "写入存档失败")
        }
    }

    fun save_slot_read(key: String?): JSONObject {
        val file = store.slotFile(key) ?: return error("存档键不合法")
        if (!file.isFile) return JSONObject().put("ok", true).put("text", JSONObject.NULL)
        return try {
            JSONObject().put("ok", true).put("text", file.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            error(e.message ?: "读取存档失败")
        }
    }

    fun save_slot_verify(key: String?, text: String?): JSONObject {
        val got = save_slot_read(key)
        val back = if (got.optBoolean("ok")) (if (got.isNull("text")) null else got.optString("text")) else null
        return JSONObject()
            .put("ok", got.optBoolean("ok") && back == text)
            .put("error", if (got.has("error")) got.opt("error") else JSONObject.NULL)
    }

    fun save_slot_delete(key: String?): JSONObject {
        val file = store.slotFile(key) ?: return error("存档键不合法")
        return try {
            file.delete()
            JSONObject().put("ok", true)
        } catch (e: Exception) {
            error(e.message ?: "删除存档失败")
        }
    }

    fun save_dir(): JSONObject = JSONObject().put("ok", true).put("dir", store.saveDir.absolutePath)

    // ---------------- 渲染缓存 ----------------

    fun cache_read(keys: Any?): JSONObject {
        val items = JSONObject()
        val arr = keys as? JSONArray ?: return JSONObject().put("ok", true).put("items", items)
        for (i in 0 until arr.length()) {
            val key = arr.optString(i, "")
            if (key.isEmpty() || key.length > Store.CACHE_KEY_MAX) continue
            val text = store.readText(store.cacheFile(key)) ?: continue
            items.put(key, text)
        }
        return JSONObject().put("ok", true).put("items", items)
    }

    fun cache_write(items: Any?): JSONObject {
        val obj = items as? JSONObject ?: return error("数据格式不对")
        var written = 0
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key.isEmpty() || key.length > Store.CACHE_KEY_MAX) continue
            val text = if (obj.isNull(key)) null else obj.optString(key, "")
            if (text == null) continue
            if (text.length > Store.CACHE_TEXT_MAX) continue
            try {
                store.writeAtomic(store.cacheFile(key), text)
                written++
            } catch (e: Exception) {
                continue
            }
        }
        if (written > 0) store.pruneCache()
        return JSONObject().put("ok", true).put("n", written)
    }

    // ---------------- 外壳 ----------------

    fun export_to_file(text: String?, filename: String? = null): JSONObject {
        if (text == null) return error("导出内容为空")
        return try {
            val raw = (filename ?: "").trim()
            val safe = if (raw.isEmpty()) "城市与地铁社区版-进度.cmsave.json"
            else raw.replace(Regex("[\\\\/:*?\"<>|]"), "_")
            val file = File(store.exportDir, safe)
            store.writeAtomic(file, text)
            host.shareExport(file, "导出存档")
            JSONObject().put("ok", true).put("path", file.absolutePath)
        } catch (e: Exception) {
            error(e.message ?: "导出失败")
        }
    }

    fun open_doc(name: String?): JSONObject {
        if (name != "LICENSE.txt" && name != "THIRD_PARTY_NOTICES.txt") return error("不支持的文件")
        return if (host.openDoc(name)) JSONObject().put("ok", true) else error("未找到 $name")
    }

    fun open_external(url: String?): JSONObject {
        val u = url ?: return error("仅支持 http/https 链接")
        if (!u.lowercase().startsWith("http://") && !u.lowercase().startsWith("https://")) {
            return error("仅支持 http/https 链接")
        }
        return if (host.openExternal(u)) JSONObject().put("ok", true) else error("打开链接失败")
    }

    fun open_data_dir(): JSONObject =
        if (host.openDataDir()) JSONObject().put("ok", true).put("dir", store.saveDir.absolutePath)
        else error("无法打开存档目录")

    @Suppress("UNUSED_PARAMETER")
    fun set_gpu(enabled: Any?): JSONObject = JSONObject().put("ok", false).put("error", "Android 上不支持")

    @Suppress("UNUSED_PARAMETER")
    fun set_window_mode(mode: Any?): JSONObject = JSONObject().put("ok", false).put("error", "Android 上不支持")

    // 与 Python 端 perf.py 的 snapshot() 同形：CPU 按本进程占整机核数的百分比，
    // RAM 取本进程实际用掉的物理内存（MB），GPU 一并取当前进程的占用。
    // 取不到的项显式放 JSONObject.NULL，前端照旧显示成 —，不要留下缺键
    @Suppress("UNUSED_PARAMETER")
    fun perf_stats(wantGpu: Any?): JSONObject = JSONObject()
        .put("ok", true)
        .put("cpu", perf.cpu() ?: JSONObject.NULL)
        .put("ram", perf.ram())
        .put("gpu", perf.gpu() ?: JSONObject.NULL)

    fun quit_app(): JSONObject {
        host.quit()
        return JSONObject().put("ok", true)
    }

    // ---------------- 清单实现（对应 saves.py 的 SaveStore） ----------------

    private fun error(msg: String): JSONObject =
        JSONObject().put("ok", false).put("error", msg)

    private fun normalizeIndex(o: JSONObject?): JSONObject? {
        if (o == null) return null
        val s = o.optJSONObject("slots") ?: JSONObject()
        return JSONObject().put("v", 1).put("slots", s)
    }

    private fun slotFiles(): List<File> =
        store.saveDir.listFiles()?.filter {
            it.isFile && it.name != Store.INDEX_KEY && it.name.endsWith(Store.FILE_SUFFIX)
        } ?: emptyList()

    companion object {
        /** 按 slots 里的文件重建清单：清单丢了、或和文件对不上时用。 */
        fun slotEntry(file: File): JSONObject? {
            val name = file.name
            val env = runCatching { JSONObject(file.readText(Charsets.UTF_8)) }.getOrNull() ?: return null
            if (env.optString("format").isEmpty()) return null
            val body = if (env.has("body") && !env.isNull("body")) env.optString("body") else ""
            val payload = if (body.isNotEmpty()) runCatching { JSONObject(body) }.getOrNull() else null
            val meta = payload?.optJSONObject("meta") ?: return null
            val slotId = meta.optString("slotId", "").ifEmpty {
                meta.optString("gameId", "unknown") + "." + name.removeSuffix(Store.FILE_SUFFIX)
            }
            val clock = payload.optJSONObject("clock") ?: JSONObject()
            val econ = payload.optJSONObject("econ") ?: JSONObject()
            val net = payload.optJSONObject("net") ?: JSONObject()
            val savedAt = if (env.has("savedAt")) env.optLong("savedAt", 0) else file.lastModified()
            val rawKind = meta.optString("kind", "")
            val kind = if (rawKind.isNotEmpty()) rawKind else if (slotId.contains(".bk")) "backup" else "manual"
            val label = meta.optString("label", "").ifEmpty {
                if (kind == "auto") "自动存档" else if (kind == "backup") "升级前备份" else "手动存档"
            }
            val date = meta.optJSONArray("date") ?: JSONArray()
                .put(clock.optInt("y", 0))
                .put(clock.optInt("m", 0))
                .put(clock.optInt("d", 0))
            return JSONObject()
                .put("slotId", slotId)
                .put("key", name)
                .put("gameId", meta.optString("gameId", ""))
                .put("kind", kind)
                .put("label", label)
                .put("mode", meta.optString("mode", "challenge"))
                .put("name", meta.optString("name", "存档"))
                .put("map", meta.optString("map", "gz"))
                .put("scenario", meta.optString("scenario", ""))
                .put("createdAt", meta.optLong("createdAt", 0))
                .put("savedAt", savedAt)
                .put("date", date)
                .put("stations", (net.optJSONObject("stations") ?: JSONObject()).length())
                .put("funds", if (econ.has("funds") && !econ.isNull("funds")) econ.optDouble("funds") else JSONObject.NULL)
                .put("size", file.length())
        }

        fun rebuildIndex(api: ShellApi): JSONObject {
            val entries = JSONObject()
            for (file in api.slotFiles()) {
                val name = file.name
                val entry = slotEntry(file) ?: continue
                val slotId = entry.optString("slotId")
                val savedAt = entry.optLong("savedAt")
                val old = entries.optJSONObject(slotId)
                if (old != null && old.optString("key") != name) {
                    val newer = when {
                        savedAt != old.optLong("savedAt") -> savedAt > old.optLong("savedAt")
                        else -> name > old.optString("key")
                    }
                    if (!newer) continue
                }
                entries.put(slotId, entry)
            }
            val index = JSONObject().put("v", 1).put("slots", entries)
            return try {
                api.store.writeAtomic(api.store.indexFile, index.toString())
                JSONObject().put("ok", true).put("index", index).put("count", entries.length())
            } catch (e: Exception) {
                api.error(e.message ?: "重建存档清单失败")
            }
        }
    }
}

object About {
    const val APP_NAME = "城市与地铁社区版"
    const val APP_ID = "city-and-metro-ce"
    const val VERSION = "2.1.0"
    val UPDATE_INFO = listOf(
        "修复了macOS的已知问题",
        "实验性多进程计算时间步进（多进程计算出现错误时请选择单进程计算）",
        "更多的画质选项",
    )

    /** 对应 bridge.py 的 bridge_script()：注入 __CM_DESKTOP__ 是前端认桌面版的唯一依据。 */
    fun bridgeScript(extra: String = ""): String {
        val info = JSONObject()
            .put("name", APP_NAME)
            .put("version", VERSION)
            .put("updateInfo", JSONArray(UPDATE_INFO))
        val payload = info.toString()
            .replace("</", "<\\/")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
        return "(function () {" +
            "  var info = " + payload + ";" +
            "  window.__CM_DESKTOP__ = true;" +
            "  window.CM = window.CM || {};" +
            "  if (window.CM.desktop) {" +
            "    window.CM.desktop.name = info.name;" +
            "    window.CM.desktop.version = info.version;" +
            "  }" +
            "  window.__CM_UPDATE_INFO__ = info.updateInfo || [];" +
            extra +
            "  window.dispatchEvent(new CustomEvent(\"__cmDesktopReady\", { detail: info }));" +
            "})();"
    }
}
