package dev.sotto.keyboard

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextPaint
import android.text.TextUtils
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * The whole keyboard, drawn on one canvas: a status strip, then either the large microphone
 * or a plain letter/symbol layout, then the bottom row. It knows nothing about dictation
 * itself; it reports touches to [Listener] and shows whatever [phase] it is given.
 */
@SuppressLint("ViewConstructor")
class KeyboardView(context: Context, private val listener: Listener) : View(context) {

    interface Listener {
        fun onText(text: String)
        fun onBackspace()
        fun onEnter()
        /** The large microphone went down; [onMicUp] follows when the finger lifts. */
        fun onMicDown()
        fun onMicUp()
        /** The small microphone key was tapped: start listening, or finish if already listening. */
        fun onMicTap()
        fun onCancel()
        fun onSwitchKeyboard()
        fun onOpenApp()
    }

    enum class Phase { IDLE, RECORDING, PROCESSING }

    enum class Panel { VOICE, LETTERS, SYMBOLS }

    private enum class Kind { CHAR, SHIFT, BACKSPACE, ENTER, SPACE, TO_LETTERS, TO_SYMBOLS, MIC, BIG_MIC, GLOBE, CANCEL }

    private enum class Shift { OFF, ONCE, LOCKED }

    private class Key(val kind: Kind, val label: String = "", val weight: Float = 1f) {
        val rect = RectF()
        var pressed = false
    }

    // State set from outside

    var phase = Phase.IDLE
        set(value) {
            if (field == value) return
            field = value
            phaseSince = SystemClock.uptimeMillis()
            if (value != Phase.RECORDING) levels.fill(0f)
            invalidate()
        }

    /** One line shown in the strip: a hint, the text heard so far, or a problem. */
    var status = ""
        set(value) {
            field = value
            invalidate()
        }

    /** A problem is drawn in the warning colour, and tapping the strip opens the app. */
    var statusIsProblem = false
        set(value) {
            field = value
            invalidate()
        }

    var enterLabel = ""
        set(value) {
            field = value
            invalidate()
        }

    var showGlobe = true
        set(value) {
            if (field == value) return
            field = value
            build()
            invalidate()
        }

    var panel = Panel.VOICE
        set(value) {
            if (field == value) return
            field = value
            build()
            invalidate()
        }

    /** Capitalize the next letter (start of a sentence). Ignored while caps lock is on. */
    fun setAutoShift(on: Boolean) {
        if (shift == Shift.LOCKED) return
        val next = if (on) Shift.ONCE else Shift.OFF
        if (next != shift) {
            shift = next
            invalidate()
        }
    }

    fun pushLevel(level: Float) {
        System.arraycopy(levels, 1, levels, 0, levels.size - 1)
        levels[levels.size - 1] = level
        invalidate()
    }

    // Geometry and paint

    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = v * density

    // A phone on its side has little height to spare, so everything is shorter there.
    private val landscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
    private val stripHeight = dp(if (landscape) 34f else 44f)
    private val rowHeight = dp(if (landscape) 40f else 54f)
    private val gap = dp(3f)
    private val side = dp(3f)
    private var bottomInset = 0

    private val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private val background = if (dark) 0xFF1B1C1F.toInt() else 0xFFE9EBF0.toInt()
    private val keyColor = if (dark) 0xFF34363C.toInt() else 0xFFFFFFFF.toInt()
    private val specialColor = if (dark) 0xFF26272C.toInt() else 0xFFCFD3DB.toInt()
    private val pressedColor = if (dark) 0xFF4A4D55.toInt() else 0xFFB9BEC9.toInt()
    private val textColor = if (dark) 0xFFF1F1F3.toInt() else 0xFF1B1C1F.toInt()
    private val dimColor = if (dark) 0xFF9A9CA5.toInt() else 0xFF5F6470.toInt()
    private val accent = 0xFF6D4AFF.toInt()
    private val recordingColor = 0xFFE5484D.toInt()
    private val problemColor = if (dark) 0xFFFFB454.toInt() else 0xFFB25E00.toInt()

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val text = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    private val path = Path()

