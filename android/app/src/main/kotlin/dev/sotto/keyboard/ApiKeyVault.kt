package dev.sotto.keyboard

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The API key, encrypted with a key that lives in the Android Keystore and never leaves it. What
 * is on disk is only the encrypted text, useless without this phone's keystore.
 *
 * Nothing is created until a key is actually saved, so someone who only uses the on-device model
 * never has a keystore entry made for them.
 */
class ApiKeyVault(context: Context) {
    private val file = File(context.filesDir, "api-key.bin")
    @Volatile private var cached: String? = null

    /** The stored key, or empty when there is none or it can no longer be decrypted. */
    fun get(): String {
        cached?.let { return it }
        val value = runCatching {
            val bytes = file.readBytes()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(create = false), GCMParameterSpec(128, bytes, 0, IV_LENGTH))
            String(cipher.doFinal(bytes, IV_LENGTH, bytes.size - IV_LENGTH), Charsets.UTF_8)
        }.getOrDefault("")
        cached = value
        return value
    }

    /** Stores the key; an empty one removes it together with its keystore entry. */
    fun set(value: String) {
        val trimmed = value.trim()
        if (trimmed == cached) return
        if (trimmed.isEmpty()) {
            file.delete()
            runCatching { KeyStore.getInstance(STORE).apply { load(null) }.deleteEntry(ALIAS) }
        } else {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key(create = true))
            file.writeBytes(cipher.iv + cipher.doFinal(trimmed.toByteArray(Charsets.UTF_8)))
        }
        cached = trimmed
    }

    private fun key(create: Boolean): SecretKey {
        val store = KeyStore.getInstance(STORE).apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        check(create) { "no key in the keystore" }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, STORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val STORE = "AndroidKeyStore"
        const val ALIAS = "sotto-api-key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_LENGTH = 12
    }
}
