const IS_DEV = process.env.APP_VARIANT === 'development'

module.exports = {
    expo: {
        // --- Identity from ChatTCP-Tester ---
        name: IS_DEV ? 'LEXAmeta-Tester (DEV)' : 'ChatTCP-Tester',
        slug: 'lexameta-tester',
        version: '0.6.1',
        // --- End Identity ---

        // --- Common/Standard Expo settings ---
        newArchEnabled: true,
        orientation: 'default',
        icon: './assets/images/icon.png',
        scheme: 'chattcp-test',
        userInterfaceStyle: 'automatic',
        assetBundlePatterns: ['**/*'],
        // --- End Common/Standard ---

        // --- iOS Configuration ---
        ios: {
            icon: {
                dark: './assets/images/ios-dark.png',
                light: './assets/images/ios-light.png',
                tinted: './assets/images/icon.png',
            },
            supportsTablet: true,
            bundleIdentifier: IS_DEV ? 'com.LEXAmeta.ChatTCPDev.tester' : 'com.LEXAmeta.ChatTCP.tester',
            // Removed redundant 'package' property here for iOS
        },
        // --- End iOS Configuration ---

        // --- Android Configuration ---
        android: {
            adaptiveIcon: {
                foregroundImage: './assets/images/adaptive-icon-foreground.png',
                backgroundImage: './assets/images/adaptive-icon-background.png',
                monochromeImage: './assets/images/adaptive-icon-foreground.png',
                backgroundColor: '#000',
            },
            package: IS_DEV ? 'com.LEXAmeta.ChatTCPDev.tester' : 'com.LEXAmeta.ChatTCP.tester',
            versionCode: 1, // Added from ChatterUI-Latest (good practice)
            userInterfaceStyle: 'dark',
            permissions: [
                'android.permission.FOREGROUND_SERVICE',
                'android.permission.WAKE_LOCK',
                'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
            ],
        },
        // --- End Android Configuration ---

        // --- Web Configuration ---
        web: {
            bundler: 'metro',
            output: 'static',
            favicon: './assets/images/adaptive-icon.png',
        },
        // --- End Web Configuration ---

        // --- Plugins (Enhanced with ChatterUI-Latest details) ---
        plugins: [
            [
                'expo-asset',
                {
                    assets: ['./assets/models/aibot.png', './assets/models/llama3tokenizer.gguf'],
                },
            ],
            [
                'expo-build-properties',
                {
                    android: {
                        largeHeap: true,
                        usesCleartextTraffic: true,
                        enableProguardInReleaseBuilds: true,
                        enableShrinkResourcesInReleaseBuilds: true,
                        useLegacyPackaging: true,
                        extraProguardRules: '-keep class com.rnllama.** { *; }',
                        // --- IMPORTANT: Added from ChatterUI-Latest ---
                        extraMavenRepositories: [
                            '../../node_modules/expo/android',
                            '../../node_modules/expo-modules-core/android',
                            '../../node_modules/react-native/android',
                            '../../node_modules/jsc-android/dist',
                        ],
                        // --- End addition ---
                    },
                },
            ],
            [
                'expo-splash-screen',
                {
                    backgroundColor: '#000000',
                    image: './assets/images/adaptive-icon.png',
                    imageWidth: 200,
                },
            ],
            [
                'expo-notifications',
                {
                    icon: './assets/images/notification.png',
                },
            ],
            [
                './expo-build-plugins/androidattributes.plugin.js',
                {
                    'android:largeHeap': true,
                },
            ],
            'expo-localization',
            'expo-router',
            'expo-sqlite',
            './expo-build-plugins/bgactions.plugin.js',
            './expo-build-plugins/copyjni.plugin.js',
            './expo-build-plugins/usercert.plugin.js',
        ],
        // --- End Plugins ---

        // --- Experiments ---
        experiments: {
            typedRoutes: true,
        },
        // --- End Experiments ---

        // --- Extra (with your specific Project ID) ---
        extra: {
            router: {
                origin: false,
            },
            eas: {
                // *** CRITICAL: Keep YOUR ChatTCP-Tester projectId ***
                projectId: '3f169a70-b4b9-4f40-b267-bb2f1f704edb',
            },
            // Added from ChatterUI-Latest, useful for conditional builds
            EXPO_PUBLIC_BUILD_TARGET: process.env.EXPO_PUBLIC_BUILD_TARGET || 'native',
        },
        // --- End Extra ---
    },
}