    private var keys = listOf<Key>()
    private var shift = Shift.OFF
    private var lastShiftTap = 0L
    private val levels = FloatArray(28)
    private var phaseSince = SystemClock.uptimeMillis()
    private val pointers = HashMap<Int, Key>()
    private val handler = Handler(Looper.getMainLooper())
    private val repeatBackspace = object : Runnable {
        override fun run() {
            listener.onBackspace()
            handler.postDelayed(this, 55)
        }
    }

    init {
        setOnApplyWindowInsetsListener { _, insets ->
            // Keep the bottom row clear of the gesture bar when the window is drawn behind it.
            val bottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(WindowInsets.Type.systemBars()).bottom
            } else {
                @Suppress("DEPRECATION") insets.systemWindowInsetBottom
            }
            if (bottom != bottomInset) {
                bottomInset = bottom
                requestLayout()
            }
            insets
        }
    }

    private val contentHeight get() = (stripHeight + 4 * rowHeight + dp(6f)).toInt()

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), contentHeight + bottomInset)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) = build()

    // Layout

    private fun chars(s: String) = s.map { Key(Kind.CHAR, it.toString()) }

    private fun bottomRow(first: Key): List<Key> = buildList {
        add(first)
        if (showGlobe) add(Key(Kind.GLOBE))
        add(Key(Kind.CHAR, ","))
        add(Key(Kind.SPACE, weight = if (showGlobe) 3.4f else 4.4f))
        add(Key(Kind.CHAR, "."))
        if (panel == Panel.VOICE) add(Key(Kind.BACKSPACE, weight = 1.3f)) else add(Key(Kind.MIC, weight = 1.1f))
        add(Key(Kind.ENTER, weight = 1.4f))
    }

    private fun build() {
        pointers.clear()
        handler.removeCallbacks(repeatBackspace)
        val w = width.toFloat()
        if (w <= 0) return
        val rows: List<List<Key>> = when (panel) {
            Panel.LETTERS -> listOf(
                chars("qwertyuiop"),
                chars("asdfghjkl"),
                listOf(Key(Kind.SHIFT, weight = 1.5f)) + chars("zxcvbnm") + Key(Kind.BACKSPACE, weight = 1.5f),
                bottomRow(Key(Kind.TO_SYMBOLS, "?123", 1.3f)),
            )
            Panel.SYMBOLS -> listOf(
                chars("1234567890"),
                chars("@#$%&-+()/"),
                chars("*\"':;!?") + Key(Kind.BACKSPACE, weight = 1.5f),
                bottomRow(Key(Kind.TO_LETTERS, "ABC", 1.3f)),
            )
            Panel.VOICE -> listOf(bottomRow(Key(Kind.TO_LETTERS, "ABC", 1.3f)))
        }
        val all = ArrayList<Key>()
        val firstRowTop = stripHeight + (4 - rows.size) * rowHeight
        rows.forEachIndexed { index, row ->
            val top = firstRowTop + index * rowHeight
            // Rows are laid out on a grid of ten keys; a shorter row is centred.
            val unit = (w - 2 * side) / max(10f, row.sumOf { it.weight.toDouble() }.toFloat())
            var x = side + (w - 2 * side - unit * row.sumOf { it.weight.toDouble() }.toFloat()) / 2
            for (key in row) {
                key.rect.set(x + gap, top + gap, x + unit * key.weight - gap, top + rowHeight - gap)
                x += unit * key.weight
                all.add(key)
            }
        }
        if (panel == Panel.VOICE) {
            val area = RectF(0f, stripHeight, w, stripHeight + 3 * rowHeight)
            val radius = min(dp(46f), area.height() / 2 - dp(18f))
            val mic = Key(Kind.BIG_MIC)
            mic.rect.set(area.centerX() - radius, area.centerY() - radius - dp(8f), area.centerX() + radius, area.centerY() + radius - dp(8f))
            all.add(mic)
            val cancel = Key(Kind.CANCEL)
            val r = dp(22f)
            cancel.rect.set(dp(22f), mic.rect.centerY() - r, dp(22f) + 2 * r, mic.rect.centerY() + r)
            all.add(cancel)
        } else {
            // In the typing layouts the cancel button sits at the right end of the strip.
            val cancel = Key(Kind.CANCEL)
            cancel.rect.set(w - dp(44f), dp(4f), w - dp(8f), stripHeight - dp(4f))
            all.add(cancel)
        }
        keys = all
    }

    // Drawing

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(background)
        drawStrip(canvas)
        for (key in keys) drawKey(canvas, key)
        if (panel == Panel.VOICE) drawVoiceDecor(canvas)
        if (phase != Phase.IDLE) postInvalidateOnAnimation()
    }

    private fun drawStrip(canvas: Canvas) {
        // The large microphone already says "Listening" with a timer.
        if (panel == Panel.VOICE && phase == Phase.RECORDING) return
        val hasCancel = panel != Panel.VOICE && phase != Phase.IDLE
        val left = dp(14f)
        val right = width - (if (hasCancel) dp(52f) else dp(14f))
        text.textAlign = Paint.Align.LEFT
        text.typeface = Typeface.DEFAULT
        text.textSize = dp(14f)
        text.color = when {
            statusIsProblem -> problemColor
            phase == Phase.RECORDING -> recordingColor
            else -> dimColor
        }
        // While text is arriving, the newest words matter: cut from the start.
        val where = if (phase == Phase.PROCESSING) TextUtils.TruncateAt.START else TextUtils.TruncateAt.END
        val line = TextUtils.ellipsize(status.replace('\n', ' '), text, right - left, where).toString()
        canvas.drawText(line, left, stripHeight / 2 - (text.ascent() + text.descent()) / 2, text)
        text.textAlign = Paint.Align.CENTER
    }

    /** The cancel button exists only while there is something to cancel. */
    private fun shown(key: Key) = key.kind != Kind.CANCEL || phase != Phase.IDLE

    private fun drawKey(canvas: Canvas, key: Key) {
        if (!shown(key)) return
        val r = key.rect
        when (key.kind) {
            Kind.BIG_MIC -> return drawBigMic(canvas, key)
            Kind.CANCEL -> {
                fill.color = if (key.pressed) pressedColor else specialColor
                canvas.drawCircle(r.centerX(), r.centerY(), min(r.width(), r.height()) / 2, fill)
                icon(canvas, Kind.CANCEL, r.centerX(), r.centerY(), dp(7f), textColor)
                return
            }
            else -> {}
        }
        val special = key.kind != Kind.CHAR && key.kind != Kind.SPACE
        fill.color = when {
            key.pressed -> pressedColor
            key.kind == Kind.MIC && phase == Phase.RECORDING -> recordingColor
            key.kind == Kind.MIC -> accent
            key.kind == Kind.SHIFT && shift != Shift.OFF -> if (dark) 0xFF5A5D66.toInt() else 0xFFFFFFFF.toInt()
            special -> specialColor
            else -> keyColor
        }
        canvas.drawRoundRect(r, dp(7f), dp(7f), fill)

        val cx = r.centerX()
        val cy = r.centerY()
        when (key.kind) {
            Kind.CHAR -> {
                val label = if (panel == Panel.LETTERS && shift != Shift.OFF) key.label.uppercase() else key.label
                label(canvas, label, cx, cy, dp(22f), textColor, Typeface.DEFAULT)
            }
            Kind.TO_LETTERS, Kind.TO_SYMBOLS -> label(canvas, key.label, cx, cy, dp(14f), textColor, Typeface.DEFAULT_BOLD)
            Kind.ENTER -> if (enterLabel.isEmpty()) icon(canvas, Kind.ENTER, cx, cy, dp(9f), textColor)
            else label(canvas, enterLabel, cx, cy, dp(14f), textColor, Typeface.DEFAULT_BOLD)
            Kind.MIC -> icon(canvas, Kind.MIC, cx, cy, dp(9f), 0xFFFFFFFF.toInt())
            Kind.SPACE -> {
                stroke.color = dimColor
                stroke.strokeWidth = dp(2f)
                canvas.drawLine(cx - dp(16f), cy + dp(7f), cx + dp(16f), cy + dp(7f), stroke)
            }
            else -> icon(canvas, key.kind, cx, cy, dp(9f), textColor)
        }
    }

    private fun label(canvas: Canvas, s: String, cx: Float, cy: Float, size: Float, color: Int, face: Typeface) {
        text.typeface = face
        text.textSize = size
        text.color = color
        canvas.drawText(s, cx, cy - (text.ascent() + text.descent()) / 2, text)
    }

    /** Simple line icons, drawn in a box of half-width [s] around the centre. */
    private fun icon(canvas: Canvas, kind: Kind, cx: Float, cy: Float, s: Float, color: Int) {
        stroke.color = color
        stroke.strokeWidth = dp(2f)
        path.reset()
        when (kind) {
            Kind.BACKSPACE -> {
                path.moveTo(cx - s * 0.45f, cy - s * 0.8f)
                path.lineTo(cx + s * 1.2f, cy - s * 0.8f)
                path.lineTo(cx + s * 1.2f, cy + s * 0.8f)
                path.lineTo(cx - s * 0.45f, cy + s * 0.8f)
                path.lineTo(cx - s * 1.2f, cy)
                path.close()
                path.moveTo(cx - s * 0.05f, cy - s * 0.35f)
                path.lineTo(cx + s * 0.65f, cy + s * 0.35f)
                path.moveTo(cx + s * 0.65f, cy - s * 0.35f)
                path.lineTo(cx - s * 0.05f, cy + s * 0.35f)
            }
            Kind.ENTER -> {
                path.moveTo(cx + s, cy - s * 0.7f)
                path.lineTo(cx + s, cy + s * 0.3f)
                path.lineTo(cx - s, cy + s * 0.3f)
                path.moveTo(cx - s * 0.4f, cy - s * 0.3f)
                path.lineTo(cx - s, cy + s * 0.3f)
                path.lineTo(cx - s * 0.4f, cy + s * 0.9f)
            }
            Kind.SHIFT -> {
                path.moveTo(cx, cy - s)
                path.lineTo(cx - s, cy)
                path.lineTo(cx - s * 0.45f, cy)
                path.lineTo(cx - s * 0.45f, cy + s * 0.9f)
                path.lineTo(cx + s * 0.45f, cy + s * 0.9f)
                path.lineTo(cx + s * 0.45f, cy)
                path.lineTo(cx + s, cy)
                path.close()
                if (shift == Shift.LOCKED) {
                    fill.color = color
                    canvas.drawPath(path, fill)
                }
            }
            Kind.GLOBE -> {
                canvas.drawCircle(cx, cy, s, stroke)
                path.moveTo(cx - s, cy)
                path.lineTo(cx + s, cy)
                path.moveTo(cx, cy - s)
                path.cubicTo(cx - s * 0.75f, cy - s * 0.4f, cx - s * 0.75f, cy + s * 0.4f, cx, cy + s)
                path.moveTo(cx, cy - s)
                path.cubicTo(cx + s * 0.75f, cy - s * 0.4f, cx + s * 0.75f, cy + s * 0.4f, cx, cy + s)
            }
            Kind.CANCEL -> {
                path.moveTo(cx - s, cy - s)
                path.lineTo(cx + s, cy + s)
                path.moveTo(cx + s, cy - s)
                path.lineTo(cx - s, cy + s)
            }
            Kind.MIC, Kind.BIG_MIC -> {
                val capsule = RectF(cx - s * 0.42f, cy - s * 1.1f, cx + s * 0.42f, cy + s * 0.25f)
                fill.color = color
                canvas.drawRoundRect(capsule, s * 0.42f, s * 0.42f, fill)
                val cup = RectF(cx - s * 0.85f, cy - s * 0.75f, cx + s * 0.85f, cy + s * 0.7f)
                path.addArc(cup, 0f, 180f)
                path.moveTo(cx, cy + s * 0.7f)
                path.lineTo(cx, cy + s * 1.15f)
            }
            else -> {}
        }
        canvas.drawPath(path, stroke)
    }

    private fun drawBigMic(canvas: Canvas, key: Key) {
        val cx = key.rect.centerX()
        val cy = key.rect.centerY()
        val radius = key.rect.width() / 2
        val elapsed = (SystemClock.uptimeMillis() - phaseSince) / 1000f
        when (phase) {
            Phase.RECORDING -> {
                // A halo that swells with the voice.
                val level = levels.last()
                fill.color = (recordingColor and 0x00FFFFFF) or 0x33000000
                canvas.drawCircle(cx, cy, radius + dp(4f) + dp(16f) * level, fill)
                fill.color = recordingColor
                canvas.drawCircle(cx, cy, radius * (if (key.pressed) 0.96f else 1f), fill)
                // A square: tap to stop.
                fill.color = 0xFFFFFFFF.toInt()
                val q = radius * 0.3f
                canvas.drawRoundRect(cx - q, cy - q, cx + q, cy + q, dp(5f), dp(5f), fill)
            }
            Phase.PROCESSING -> {
                fill.color = specialColor
                canvas.drawCircle(cx, cy, radius, fill)
                stroke.color = accent
                stroke.strokeWidth = dp(4f)
                val ring = RectF(cx - radius + dp(8f), cy - radius + dp(8f), cx + radius - dp(8f), cy + radius - dp(8f))
                canvas.drawArc(ring, (elapsed * 300f) % 360f, 100f, false, stroke)
                icon(canvas, Kind.MIC, cx, cy, radius * 0.3f, dimColor)
            }
            Phase.IDLE -> {
                fill.color = accent
                canvas.drawCircle(cx, cy, radius * (if (key.pressed) 0.95f else 1f), fill)
                icon(canvas, Kind.MIC, cx, cy, radius * 0.36f, 0xFFFFFFFF.toInt())
            }
        }
    }

    /** The waveform beside the microphone while recording, and the hint under it. */
    private fun drawVoiceDecor(canvas: Canvas) {
        val mic = keys.firstOrNull { it.kind == Kind.BIG_MIC } ?: return
        val cy = mic.rect.centerY()
        if (phase == Phase.RECORDING) {
            fill.color = recordingColor
            val barWidth = dp(3f)
            val step = dp(7f)
            val half = levels.size / 2
            for (i in 0 until half) {
                // The newest level is nearest the button on both sides.
                val level = levels[levels.size - 1 - i]
                val h = dp(3f) + min(dp(34f), mic.rect.height() * 0.4f) * level
                for (direction in intArrayOf(-1, 1)) {
                    val x = mic.rect.centerX() + direction * (mic.rect.width() / 2 + dp(26f) + i * step)
                    if (direction < 0 && x < dp(74f)) continue // leave room for the cancel button
                    if (x < dp(8f) || x > width - dp(8f)) continue
                    canvas.drawRoundRect(x - barWidth / 2, cy - h / 2, x + barWidth / 2, cy + h / 2, barWidth / 2, barWidth / 2, fill)
                }
            }
        }
        val hint = when (phase) {
            Phase.IDLE -> "Tap to dictate · hold to talk"
            Phase.RECORDING -> {
                val seconds = ((SystemClock.uptimeMillis() - phaseSince) / 1000).toInt()
                "Listening  %d:%02d".format(seconds / 60, seconds % 60)
            }
            Phase.PROCESSING -> "Writing…"
        }
        // A slow breathing dot keeps the idle screen from looking frozen while loading.
        val alpha = if (phase == Phase.PROCESSING) (160 + 80 * sin(SystemClock.uptimeMillis() / 300.0)).toInt() else 255
        text.alpha = alpha
        label(canvas, hint, mic.rect.centerX(), mic.rect.bottom + dp(if (landscape) 13f else 20f), dp(13f), dimColor, Typeface.DEFAULT)
        text.alpha = 255
    }

    // Touch

    private fun keyAt(x: Float, y: Float): Key? {
        // The gaps between keys belong to the nearest key, so no touch falls through.
        var best: Key? = null
        var bestDistance = Float.MAX_VALUE
        for (key in keys) {
            if (!shown(key)) continue
            val r = key.rect
            val dx = max(0f, max(r.left - x, x - r.right))
            val dy = max(0f, max(r.top - y, y - r.bottom))
            val d = dx * dx + dy * dy
            if (d < bestDistance) {
                bestDistance = d
                best = key
            }
        }
        val reach = if (best?.kind == Kind.BIG_MIC) dp(10f) else dp(8f)
        return if (bestDistance <= reach * reach) best else null
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val index = event.actionIndex
        val id = event.getPointerId(index)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val key = keyAt(event.getX(index), event.getY(index))
                if (key == null) {
                    if (event.getY(index) < stripHeight && statusIsProblem) listener.onOpenApp()
                    return true
                }
                pointers[id] = key
                key.pressed = true
                performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                when (key.kind) {
                    Kind.BACKSPACE -> {
                        listener.onBackspace()
                        handler.postDelayed(repeatBackspace, 380)
                    }
                    Kind.BIG_MIC -> listener.onMicDown()
                    else -> {}
                }
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    val key = pointers[event.getPointerId(i)] ?: continue
                    // Sliding off a key lets go of it; the microphone keeps its hold.
                    if (key.kind == Kind.BIG_MIC) continue
                    if (keyAt(event.getX(i), event.getY(i)) !== key && key.pressed) {
                        key.pressed = false
                        if (key.kind == Kind.BACKSPACE) handler.removeCallbacks(repeatBackspace)
                        invalidate()
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val key = pointers.remove(id) ?: return true
                val wasPressed = key.pressed
                key.pressed = false
                invalidate()
                if (key.kind == Kind.BACKSPACE) handler.removeCallbacks(repeatBackspace)
                if (key.kind == Kind.BIG_MIC) listener.onMicUp()
                else if (wasPressed) activate(key)
            }
            MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(repeatBackspace)
                for (key in pointers.values) {
                    key.pressed = false
                    if (key.kind == Kind.BIG_MIC) listener.onMicUp()
                }
                pointers.clear()
                invalidate()
            }
        }
        return true
    }

    private fun activate(key: Key) {
        when (key.kind) {
            Kind.CHAR -> {
                val upper = panel == Panel.LETTERS && shift != Shift.OFF
                listener.onText(if (upper) key.label.uppercase() else key.label)
                if (shift == Shift.ONCE) shift = Shift.OFF
            }
            Kind.SPACE -> listener.onText(" ")
            Kind.ENTER -> listener.onEnter()
            Kind.SHIFT -> {
                val now = SystemClock.uptimeMillis()
                shift = when {
                    shift == Shift.LOCKED -> Shift.OFF
                    now - lastShiftTap < 350 -> Shift.LOCKED
                    shift == Shift.ONCE -> Shift.OFF
                    else -> Shift.ONCE
                }
                lastShiftTap = now
            }
            Kind.TO_LETTERS -> panel = Panel.LETTERS
            Kind.TO_SYMBOLS -> panel = Panel.SYMBOLS
            Kind.MIC -> {
                // Dictation always shows the large microphone, with its waveform and stop button.
                panel = Panel.VOICE
                listener.onMicTap()
            }
            Kind.GLOBE -> listener.onSwitchKeyboard()
            Kind.CANCEL -> listener.onCancel()
            else -> {}
        }
        invalidate()
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        handler.removeCallbacks(repeatBackspace)
    }
}
