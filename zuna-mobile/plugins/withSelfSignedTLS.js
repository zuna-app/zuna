const { withAndroidManifest, withInfoPlist, withDangerousMod } = require('@expo/config-plugins');
const { getMainApplicationOrThrow } = require('@expo/config-plugins').AndroidConfig.Manifest;
const path = require('path');
const fs = require('fs');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

const getUnsafeOkHttpFactory = (packageName) => `package ${packageName}

import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.ReactCookieJarContainer
import okhttp3.OkHttpClient
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class UnsafeOkHttpClientFactory : OkHttpClientFactory {
    override fun createNewNetworkModuleClient(): OkHttpClient {
        val trustAllCerts = arrayOf<TrustManager>(
            object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
                override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
            }
        )
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, trustAllCerts, SecureRandom())
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
            .hostnameVerifier { _, _ -> true }
            .cookieJar(ReactCookieJarContainer())
            .build()
    }
}
`;

// JVM-level trust-all: covers all SSL paths including new-arch WebSocket,
// HttpsURLConnection, and any library that does not go through OkHttpClientProvider.
const getTrustAllSSL = (packageName) => `package ${packageName}

import android.annotation.SuppressLint
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

@SuppressLint("TrustAllX509TrustManager", "BadHostnameVerifier", "CustomX509TrustManager")
object TrustAllSSL {
    fun install() {
        val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val sc = SSLContext.getInstance("TLS")
        sc.init(null, trustAll, SecureRandom())
        SSLContext.setDefault(sc)
        HttpsURLConnection.setDefaultSSLSocketFactory(sc.socketFactory)
        HttpsURLConnection.setDefaultHostnameVerifier(HostnameVerifier { _, _ -> true })
    }
}
`;

const withAndroidSelfSignedTLS = (config) => {
  return withAndroidManifest(config, (config) => {
    const mainApplication = getMainApplicationOrThrow(config.modResults);

    mainApplication.$['android:networkSecurityConfig'] = '@xml/network_security_config';

    const xmlDir = path.join(
      config.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'res',
      'xml'
    );
    const xmlPath = path.join(xmlDir, 'network_security_config.xml');

    if (!fs.existsSync(xmlDir)) {
      fs.mkdirSync(xmlDir, { recursive: true });
    }

    fs.writeFileSync(xmlPath, NETWORK_SECURITY_CONFIG_XML, 'utf8');

    return config;
  });
};

const withAndroidUnsafeOkHttp = (config) => {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const packageName = (config.android && config.android.package) || 'com.anonymous.minimal';
      const packagePath = packageName.replace(/\./g, '/');
      const javaDir = path.join(
        config.modRequest.platformProjectRoot,
        'app', 'src', 'main', 'java', packagePath
      );

      // Write UnsafeOkHttpClientFactory.kt (patches OkHttp-based fetch)
      fs.writeFileSync(
        path.join(javaDir, 'UnsafeOkHttpClientFactory.kt'),
        getUnsafeOkHttpFactory(packageName),
        'utf8'
      );

      // Write TrustAllSSL.kt (JVM-level bypass — covers new-arch WebSocket,
      // HttpsURLConnection, and any path that bypasses OkHttpClientProvider)
      fs.writeFileSync(
        path.join(javaDir, 'TrustAllSSL.kt'),
        getTrustAllSSL(packageName),
        'utf8'
      );

      // Patch MainApplication.kt
      const mainAppPath = path.join(javaDir, 'MainApplication.kt');
      if (fs.existsSync(mainAppPath)) {
        let src = fs.readFileSync(mainAppPath, 'utf8');

        const okHttpImport = 'import com.facebook.react.modules.network.OkHttpClientProvider';
        if (!src.includes(okHttpImport)) {
          src = src.replace(
            /^(import android\.app\.Application)/m,
            `${okHttpImport}\n$1`
          );
        }

        // JVM-level bypass must run before everything else in onCreate
        const trustAllCall = 'TrustAllSSL.install()';
        if (!src.includes(trustAllCall)) {
          src = src.replace(
            'super.onCreate()',
            `super.onCreate()\n    ${trustAllCall}`
          );
        }

        const factoryCall = 'OkHttpClientProvider.setOkHttpClientFactory(UnsafeOkHttpClientFactory())';
        if (!src.includes(factoryCall)) {
          src = src.replace(
            'super.onCreate()',
            `super.onCreate()\n    ${factoryCall}`
          );
        }

        fs.writeFileSync(mainAppPath, src, 'utf8');
      }

      return config;
    },
  ]);
};

const withIosSelfSignedTLS = (config) => {
  return withInfoPlist(config, (config) => {
    config.modResults['NSAppTransportSecurity'] = {
      NSAllowsArbitraryLoads: true,
    };
    return config;
  });
};

module.exports = (config) => {
  config = withAndroidSelfSignedTLS(config);
  config = withAndroidUnsafeOkHttp(config);
  config = withIosSelfSignedTLS(config);
  return config;
};
