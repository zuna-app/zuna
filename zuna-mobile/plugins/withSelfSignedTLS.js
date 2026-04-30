const { withAndroidManifest, withInfoPlist, withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
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

// iOS equivalent of the Android JVM-level bypass.
// NSAllowsArbitraryLoads in Info.plist disables ATS rules but does NOT bypass
// certificate chain validation — self-signed certs still fail at the URLSession
// level. This file swizzles the URLSession delegate challenge handlers on
// RCTHTTPRequestHandler (fetch/XHR) and RCTWebSocketModule (WebSocket) so that
// all server trust challenges are accepted unconditionally.
const TRUST_ALL_CERTS_M = `#import <Foundation/Foundation.h>
#import <CFNetwork/CFNetwork.h>
#import <objc/runtime.h>

typedef void (^ZunaAuthChallengeHandler)(NSURLSessionAuthChallengeDisposition, NSURLCredential *_Nullable);

static void ZunaPatchSSLChallenge(Class _Nullable cls) {
    if (!cls) return;

    // Session-level: URLSession:didReceiveChallenge:completionHandler:
    {
        SEL sel = @selector(URLSession:didReceiveChallenge:completionHandler:);
        IMP imp = imp_implementationWithBlock(^(id _s,
                                                NSURLSession *session,
                                                NSURLAuthenticationChallenge *challenge,
                                                ZunaAuthChallengeHandler handler) {
            if ([challenge.protectionSpace.authenticationMethod
                 isEqualToString:NSURLAuthenticationMethodServerTrust]) {
                handler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]);
            } else {
                handler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
            }
        });
        if (!class_addMethod(cls, sel, imp, "v@:@@@?")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }

    // Task-level: URLSession:task:didReceiveChallenge:completionHandler:
    {
        SEL sel = @selector(URLSession:task:didReceiveChallenge:completionHandler:);
        IMP imp = imp_implementationWithBlock(^(id _s,
                                                NSURLSession *session,
                                                NSURLSessionTask *task,
                                                NSURLAuthenticationChallenge *challenge,
                                                ZunaAuthChallengeHandler handler) {
            if ([challenge.protectionSpace.authenticationMethod
                 isEqualToString:NSURLAuthenticationMethodServerTrust]) {
                handler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]);
            } else {
                handler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
            }
        });
        if (!class_addMethod(cls, sel, imp, "v@:@@@@?")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }
}

// RCTWebSocketModule uses SocketRocket (SRWebSocket) for all WSS connections.
// SSL validation in SocketRocket happens at two levels:
//
// 1. SecureTransport (OS-level, during TLS handshake):
//    SRSecurityPolicy.updateSecurityOptionsInStream: sets stream SSL properties.
//    The default sets kCFStreamSSLValidatesCertificateChain=YES, which causes
//    error -9807 (errSSLXCertChainInvalid) for self-signed certs before any
//    app-level code runs.
//
// 2. App-level (post-handshake):
//    SRSecurityPolicy.evaluateServerTrust:forDomain: is an additional check
//    after the TLS handshake completes.
//
// Both must be patched to allow self-signed certificates.
static void ZunaPatchSocketRocket(void) {
    Class cls = NSClassFromString(@"SRSecurityPolicy");
    if (!cls) return;

    // Patch 1: disable SecureTransport-level chain validation so the TLS
    // handshake succeeds even with a self-signed certificate.
    {
        SEL sel = @selector(updateSecurityOptionsInStream:);
        IMP imp = imp_implementationWithBlock(^(id _s, NSStream *stream) {
            NSDictionary *sslSettings = @{
                (__bridge NSString *)kCFStreamSSLValidatesCertificateChain: @NO
            };
            [stream setProperty:sslSettings
                         forKey:(__bridge NSString *)kCFStreamPropertySSLSettings];
        });
        if (!class_addMethod(cls, sel, imp, "v@:@")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }

    // Patch 2: accept all certificates at the app-level post-handshake check.
    {
        SEL sel = @selector(evaluateServerTrust:forDomain:);
        IMP imp = imp_implementationWithBlock(^BOOL(id _s, void *serverTrust, NSString *domain) {
            return YES;
        });
        if (!class_addMethod(cls, sel, imp, "B@:^v@")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }
}

@interface ZunaTrustAllCerts : NSObject
@end

@implementation ZunaTrustAllCerts
+ (void)load {
    // Covers fetch / XMLHttpRequest (old arch + new arch)
    ZunaPatchSSLChallenge(NSClassFromString(@"RCTHTTPRequestHandler"));
    // Covers WebSocket session-level challenges (new arch fallback path)
    ZunaPatchSSLChallenge(NSClassFromString(@"RCTWebSocketModule"));
    ZunaPatchSSLChallenge(NSClassFromString(@"NativeWebSocketModule"));
    // Covers WSS via SocketRocket (the actual path used by RCTWebSocketModule)
    ZunaPatchSocketRocket();
}
@end
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

// Write TrustAllCerts.m to the ios/Zuna/ directory.
const withIosTrustAllCertsFile = (config) => {
  return withDangerousMod(config, [
    'ios',
    (config) => {
      const zunaDir = path.join(config.modRequest.platformProjectRoot, 'Zuna');
      fs.writeFileSync(path.join(zunaDir, 'TrustAllCerts.m'), TRUST_ALL_CERTS_M, 'utf8');
      return config;
    },
  ]);
};

// Register TrustAllCerts.m in the Xcode project so it gets compiled.
const withIosTrustAllCertsXcode = (config) => {
  return withXcodeProject(config, (config) => {
    const proj = config.modResults;
    const fileName = 'TrustAllCerts.m';

    // Guard against double-adding on repeated prebuild runs
    const alreadyAdded = Object.values(proj.pbxFileReferenceSection()).some(
      (ref) => ref && typeof ref === 'object' && ref.path &&
        (ref.path === `"${fileName}"` || ref.path === fileName)
    );

    if (!alreadyAdded) {
      const groupKey = proj.findPBXGroupKey({ name: 'Zuna' });
      proj.addSourceFile(`Zuna/${fileName}`, {}, groupKey);
    }

    return config;
  });
};

module.exports = (config) => {
  config = withAndroidSelfSignedTLS(config);
  config = withAndroidUnsafeOkHttp(config);
  config = withIosSelfSignedTLS(config);
  config = withIosTrustAllCertsFile(config);
  config = withIosTrustAllCertsXcode(config);
  return config;
};
