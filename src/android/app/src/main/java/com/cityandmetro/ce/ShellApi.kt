package com.cityandmetro.ce

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/**
 * 桌面壳的数据目录，对应 Python 端的 storage.py + saves.py。
 *
 * 目录结构照搬桌面版：files/saves/index.json 是清单，files/saves/slots/ 下每个存档一个文件。
 */
class Store(root: File) {
    private val saves = File(root, "saves")
    private val slots = File(saves, "slots")
    private val cache = File(root, "cache")
    private val exports = File(root, "exports")
    private val prof = File(root, "profile")

    val indexFile = File(saves, "index.json")
    val cacheDir: File get() = cache
    val exportDir: File get() = exports
    val profileDir: File get() = prof
    val saveDir: File get() = saves

    init {
        slots.mkdirs()
        cache.mkdirs()
        exports.mkdirs()
        prof.mkdirs()
    }

    companion object {
        const val KEY_MAX = 120
        const val BODY_MAX = 64L * 1024 * 1024
        const val KEY_PREFIX = "cm1.slot."
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
        val raw = store.readText(store.indexFile)
        val data = raw?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (data != null && !isEmptyIndex(data)) {
            return JSONObject().put("ok", true)
                .put("index", data)
                .put("count", data.optJSONObject("slots")?.length() ?: 0)
                .put("files", countFiles())
        }
        val old = loadBackup()
        if (old != null) {
            return JSONObject().put("ok", true)
                .put("index", old)
                .put("count", old.optJSONObject("slots")?.length() ?: 0)
                .put("files", countFiles())
        }
        return rebuildIndex(this)
    }

    fun save_index_set(index: Any?): JSONObject {
        val obj = index as? JSONObject ?: return error("索引格式不对")
        return setIndexLocked(obj)
    }

    fun save_index_rebuild(): JSONObject = rebuildIndex(this)

    fun save_slot_write(key: String?, text: String?): JSONObject {
        val file = store.slotFile(key) ?: return error("存档键不合法")
        if (text == null) return error("存档内容格式不对")
        if (text.length > Store.BODY_MAX) return error("存档过大（超过 64 MB）")
        return try {
            store.writeAtomic(file, text)
            JSONObject().put("ok", true)
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

    fun export_to_file(text: String?): JSONObject {
        if (text == null) return error("导出内容为空")
        return try {
            val name = "城市与地铁社区版-进度-" + System.currentTimeMillis() + ".cmsave.json"
            val file = File(store.exportDir, name)
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

    @Suppress("UNUSED_PARAMETER")
    fun perf_stats(wantGpu: Any?): JSONObject = JSONObject().put("ok", false)

    fun quit_app(): JSONObject {
        host.quit()
        return JSONObject().put("ok", true)
    }

    // ---------------- 索引实现（对应 saves.py 的 SaveStore） ----------------

    private fun error(msg: String): JSONObject =
        JSONObject().put("ok", false).put("error", msg)

    private fun isEmptyIndex(o: JSONObject): Boolean {
        val g = o.optJSONObject("games")
        val s = o.optJSONObject("slots")
        return (g == null || g.length() == 0) && (s == null || s.length() == 0)
    }

    private fun countFiles(): Int =
        store.saveDir.let { d -> File(d, "slots").listFiles()?.count {
            it.name.startsWith(Store.KEY_PREFIX) && !it.name.endsWith(".tmp")
        } ?: 0 }

    private fun loadBackup(): JSONObject? {
        for (name in listOf("index.json.prev", "index.json.tmp")) {
            val raw = store.readText(File(store.saveDir, name)) ?: continue
            val old = runCatching { JSONObject(raw) }.getOrNull() ?: continue
            if (!isEmptyIndex(old)) return old
        }
        return null
    }

    private fun setIndexLocked(index: JSONObject): JSONObject {
        // 空清单不能覆盖非空清单：前端读清单失败后会把内存里的空清单写回，那会抹掉磁盘上所有进度
        if (isEmptyIndex(index)) {
            val old = store.readText(store.indexFile)?.let { runCatching { JSONObject(it) }.getOrNull() }
            if (old != null && !isEmptyIndex(old)) return error("拒绝用空清单覆盖磁盘上已有的存档清单")
            val backups = store.saveDir.listFiles()?.any { it.name.startsWith("index.json.") } ?: false
            if (backups) return error("拒绝用空清单覆盖存档索引（索引备份还在，说明之前有过存档）")
        }
        return try {
            val src = store.indexFile
            if (src.exists()) {
                val prev = File(store.saveDir, "index.json.prev")
                prev.delete()
                src.renameTo(prev)
            }
            store.writeAtomic(src, index.toString())
            JSONObject().put("ok", true)
        } catch (e: Exception) {
            error(e.message ?: "写入存档索引失败")
        }
    }

    companion object {
        /** 按 slots 里的文件重建清单；清单丢了或和文件对不上时用。 */
        fun rebuildIndex(api: ShellApi): JSONObject {
            val store = api.store
            val entries = JSONObject()
            val dir = File(store.saveDir, "slots")
            val names = dir.list() ?: emptyArray()
            for (name in names) {
                if (name.endsWith(".tmp") || !name.startsWith(Store.KEY_PREFIX)) continue
                val tail = name.removePrefix(Store.KEY_PREFIX)
                val gameId = tail.split(".", limit = 2).firstOrNull() ?: ""
                if (gameId.isEmpty()) continue
                val file = File(dir, name)
                val env = runCatching { JSONObject(file.readText(Charsets.UTF_8)) }.getOrNull() ?: JSONObject()
                val body = if (env.has("body") && !env.isNull("body")) env.optString("body") else ""
                val payload = if (body.isNotEmpty()) runCatching { JSONObject(body) }.getOrNull() else null
                val meta = payload?.optJSONObject("meta") ?: JSONObject()
                val clock = payload?.optJSONObject("clock") ?: JSONObject()
                val date = JSONArray()
                    .put(clock.optInt("y", 0))
                    .put(clock.optInt("m", 0))
                    .put(clock.optInt("d", 0))
                val entry = JSONObject()
                    .put("slotId", name)
                    .put("key", name)
                    .put("gameId", gameId)
                    .put("kind", if (name.contains(".a1.") || name.contains(".a2.")) "auto" else "manual")
                    .put("mode", meta.optString("mode", "challenge"))
                    .put("name", meta.optString("name", gameId))
                    .put("map", meta.optString("map", "gz"))
                    .put("label", "恢复的存档")
                    .put("savedAt", env.optLong("savedAt", file.lastModified()))
                    .put("date", date)
                    .put("size", file.length())
                entries.put(name, entry)
            }
            if (entries.length() == 0) {
                return JSONObject().put("ok", true).put("count", 0)
            }
            val games = JSONObject()
            val keys = entries.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                val s = entries.optJSONObject(k) ?: continue
                val gid = s.optString("gameId")
                val cur = games.optJSONObject(gid)
                val savedAt = s.optLong("savedAt")
                if (cur == null || cur.optLong("updatedAt") < savedAt) {
                    games.put(gid, JSONObject()
                        .put("gameId", gid)
                        .put("name", s.optString("name"))
                        .put("mode", s.optString("mode"))
                        .put("map", s.optString("map"))
                        .put("createdAt", savedAt)
                        .put("updatedAt", savedAt))
                }
            }
            val index = JSONObject().put("games", games).put("slots", entries)
            val res = api.setIndexLocked(index)
            if (!res.optBoolean("ok")) return res
            return JSONObject().put("ok", true).put("count", entries.length()).put("index", index)
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
