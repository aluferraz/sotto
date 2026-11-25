plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin { jvmToolchain(17) }

dependencies {
    // The app brings litertlm-android and the bench brings litertlm-jvm; both carry the same API.
    compileOnly("com.google.ai.edge.litertlm:litertlm-jvm:0.20.0")
    // Android has org.json built in; a desktop JVM (the tests) needs the library.
    compileOnly("org.json:json:20250517")
    testImplementation("org.json:json:20250517")
    testImplementation("junit:junit:4.13.2")
}
