plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("kapt")
    kotlin("plugin.serialization")
}

val releaseSigningValues = listOf(
    "BUHGUY_ANDROID_KEYSTORE_PATH",
    "BUHGUY_ANDROID_STORE_PASSWORD",
    "BUHGUY_ANDROID_KEY_ALIAS",
    "BUHGUY_ANDROID_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it).orNull }
val releaseSigningReady = releaseSigningValues.values.all { !it.isNullOrBlank() }
val releaseSigningError =
    "Release signing requires BUHGUY_ANDROID_KEYSTORE_PATH, " +
        "BUHGUY_ANDROID_STORE_PASSWORD, BUHGUY_ANDROID_KEY_ALIAS, and " +
        "BUHGUY_ANDROID_KEY_PASSWORD"

gradle.taskGraph.whenReady {
    if (!releaseSigningReady && allTasks.any {
            it.name.contains("release", ignoreCase = true) ||
                it.path.contains("release", ignoreCase = true)
        }
    ) {
        throw GradleException(releaseSigningError)
    }
}

android {
    namespace = "com.adamaste.buhguy.bankcollector"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.adamaste.buhguy.bankcollector"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = file(releaseSigningValues.getValue("BUHGUY_ANDROID_KEYSTORE_PATH"))
                storePassword = releaseSigningValues.getValue("BUHGUY_ANDROID_STORE_PASSWORD")
                keyAlias = releaseSigningValues.getValue("BUHGUY_ANDROID_KEY_ALIAS")
                keyPassword = releaseSigningValues.getValue("BUHGUY_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    kapt("androidx.room:room-compiler:2.6.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.room:room-testing:2.6.1")
    testImplementation("androidx.test:core:1.6.1")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("org.robolectric:robolectric:4.14.1")
}
