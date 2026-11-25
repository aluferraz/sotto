plugins {
    id("org.jetbrains.kotlin.jvm")
    application
}

// litertlm-jvm is built for Java 25.
kotlin { jvmToolchain(25) }

dependencies {
    implementation(project(":core"))
    implementation("com.google.ai.edge.litertlm:litertlm-jvm:0.20.0")
}

application {
    mainClass.set("dev.sotto.bench.MainKt")
}

tasks.named<JavaExec>("run") {
    workingDir = rootProject.projectDir
}
