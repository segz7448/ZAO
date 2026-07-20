package com.zenas.zao.termux

import android.content.ComponentName
import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray

/**
 * Bridges JS -> Termux's com.termux.app.RunCommandService.
 *
 * This is the one piece expo-intent-launcher cannot do: RunCommandService
 * is an Android Service, and Expo's managed-workflow intent launcher only
 * starts Activities. This module calls Context.startService()/
 * startForegroundService() directly, which is the API Termux actually
 * requires.
 *
 * Termux enforces its own permission gate on its side
 * (`allow-external-apps=true` in ~/.termux/termux.properties, plus the
 * Android runtime permission "Run commands in Termux" which the user
 * grants once via a system prompt). This module cannot bypass or grant
 * that - it can only send the intent; Termux decides whether to honor it.
 */
class TermuxRunCommandModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "TermuxRunCommand"

  @ReactMethod
  fun startRunCommandService(
    path: String,
    argumentsArray: ReadableArray?,
    workdir: String?,
    background: Boolean,
    promise: Promise
  ) {
    try {
      val context = reactApplicationContext

      val args = ArrayList<String>()
      if (argumentsArray != null) {
        for (i in 0 until argumentsArray.size()) {
          args.add(argumentsArray.getString(i) ?: "")
        }
      }

      val intent = Intent()
      intent.setClassName("com.termux", "com.termux.app.RunCommandService")
      intent.action = "com.termux.RUN_COMMAND"
      intent.putExtra("com.termux.RUN_COMMAND_PATH", path)
      intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", args.toTypedArray())
      if (!workdir.isNullOrEmpty()) {
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", workdir)
      }
      intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", background)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }

      promise.resolve(true)
    } catch (e: SecurityException) {
      // Almost always means Termux's "allow-external-apps" setting or the
      // Android runtime permission for RUN_COMMAND hasn't been granted yet.
      promise.reject(
        "TERMUX_PERMISSION_DENIED",
        "Termux refused the command. Run the one-time setup first: " +
          "in Termux, run `echo allow-external-apps=true >> ~/.termux/termux.properties && termux-reload-settings`, " +
          "then grant ZAO the \"Run commands in Termux\" permission when Android prompts for it.",
        e
      )
    } catch (e: Exception) {
      promise.reject("TERMUX_RUN_COMMAND_FAILED", e.message ?: "Could not start Termux's RunCommandService.", e)
    }
  }

  @ReactMethod
  fun isTermuxAvailable(promise: Promise) {
    try {
      val pm = reactApplicationContext.packageManager
      pm.getPackageInfo("com.termux", 0)
      promise.resolve(true)
    } catch (e: Exception) {
      promise.resolve(false)
    }
  }
}
