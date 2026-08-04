package com.asuka109.mish

/** Android-only JNI seam into the Shared Rust outer-shell authority. */
object NativeShellBridge {
  @JvmStatic external fun snapshot(): String

  @JvmStatic external fun selectDestination(
    destination: String,
    expectedRevision: Long,
    intentId: String,
  ): String

  @JvmStatic external fun openDeepLink(
    webEntryPath: String,
    expectedRevision: Long,
    intentId: String,
  ): String
}
