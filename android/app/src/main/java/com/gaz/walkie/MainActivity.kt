package com.gaz.walkie

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * GAZ Walkie for Android: shows the walkie-talkie app and keeps it running in the
 * background (screen off / other apps open) through WalkieService.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private var pendingWebPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.parseColor("#0f1115")
        volumeControlStream = AudioManager.STREAM_MUSIC

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0f1115"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.userAgentString = web.settings.userAgentString + " GazWalkieApp/1.0"

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: return false
                if (host == APP_HOST) return false
                // Links to other sites (e.g. WhatsApp) open outside the app.
                try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {}
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (hasMic()) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        } else {
                            pendingWebPermission = request
                            askPermissions()
                        }
                    } else {
                        request.deny()
                    }
                }
            }
        }

        setContentView(web)
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl(APP_URL)
        askPermissions()
    }

    private fun hasMic(): Boolean =
        checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun askPermissions() {
        val wanted = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 33) wanted.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = wanted.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1) else startWalkieService()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val req = pendingWebPermission
        pendingWebPermission = null
        if (hasMic()) {
            req?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            startWalkieService()
        } else {
            req?.deny()
        }
    }

    private fun startWalkieService() {
        if (!hasMic()) return
        try {
            val i = Intent(this, WalkieService::class.java)
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        } catch (_: Exception) {
            // Some phones refuse if the app isn't in front yet; we try again in onResume.
        }
    }

    override fun onResume() {
        super.onResume()
        startWalkieService()
    }

    // Note: we deliberately do NOT pause the WebView in onPause, so voice keeps
    // playing when the screen is off or another app is open.

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
    }

    override fun onDestroy() {
        if (isFinishing) stopService(Intent(this, WalkieService::class.java))
        web.destroy()
        super.onDestroy()
    }

    companion object {
        const val APP_HOST = "gaz-walkie.ioghenevwogaga.workers.dev"
        const val APP_URL = "https://$APP_HOST/"
    }
}
