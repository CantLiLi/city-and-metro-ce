package com.cityandmetro.ce

import android.os.Bundle
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/** 对应 Python 端 open_doc 用系统程序打开的许可与第三方声明；Android 上没有可用的文本查看器，自己开一页。 */
class DocActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val text = intent.getStringExtra(EXTRA_TEXT) ?: ""

        val root = FrameLayout(this)
        root.setBackgroundColor(0xFFFFFFFF.toInt())
        val scroll = ScrollView(this)
        val body = TextView(this).apply {
            this.text = text
            textSize = 13f
            setPadding(48, 48, 48, 48)
            setTextIsSelectable(true)
            setBackgroundColor(0xFFFFFFFF.toInt())
            setTextColor(0xFF1A2027.toInt())
            typeface = android.graphics.Typeface.MONOSPACE
        }
        scroll.addView(body, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        root.addView(scroll, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        ))
        setContentView(root)
        this.title = title
    }

    companion object {
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
    }
}
