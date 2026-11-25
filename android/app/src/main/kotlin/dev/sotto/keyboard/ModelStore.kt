package dev.sotto.keyboard

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.StatFs
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.concurrent.thread
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Where the model file lives, and the one-time download that puts it there. */
class ModelStore(private val context: Context) {
    sealed interface State {
        /** Not on the phone. [partial] is how much an earlier, unfinished download left behind. */
        data class Absent(val partial: Long = 0) : State
        data class Downloading(val bytes: Long, val total: Long) : State
        data object Verifying : State
        data object Ready : State
        data class Failed(val message: String) : State
    }

    val file = File(context.filesDir, "models/$FILE_NAME")
    private val partial = File(context.filesDir, "models/$FILE_NAME.part")

    private val flow = MutableStateFlow(initial())
    val state: StateFlow<State> = flow

    @Volatile private var cancelled = false
    @Volatile private var running = false

    val isReady get() = flow.value is State.Ready

    private fun initial(): State = if (file.length() == SIZE) State.Ready else State.Absent(partial.length())

    /** Looks at the disk again, for a file put there by other means (adb, a restore). */
    fun refresh() {
        if (!running) flow.value = initial()
    }

    fun delete() {
        if (running) return
        file.delete()
        partial.delete()
        flow.value = State.Absent()
    }

    fun cancel() {
        cancelled = true
    }

    /**
     * Downloads the model, continuing a partial file if there is one, then checks it against
     * the published SHA-256. Blocks; [ModelDownloadService] calls it on its own thread.
     */
    fun download() {
        if (running || flow.value is State.Ready) return
        running = true
        cancelled = false
        try {
            file.parentFile?.mkdirs()
            var have = partial.length()
            if (have > SIZE) {
                partial.delete()
                have = 0
            }
            val free = StatFs(context.filesDir.path).availableBytes
            if (free < SIZE - have + 200_000_000L) {
                flow.value = State.Failed("Not enough free space: the model needs ${(SIZE - have) / 1_000_000} MB.")
                return
            }
            flow.value = State.Downloading(have, SIZE)
            if (have < SIZE) {
                val connection = (URL(URL_STRING).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    instanceFollowRedirects = true
                    if (have > 0) setRequestProperty("Range", "bytes=$have-")
                }
                try {
                    val code = connection.responseCode
                    if (code == 200 && have > 0) {
                        have = 0 // the server ignored the range: start again
                    } else if (code != 200 && code != 206) {
                        flow.value = State.Failed("The download server answered $code.")
                        return
                    }
                    RandomAccessFile(partial, "rw").use { out ->
                        out.setLength(have)
                        out.seek(have)
                        connection.inputStream.use { input ->
                            val buffer = ByteArray(1 shl 16)
                            var lastReport = 0L
                            while (true) {
                                if (cancelled) {
                                    flow.value = State.Absent(have)
                                    return
                                }
                                val n = input.read(buffer)
                                if (n < 0) break
                                out.write(buffer, 0, n)
                                have += n
                                if (have - lastReport > 2_000_000) {
                                    lastReport = have
                                    flow.value = State.Downloading(have, SIZE)
                                }
                            }
                        }
                    }
                } finally {
                    connection.disconnect()
                }
            }
            if (have != SIZE) {
                flow.value = State.Failed("The download stopped early. Try again to continue it.")
                return
            }
            flow.value = State.Verifying
            if (sha256(partial) != SHA256) {
                partial.delete()
                flow.value = State.Failed("The downloaded file is damaged. Try again.")
                return
            }
            if (!partial.renameTo(file)) {
                flow.value = State.Failed("Could not store the model file.")
                return
            }
            flow.value = State.Ready
        } catch (e: Exception) {
            flow.value = State.Failed("Download failed: ${e.message ?: e.javaClass.simpleName}. Try again to continue it.")
        } finally {
            running = false
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    companion object {
        const val FILE_NAME = "lfm3-audio-2b_int4_b128_c2048_h30.litertlm"
        const val SIZE = 1_531_232_624L
        const val SHA256 = "5168b79a795d1737e789f22a84f5830e808f45a3ba2d3a02099b4d291bda4f02"
        const val URL_STRING = "https://huggingface.co/litert-community/LFM3-Audio-2B-LiteRT/resolve/main/$FILE_NAME"
    }
}

/** Keeps the download alive while the app is in the background, with its progress in a notification. */
class ModelDownloadService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Model download", NotificationManager.IMPORTANCE_LOW)
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION, notification(0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION, notification(0))
        }
        val models = sotto.models
        thread(name = "model-download") {
            val watcher = thread(name = "model-download-progress") {
                try {
                    while (true) {
                        val state = models.state.value
                        if (state is ModelStore.State.Downloading) {
                            manager.notify(NOTIFICATION, notification((state.bytes * 100 / state.total).toInt()))
                        }
                        Thread.sleep(1000)
                    }
                } catch (_: InterruptedException) {
                }
            }
            models.download()
            watcher.interrupt()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notification(percent: Int): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sotto)
            .setContentTitle("Downloading the speech model")
            .setContentText("$percent%")
            .setProgress(100, percent, false)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val CHANNEL = "model"
        private const val NOTIFICATION = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, ModelDownloadService::class.java))
        }
    }
}
