plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "org.xinutec.home"
    compileSdk = 36
    // The nix SDK is read-only and has only this one; AGP would pick another.
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "org.xinutec.home"
        // From Android 8 the system WebView is Chromium.
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// A sentence instead of a stack trace when the shell is missing. rootDir, not
// file(): the path must match settings.gradle.kts, which resolves from android/.
require(rootDir.resolve("../../ui-harness/android").isDirectory) {
    "ui-harness must be checked out beside this repo (~/Code/ui-harness)"
}

dependencies {
    // Substituted by the path in settings.gradle.kts; no version.
    implementation("org.xinutec:shell")
    implementation(libs.androidx.core.ktx)
}
