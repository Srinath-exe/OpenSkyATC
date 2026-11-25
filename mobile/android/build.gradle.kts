allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
// mapbox_maps_flutter applies Kotlin only on AGP < 9 (it expects AGP 9's built-in Kotlin, which gradle.properties turns
// off for the other plugins): apply it there, before its build file reaches its kotlin { } block
subprojects {
    if (name == "mapbox_maps_flutter") {
        pluginManager.withPlugin("com.android.library") { apply(plugin = "org.jetbrains.kotlin.android") }
    }
}
// flutter_js's Android QuickJS comes from JitPack
allprojects {
    repositories { maven { url = uri("https://jitpack.io") } }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
