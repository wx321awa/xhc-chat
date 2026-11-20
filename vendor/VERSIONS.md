# PrivChat/XHC vendor 组件清单

生成时间：2026-11-20T15:12:46.025Z

| 组件 | 版本/文件 | 大小 | sha256 | 来源 |
|---|---|---|---|---|
| OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.21_9.tar.gz | OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.21_9.tar.gz | 183.43MB | 3e4eca7ead088f080af1476007decf010a240a1eb4e1e78c54fa32fbcc347084 | https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/aarch64/linux/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.21_9.tar.gz |
| platform-33_r02.zip | platform-33_r02.zip | 64.21MB | f851b13fe89f8510a1250df5e8593e86176b2428f4f3cbe0e304a85818c07bc8 | https://dl.google.com/android/repository/platform-33_r02.zip |
| android.jar | android.jar | 25.88MB | 14261d2817d558e7fbbf9848216c4f6ec37c134353325eab230acf2af0c25fe7 | https://dl.google.com/android/repository/platform-33_r02.zip!/android.jar |
| r8.jar | r8.jar | 20.21MB | 9743e95de295fb6f5490e21da26536e4d0921809511423122ff20328a572e7f5 | https://dl.google.com/dl/android/maven2/com/android/tools/r8/9.5.33/r8-9.5.33.jar |
| uber-apk-signer.jar | uber-apk-signer.jar | 3.06MB | e1299fd6fcf4da527dd53735b56127e8ea922a321128123b9c32d619bba1d835 | https://github.com/patrickfav/uber-apk-signer/releases/download/v1.3.0/uber-apk-signer-1.3.0.jar |

## 实测命令

- `java -version` → exit 0 :: openjdk version "17.0.21" 2026-10-20 | OpenJDK Runtime Environment Temurin-17.0.21+9 (build 17.0.21+9) | OpenJDK 64-Bit Server VM Temurin-17.0.21+9 (build 17.0.21+9, mixed mode, sharing)
- `javac --version` → exit 0 :: javac 17.0.21
- `D8 --version` → exit 0 :: D8 9.5.33 (build 06d10cab5b08b17aa947de640994f682c3786336 from go/r8bot (luci-r8-custom-ci-jammy-c3d-us-central1-b-2-5qn4))
- `uber-apk-signer --version` → exit 0 :: Version: 1.3.0

## 路径

- java: `/root/workspace/privchat/vendor/jdk/bin/java`
- javac: `/root/workspace/privchat/vendor/jdk/bin/javac`
- D8: `/root/workspace/privchat/vendor/jdk/bin/java -cp /root/workspace/privchat/vendor/r8.jar com.android.tools.r8.D8`
- signer: `/root/workspace/privchat/vendor/jdk/bin/java -jar /root/workspace/privchat/vendor/uber-apk-signer.jar`
- android.jar: `/root/workspace/privchat/vendor/android.jar`
