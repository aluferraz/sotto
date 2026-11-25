plugins {
    id("com.android.application") version "9.1.1" apply false
    // LiteRT-LM 0.17+ is compiled with Kotlin 2.4 metadata, so the whole build uses Kotlin 2.4.
    id("org.jetbrains.kotlin.jvm") version "2.4.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.0" apply false
}
